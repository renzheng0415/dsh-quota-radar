// dsh/index.js — 模型余额雷达 · Host 半边
//
// 责任：只对「DSH 实际接入的 provider」取额度，归一成统一 QuotaState，
//       通过 webServer 路由暴露给 client 半边。
//
// 审计修复记录（2026-10-01）：
//   H1 只轮询实际接入的 provider（ctx.llm.listProviders 发现），未接入不取数、不读凭据
//   H2 强制刷新限流 + 自定义请求头鉴权 + GET 白名单 + no-store
//   H3 AbortController 取消在途请求 + disposed 门闩 + 路由 disposer 归 fiber
//   H4 OpenCodex 改用真实 /api/provider-quotas
//   H6 错误信息脱敏，不把上游原文送到浏览器
//
// 设计红线（违反即失败）：
//   1. 不读 session 日志 / 缓存文件。只做小 JSON 的 HTTP GET。
//      这类本地缓存文件可能很大，全量 JSON.parse 会吃掉大量堆内存；
//      而余额只是 1KB 级数据，读那些是纯架构错误。
//   2. 不抓流量 / hook 请求体。宿主 UI 与 agent loop 与本插件同进程。
//   3. 所有历史结构必须有硬上限（环形缓冲）。
//   4. 不改宿主共享依赖。本插件零 npm 运行时依赖。
//   5. 密钥只在 host 侧取用，不落盘、不外传、不写日志、不进错误信息。

import { PUBLIC_ADAPTERS } from "./adapters-public.js";

const POLL_INTERVAL_MS = 60_000;
const CACHE_TTL_MS = 30_000;
// 「未配置 / 无额度接口」这类配置态的重查间隔。比轮询周期短，
// 保证每一轮都会重查，不会因为退避长期停在错误状态。
const CONFIG_RETRY_TTL_MS = 15_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 256 * 1024; // 流式读取上限，超出立即断开
const RING_SIZE = 120; // 每 provider 历史点数上限（@60s ≈ 2 小时）
const FORCE_MIN_INTERVAL_MS = 15_000; // 强制刷新的最小间隔
const MAX_TOKEN_FILE_BYTES = 4096;

// 单轮整轮的兜底期限。HTTP 超时只管网络，管不到「凭据解析挂起」这类
// 非网络等待——没有这一层，一个卡住的适配器会让全轮永远不结束，
// inFlight 一直是 true，之后所有刷新都只返回旧快照。
const ADAPTER_DEADLINE_MS = 15_000;
const CREDENTIAL_TIMEOUT_MS = 5_000;
const TOKEN_READ_TIMEOUT_MS = 5_000;
// 上游额度报告超过这个年龄就视为陈旧（OpenCodex 会返回很久以前的采样）
const UPSTREAM_STALE_MS = 30 * 60 * 1000;

const ARK_BRIDGE = "http://127.0.0.1:18901/ark-coding-plan";
const OPENCODEX_QUOTAS = "http://127.0.0.1:10100/api/provider-quotas";
const WORKBUDDY_PATH = "/plugins/dsh-connect-workbuddy/usage";


export const name = "quota-radar";
// Cordis 的 inject 是硬门禁：声明了运行时不存在的服务 → apply 永不执行且不报错。
// 这里只声明确定存在的 timer；llm / webServer / credentials 一律用 ctx.get() 软探测。
export const inject = ["timer"];

// ============================================================
// 工具：严格数值与脱敏
// ============================================================

/** 严格数值解析。拒绝 "12garbage" 这类 parseFloat 会放行的脏值。 */
function strictNum(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    const n = Number(t);
    return isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 百分比：保留原值同时标记越界，绝不静默把 150% 变成 100%。
 * 返回 { value, raw, outOfRange } —— UI 用 value 显示，越界时打警告。
 */
function pct(v) {
  const n = strictNum(v);
  if (n === null) return null;
  const rounded = Math.round(n * 10) / 10;
  return {
    value: Math.max(0, Math.min(100, rounded)),
    raw: rounded,
    outOfRange: rounded < 0 || rounded > 100,
  };
}

/**
 * 把上游时间戳统一成 ISO。上游可能给秒、毫秒，也可能给绝对时刻或
 * 「距今多少毫秒」——这里只接受能明确识别的绝对值，其余返回 null。
 */
function epochToIso(raw) {
  const n = strictNum(raw);
  if (n === null || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n; // 秒 vs 毫秒
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  // 落在 2001 年之前或太遥远的未来，说明单位判断错了，宁可不用
  const year = d.getUTCFullYear();
  if (year < 2001 || year > 2200) return null;
  return d.toISOString();
}

/**
 * 错误脱敏：上游错误可能含 token / Authorization，绝不能原样送到浏览器。
 *
 * 注意别过度匹配：上一版把「读取 admin token 超时」里的后半句也吃掉了，
 * 结果错误信息变得没用。所以只在确实出现赋值分隔符（: 或 =）或已知密钥
 * 前缀时才打码。
 */
function sanitizeMessage(raw) {
  let s = String(raw ?? "").slice(0, 200);
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._\-]{6,}/gi, "$1 [已隐藏]");
  s = s.replace(/\b(sk-|ghp_|gho_|xoxb-|xai-)[A-Za-z0-9._\-]{4,}/gi, "[已隐藏]");
  s = s.replace(
    /((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9._\-+/=]{6,})/gi,
    "$1[已隐藏]",
  );
  s = s.replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[已隐藏]");
  s = s.replace(/([?&](?:key|token|secret|apikey)=)[^&\s]+/gi, "$1[已隐藏]");
  return s;
}

function currencySymbol(c) {
  if (c === "CNY") return "¥";
  if (c === "USD") return "$";
  return "";
}

function formatAmount(n, currency) {
  if (typeof n !== "number" || !isFinite(n)) return null;
  const sym = currencySymbol(currency);
  const abs = Math.abs(n);
  const text = abs >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2);
  return sym + text;
}

/**
 * 环形缓冲：固定容量，O(1) 写入，内存恒定。
 * 防慢性 OOM 的关键——禁止用无界数组累积历史。
 */
class Ring {
  constructor(size) {
    this.size = size;
    this.buf = new Array(size);
    this.idx = 0;
    this.count = 0;
  }
  push(value) {
    this.buf[this.idx] = value;
    this.idx = (this.idx + 1) % this.size;
    if (this.count < this.size) this.count += 1;
  }
  toArray() {
    const out = [];
    const start = this.count < this.size ? 0 : this.idx;
    for (let i = 0; i < this.count; i += 1) out.push(this.buf[(start + i) % this.size]);
    return out;
  }
}

// ============================================================
// 统一状态形状（归一层）
// ============================================================
// 所有 provider 都产出这个形状，UI 只认它、不认 provider。
// 加第 7 家时，UI 一行都不用改。

function stateOk(provider, label, extra) {
  return {
    provider,
    label,
    routes: extra.routes ?? [],
    status: "ok",
    windows: extra.windows ?? [],
    balance: extra.balance ?? null,
    detail: extra.detail ?? null,
    updatedAt: Date.now(),
    stale: false,
    message: null,
  };
}

function stateBad(provider, label, status, message, routes) {
  return {
    provider,
    label,
    routes: routes ?? [],
    status, // unconfigured | unsupported | error
    windows: [],
    balance: null,
    detail: null,
    updatedAt: Date.now(),
    stale: false,
    message: message ? sanitizeMessage(message) : null,
  };
}

/** 把上游 {rolling,weekly,monthly} 结构解析成统一窗口。 */
function parseUsageWindows(usage) {
  const windows = [];
  const map = [
    ["rolling", "5h"],
    ["weekly", "本周"],
    ["monthly", "本月"],
  ];
  for (const [key, label] of map) {
    const w = usage[key];
    if (!w || typeof w !== "object") continue;
    if (w.status && w.status !== "ok") continue;
    const p = pct(w.percent);
    if (!p) continue;
    windows.push({
      label,
      usedPercent: p.value,
      outOfRange: p.outOfRange,
      rawPercent: p.outOfRange ? p.raw : undefined,
      resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
    });
  }
  return windows;
}

// ============================================================
// 各 provider 适配器
// ============================================================
// 每个适配器：
//   id        内部标识
//   label     显示名
//   providers 它服务的 DSH route id（用于「只查实际接入」匹配）
//   fetch     async (ctx, deps) => QuotaState
//
// 未接入的适配器根本不会被调用——见 createRegistry 的 discovery。

/**
 * Ark 火山方舟（经由用户自建的 18901 桥接）
 *
 * 为什么必须走桥接：方舟额度只在控制面（OpenTOP）提供，鉴权是 SSO
 * （V4 签名 + X-Security-Token），API Key 做不到。数据面带真实 key 实测
 * /api/v3/balance 与 /api/v3/usage 均 404，而 /api/v3/models 是 200。
 */
const arkAdapter = {
  id: "ark",
  label: "Ark",
  providers: ["ark", "volcengine", "volces", "doubao", "ark-coding"],
  async fetch(ctx, deps = {}) {
    // 必须把取消信号传下去。审计确认过：漏传时卸载后这条请求仍会跑到
    // 自己的 12s 超时才结束。
    // 端点可由配置覆盖。默认值是本机桥接——发布版对没有这个桥的人
    // 会走「不可达」分支并给出可操作的提示，而不是静默失败。
    const url = (deps.endpoints && deps.endpoints.ark) || ARK_BRIDGE;
    const body = await getJson(url, undefined, deps.signal);
    const usage = body && body.usage;
    if (!usage) return stateBad("ark", "Ark", "error", "桥接返回结构异常");
    const windows = parseUsageWindows(usage);
    if (windows.length === 0) return stateBad("ark", "Ark", "error", "桥接无可用窗口数据");
    return stateOk("ark", "Ark", {
      windows,
      detail: { source: "本地桥接 (18901)", note: "经 arkcli SSO 获取" },
    });
  },
};

/**
 * WorkBuddy（CN + 全球）
 *
 * 复用已装的 dsh-connect-workbuddy 插件暴露的只读路由——token 刷新、
 * 凭据管理、region 切换全由它负责，本插件不碰密钥。
 * 实测：CN credits.total = 4221，全球 = 350。单位是积分，不是人民币。
 */
function makeWorkbuddyAdapter(region, id, label, providers) {
  return {
    id,
    label,
    providers,
    async fetch(ctx, deps = {}) {
      const port = deps.getWebPort ? deps.getWebPort() : null;
      if (!port) return stateBad(id, label, "error", "宿主 webServer 端口未知");
      const url = `http://127.0.0.1:${port}${WORKBUDDY_PATH}?region=${region}`;
      let body;
      try {
        body = await getJson(url, undefined, deps.signal);
      } catch {
        return stateBad(id, label, "error", "WorkBuddy 插件路由不可达（未安装或未运行）");
      }
      if (!body || body.status !== "signed-in") {
        return stateBad(id, label, "unconfigured", "未登录");
      }
      const credits = body.credits;
      const total = credits ? strictNum(credits.total) : null;
      if (!credits || total === null) {
        // creditsError 是上游账单查询失败，不是没登录。脱敏后再用。
        const why = body.creditsError ? sanitizeMessage(body.creditsError) : "上游未返回额度";
        return stateBad(id, label, "error", why);
      }
      const pkgs = Array.isArray(credits.packages) ? credits.packages : [];
      const monthly = [];
      for (const p of pkgs) {
        if (!p || !p.monthly) continue;
        const remain = strictNum(p.remain);
        const size = strictNum(p.size);
        if (remain === null || size === null || size <= 0 || remain < 0) continue;
        // 走统一越界校验：remain > size 时不能算出「剩余 200%」这种数。
        const used = pct((1 - remain / size) * 100);
        if (!used) continue;
        monthly.push({
          remain,
          size,
          ratio: remain / size,
          used,
          name: p.packageName,
          cycleRefreshMs: p.cycleRefreshMs,
        });
      }
      // 按「剩余比例」取最吃紧的那个包——按绝对积分挑会选错（大包天然剩余多）
      monthly.sort((a, b) => a.ratio - b.ratio);
      const tightest = monthly[0] ?? null;
      let resetsAt = null;
      if (tightest && typeof tightest.cycleRefreshMs === "number" && isFinite(tightest.cycleRefreshMs)) {
        const d = new Date(tightest.cycleRefreshMs);
        if (!isNaN(d.getTime())) resetsAt = d.toISOString();
      }
      const windows = tightest
        ? [
            {
              label: "最紧月度包",
              usedPercent: tightest.used.value,
              outOfRange: tightest.used.outOfRange,
              rawPercent: tightest.used.outOfRange ? tightest.used.raw : undefined,
              resetsAt,
            },
          ]
        : [];
      // 只有走原生 WorkBuddy 插件的那条路由，账号归属才是确定的。
      // 其它别名（如本地 8200 代理 workbuddy2api）复用的是同一套凭据，
      // 但「代理账号 == 此处显示的账号」没有独立证据，所以如实标注，
      // 并且这条说明会一路传到界面，不只是一句注释。
      const nativeRoute = id === "workbuddy-global" ? "workbuddy-global" : "workbuddy";
      const matched = Array.isArray(deps.matchedRoutes) ? deps.matchedRoutes : [];
      const viaAlias = matched.some((r) => r !== nativeRoute);
      const accountNote = viaAlias
        ? `经「${matched.filter((r) => r !== nativeRoute).join("/")}」接入，额度归属未独立验证`
        : null;
      return stateOk(id, label, {
        windows,
        balance: { amount: total, currency: "积分", display: String(total) },
        detail: {
          account: typeof body.accountName === "string" ? body.accountName : null,
          packageCount: pkgs.length,
          monthlyCount: monthly.length,
          expiringSoon: strictNum(credits.expiringSoon) ?? 0,
          unitNote: "单位为积分，非人民币",
          bindingNote: accountNote,
        },
      });
    },
  };
}

/**
 * OpenCodex 本地网关
 *
 * 用 /api/provider-quotas（真实额度接口），不是 /api/usage（那是花费统计）。
 * 该接口按上游 provider（openai / xai）给报告，含多账号聚合：
 *   reports[].quota.{fiveHourPercent, weeklyPercent}  已用百分比
 *   reports[].aggregation.currentAccount.quota        当前账号自身
 * 注意聚合值来自多个账号，不能当成单一账号的独立余额——如实标注。
 */
const opencodexAdapter = {
  id: "opencodex",
  label: "OpenCodex",
  providers: ["opencodex", "opencodex-local"],
  async fetch(ctx, deps = {}) {
    // readToken 是给测试留的接缝：让测试不碰真实 ~/.opencodex 文件。
    const readToken = typeof deps.readToken === "function" ? deps.readToken : readOpencodexToken;
    let token = null;
    try {
      token = await withDeadline(Promise.resolve().then(readToken), TOKEN_READ_TIMEOUT_MS, "读取 OpenCodex token");
    } catch {
      return stateBad("opencodex", "OpenCodex", "error", "读取 admin token 超时或失败");
    }
    if (!token) return stateBad("opencodex", "OpenCodex", "unconfigured", "未找到 admin token");
    const url = (deps.endpoints && deps.endpoints.opencodex) || OPENCODEX_QUOTAS;
    const body = await getJson(url, { Authorization: `Bearer ${token}` }, deps.signal);
    const reports = body && body.reports;
    if (!Array.isArray(reports) || reports.length === 0) {
      return stateBad("opencodex", "OpenCodex", "unsupported", "网关未返回任何额度报告");
    }
    const windows = [];
    const accounts = [];
    let oldestSourceMs = null;
    let anyPartial = false;
    for (const r of reports) {
      if (!r || typeof r !== "object") continue;
      const name = typeof r.label === "string" ? r.label : String(r.provider ?? "未知");
      const q = r.quota && typeof r.quota === "object" ? r.quota : {};
      const agg = r.aggregation && typeof r.aggregation === "object" ? r.aggregation : null;
      const aggIncomplete = agg ? agg.incomplete === true : false;

      // 上游自己的采样时刻。用它判断「数字是不是很久没更新」，
      // 不能拿我们收到响应的时刻冒充新鲜度。
      const sourceIso = epochToIso(q.updatedAt) ?? epochToIso(r.updatedAt);
      if (sourceIso) {
        const ms = Date.parse(sourceIso);
        if (oldestSourceMs === null || ms < oldestSourceMs) oldestSourceMs = ms;
      }

      // 聚合不完整 = 只统计了部分账号，数值会偏乐观/偏悲观，必须标注
      const fivePartial = agg
        ? agg.fiveHour && typeof agg.fiveHour === "object"
          ? agg.fiveHour.incomplete === true
          : aggIncomplete
        : false;
      const weekPartial = agg
        ? agg.weekly && typeof agg.weekly === "object"
          ? agg.weekly.incomplete === true
          : aggIncomplete
        : false;

      const five = pct(q.fiveHourPercent);
      const week = pct(q.weeklyPercent);
      if (five) {
        windows.push({
          label: `${name} 5h`,
          usedPercent: five.value,
          outOfRange: five.outOfRange,
          rawPercent: five.outOfRange ? five.raw : undefined,
          resetsAt: null,
          partial: fivePartial,
          sourceAt: sourceIso,
        });
      }
      if (week) {
        windows.push({
          label: `${name} 本周`,
          usedPercent: week.value,
          outOfRange: week.outOfRange,
          rawPercent: week.outOfRange ? week.raw : undefined,
          resetsAt: epochToIso(q.weeklyResetAt),
          partial: weekPartial,
          sourceAt: sourceIso,
        });
      }
      if (fivePartial || weekPartial) anyPartial = true;

      accounts.push({
        provider: String(r.provider ?? "?"),
        label: name,
        source: typeof r.source === "string" ? r.source : null,
        includedAccounts: agg ? strictNum(agg.includedAccounts) : null,
        excludedAccounts: agg ? strictNum(agg.excludedAccounts) : null,
        incomplete: agg ? aggIncomplete : null,
        partialWindows: [fivePartial ? "5h" : null, weekPartial ? "本周" : null].filter(Boolean),
        sourceAt: sourceIso,
      });
    }
    if (windows.length === 0) {
      return stateBad("opencodex", "OpenCodex", "unsupported", "额度报告里没有可用窗口");
    }

    const state = stateOk("opencodex", "OpenCodex", {
      windows,
      detail: {
        generatedAt: strictNum(body.generatedAt),
        accounts,
        partial: anyPartial,
        // 诚实标注：这是多账号聚合，不是单一账号余额
        aggregationNote: "为多账号聚合值，非单一账号余额",
        partialNote: anyPartial ? "部分账号未纳入统计，数值不完整" : null,
      },
    });

    // 上游采样过旧 → 标成 stale，界面会显示「数据可能过期」，
    // 而不是把一个几小时前的数当成实时值。
    if (oldestSourceMs !== null) {
      const ageMs = Date.now() - oldestSourceMs;
      state.detail.sourceAgeMs = ageMs;
      if (ageMs > UPSTREAM_STALE_MS) {
        state.stale = true;
        state.message = `上游数据约 ${Math.round(ageMs / 60000)} 分钟未更新`;
      }
    }
    return state;
  },
};

const ADAPTERS = [
  // ── 公开适配器：只请求厂商官方域名，任何用户装上即可用 ──
  ...PUBLIC_ADAPTERS,
  // ── 本机适配器：依赖用户自己跑的服务/插件，见文件头说明 ──
  arkAdapter,
  makeWorkbuddyAdapter("cn", "workbuddy", "WorkBuddy", ["workbuddy", "codebuddy", "workbuddy2api"]),
  makeWorkbuddyAdapter("global", "workbuddy-global", "WorkBuddy 全球", ["workbuddy-global", "workbuddy-global-api"]),
  opencodexAdapter,
];

// ============================================================
// 取数原语
// ============================================================

/** 合并超时信号与外部取消信号（Node 20+ 有 AbortSignal.any）。 */
function mergedSignal(external) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!external) return timeout;
  try {
    return AbortSignal.any([timeout, external]);
  } catch {
    return timeout; // 老运行时降级：至少保住超时
  }
}

/**
 * 给任意 Promise 加一个硬期限。
 * 用途：凭据解析、token 读取、整个适配器调用——这些都不是 HTTP，
 * fetch 的超时管不到。没有它，一次挂起就会卡死整轮刷新。
 */
function withDeadline(promise, ms, label) {
  let timer = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 带超时的小 JSON GET。
 * 流式读取并在超限时立即断开——不是先全读进内存再检查。
 * 非 2xx 也会 cancel body，不留悬挂连接。
 */
async function getJson(url, headers, signal) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "error", // 带 Bearer 的请求不跟随重定向，防凭据外送
    headers: { accept: "application/json", ...(headers ?? {}) },
    signal: mergedSignal(signal),
  });
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // 已关闭
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("响应体缺失");
  // 预分配固定缓冲，并限制 chunk 数量，避免大量极小 chunk 撑爆内存
  const buf = new Uint8Array(MAX_BODY_BYTES);
  let bytes = 0;
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      if (chunks > 4096) throw new Error("响应分片过多，已停止读取");
      if (bytes + value.byteLength > MAX_BODY_BYTES) {
        throw new Error(`响应超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB，已停止读取`);
      }
      buf.set(value, bytes);
      bytes += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder().decode(buf.subarray(0, bytes)));
}

/**
 * 「凭据服务尚未就绪」的哨兵值。
 *
 * 必须与「没配密钥」区分开：DSH 刚启动时 credentials 服务可能还没挂上，
 * 这时候返回 null 会被上层当成「未配置」缓存下来，界面上就一直显示
 * 「未配置」——而用户其实配置得好好的。那是个启动竞态，不是配置问题。
 */
const CREDENTIALS_UNAVAILABLE = Symbol("credentials-unavailable");

/** 从 DSH credentials 服务取 key（只在 host 侧，不外传） */
async function resolveApiKey(ctx, refs) {
  let cred;
  try {
    cred = typeof ctx.get === "function" ? ctx.get("credentials") : ctx.credentials;
  } catch {
    cred = undefined;
  }
  if (!cred || typeof cred.resolve !== "function") return CREDENTIALS_UNAVAILABLE;
  for (const ref of refs) {
    try {
      // 凭据解析不是 HTTP，fetch 的超时管不到它。审计确认过：解析一旦挂起，
      // 整轮就永远不结束，inFlight 卡在 true，之后所有刷新都只返回旧快照。
      const hit = await withDeadline(
        Promise.resolve().then(() => cred.resolve(ref)),
        CREDENTIAL_TIMEOUT_MS,
        `解析凭据 ${ref}`,
      );
      if (hit && typeof hit.value === "string" && hit.value) return hit.value;
    } catch {
      // 单个 ref 失败或超时，不影响其它候选
    }
  }
  return null;
}

/** 读 OpenCodex admin token：先查大小再读，避免无界读入。 */
async function readOpencodexToken() {
  try {
    const { open, stat } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(homedir(), ".opencodex", "admin-api-token");
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_TOKEN_FILE_BYTES) return null;
    const handle = await open(file, "r");
    try {
      const buf = Buffer.alloc(info.size);
      await handle.read(buf, 0, info.size, 0);
      const t = buf.toString("utf8").trim();
      return t.length > 0 && t.length < 512 ? t : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

// ============================================================
// 发现 + 缓存 + 退避 + 单飞 + 取消
// ============================================================

/**
 * 发现 DSH 实际注册的 provider route。
 * 返回 Set；无法发现时返回 null（保守：不取任何数，避免误查未接入的服务）。
 */
function discoverProviders(ctx) {
  let llm;
  try {
    llm = typeof ctx.get === "function" ? ctx.get("llm") : ctx.llm;
  } catch {
    llm = undefined;
  }
  if (!llm || typeof llm.listProviders !== "function") return null;
  try {
    const list = llm.listProviders();
    if (!Array.isArray(list)) return null;
    const ids = new Set();
    for (const p of list) {
      const id = p && typeof p.id === "string" ? p.id : null;
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return null;
  }
}

/** 找出有实际接入 route 的适配器，并绑定匹配到的 route。 */
function activeAdapters(registered) {
  if (!registered) return [];
  const out = [];
  for (const adapter of ADAPTERS) {
    const routes = adapter.providers.filter((p) => registered.has(p));
    if (routes.length > 0) out.push({ adapter, routes });
  }
  return out;
}

function createRegistry(ctx, deps) {
  const cache = new Map(); // id -> { state, expiresAt, streak }
  const history = new Map(); // id -> Ring
  const controller = new AbortController();
  let disposed = false;
  let inFlight = false;
  let lastForceAt = 0;
  let roundSeq = 0;

  for (const a of ADAPTERS) history.set(a.id, new Ring(RING_SIZE));

  function computeBackoff(streak) {
    if (streak <= 0) return 0;
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, streak - 1));
  }

  async function loadOne(adapter, routes, force, round) {
    if (disposed) return null;
    const cached = cache.get(adapter.id);
    const now = Date.now();

    // 强制刷新只能跳过「成功之后的 30s 缓存」，不能跳过失败退避。
    // 否则连续失败时每 15s 强刷一次就能一直打上游，退避等于没有。
    const inBackoff = Boolean(cached) && cached.streak > 0;
    const effectiveForce = force && !inBackoff;
    if (!effectiveForce && cached && cached.expiresAt > now) return cached.state;

    let state;
    try {
      // 适配器原语由 registry 统一注入，不依赖调用方传全。
      // 之前只靠 apply() 组装 deps，任何直接 createRegistry 的调用方
      // （测试、未来的其他入口）都会让适配器拿到 undefined 而抛错。
      state = await adapter.fetch(ctx, {
        getJson,
        stateOk,
        stateBad,
        resolveKey: resolveApiKey,
        CREDENTIALS_UNAVAILABLE,
        ...deps,
        signal: controller.signal,
        matchedRoutes: routes,
      });
    } catch (e) {
      const msg = sanitizeMessage((e && e.message) || e);
      const prev = cached && cached.state;
      if (prev && prev.status === "ok") {
        state = { ...prev, stale: true, message: msg };
      } else {
        state = stateBad(adapter.id, adapter.label, "error", msg, routes);
      }
    }
    if (disposed) return null; // 卸载后不再回写
    // 已被更新的轮次接手，丢弃这次迟到的结果，避免旧数据覆盖新数据
    if (round !== roundSeq) return null;

    // 适配器主动返回 error 时，同样保留上一次有效值
    if (state.status === "error" && cached?.state.status === "ok") {
      state = { ...cached.state, stale: true, message: state.message };
    }
    state.routes = routes;

    const succeeded = state.status === "ok" && !state.stale;
    // 「未配置 / 该网关无额度接口」不是上游故障，不该按指数退避压到 15 分钟。
    // 用户随时可能补上密钥，凭据服务也可能才刚起来；这类状态给个固定短 TTL，
    // 下一轮就重查，免得界面长时间停在「未配置」上误导人。
    const configState = state.status === "unconfigured" || state.status === "unsupported";
    const prevStreak = cached ? cached.streak : 0;
    const streak = succeeded || configState ? 0 : Math.min(prevStreak + 1, 32);
    const ttl = succeeded ? CACHE_TTL_MS : configState ? CONFIG_RETRY_TTL_MS : computeBackoff(streak);
    cache.set(adapter.id, { state, expiresAt: now + ttl, streak });

    // 只有真正的新鲜成功才写入历史——stale 会把旧时间点重复记一遍
    if (succeeded) {
      const ring = history.get(adapter.id);
      if (ring) {
        ring.push({
          at: state.updatedAt,
          windows: state.windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent })),
          balance: state.balance ? state.balance.amount : null,
        });
      }
    }
    return state;
  }

  /** 强制刷新限流：距上次强制刷新太近则降级为普通刷新。 */
  function allowForce(force) {
    if (!force) return false;
    const now = Date.now();
    if (now - lastForceAt < FORCE_MIN_INTERVAL_MS) return false;
    lastForceAt = now;
    return true;
  }

  async function loadAll(force) {
    if (disposed) return [];
    if (inFlight) return snapshot();
    inFlight = true;
    const round = (roundSeq += 1);
    try {
      const registered = discoverProviders(ctx);
      const active = activeAdapters(registered);
      const effectiveForce = allowForce(force);
      // 每个适配器都套硬期限。没有这一层，任何一个卡住的适配器
      // （凭据解析挂起、本地文件读挂起）都会让整轮永不结束，
      // inFlight 一直是 true，之后所有刷新都只返回旧快照。
      const results = await Promise.all(
        active.map(({ adapter, routes }) =>
          withDeadline(
            Promise.resolve()
              .then(() => loadOne(adapter, routes, effectiveForce, round))
              .catch((e) =>
                stateBad(adapter.id, adapter.label, "error", sanitizeMessage((e && e.message) || e), routes),
              ),
            ADAPTER_DEADLINE_MS,
            `${adapter.label} 取数`,
          ).catch((e) =>
            stateBad(adapter.id, adapter.label, "error", sanitizeMessage((e && e.message) || e), routes),
          ),
        ),
      );
      return results.filter(Boolean);
    } finally {
      inFlight = false;
    }
  }

  /** 当前快照：只包含已接入且有适配器的 provider。 */
  function snapshot() {
    if (disposed) return [];
    const registered = discoverProviders(ctx);
    const active = activeAdapters(registered);
    const out = [];
    for (const { adapter, routes } of active) {
      const c = cache.get(adapter.id);
      if (!c) {
        out.push(stateBad(adapter.id, adapter.label, "error", "尚未取数", routes));
        continue;
      }
      // 当前实际接入的 route 要覆盖缓存里的旧值。否则 provider 改名
      // （ark → ark-coding）后，界面仍按旧 route 去匹配当前模型，
      // 结果就是「明明在用，却不显示」。
      out.push(c.state.routes === routes ? c.state : { ...c.state, routes });
    }
    return out;
  }

  /** 已接入但没有适配器的 route——UI 显示「不提供额度接口」而不是消失。 */
  function unadapted() {
    const registered = discoverProviders(ctx);
    if (!registered) return [];
    const covered = new Set();
    for (const a of ADAPTERS) for (const p of a.providers) covered.add(p);
    return [...registered].filter((id) => !covered.has(id));
  }

  function registeredList() {
    const registered = discoverProviders(ctx);
    return registered ? [...registered] : [];
  }

  function historyFor(id) {
    const ring = history.get(id);
    return ring ? ring.toArray() : [];
  }

  /**
   * 估算本插件持有的数据量（序列化长度）。
   * 注意：这不是进程 RSS，也不是插件真实堆占用，只用于观察趋势。
   */
  function payloadEstimate() {
    let bytes = 0;
    for (const [, c] of cache) bytes += JSON.stringify(c.state).length * 2;
    for (const [, ring] of history) for (const item of ring.toArray()) bytes += JSON.stringify(item).length * 2;
    return { approxBytes: bytes, providers: cache.size, ringSize: RING_SIZE, note: "序列化估算，非进程 RSS" };
  }

  function dispose() {
    disposed = true;
    try {
      controller.abort();
    } catch {
      // 已中止
    }
    cache.clear();
    history.clear();
  }

  return { loadAll, snapshot, unadapted, registeredList, historyFor, payloadEstimate, dispose, isDisposed: () => disposed };
}

// ============================================================
// 插件入口
// ============================================================

export function apply(ctx, config) {
  let webPort = null;

  // 可配置端点：让「本机桥接」类适配器也能被别人用。
  // 没配就走各自的内置默认值（本机端口）。
  const endpoints = {
    ark: config?.endpoints?.ark,
    opencodeGo: config?.endpoints?.opencodeGo,
    opencodex: config?.endpoints?.opencodex,
  };
  // 适配器依赖束。公开适配器（adapters-public.js）只通过这些注入的
  // 原语做事，不直接 import index.js 的内部函数——这样它们可以独立测试，
  // 也不会把 host 的实现细节耦进适配器里。
  const registry = createRegistry(ctx, {
    getWebPort: () => webPort,
    getJson,
    stateOk,
    stateBad,
    resolveKey: resolveApiKey,
    CREDENTIALS_UNAVAILABLE,
    endpoints,
  });
  const logger = ctx.logger ?? console;

  // 只对已接入的 provider 取数。未接入 → active 为空 → 这一 tick 是空操作。
  const disposePoll = ctx.interval(() => {
    registry.loadAll(false).catch((e) => {
      logger.warn?.("[quota-radar] 轮询异常: " + sanitizeMessage((e && e.message) || e));
    });
  }, POLL_INTERVAL_MS);

  // 启动预热。
  //
  // 原来只等 800ms 就取一次，太急：那时候 credentials 服务可能还没挂上，
  // Ark 的本地桥接也可能还在冷启动（实测冷启动会超过 12s 超时）。
  // 于是第一轮拿到的是「未配置 / 超时」，还会被缓存下来，界面上就一直错。
  // 现在拉开到 3s，并且 25s 后再补一次——第一轮就算失手也能很快自愈。
  ctx.timeout(() => {
    registry.loadAll(false).catch(() => {});
  }, 3_000);
  ctx.timeout(() => {
    registry.loadAll(false).catch(() => {});
  }, 25_000);

  ctx.inject(["webServer"], (scope) => {
    const server = scope.webServer;
    webPort = typeof server.port === "number" ? server.port : null;

    const send = (res, code, body) => {
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };

    /**
     * 本机路由防护。
     *
     * 宿主自带的启动令牌 + 签名 cookie 鉴权只保护首页 HTML（实测 `/` 返回
     * 401，而插件路由返回 200），所以这一层必须由插件自己提供。
     *
     * 三道检查：
     *   1. 只允许 GET —— 杜绝任何带副作用的调用。
     *   2. 必须带自定义头。跨站「简单请求」无法携带自定义头，一旦携带就会
     *      触发预检，而预检（OPTIONS）在这里被直接拒掉。
     *   3. 校验 Origin / Sec-Fetch-Site。只认自定义头是不够的：本机任意进程
     *      都能伪造这个头，浏览器跨源请求也会带上它。Origin 存在时必须与
     *      本机 Host 完全一致（同源 GET 通常不带 Origin，所以「不存在」放行）。
     */
    const guard = (req) => {
      if (req.method !== "GET") return "仅支持 GET";
      const h = req.headers ?? {};
      if (h["x-quota-radar"] !== "1") return "缺少必要的请求头";

      const site = h["sec-fetch-site"];
      if (typeof site === "string" && site !== "same-origin" && site !== "none") {
        return "跨站请求被拒绝";
      }

      const origin = h.origin;
      if (typeof origin === "string" && origin.length > 0) {
        const host = h.host;
        let sameOrigin = false;
        if (typeof host === "string" && host.length > 0) {
          try {
            const parsed = new URL(origin);
            sameOrigin =
              (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
          } catch {
            sameOrigin = false; // "null" 或不合法 Origin
          }
        }
        if (!sameOrigin) return "跨源请求被拒绝";
      }
      return null;
    };

    const route1 = server.register({
      kind: "exact",
      path: "/quota-radar/snapshot",
      handler: async (req, res) => {
        try {
          const denied = guard(req);
          if (denied) {
            send(res, 403, { ok: false, error: denied });
            return;
          }
          const url = new URL(req.url, "http://localhost");
          const force = url.searchParams.get("force") === "1";
          const provider = url.searchParams.get("provider");

          let states = force ? await registry.loadAll(true) : registry.snapshot();
          if (provider) states = states.filter((s) => s.provider === provider || (s.routes ?? []).includes(provider));

          send(res, 200, {
            ok: true,
            now: Date.now(),
            providers: states,
            unadapted: registry.unadapted(),
            registered: registry.registeredList(),
            payload: registry.payloadEstimate(),
          });
        } catch (e) {
          send(res, 200, { ok: false, error: sanitizeMessage((e && e.message) || e) });
        }
      },
    });

    const route2 = server.register({
      kind: "exact",
      path: "/quota-radar/history",
      handler: async (req, res) => {
        try {
          const denied = guard(req);
          if (denied) {
            send(res, 403, { ok: false, error: denied });
            return;
          }
          const url = new URL(req.url, "http://localhost");
          const provider = url.searchParams.get("provider");
          if (!provider) {
            send(res, 400, { ok: false, error: "缺少 provider 参数" });
            return;
          }
          send(res, 200, { ok: true, provider, points: registry.historyFor(provider) });
        } catch (e) {
          send(res, 200, { ok: false, error: sanitizeMessage((e && e.message) || e) });
        }
      },
    });

    // register() 返回 disposer 且不自动挂 fiber —— 必须显式登记。
    //
    // 关键点：登记在「注入出来的那个作用域」上，不是顶层 ctx。
    // 顶层 ctx 只在插件整体卸载时才回收；如果宿主只是重启了 webServer
    // 服务（作用域销毁重建），路由就会残留，重新注入时还会因为
    // duplicate route 直接抛错。挂在 scope 上才能随服务生命周期回收。
    const host = typeof scope.effect === "function" ? scope : ctx;
    host.effect(
      () => () => {
        try {
          route1();
        } catch {
          /* 已释放 */
        }
        try {
          route2();
        } catch {
          /* 已释放 */
        }
        webPort = null;
      },
      "quota-radar: routes",
    );

    logger.info?.(`[quota-radar] 路由已注册 (端口 ${webPort ?? "未知"})`);
  });

  // 卸载：停轮询 + 取消在途 + 释放缓存
  ctx.effect(
    () => () => {
      try {
        disposePoll();
      } catch {
        /* 已释放 */
      }
      registry.dispose();
      logger.info?.("[quota-radar] 已卸载");
    },
    "quota-radar: cleanup",
  );
}
