// dsh/client.js — 模型余额雷达 · Client 半边
//
// 责任：在对话框下方的 `conversation.composer.dock` 槽注册一行读数
//       （与宿主「缓存命中 / Token 速度」那组指标并排），
//       把已接入服务的额度全部显示出来，并高亮当前会话选中的那个；
//       没有额度接口的服务显示「暂不提供额度」，绝不拿别家数字顶替。
//
// 为什么不在 `conversation.input.left`：那个位置要跟模型选择器抢横向宽度，
// 怎么压都会把模型名挤出去。dock 是宿主自己放状态信息的地方，空间宽裕。
//
// 审计修复记录（2026-10-01 第二轮）：
//   1. 卸载/关闭时真正中止在途请求 —— 上一版 AbortController 建在函数内部，
//      cleanup 根本拿不到它，请求只能等超时。
//   2. 补上「所有已接入 provider 的总览」——点开即可看到全部，不再只有一行。
//   3. 已接入但没有额度接口的服务（如 agnes）显示「暂不提供额度」，
//      而不是整行消失、让人以为插件没工作。
//   4. 账号归属提醒、数据不完整提醒真正渲染出来 —— 上一版只写在数据里，
//      界面从来没显示过。
//   5. 陈旧数据（stale）与「部分账号未统计」（partial）都有可见标记。
//
// 形态：手写 lazy-CJS bundle（window.__ModuleLoader__.load + factory(require)），
//       与 DSH 内置插件同一形态，无构建步骤。

window.__ModuleLoader__.load({
  id: "dsh-quota-radar",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    const REFRESH_INTERVAL_MS = 60_000;
    const CLIENT_TIMEOUT_MS = 10_000;

    /**
     * 与宿主「缓存命中 / Token 速度 / 上下文」那组指标完全一致的排版。
     *
     * 这些值不是猜的，是从宿主 chat 包里的 StatsPills 样式抄出来的：
     *   font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)
     *   line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))
     *   gap: 6px; padding: 1px 8px; border-radius: 999px
     *
     * 用同一组 CSS 变量，这样用户调界面字号时两边一起变，
     * 不会出现「插件一行大、旁边一行小」的割裂感。写死 px 就会那样。
     */
    const PILL_ROOT_STYLE = {
      boxSizing: "border-box",
      minWidth: 0,
      maxWidth: "100%",
      fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
      lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
      display: "flex",
      alignItems: "center",
      gap: 12,
    };

    const PILL_STYLE = {
      boxSizing: "border-box",
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "1px 8px",
      maxWidth: "100%",
      borderRadius: 999,
      font: "inherit",
      fontVariantNumeric: "tabular-nums",
      lineHeight: "inherit",
      whiteSpace: "nowrap",
      background: "none",
      border: "none",
      // 这里刻意不设 color。
      //
      // 曾经写过 color: var(--dsw-alias-label-tertiary)，但两处调用点都是
      // 「...PILL_STYLE 之后再显式给 color」，那行从来没生效过——是死代码，
      // 还让变异测试误判成「改了颜色却没影响」。
      // 颜色统一由 READOUT_COLOR / TONE_COLOR 决定（见下方注释）。
    };

    // ── 中英双语 ──────────────────────────────────────────────
    //
    // 为什么内联而不是 import：client 半边是 lazy-CJS 单文件，
    // 相对 require 在浏览器加载器里行为不确定。词典只有几十条，
    // 内联最稳，也避免多一份文件产生漂移。
    //
    // 语言来源顺序：宿主 locale 服务 → 浏览器 navigator.language → 中文。
    const DICT = {
      zh: {
        "mark.partial": "部分",
        "mark.staleTip": "（数据可能过期）",
        "mark.partialTip": "（部分账号未纳入统计）",
        "window.remaining": "{label} 剩余 {p}%",
        "reset.soon": " · 即将重置",
        "reset.days": " · {n}d 后重置",
        "reset.hours": " · {h}h{m}m 后重置",
        "reset.minutes": " · {n}m 后重置",
        "status.unconfigured": "未配置",
        "status.unsupported": "该网关不提供额度接口",
        "status.error": "读取失败",
        "status.noData": "无数据",
        "unit.credits": " 积分",
        "panel.expand": "查看全部 {n} 项",
        "panel.collapse": "收起",
        "panel.unsupported": "暂不提供额度",
        "panel.unsupportedTip": "该服务已接入，但插件没有它的额度接口。",
        "panel.label": "余额雷达",
      },
      en: {
        "mark.partial": "partial",
        "mark.staleTip": " (may be stale)",
        "mark.partialTip": " (some accounts excluded)",
        "window.remaining": "{label} {p}% left",
        "reset.soon": " · resetting soon",
        "reset.days": " · resets in {n}d",
        "reset.hours": " · resets in {h}h{m}m",
        "reset.minutes": " · resets in {n}m",
        "status.unconfigured": "Not configured",
        "status.unsupported": "No quota API for this gateway",
        "status.error": "Read failed",
        "status.noData": "No data",
        "unit.credits": " credits",
        "panel.expand": "Show all {n}",
        "panel.collapse": "Collapse",
        "panel.unsupported": "Quota unavailable",
        "panel.unsupportedTip": "This service is connected, but the plugin has no quota API for it.",
        "panel.label": "Quota Radar",
      },
    };

    let currentLang = null;

    /**
     * 语言判定。
     *
     * 顺序很重要：**必须先看宿主自己的语言设置**。
     * DSH 把当前语言写在 document.documentElement.lang 上
     * （宿主源码 syncDocumentLanguage：snapshot.active === "zh" ? "zh-CN" : active）。
     *
     * 曾经只用 navigator.language，结果系统语言是英文、DSH 界面是中文的用户
     * 会看到整个插件变成英文——界面里唯一一块非中文，非常突兀。
     */
    function detectLang() {
      if (currentLang) return currentLang;
      // 1) 宿主页面语言（最权威）
      try {
        if (typeof document !== "undefined" && document.documentElement) {
          const htmlLang = String(document.documentElement.lang || "").toLowerCase();
          if (htmlLang) return htmlLang.startsWith("zh") ? "zh" : "en";
        }
      } catch {
        // document 不可用
      }
      // 2) 浏览器语言（兜底）
      try {
        if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
          return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
      } catch {
        // navigator 不可用
      }
      // 3) 都没有 → 中文（本插件以中文为主）
      return "zh";
    }

    /** 取词并插值。缺词回退中文，再缺就返回 key 本身（便于发现漏翻）。 */
    function t(key, params) {
      const lang = detectLang();
      const table = DICT[lang] || DICT.zh;
      let text = table[key] ?? DICT.zh[key] ?? key;
      if (params) {
        for (const k of Object.keys(params)) text = text.split(`{${k}}`).join(String(params[k]));
      }
      return text;
    }

    /** 窗口标签本地化。host 给的是中文短标签，英文界面要换掉。 */
    function shortLabel(label) {
      if (!label) return "";
      const base = String(label)
        .replace(/[（(][^）)]*[）)]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (detectLang() === "en") {
        return base
          .replace("最紧月度包", "Tightest monthly")
          .replace("本周", "Week")
          .replace("本月", "Month")
          .replace("月包", "Monthly");
      }
      return base.replace("最紧月度包", "月包").replace("本周", "周").replace("本月", "月");
    }

    /** 当前模型的 route → 提供额度的适配器 id。host 已按实际接入过滤过。 */
    function providerOfRoute(route, providers) {
      if (!route) return null;
      for (const p of providers) {
        if (p.provider === route) return p.provider;
        if (Array.isArray(p.routes) && p.routes.includes(route)) return p.provider;
      }
      return null;
    }

    /**
     * 展开总览里的固定显示顺序（用户指定）：
     *   官方账号 → OpenCode → OpenCodex → WorkBuddy 国内版 → 国际版 → Ark
     *
     * 不在这份名单里的排到最后，并保持 host 返回的相对顺序。
     * 顺序只影响展示，不影响取数与高亮。
     */
    const PANEL_ORDER = [
      "deepseek", // DSH 官方账号
      "opencode-go", // OpenCode（Go / Zen）
      "opencodex", // OpenAI Codex
      "workbuddy", // WorkBuddy 国内版
      "workbuddy-global", // WorkBuddy 国际版
      "ark", // 火山方舟 Ark
      "woyaopro", // 第三方中转站（WoYaoPro）
      "factory", // Factory（Droid）
    ];

    function orderedForPanel(providers) {
      const rankOf = (p) => {
        const i = PANEL_ORDER.indexOf(p.provider);
        return i === -1 ? PANEL_ORDER.length : i;
      };
      return (
        providers
          .map((p, i) => ({ p, i }))
          // 显式带原始下标兜底，same rank 时保持 host 给的顺序，
          // 不依赖 Array.prototype.sort 的稳定性
          .sort((a, b) => rankOf(a.p) - rankOf(b.p) || a.i - b.i)
          .map((x) => x.p)
      );
    }

    /** 请求快照。signal 由调用方持有，这样组件卸载时才能真正中止。 */
    async function fetchSnapshot(signal) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const res = await fetch("/quota-radar/snapshot", {
          method: "GET",
          headers: { accept: "application/json", "x-quota-radar": "1" },
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }

    function remainOf(w) {
      if (!w || typeof w.usedPercent !== "number") return null;
      return Math.round(100 - w.usedPercent);
    }

    function windowText(w) {
      const remain = remainOf(w);
      if (remain === null) return null;
      const marks = [];
      if (w.outOfRange) marks.push("⚠");
      if (w.partial) marks.push(t("mark.partial"));
      return t("window.remaining", { label: shortLabel(w.label), p: remain }) + marks.join("");
    }

    function resetText(iso) {
      if (!iso) return "";
      // 变量名不能叫 t —— 会把外层的 i18n 取词函数 t() 覆盖掉，
      // 后面 t("reset.soon") 就会抛 "t is not a function"，
      // 整个组件崩掉、读数整行消失。曾真实发生过。
      const parsed = Date.parse(iso);
      if (isNaN(parsed)) return "";
      const ms = parsed - Date.now();
      if (ms <= 0) return t("reset.soon");
      const min = Math.floor(ms / 60000);
      const h = Math.floor(min / 60);
      if (h >= 24) return t("reset.days", { n: Math.floor(h / 24) });
      if (h > 0) return t("reset.hours", { h, m: min % 60 });
      return t("reset.minutes", { n: min });
    }

    /**
     * 用量语气。仍在算，但**不再用颜色表达**。
     *
     * 曾经按用量变色（≥75% 金、≥90% 红）。实际效果：Ark 月度刚到 75.3%、
     * OpenCodex 也过线，于是这两个是金色，而 DeepSeek / WorkBuddy 只出余额
     * 没有窗口、算作 ok 是灰色——同一行里两种颜色，跟宿主统计条的观感不统一。
     *
     * 现在统一灰色。用量告警不丢：危险/警告写进 hover 详情（见 titleOf），
     * 只是不再用颜色喊。想恢复配色，只改 TONE_COLOR 一个对象。
     */
    function toneOf(state) {
      if (!state) return "muted";
      if (state.status !== "ok") return "warn";
      const worst = state.windows.reduce((m, w) => Math.max(m, w.usedPercent ?? 0), 0);
      if (worst >= 90) return "danger";
      if (worst >= 75) return "warn";
      return "ok";
    }

    // 统一灰色，跟宿主的统计条保持一致。
    //
    // 用宿主的 --dsw-alias-* 而不是自己写死颜色：这套变量每个都有亮/暗两套值
    // （label-secondary 亮色 #61666b、暗色 #cfd3d6），主题切换由宿主负责。
    //
    // 这里曾经写的是 `var(--dsh-text-muted, #888)`——而 --dsh-text-muted 在宿主里
    // 根本不存在，于是永远走 #888 兜底；后来改成 label-tertiary，但那一档
    // 亮色下只有 3.7:1 对比度，仍然偏浅。现在用 secondary（5.8:1）。
    const READOUT_COLOR = "var(--dsw-alias-label-secondary)";
    const TONE_COLOR = {
      ok: READOUT_COLOR,
      muted: READOUT_COLOR,
      warn: READOUT_COLOR,
      danger: READOUT_COLOR,
    };

    const STATUS_TEXT = {
      get unconfigured() { return t("status.unconfigured"); },
      get unsupported() { return t("status.unsupported"); },
      get error() { return t("status.error"); },
    };

    /**
     * 行内主文案。
     *
     * 挪到 dock 之后横向空间宽裕了，所以这里重新把「全部窗口」铺开显示，
     * 不再只留最吃紧的一个——这正是用户要的「显示全一点」。
     * 名字仍然走 shortLabel 压缩，避免个别上游的长标签占太多地方。
     */
    function summaryOf(state) {
      if (!state) return "";
      if (state.status !== "ok") return STATUS_TEXT[state.status] ?? t("status.error");
      if (state.balance && state.balance.display) {
        const unit = state.balance.currency === "积分" ? t("unit.credits") : "";
        return `${state.balance.display}${unit}`;
      }
      if (state.windows.length === 0) return t("status.noData");
      const shown = state.windows.map(windowText).filter(Boolean);
      const last = state.windows[state.windows.length - 1];
      // 保留最近的重置时间，其余窗口的重置信息在 hover 里
      return shown.join(" · ") + resetText(last && last.resetsAt);
    }

    /**
     * 展开面板里用完整文案（面板有足够横向空间，不用压缩）。
     * 与 summaryOf 的区别：summaryOf 是默认那一行用的短文案。
     */
    function panelSummaryOf(state) {
      if (!state) return "";
      if (state.status !== "ok") return STATUS_TEXT[state.status] ?? t("status.error");
      if (state.balance && state.balance.display) {
        const unit = state.balance.currency === "积分" ? t("unit.credits") : "";
        return `${state.balance.display}${unit}`;
      }
      if (state.windows.length === 0) return t("status.noData");
      const shown = state.windows.slice(0, 3).map(windowText).filter(Boolean);
      const last = state.windows[state.windows.length - 1];
      return shown.join(" · ") + resetText(last && last.resetsAt);
    }

    /** hover 详情：把来源、单位、账号归属、数据完整性都说清楚。 */
    function titleOf(state) {
      const stale = state.stale ? t("mark.staleTip") : "";
      const lines = [`${state.label} · ${state.status}${stale}`];
      if (state.message) lines.push(`原因：${state.message}`);
      for (const w of state.windows) {
        const bits = [`${w.label}: 已用 ${w.usedPercent}%`];
        if (w.outOfRange) bits.push(`（原始值 ${w.rawPercent}% 越界，已截断显示）`);
        if (w.partial) bits.push(t("mark.partialTip"));
        lines.push(bits.join("") + resetText(w.resetsAt));
      }
      if (state.balance) lines.push(`余额：${state.balance.display}`);
      const d = state.detail ?? {};
      // 适配器给的说明。双语对象按当前语言取词。
      //
      // 这段曾经只认 unitNote/partialNote 那几个字段，而各通路大量产出的
      // 是 note / noteParts —— 结果 Kimi、OpenRouter、中转站的
      // 「已用 / 总额度」这类说明生成了却永远不显示。三种写法都要认。
      const sayNote = (n) => {
        if (!n) return null;
        if (typeof n === "string") return n;
        return n[currentLang] ?? n.zh ?? n.en ?? null;
      };
      for (const n of Array.isArray(d.noteParts) ? d.noteParts : []) {
        const txt = sayNote(n);
        if (txt) lines.push(`说明：${txt}`);
      }
      const single = sayNote(d.note);
      if (single) lines.push(`说明：${single}`);
      if (d.unitNote) lines.push(`说明：${d.unitNote}`);
      if (d.aggregationNote) lines.push(`说明：${d.aggregationNote}`);
      if (d.partialNote) lines.push(`注意：${d.partialNote}`);
      if (d.bindingNote) lines.push(`注意：${d.bindingNote}`);
      if (d.unverified) lines.push("注意：该接口未经真实凭据核实，数值可能不准");
      if (d.unofficial) lines.push("注意：非厂商官方文档接口");
      if (d.thirdParty) lines.push("注意：第三方中转站，非模型厂商官方接口");
      // 用量告警改用文字表达：颜色已统一成灰色（见 TONE_COLOR），
      // 但「快用完了」这件事不能因此消失。
      const tone = state.status === "ok" ? toneOf(state) : null;
      if (tone === "danger") lines.push("注意：有额度窗口已用超过 90%，可能即将耗尽");
      else if (tone === "warn") lines.push("提示：有额度窗口已用超过 75%");
      if (Array.isArray(state.routes) && state.routes.length > 0) {
        lines.push(`对应接入：${state.routes.join(", ")}`);
      }
      return lines.join("\n");
    }

    function Readout(props) {
      const [snap, setSnap] = React.useState(null);
      const [route, setRoute] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      // 点一下展开「全部服务」的总览。默认不展开，保持那一行够短。
      const [open, setOpen] = React.useState(false);
      const models = props.__models;
      const timer = props.__timer;
      // 组件最外层节点：用来判断一次点击是否落在组件之外
      const rootRef = React.useRef(null);

      // 点别处就收起面板 —— 不用再点回那一行字。
      //
      // · mousedown 而不是 click：click 要等 mouseup，拖选文字时会误触发；
      //   mousedown 在手按下的瞬间判定，更符合直觉。
      // · capture 阶段监听：宿主内部若有 stopPropagation，冒泡阶段收不到。
      // · Escape 也能关，键盘操作不用去够鼠标。
      React.useEffect(() => {
        if (!open) return undefined;
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
          return undefined;
        }
        const onDown = (ev) => {
          const root = rootRef.current;
          const target = ev && ev.target;
          // 点在组件内部（那一行字 + 面板本身）不算「别处」，
          // 否则点 header 会先被这里关掉、再被 onClick 打开，来回抖。
          if (root && target && typeof root.contains === "function" && root.contains(target)) return;
          setOpen(false);
        };
        const onKey = (ev) => {
          if (ev && (ev.key === "Escape" || ev.key === "Esc")) setOpen(false);
        };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
          document.removeEventListener("mousedown", onDown, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [open]);

      // 订阅当前会话的模型选择
      React.useEffect(() => {
        const sessionId = (props.session && props.session.sessionId) || props.sessionId || null;
        if (!models || !sessionId || typeof models.directoryFor !== "function") {
          setRoute(null);
          return undefined;
        }
        let directory;
        try {
          directory = models.directoryFor(sessionId);
        } catch {
          setRoute(null);
          return undefined;
        }
        if (!directory || !directory.store || typeof directory.store.subscribe !== "function") {
          setRoute(null);
          return undefined;
        }
        const read = () => {
          try {
            const s = directory.store.getSnapshot();
            setRoute((s && s.current && s.current.provider) || null);
          } catch {
            setRoute(null);
          }
        };
        read();
        const stop = directory.store.subscribe(read);
        return () => {
          try {
            stop();
          } catch {
            // 已解绑
          }
        };
      }, [models, props.session, props.sessionId]);

      // 定时拉取：单飞 + 卸载真正中止 + 页面隐藏时暂停
      React.useEffect(() => {
        if (!timer) return undefined;
        // controller 建在 effect 作用域里，cleanup 才拿得到它。
        // 上一版建在 fetchSnapshot 内部，组件卸载时无法中止，只能等超时。
        const controller = new AbortController();
        let loading = false;

        const load = async () => {
          if (controller.signal.aborted) return;
          if (loading) return; // 单飞：上一轮没回来就跳过
          if (typeof document !== "undefined" && document.hidden) return; // 不可见不拉
          loading = true;
          try {
            const data = await fetchSnapshot(controller.signal);
            if (controller.signal.aborted) return;
            setSnap(data);
            setFailed(false);
          } catch {
            if (!controller.signal.aborted) setFailed(true);
          } finally {
            loading = false;
          }
        };

        const onVisibility = () => {
          if (typeof document !== "undefined" && !document.hidden) load();
        };

        load();
        const dispose = timer.interval(load, REFRESH_INTERVAL_MS);
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

        return () => {
          controller.abort(); // 真正中止在途请求
          try {
            dispose();
          } catch {
            // 已释放
          }
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [timer]);

      // 失败 / 加载中：整行隐藏，不刷屏
      if (failed || !snap || !snap.ok || !Array.isArray(snap.providers)) return null;

      const list = snap.providers;
      const registered = Array.isArray(snap.registered) ? snap.registered : [];

      // 只显示「当前选中的那个模型」对应的服务，不做全量总览。
      // 这是用户明确要的：选哪个就显示哪个，别把一整排都摊出来。
      // 对不上就整行隐藏——绝不拿别家的数字顶替当前模型。
      if (!route || !registered.includes(route)) return null;
      const wanted = providerOfRoute(route, list);
      const state = wanted ? list.find((p) => p.provider === wanted) : null;

      // 选了某个服务，但插件没有它的额度接口 → 说清楚，而不是整行消失
      if (!state) {
        return React.createElement(
          "div",
          { style: PILL_ROOT_STYLE },
          React.createElement(
            "span",
            {
              title: `${route}\n该服务已接入，但插件没有它的额度接口。`,
              "data-qr-unsupported": route,
              style: { ...PILL_STYLE, color: TONE_COLOR.muted, cursor: "default", userSelect: "none" },
            },
            `${shortLabel(route)}：暂不提供额度`,
          ),
        );
      }

      const marks = [];
      if (state.stale) marks.push("⏱");
      if (state.detail && state.detail.partial) marks.push(t("mark.partial"));
      if (state.detail && state.detail.bindingNote) marks.push("?");

      const unadapted = Array.isArray(snap.unadapted) ? snap.unadapted : [];
      const others = list.filter((p) => p.provider !== state.provider);
      const moreCount = others.length + unadapted.length;

      // 默认只显示当前模型（够短）；点一下才展开全部服务的总览。
      const header = React.createElement(
        "button",
        {
          type: "button",
          onClick: () => setOpen((v) => !v),
          title:
            titleOf(state) +
            (moreCount > 0
              ? "\n\n" +
                (open
                  ? t("panel.collapse")
                  : t("panel.expand", { n: list.length + unadapted.length }))
              : ""),
          "data-qr-main": state.provider,
          "aria-expanded": open,
          style: {
            ...PILL_STYLE,
            color: TONE_COLOR[toneOf(state)],
            cursor: "pointer",
            userSelect: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        },
        React.createElement(
          "span",
          // 这里曾经有 opacity: 0.8。颜色已经是灰的，再压一层透明度会把
          // 亮色下的对比度从 3.7:1 拉到 2.9:1，等于自己把可读性抹掉。
          // 层次改由字重承担，不用透明度。
          { style: { fontWeight: 500, flexShrink: 0 } },
          shortLabel(state.label),
        ),
        React.createElement(
          "span",
          {
            style: {
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          },
          summaryOf(state),
        ),
        // 「部分」「⏱」这些是有信息量的文字，不是装饰，不压暗。
        marks.length > 0 ? React.createElement("span", { style: { flexShrink: 0 } }, marks.join("")) : null,
        // 展开箭头是装饰性提示，可以比正文淡一档，但不能淡到看不见。
        moreCount > 0
          ? React.createElement("span", { style: { opacity: 0.6, flexShrink: 0 } }, open ? "▴" : "▾")
          : null,
      );

      let panel = null;
      if (open) {
        const rows = [];
        // 按用户指定的固定顺序展示：官方 → OpenCode → OpenCodex →
        // WorkBuddy 国内 → 国际 → Ark → 其余
        for (const p of orderedForPanel(list)) {
          const isCurrent = p.provider === state.provider;
          rows.push(
            React.createElement(
              "div",
              {
                key: p.provider,
                title: titleOf(p),
                "data-qr-panel-row": p.provider,
                style: {
                  display: "flex",
                  gap: 8,
                  padding: "2px 8px",
                  // 面板同样跟随宿主注入的字号，不写死
                  font: "inherit",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  color: TONE_COLOR[toneOf(p)],
                  background: isCurrent ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
                },
              },
              React.createElement("span", { style: { minWidth: 88, fontWeight: isCurrent ? 600 : 500 } }, shortLabel(p.label)),
              // 数字不单独换个色阶。整块统一 label-secondary，层次靠字重，
              // 这样亮色下不会出现「一半深一半浅」的花脸读数。
              React.createElement("span", { style: { fontWeight: isCurrent ? 600 : 500 } }, panelSummaryOf(p)),
              p.stale ? React.createElement("span", { style: { opacity: 0.6 } }, "⏱") : null,
            ),
          );
        }
        for (const u of unadapted) {
          rows.push(
            React.createElement(
              "div",
              {
                key: `unadapted:${u}`,
                title: `${u}\n该服务已接入，但插件没有它的额度接口。`,
                "data-qr-panel-row": `unadapted:${u}`,
                style: {
                  display: "flex",
                  gap: 8,
                  padding: "2px 8px",
                  font: "inherit",
                  whiteSpace: "nowrap",
                  color: TONE_COLOR.muted,
                },
              },
              React.createElement("span", { style: { minWidth: 88 } }, u),
              React.createElement("span", null, t("panel.unsupported")),
            ),
          );
        }
        panel = React.createElement(
          "div",
          {
            "data-qr-panel": "1",
            style: {
              position: "absolute",
              // dock 在对话框下方，面板朝上弹，不会被输入框挡住
              bottom: "100%",
              left: 0,
              marginBottom: 4,
              minWidth: 260,
              maxHeight: 320,
              overflowY: "auto",
              padding: "4px 0",
              borderRadius: "var(--dsw-radius-lg, 8px)",
              // 照抄宿主自己弹层的写法（.xRgRca_card）：描边由 elevation 的
              // stroke 提供，这里再加 border 会在亮色下显出双线。
              border: 0,
              // 菜单底色自带毛玻璃，亮/暗各一套值，跟着主题走
              background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2))",
              backdropFilter: "var(--dsw-menu-backdrop-filter, none)",
              boxShadow: "var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,0.15))",
              // elevation 的描边颜色从这个局部变量读，宿主弹层也是这么注入的
              "--dsw-elevation-stroke-color": "var(--dsw-alias-border-l1)",
              zIndex: 50,
            },
          },
          rows,
        );
      }

      return React.createElement(
        "div",
        {
          ref: rootRef,
          style: open ? { ...PILL_ROOT_STYLE, position: "relative" } : PILL_ROOT_STYLE,
        },
        header,
        panel,
      );
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== "function") {
        ctx.logger?.warn?.("[quota-radar-client] slots 服务不可用");
        return;
      }
      const timer = ctx.timer;
      const models = ctx.modelDirectories;

      // 放在「对话框下方的 dock」而不是模型选择器左边。
      //
      // 为什么换位置：左边那块地方要跟模型名抢宽度，怎么压都显示不全。
      // dock 是宿主自己放状态信息的地方（自带一个 id:"stats" 的条目），
      // 横向空间宽松得多，不用再削字。
      // order 用 10，排在宿主那个 stats（order 0）后面。
      slots.inject("conversation.composer.dock", () =>
        slots.register(
          { name: "conversation.composer.dock", id: "quota-radar", order: 10, get label() { return t("panel.label"); } },
          (props) => React.createElement(Readout, { ...props, __timer: timer, __models: models }),
        ),
      );
    }

    exports.apply = apply;
    // 少写一个注入会导致 apply 永不执行（Cordis 的 inject 是硬门禁）
    exports.inject = ["slots", "timer", "modelDirectories"];
    exports.name = "dsh-quota-radar-client";

    return module.exports;
  },
});
