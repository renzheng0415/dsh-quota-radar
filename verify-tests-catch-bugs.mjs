// 测试有效性验证（变异测试）
//
// 为什么需要这个文件：
// 第一轮交付时 26 项测试全绿，但审计发现功能根本没修好。根因不是测试少，
// 而是测试**假通过**——比如「卸载会取消请求」那条，写成 `await pending` 之后
// 再断言，结果请求是被它自己的 12 秒超时中止的，测试照样通过（耗时 12014ms
// 却显示全绿）。
//
// 所以：一条测试只有在「把对应的 bug 注入回去时会失败」，才算真的有效。
// 这个脚本就是自动做这件事。
//
// 用法：node verify-tests-catch-bugs.mjs
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const root = path.dirname(new URL(import.meta.url).pathname);
const backupDir = path.join(root, ".mutation-backup");

const HOST = "dsh/index.js";
const CLIENT = "dsh/client.js";
const PUBLIC = "dsh/adapters-public.js";

/**
 * 每个变异体：把某个已修复的 bug 重新注入，然后跑指定测试。
 * 期望结果：该测试必须失败。若仍然通过，说明这条测试是假通过。
 */
const mutations = [
  {
    name: "Ark 不把取消信号传给 fetch",
    file: HOST,
    find: "    const body = await getJson(url, undefined, deps.signal);",
    replace: "const body = await getJson(ARK_BRIDGE);",
    testPattern: "Ark 适配器把 registry",
  },
  {
    name: "前端 cleanup 不中止在途请求",
    file: CLIENT,
    find: "            const data = await fetchSnapshot(controller.signal);",
    replace: "            const data = await fetchSnapshot(undefined);",
    testPattern: "前端组件卸载时真正中止",
  },
  {
    name: "强制刷新绕过失败退避",
    file: HOST,
    find: "    const effectiveForce = force && !inBackoff;",
    replace: "const effectiveForce = force;",
    testPattern: "失败退避期间",
  },
  {
    name: "WorkBuddy 百分比不走越界校验",
    file: HOST,
    find: "        const used = pct((1 - remain / size) * 100);",
    replace: "const used = { value: Math.round((1 - remain / size) * 1000) / 10, outOfRange: false, raw: 0 };",
    testPattern: "WorkBuddy 剩余量大于套餐总量",
  },
  {
    name: "路由清理挂到父 ctx（服务重载后残留）",
    file: HOST,
    find: '    const host = typeof scope.effect === "function" ? scope : ctx;',
    replace: "const host = ctx;",
    testPattern: "注入作用域销毁时路由随之释放",
  },
  {
    name: "路由不校验 Origin（跨源可读）",
    file: HOST,
    find: "      const origin = h.origin;",
    replace: "      const origin = undefined;",
    testPattern: "路由拒绝",
  },
  {
    name: "凭据解析没有期限（挂起会卡死整轮）",
    file: HOST,
    find: "        Promise.resolve().then(() => cred.resolve(ref)),\n        CREDENTIAL_TIMEOUT_MS,",
    replace: "        Promise.resolve().then(() => cred.resolve(ref)),\n        60 * 60 * 1000,",
    testPattern: "凭据解析挂起会被期限打断",
  },
  {
    name: "OpenCodex 忽略上游采样时间（旧数据冒充实时）",
    file: HOST,
    find: "      if (ageMs > UPSTREAM_STALE_MS) {",
    replace: "      if (false) {",
    testPattern: "OpenCodex 上游采样过旧",
  },
  {
    name: "OpenCodex 不标记聚合不完整",
    file: HOST,
    find: "      if (fivePartial || weekPartial) anyPartial = true;",
    replace: "      anyPartial = false;",
    testPattern: "OpenCodex 解析真实结构",
  },
  {
    name: "前端不渲染账号归属提醒",
    file: CLIENT,
    find: "      if (d.bindingNote) lines.push(`注意：${d.bindingNote}`);",
    replace: "",
    testPattern: "账号归属提醒真正渲染",
  },
  {
    name: "又变成摊开全部服务（用户明确不要）",
    file: CLIENT,
    find: "        header,\n        panel,\n      );",
    replace: '        list.map((p) => React.createElement("span", { key: p.provider, "data-qr-main": p.provider, style: PILL_STYLE }, p.label)),\n        panel,\n      );',
    testPattern: "只显示当前选中的那个模型",
  },
  {
    name: "点击不再展开全部服务",
    file: CLIENT,
    find: "          onClick: () => setOpen((v) => !v),",
    replace: "          onClick: () => {},",
    testPattern: "按用户指定的固定顺序排列",
  },
  {
    name: "总览顺序改回 host 原始顺序",
    file: CLIENT,
    find: "        for (const p of orderedForPanel(list)) {",
    replace: "        for (const p of list) {",
    testPattern: "按用户指定的固定顺序排列",
  },
  {
    name: "鼠标又变回问号（cursor:help）",
    file: CLIENT,
    find: '            cursor: "pointer",',
    replace: '            cursor: "help",',
    testPattern: "悬停不会变成问号鼠标",
  },
  {
    name: "切换模型时读数不跟着切换（锁死 Ark）",
    file: CLIENT,
    find: "      const wanted = providerOfRoute(route, list);",
    replace: '      const wanted = providerOfRoute("ark", list);',
    testPattern: "切换模型时读数跟着切换",
  },
  {
    name: "已接入但无额度接口时整行消失",
    file: CLIENT,
    find: '              "data-qr-unsupported": route,',
    replace: '            "data-qr-unsupported-disabled": route,',
    testPattern: "前端在已接入但无额度接口时",
  },
  {
    name: "快照不跟随 provider 改名",
    file: HOST,
    find: "      out.push(c.state.routes === routes ? c.state : { ...c.state, routes });",
    replace: "      out.push(c.state);",
    testPattern: "provider 改名后",
  },
  {
    name: "错误脱敏不处理 bearer",
    file: HOST,
    find: '  s = s.replace(/\\b(bearer)\\s+[A-Za-z0-9._\\-]{6,}/gi, "$1 [已隐藏]");',
    replace: "",
    testPattern: "错误脱敏",
  },
  {
    name: "响应体不设上限（全读进内存）",
    file: HOST,
    find: "      if (bytes + value.byteLength > MAX_BODY_BYTES) {",
    replace: "      if (false) {",
    testPattern: "响应体超限时",
  },
  {
    name: "字号写死成 px（不再跟随宿主变量）",
    file: CLIENT,
    find: '      fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",',
    replace: '      fontSize: "11px",',
    testPattern: "字号与宿主",
  },
  {
    name: "行高写死成 px（不再跟随宿主变量）",
    file: CLIENT,
    find: '      lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",',
    replace: '      lineHeight: "18px",',
    testPattern: "字号与宿主",
  },
  {
    name: "又注册回模型选择器左侧",
    file: CLIENT,
    find: '      slots.inject("conversation.composer.dock", () =>',
    replace: '      slots.inject("conversation.input.left", () =>',
    testPattern: "注册在对话框下方的 dock 插槽",
  },
  {
    name: "只显示最吃紧的一个窗口（又显示不全）",
    file: CLIENT,
    find: "      const shown = state.windows.map(windowText).filter(Boolean);",
    replace: "      const shown = state.windows.slice(0, 1).map(windowText).filter(Boolean);",
    testPattern: "全部窗口一次显示完",
  },
  {
    name: "凭据服务未就绪时误报「未配置」",
    file: PUBLIC,
    find: '      if (key === deps.CREDENTIALS_UNAVAILABLE) {\n        return deps.stateBad(entry.id, entry.label, "error", "凭据服务尚未就绪，稍后自动重试");\n      }',
    replace: "",
    testPattern: "凭据服务还没就绪时报",
  },
  {
    name: "配置态也吃指数退避（长期停在未配置）",
    file: HOST,
    find: "    const streak = succeeded || configState ? 0 : Math.min(prevStreak + 1, 32);\n    const ttl = succeeded ? CACHE_TTL_MS : configState ? CONFIG_RETRY_TTL_MS : computeBackoff(streak);",
    replace: "    const streak = succeeded ? 0 : Math.min(prevStreak + 1, 32);\n    const ttl = succeeded ? CACHE_TTL_MS : computeBackoff(streak);",
    testPattern: "「未配置」不会退避",
  },
  {
    name: "Moonshot 只认一个字段名（改名就静默失效）",
    file: PUBLIC,
    find: '    const avail = num(d.available_balance) ?? num(d.total_balance);',
    replace: '    const avail = num(d.available_balance);',
    testPattern: "字段名有两个来源时都认",
  },
  {
    name: "硅基流动只认一个字段名",
    file: PUBLIC,
    find: '    const amount = num(d.balance) ?? num(d.totalBalance);',
    replace: '    const amount = num(d.totalBalance);',
    testPattern: "字段名有两个来源时都认",
  },
  {
    name: "业务成功码写死成 200/0（硅基流动成功码 20000 会被误判失败）",
    file: PUBLIC,
    find: '            const okCodes = entry.okCodes ?? [200, 0];',
    replace: '            const okCodes = [200, 0];',
    testPattern: "硅基流动：解析 totalBalance",
  },
  {
    name: "通路表里混进本机地址（别人装了用不了）",
    file: PUBLIC,
    find: '    endpoint: "https://opencode.ai/zen/go/v1/usage",',
    replace: '    endpoint: "http://127.0.0.1:18900/zen/go/v1/usage",',
    testPattern: "不含任何本机地址",
  },
  {
    name: "未核实的通路不标 unverified（假装可信）",
    file: PUBLIC,
    find: '                unverified: entry.unverified === true || detail.unverified === true,',
    replace: '                unverified: false,',
    testPattern: "未核实的通路必须带 unverified",
  },
  {
    name: "语言判定忽略宿主、只看浏览器（系统英文就变英文）",
    file: CLIENT,
    find: `      // 1) 宿主页面语言（最权威）
      try {
        if (typeof document !== "undefined" && document.documentElement) {
          const htmlLang = String(document.documentElement.lang || "").toLowerCase();
          if (htmlLang) return htmlLang.startsWith("zh") ? "zh" : "en";
        }
      } catch {
        // document 不可用
      }
`,
    replace: "",
    // ⚠️ pattern 当正则用。`+` 是量词，写成「系统英文 + DSH 中文」会
    // 匹配不到任何测试 → Node 回退跑整个文件 → 文件级测试永远通过，
    // 于是把有效的测试误报成「假通过」。用不含元字符的片段。
    testPattern: "宿主优先",
  },
  {
    name: "局部变量遮蔽 i18n 取词函数（组件会崩、整行消失）",
    file: CLIENT,
    find: '      const parsed = Date.parse(iso);\n      if (isNaN(parsed)) return "";\n      const ms = parsed - Date.now();',
    replace: '      const t = Date.parse(iso);\n      if (isNaN(t)) return "";\n      const ms = t - Date.now();',
    testPattern: "带重置时间的窗口不会让组件崩掉",
  },
  {
    name: "英文界面漏翻（中文词条直接漏给英文用户）",
    file: CLIENT,
    find: '        "panel.unsupported": "Quota unavailable",',
    replace: "",
    testPattern: "英文环境下界面全英文",
  },
  {
    name: "语言判定永远返回中文（英文用户看到中文）",
    file: CLIENT,
    // 直接打掉「浏览器语言」分支：宿主没标语言时会退回中文
    find: `      // 2) 浏览器语言（兜底）
      try {
        if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
          return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
      } catch {
        // navigator 不可用
      }
`,
    replace: "",
    testPattern: "宿主没给 lang 时才退回浏览器语言",
  },
  {
    name: "窗口标签不做英文本地化",
    file: CLIENT,
    find: '          .replace("本周", "Week")',
    replace: "",
    testPattern: "英文环境下界面全英文",
  },
  {
    name: "状态文案绕过词典直接用 host 中文原文",
    file: CLIENT,
    find: '      get unconfigured() { return t("status.unconfigured"); },',
    replace: '      unconfigured: "未配置",',
    testPattern: "英文界面的余额/凭据类提示",
  },
  {
    name: "Moonshot 不区分赠金与现金",
    file: PUBLIC,
    find: '    if (voucher !== undefined) parts.push(note(`赠金 ${voucher.toFixed(2)}`, `voucher ${voucher.toFixed(2)}`));',
    replace: "",
    testPattern: "解析 available_balance，并区分赠金与现金",
  },
  {
    name: "Moonshot 只试一个域名（国内挂了就没了）",
    file: PUBLIC,
    find: '    endpointFallbacks: ["https://api.moonshot.ai/v1/users/me/balance"],',
    replace: '',
    testPattern: "国内站失败时自动回退海外站",
  },
  {
    name: "智谱不认老账号的 TOKENS_LIMIT",
    file: PUBLIC,
    find: '      if (!lim || (lim.type !== "CREDIT_LIMIT" && lim.type !== "TOKENS_LIMIT")) continue;',
    replace: '      if (!lim || lim.type !== "CREDIT_LIMIT") continue;',
    testPattern: "老账号的 TOKENS_LIMIT 也要认",
  },
  {
    name: "智谱把无关 limit 类型也当成窗口",
    file: PUBLIC,
    find: '      if (!lim || (lim.type !== "CREDIT_LIMIT" && lim.type !== "TOKENS_LIMIT")) continue;',
    replace: '      if (!lim) continue;',
    testPattern: "忽略无关的 limit 类型",
  },
  {
    name: "智谱把「无套餐」当成故障而不是状态",
    file: PUBLIC,
    find: '                return deps.stateBad(entry.id, entry.label, "unconfigured", "该 API Key 没有生效中的套餐");',
    replace: '                return deps.stateBad(entry.id, entry.label, "error", "该 API Key 没有生效中的套餐");',
    testPattern: "code 500 表示 key 有效但无套餐",
  },
  {
    name: "智谱不做裸 key → Bearer 回退",
    file: PUBLIC,
    find: '      const authModes = entry.auth === "raw" ? ["raw", "bearer"] : ["bearer"];',
    replace: '      const authModes = ["bearer"];',
    testPattern: "裸 key 被拒后自动回退 Bearer",
  },
  {
    name: "智谱越界百分比静默裁剪（不标记）",
    file: PUBLIC,
    find: '  if (n > 100) return { value: 100, outOfRange: true, raw: n };',
    replace: '  if (n > 100) return { value: 100, outOfRange: false, raw: n };',
    testPattern: "越界百分比保留原值并标记",
  },
  {
    name: "OpenRouter 用总额度冒充余额",
    file: PUBLIC,
    find: '    const remain = used === undefined ? total : total - used;',
    replace: '    const remain = total;',
    testPattern: "余额 = 总额度 - 已用",
  },
  {
    name: "中转站把预充值额度当成时间窗",
    file: PUBLIC,
    find: '      balance: money(remaining, unit),\n      detail: { source: "relay", noteParts: parts },',
    replace:
      '      balance: money(remaining, unit),\n      windows: [win("总额度", 50)],\n      detail: { source: "relay", noteParts: parts },',
    testPattern: "解析预充值额度",
  },
  {
    name: "中转站端点覆盖被忽略（换网关失效）",
    file: PUBLIC,
    find: '      const override = deps.endpoints && deps.endpoints[entry.id];',
    replace: '      const override = null;',
    testPattern: "换网关不用改代码",
  },
  {
    name: "中转站不标来源性质（冒充厂商官方接口）",
    file: PUBLIC,
    find: '                thirdParty: entry.thirdParty === true || detail.thirdParty === true,',
    replace: '                thirdParty: false,',
    testPattern: "不冒充厂商官方接口",
  },
  {
    name: "tooltip 丢掉 noteParts（说明生成了却不显示）",
    file: CLIENT,
    find: '      for (const n of Array.isArray(d.noteParts) ? d.noteParts : []) {\n        const txt = sayNote(n);\n        if (txt) lines.push(`说明：${txt}`);\n      }\n',
    replace: "",
    testPattern: "noteParts 曾经全被丢弃",
  },
];

async function runPattern(pattern) {
  try {
    // 必须带超时：注入某些 bug（例如移除期限）会让测试挂死而不是失败。
    // 挂死如果不处理，整个变异测试就会永远卡住——那等于没有验证能力。
    // 这里把「超时」也视为「测试抓到了问题」。
    const { stdout, stderr } = await run(
      "node",
      ["--test", `--test-name-pattern=${pattern}`, "audit-regression.test.mjs"],
      { cwd: root, maxBuffer: 10 * 1024 * 1024, timeout: 120_000, killSignal: "SIGKILL" },
    );
    return { output: stdout + stderr, failed: false };
  } catch (error) {
    const timedOut = error.killed === true || error.signal === "SIGKILL";
    // ⚠️ 这里必须同时取 error.stdout 和 error.output。
    //
    // node:child_process 在「非零退出」时把子进程输出挂在 error.output 上，
    // 而 error.stdout 往往是空字符串。曾经只读 error.stdout，导致失败路径
    // 的 output 恒为空 → 解析不出 ℹ pass/ℹ fail → 计数是 undefined →
    // 掉进 WEAK 分支，把**本来有效的测试**误报成「假通过」。
    // 这个 bug 让 2 条语言判定的变异体长期显示假通过。
    const out = error.stdout ?? error.output?.[1] ?? "";
    const err = error.stderr ?? error.output?.[2] ?? "";
    return {
      output: out + err,
      failed: true,
      timedOut,
    };
  }
}

function parseCounts(output) {
  const pass = Number(/^ℹ pass (\d+)$/m.exec(output)?.[1] ?? 0);
  const fail = Number(/^ℹ fail (\d+)$/m.exec(output)?.[1] ?? 0);
  return { pass, fail };
}

await mkdir(backupDir, { recursive: true });

// 防并发：变异测试会临时改写源码，若同时有别的进程在读源码，
// 会把「注入 bug 的版本」当成真源码（本轮开发中真实踩过这个坑）。
const lockFile = path.join(backupDir, "RUNNING.lock");
try {
  await writeFile(lockFile, String(process.pid), { flag: "wx" });
} catch {
  console.error("❌ 已有一个变异测试在运行（存在 .mutation-backup/RUNNING.lock）。");
  console.error("   变异测试会临时改写源码，必须串行执行。");
  process.exit(1);
}
process.on("exit", () => {
  // exit 钩子里不能 await，必须用同步 API
  try {
    rmSync(lockFile, { force: true });
  } catch {
    /* 尽力而为 */
  }
});

await copyFile(path.join(root, HOST), path.join(backupDir, "index.js.bak"));
await copyFile(path.join(root, CLIENT), path.join(backupDir, "client.js.bak"));

const results = [];
try {
  for (const m of mutations) {
    const target = path.join(root, m.file);
    const original = await readFile(target, "utf8");

    // 必须「整行起始」匹配。
    //
    // 为什么：String.replace 是按子串匹配的，不看行边界。短片段会落在
    // 更长行的缩进中间，从而改到别的地方去。本轮真实踩过——`maxWidth: 148,`
    // 在 client.js 里有两处（缩进 12 和 14），12 空格的查找串匹配到了
    // 14 空格那行的尾部子串，结果改的是「暂不提供额度」那一处，
    // 主读数根本没被动，于是被测的变异体显示成「假通过」。
    const anchored = "\n" + m.find;
    const at = original.indexOf(anchored);
    if (at < 0) {
      results.push({
        ...m,
        status: "SKIP",
        note: "找不到该代码片段（要求整行起始匹配；可能是缩进变了或源码已变）",
      });
      continue;
    }
    if (original.indexOf(anchored, at + 1) >= 0) {
      results.push({
        ...m,
        status: "SKIP",
        note: "该片段在源码中出现多次，注入点不唯一，请加长匹配串",
      });
      continue;
    }

    // 替换时保留前导换行
    await writeFile(target, original.slice(0, at + 1) + m.replace + original.slice(at + 1 + m.find.length), "utf8");
    let outcome;
    try {
      outcome = await runPattern(m.testPattern);
    } finally {
      await writeFile(target, original, "utf8"); // 无论成败都还原
    }

    const { pass, fail } = parseCounts(outcome.output);
    if (outcome.timedOut) {
      results.push({ ...m, status: "OK", note: "注入后测试挂死（已超时终止）→ 测试有效" });
    } else if (fail > 0) {
      results.push({ ...m, status: "OK", note: `注入后 ${fail} 项失败 → 测试有效` });
    } else if (pass === 0 && fail === 0) {
      results.push({ ...m, status: "SKIP", note: "该模式没匹配到测试" });
    } else {
      results.push({ ...m, status: "WEAK", note: `注入后仍全绿（${pass} 项通过）→ 假通过` });
    }
  }
} finally {
  await copyFile(path.join(backupDir, "index.js.bak"), path.join(root, HOST));
  await copyFile(path.join(backupDir, "client.js.bak"), path.join(root, CLIENT));
}

console.log("\n变异测试结果：把已修复的 bug 注入回去，看对应测试是否会失败\n");
console.log("状态   测试是否有效  变异体");
console.log("─".repeat(78));
for (const r of results) {
  const mark = r.status === "OK" ? "✅ 有效" : r.status === "WEAK" ? "❌ 假通过" : "⚠️  跳过";
  console.log(`${r.status.padEnd(6)} ${mark.padEnd(12)} ${r.name}`);
  if (r.status !== "OK") console.log(`${" ".repeat(20)}└─ ${r.note}`);
}

const weak = results.filter((r) => r.status === "WEAK");
const ok = results.filter((r) => r.status === "OK");
const skipped = results.filter((r) => r.status === "SKIP");
console.log("─".repeat(78));
console.log(`有效 ${ok.length} · 假通过 ${weak.length} · 跳过 ${skipped.length} · 共 ${results.length}`);

if (weak.length > 0) {
  console.log("\n❌ 存在假通过的测试，必须修正后才算验证完成。");
  process.exitCode = 1;
} else if (skipped.length > 0) {
  console.log("\n⚠️  有变异体被跳过（源码片段已变），请核对。");
} else {
  console.log("\n✅ 全部变异体都被测试抓到：这些测试是真的在验证行为。");
}
