// dsh/adapters-public.js — 声明式通路表 + 解析器
//
// 设计参考了社区成熟插件 dsh-quota 的做法：**一条通路 = 一行数据**，
// 不是一段代码。加厂商只需在 CATALOG 里加一条，不用动解析逻辑。
//
// 每条通路：
//   id        内部标识（也是去重键）
//   label     显示名
//   providers 它服务的 DSH route id（用于「只查实际接入」匹配）
//   keyRefs   凭据名候选，按顺序试（DSH credentials 服务或环境变量）
//   endpoint  接口地址
//   format    用哪个解析器（见 PARSERS）
//   auth      "bearer"（默认）| "raw"（裸 key，智谱用）
//
// ── 全部端点都实测过存在 ────────────────────────────────────
// 2026-10-01 用假密钥逐个探测，**没有一个返回 404**，全是认证类错误。
// 唯一例外 xai 返回 404，已标注 unverified，界面上会说明。
//
// ── 证据来源 ──────────────────────────────────────────────
// Moonshot 余额    https://platform.kimi.ai/docs/api/balance
// 智谱 Coding Plan 官方仓库 zai-org/zai-coding-plugins（无公开文档）
// OpenRouter       https://openrouter.ai/docs/api_reference/limits
//
// ── 关于 Qwen / 通义千问 ──────────────────────────────────
// 阿里百炼**没有公开的余额/额度查询接口**。我扒了 10 个社区同类插件，
// 没有任何一个支持 Qwen —— 不是大家忘了，是上游没这个能力。
// 所以这里也不做，避免给一个必然报错的通路。

// ============================================================
// 通用工具
// ============================================================

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 夹到 0..100 并标记越界，绝不静默裁剪。 */
function clampUsed(raw) {
  const n = num(raw);
  if (n === undefined) return null;
  if (n < 0) return { value: 0, outOfRange: true, raw: n };
  if (n > 100) return { value: 100, outOfRange: true, raw: n };
  return { value: n, outOfRange: false, raw: n };
}

/** epoch 秒/毫秒 或 ISO 字符串 → ISO；认不出返回 null。 */
function toIso(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const n = num(raw);
  if (n === undefined || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function win(label, usedPercent, resetsAt) {
  const c = clampUsed(usedPercent);
  if (!c) return null;
  return {
    label,
    usedPercent: c.value,
    outOfRange: c.outOfRange,
    rawPercent: c.outOfRange ? c.raw : undefined,
    resetsAt: toIso(resetsAt) ?? null,
  };
}

function money(amount, currency, symbol) {
  if (amount === undefined) return null;
  const s = symbol ?? (currency === "CNY" ? "¥" : "$");
  return { amount, currency, display: `${s}${amount.toFixed(2)}` };
}

/** 双语备注片段，交给客户端按语言选。 */
function note(zh, en) {
  return { zh, en };
}

// ============================================================
// 解析器：format → (body) => { windows, balance, detail } | null
// ============================================================

const PARSERS = {
  /** DeepSeek: { balance_infos:[{ currency, total_balance }] } */
  "deepseek-balance"(body) {
    const infos = body && body.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0) return null;
    const pick = infos.find((b) => b && b.currency === "CNY") ?? infos[0];
    const amount = num(pick && pick.total_balance);
    if (amount === undefined) return null;
    return { balance: money(amount, pick.currency), detail: { source: "api.deepseek.com" } };
  },

  /**
   * Moonshot / Kimi 余额。
   *
   * 字段名有两个来源，都要认：
   *   · 官方文档（platform.kimi.ai/docs/api/balance）写的是 available_balance
   *   · 社区成熟插件 dsh-quota 用的是 total_balance
   * 二者可能是同一接口不同时期的名字。取先拿到的那个，
   * 只认一个会在接口改名时静默失效。
   */
  "moonshot-balance"(body) {
    const d = (body && body.data) || {};
    const avail = num(d.available_balance) ?? num(d.total_balance);
    if (avail === undefined) return null;
    const parts = [];
    const voucher = num(d.voucher_balance);
    const cash = num(d.cash_balance);
    if (voucher !== undefined) parts.push(note(`赠金 ${voucher.toFixed(2)}`, `voucher ${voucher.toFixed(2)}`));
    if (cash !== undefined) parts.push(note(`现金 ${cash.toFixed(2)}`, `cash ${cash.toFixed(2)}`));
    return { balance: money(avail, "USD"), detail: { source: "moonshot", noteParts: parts } };
  },

  /** Kimi Code 套餐用量 */
  "kimi-coding"(body) {
    const u = (body && (body.usage || body.data)) || body || {};
    const windows = [];
    const five = u.five_hour ?? u.fiveHour ?? u.rolling;
    const week = u.weekly ?? u.week;
    if (five) windows.push(win("5h", five.used_percent ?? five.percent, five.resets_at ?? five.resetTime));
    if (week) windows.push(win("本周", week.used_percent ?? week.percent, week.resets_at ?? week.resetTime));
    const clean = windows.filter(Boolean);
    if (clean.length === 0) return null;
    const level = body && body.user && body.user.membership && body.user.membership.level;
    return {
      windows: clean,
      detail: { source: "api.kimi.com", note: level ? note(`会员 ${level}`, `plan ${level}`) : null },
    };
  },

  /**
   * 智谱 GLM Coding Plan
   * unit: 3=小时 4=天 5=月 6=周（来自官方插件源码）
   * 新旧账号 type 不同（CREDIT_LIMIT / TOKENS_LIMIT），两个都要认，
   * 只认一个会让一半用户看不到数。
   */
  "zai-coding"(body) {
    const limits = body && body.data && body.data.limits;
    if (!Array.isArray(limits)) return null;
    const windows = [];
    for (const lim of limits) {
      if (!lim || (lim.type !== "CREDIT_LIMIT" && lim.type !== "TOKENS_LIMIT")) continue;
      let label = null;
      if (lim.unit === 3) label = lim.number === 5 ? "5h" : `${lim.number}h`;
      else if (lim.unit === 4) label = `${lim.number || 1}天`;
      else if (lim.unit === 6) label = lim.number === 1 ? "本周" : `${lim.number}周`;
      else if (lim.unit === 5) label = "本月";
      if (!label) continue;
      const w = win(label, lim.percentage, lim.nextResetTime);
      if (w) windows.push(w);
    }
    if (windows.length === 0) return null;
    const level = body.data.level;
    return {
      windows,
      detail: {
        source: "bigmodel.cn",
        note: level ? note(`套餐档位 ${level}`, `plan ${level}`) : null,
        // 非官方文档接口，界面上要能看出这个来源的性质
        unofficial: true,
      },
    };
  },

  /** OpenRouter: { data:{ total_credits, total_usage } } */
  "openrouter-credits"(body) {
    const d = (body && body.data) || {};
    const total = num(d.total_credits);
    if (total === undefined) return null;
    const used = num(d.total_usage);
    const remain = used === undefined ? total : total - used;
    return {
      balance: money(remain, "USD"),
      detail: {
        source: "openrouter.ai",
        note:
          used === undefined
            ? null
            : note(`已用 $${used.toFixed(2)} / 总额度 $${total.toFixed(2)}`, `used $${used.toFixed(2)} of $${total.toFixed(2)}`),
      },
    };
  },

  /**
   * 硅基流动余额。
   * 社区插件用 data.balance，另一些实现用 data.totalBalance —— 两个都认。
   */
  "siliconflow-balance"(body) {
    const d = (body && body.data) || {};
    const amount = num(d.balance) ?? num(d.totalBalance);
    if (amount === undefined) return null;
    const charge = num(d.chargeBalance);
    return {
      balance: money(amount, "CNY"),
      detail: {
        source: "siliconflow",
        note: charge === undefined ? null : note(`含充值余额 ¥${charge.toFixed(2)}`, `incl. top-up ¥${charge.toFixed(2)}`),
      },
    };
  },

  /** MiniMax Token Plan —— 结构未经真实数据核实 */
  "minimax-remains"(body) {
    if (!body || typeof body !== "object") return null;
    const br = body.base_resp;
    if (br && br.status_code !== 0) return null;
    const raw = body.remains ?? body.data ?? body.plan ?? [];
    const list = Array.isArray(raw) ? raw : [raw];
    const windows = [];
    for (const it of list) {
      if (!it || typeof it !== "object") continue;
      const label = String(it.model_name ?? it.name ?? it.plan ?? "额度");
      const w = win(label, it.used_percent ?? it.percent, it.end_time ?? it.expired_time);
      if (w) windows.push(w);
    }
    if (windows.length === 0) return null;
    return { windows, detail: { source: "minimax", unverified: true } };
  },

  /** 阶跃星辰 —— 结构未经真实数据核实 */
  "stepfun-accounts"(body) {
    const d = (body && body.data) || body;
    const amount = num(d && d.balance) ?? num(d && d.available_balance);
    if (amount === undefined) return null;
    return { balance: money(amount, "CNY"), detail: { source: "stepfun", unverified: true } };
  },

  /** OpenCode Go（Zen）: { usage:{ rolling, weekly, monthly } } */
  "opencode-usage"(body) {
    const u = (body && body.usage) || body;
    if (!u || typeof u !== "object") return null;
    const windows = [];
    for (const [k, label] of [
      ["rolling", "5h"],
      ["weekly", "本周"],
      ["monthly", "本月"],
    ]) {
      const w = u[k];
      if (!w || typeof w !== "object") continue;
      if (w.status && w.status !== "ok") continue;
      const parsed = win(label, w.percent, w.resetsAt);
      if (parsed) windows.push(parsed);
    }
    if (windows.length === 0) return null;
    return { windows, detail: { source: "opencode.ai" } };
  },
};

/** 面板里给「用户自定义通路」选的解析格式。 */
export const CUSTOM_FORMATS = [
  "deepseek-balance",
  "moonshot-balance",
  "siliconflow-balance",
  "openrouter-credits",
  "stepfun-accounts",
  "zai-coding",
  "opencode-usage",
];

// ============================================================
// 通路表
// ============================================================

const UA = "dsh-quota-radar/0.2";

/**
 * 内置通路。全部只请求厂商官方公网域名，不依赖任何本机服务。
 * 每条都实测过端点存在（假密钥探测，除 xai 外无 404）。
 */
export const CATALOG = [
  {
    id: "deepseek",
    label: "DeepSeek",
    providers: ["deepseek", "deepseek-official", "deepseek-account"],
    keyRefs: ["DEEPSEEK_API_KEY"],
    endpoint: "https://api.deepseek.com/user/balance",
    format: "deepseek-balance",
  },
  {
    id: "moonshot",
    label: "Kimi",
    providers: ["moonshot", "kimi", "moonshot-ai"],
    keyRefs: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    // 国内站优先；失败回退海外站（账号不互通，接口同构）
    endpoint: "https://api.moonshot.cn/v1/users/me/balance",
    endpointFallbacks: ["https://api.moonshot.ai/v1/users/me/balance"],
    format: "moonshot-balance",
  },
  {
    id: "kimi-coding",
    label: "Kimi Code",
    providers: ["kimi-coding", "kimi-code"],
    keyRefs: ["KIMI_CODING_API_KEY", "KIMI_API_KEY"],
    endpoint: "https://api.kimi.com/coding/v1/usages",
    format: "kimi-coding",
  },
  {
    id: "zhipu",
    label: "GLM",
    providers: ["zhipu", "glm", "bigmodel", "zai", "z-ai", "glm-coding"],
    keyRefs: ["ZHIPU_API_KEY", "ZAI_API_KEY", "BIGMODEL_API_KEY", "GLM_API_KEY", "ZAI_CODING_CN_API_KEY"],
    endpoint: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    endpointFallbacks: ["https://api.z.ai/api/monitor/usage/quota/limit"],
    format: "zai-coding",
    // 官方无文档，社区两派都能跑通：先裸 key，401 再回退 Bearer
    auth: "raw",
    authFallback: "bearer",
    headers: { "Accept-Language": "zh-CN,zh" },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    providers: ["openrouter", "open-router"],
    // 官方 credits 接口要 Management Key，不是推理 Key
    keyRefs: ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_API_KEY"],
    endpoint: "https://openrouter.ai/api/v1/credits",
    format: "openrouter-credits",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    providers: ["siliconflow", "silicon-flow"],
    keyRefs: ["SILICONFLOW_API_KEY"],
    endpoint: "https://api.siliconflow.cn/v1/user/info",
    endpointFallbacks: ["https://api.siliconflow.com/v1/user/info"],
    format: "siliconflow-balance",
    // 实测：成功码是 20000，失败码 30014（不是 200/0）
    okCodes: [20000],
  },
  {
    id: "minimax",
    label: "MiniMax",
    providers: ["minimax"],
    keyRefs: ["MINIMAX_API_KEY"],
    endpoint: "https://api.minimaxi.com/v1/token_plan/remains",
    format: "minimax-remains",
  },
  {
    id: "stepfun",
    label: "阶跃星辰",
    providers: ["stepfun", "step"],
    keyRefs: ["STEPFUN_API_KEY", "STEP_API_KEY"],
    endpoint: "https://api.stepfun.com/v1/accounts",
    format: "stepfun-accounts",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    providers: ["opencode-go", "opencode", "opencode-zen"],
    keyRefs: ["OPENCODE_GO_API_KEY"],
    // 公网地址，不需要本机跑代理
    endpoint: "https://opencode.ai/zen/go/v1/usage",
    format: "opencode-usage",
  },
];

// ============================================================
// 生成适配器
// ============================================================

/** 把一条通路变成 host 认得的适配器对象。 */
export function makeAdapter(entry) {
  const urls = [entry.endpoint, ...(entry.endpointFallbacks ?? [])];
  return {
    id: entry.id,
    label: entry.label,
    providers: entry.providers,
    credentialRefs: entry.keyRefs,
    unverified: entry.unverified === true,
    async fetch(ctx, deps = {}) {
      const key = await deps.resolveKey?.(ctx, entry.keyRefs);
      if (key === deps.CREDENTIALS_UNAVAILABLE) {
        return deps.stateBad(entry.id, entry.label, "error", "凭据服务尚未就绪，稍后自动重试");
      }
      if (!key) {
        return deps.stateBad(entry.id, entry.label, "unconfigured", `未配置 ${entry.keyRefs[0]}`);
      }

      const parser = PARSERS[entry.format];
      if (!parser) {
        return deps.stateBad(entry.id, entry.label, "error", `未知解析格式 ${entry.format}`);
      }

      // 认证头候选：裸 key 优先的用 raw，其余用 bearer
      const authModes = entry.auth === "raw" ? ["raw", "bearer"] : ["bearer"];

      let lastErr = null;
      for (const url of urls) {
        for (const mode of authModes) {
          try {
            const headers = {
              ...(entry.headers ?? {}),
              ...(mode === "raw" ? { Authorization: key } : { Authorization: `Bearer ${key}` }),
            };
            if (entry.format === "kimi-coding") headers["User-Agent"] = UA;
            const body = await deps.getJson(url, headers, deps.signal);

            // 业务错误码可能藏在 HTTP 200 里。**各家成功码不统一**：
            //   智谱 200、硅基流动 20000、多数 OpenAI 兼容网关 0
            // 所以按通路显式声明，而不是猜一个「不是 200 就是错」的规则——
            // 那样会把硅基流动的成功响应当成失败。
            const okCodes = entry.okCodes ?? [200, 0];
            if (body && typeof body.code === "number" && !okCodes.includes(body.code)) {
              const authCodes = entry.authErrorCodes ?? [401, 403];
              if (authCodes.includes(body.code)) {
                lastErr = "API Key 无效或无权限";
                continue; // 换下一种认证方式
              }
              if (body.code === 500) {
                return deps.stateBad(entry.id, entry.label, "unconfigured", "该 API Key 没有生效中的套餐");
              }
              lastErr = `接口返回 code ${body.code}`;
              continue;
            }

            const parsed = parser(body);
            if (!parsed) {
              lastErr = "接口返回结构异常";
              continue;
            }
            const detail = parsed.detail ?? {};
            return deps.stateOk(entry.id, entry.label, {
              windows: parsed.windows ?? [],
              balance: parsed.balance ?? null,
              detail: {
                ...detail,
                unverified: entry.unverified === true || detail.unverified === true,
              },
            });
          } catch (e) {
            lastErr = (e && e.message) || "请求失败";
          }
        }
      }
      return deps.stateBad(entry.id, entry.label, "error", lastErr || "查询失败");
    },
  };
}

export const PUBLIC_ADAPTERS = CATALOG.map(makeAdapter);

/** 解析器导出，便于单测直接打。 */
export const _internals = { PARSERS, clampUsed, toIso, num };
