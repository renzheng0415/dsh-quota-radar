// 审计回归测试（第二轮重写）
//
// 第一轮的教训：测试全绿但功能没修。原因有三——
//   1. 取消测试把所有适配器换成 mock，没测到真实 Ark 实现漏传 signal；
//   2. OpenCodex「解析测试」接受 ok/error/unconfigured 三种结果，不解析也能过；
//   3. 前端测试只 grep 源码关键词，从不真正渲染组件。
//
// 本轮规则：
//   · 测试真实适配器实现，只 mock 网络与文件接缝；
//   · 断言具体数值，不接受「任意状态都行」；
//   · 前端用最小 hooks 运行时真正挂载、渲染、卸载；
//   · 全程不读真实凭据、不碰 ~/.opencodex、不发真实请求。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const hostSource = await readFile(new URL("./dsh/index.js", import.meta.url), "utf8");
const clientSource = await readFile(new URL("./dsh/client.js", import.meta.url), "utf8");

// ---------------------------------------------------------------
// 加载 host 源码（隔离副本，不执行任何网络/文件访问）
// ---------------------------------------------------------------
async function loadHost({ stubToken = "fixture-token", tokenReader } = {}) {
  const exportsList =
    "export { getJson, createRegistry, discoverProviders, activeAdapters, Ring, ADAPTERS, " +
    "sanitizeMessage, strictNum, pct, epochToIso, withDeadline, resolveApiKey };";
  // host 源码里有 `import ... from "./adapters-public.js"`。
  // data: URL 无法解析相对说明符，所以先把相对路径改写成绝对 file: URL，
  // 否则整个 host 模块根本加载不起来。
  const resolvable = hostSource.replace(
    /from "\.\/([^"]+)"/g,
    (_m, rel) => `from "${new URL("./dsh/" + rel, import.meta.url).href}"`,
  );
  return import(
    "data:text/javascript;base64," +
      Buffer.from(resolvable + "\n" + exportsList).toString("base64")
  );
}

/** 记录所有被调用的 fetch，并可控制响应。 */
function installFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const record = { url: String(url), opts, signal: opts.signal };
    calls.push(record);
    return handler(record);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** 造一个只有一条 JSON 的流式响应。 */
function jsonResponse(payload, { status = 200 } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => {},
        releaseLock() {},
      }),
      cancel: async () => {},
    },
  };
}

function makeCtx({ providers = [], credentials = null, webServer = null } = {}) {
  const services = new Map();
  if (providers) services.set("llm", { listProviders: () => providers.map((id) => ({ id, name: id })) });
  if (credentials) services.set("credentials", credentials);
  const cleanups = [];
  const scopeCleanups = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => services.get(name),
    interval: () => () => {},
    timeout: () => () => {},
    effect: (fn) => {
      const d = fn();
      if (typeof d === "function") cleanups.push(d);
    },
    inject: (deps, fn) => {
      if (!webServer) return undefined;
      // 真实 Cordis 里注入回调拿到的是子作用域，它有自己的 effect。
      // 这里如实模拟：子作用域 effect 单独收集，便于验证路由是否随服务回收。
      const scope = {
        webServer,
        effect: (fn) => {
          const d = fn();
          if (typeof d === "function") scopeCleanups.push(d);
        },
      };
      return fn(scope);
    },
    __cleanups: cleanups,
    __scopeCleanups: scopeCleanups,
  };
  return ctx;
}

function fakeWebServer() {
  const registered = new Map();
  return {
    port: 19387,
    register(route) {
      if (registered.has(route.path)) throw new Error("duplicate route " + route.path);
      registered.set(route.path, route);
      return () => registered.delete(route.path);
    },
    __registered: registered,
  };
}

/** 替换某个适配器的 fetch，记录是否收到可用的取消信号。 */
function stubAdapters(core, impl) {
  const originals = core.ADAPTERS.map((a) => a.fetch);
  core.ADAPTERS.forEach((a) => {
    a.fetch = (ctx, deps) => impl(a, ctx, deps);
  });
  return () => core.ADAPTERS.forEach((a, i) => (a.fetch = originals[i]));
}

const okState = (a) => ({
  provider: a.id,
  label: a.label,
  status: "ok",
  windows: [],
  balance: null,
  updatedAt: Date.now(),
  stale: false,
  message: null,
});

// ===============================================================
// P1-1 Ark 真的把取消信号传下去了
// ===============================================================

test("Ark 适配器把 registry 的取消信号传给 fetch，卸载后该请求确实被中止", async () => {
  const core = await loadHost();
  let captured = null;
  const f = installFetch((record) => {
    captured = record.signal;
    // 永不 resolve：只有取消能结束它
    return new Promise((_, reject) => {
      record.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
    const pending = registry.loadAll(false);
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(captured, "真实 Ark 适配器必须发起 fetch");
    assert.equal(captured.aborted, false, "卸载前不应是已中止状态");

    // 关键：必须在 dispose() 之后「同步」检查。
    // 上一版这个测试写成 await pending 之后再断言，结果请求是被它自己的
    // 12 秒超时中止的，测试照样通过（耗时 12014ms 却全绿）——典型的假通过。
    const before = Date.now();
    registry.dispose();
    const abortedSynchronously = captured.aborted;
    const elapsed = Date.now() - before;

    assert.equal(
      abortedSynchronously,
      true,
      "dispose() 必须立即中止实际请求；若为 false，说明 Ark 没把 registry 的 signal 传下去",
    );
    assert.ok(elapsed < 1000, `中止必须是即时的，不能等到 12 秒超时（实际 ${elapsed}ms）`);

    await pending.catch(() => {});
  } finally {
    f.restore();
  }
});

// ===============================================================
// P1-2 前端卸载真正中止在途请求
// ===============================================================

/**
 * 最小 hooks 运行时：真正调用组件、执行 effect、支持重渲染与卸载。
 * 目的是让前端断言基于「渲染出来的东西」，而不是 grep 源码。
 */
function mountReadout({ models, timer, props = {} }) {
  const hooks = [];
  const cleanups = [];
  const effectsRun = new Set();
  let cursor = 0;
  let pending = false;

  const React = {
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = init;
      const set = (v) => {
        const next = typeof v === "function" ? v(hooks[i]) : v;
        if (next !== hooks[i]) {
          hooks[i] = next;
          pending = true;
        }
      };
      return [hooks[i], set];
    },
    useEffect(fn) {
      const i = cursor++;
      if (!effectsRun.has(i)) {
        effectsRun.add(i);
        const c = fn();
        if (typeof c === "function") cleanups[i] = c;
      }
    },
    createElement(type, props2, ...children) {
      return {
        type,
        props: props2 ?? {},
        children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
      };
    },
  };

  const Component = loadClientComponent(React, { models, timer });

  /** 渲染一次，并把函数组件逐层展开成宿主元素。 */
  function renderOnce() {
    cursor = 0;
    pending = false;
    let el = React.createElement(Component, { ...props, __models: models, __timer: timer });
    let guard = 0;
    while (el && typeof el.type === "function" && guard < 20) {
      el = el.type(el.props);
      guard += 1;
    }
    return el;
  }

  return {
    /** 反复渲染并让出事件循环，直到异步状态（fetch 结果）落地。 */
    async settle(passes = 12) {
      let tree = null;
      for (let i = 0; i < passes; i += 1) {
        tree = renderOnce();
        // 必须真的让出事件循环：首次渲染时 snap 还是 null，
        // 数据要等 effect 里的 fetch 完成后才会经由 setState 进来。
        await new Promise((r) => setTimeout(r, 0));
      }
      return tree;
    },
    unmount() {
      for (const c of cleanups) if (typeof c === "function") c();
    },
  };
}

/**
 * 在沙箱里跑 client.js，取回工厂导出的组件。
 *
 * 注意：client 的 apply() 会从 ctx 上捕获 slots / timer / modelDirectories，
 * 组件渲染时用的是这些捕获值（不是 props）。所以测试必须把它们注入 ctx，
 * 通过 props 传是没用的——这正是第一版测试没能真正驱动组件的原因之一。
 */
function loadClientComponent(React, { models, timer } = {}) {
  let component = null;
  const sandbox = {
    // 浏览器里这些是全局对象；沙箱必须显式提供，否则组件里的
    // AbortController / fetch / setTimeout 会直接 ReferenceError。
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    console,
    window: {
      __ModuleLoader__: {
        load(bundle) {
          const mod = bundle.factory((name) => (name === "react" ? React : undefined));
          mod.apply({
            slots: {
              inject: (slot, fn) => fn(),
              register: (meta, render) => {
                component = render;
              },
            },
            timer: timer ?? { interval: () => () => {} },
            modelDirectories: models ?? {},
          });
        },
      },
    },
  };
  // fetch / document 在测试里会被替换，用 getter 保证每次都读到最新值
  Object.defineProperty(sandbox, "fetch", { get: () => (...args) => globalThis.fetch(...args) });
  Object.defineProperty(sandbox, "document", { get: () => globalThis.document });
  // 语言判定读 navigator.language。沙箱默认没有 navigator，
  // 不转发的话组件永远走中文兜底，英文路径就测不到了。
  Object.defineProperty(sandbox, "navigator", { get: () => globalThis.navigator });
  sandbox.globalThis = sandbox;
  vm.runInNewContext(clientSource, sandbox);
  if (!component) throw new Error("client.js 未注册组件");
  return component;
}

test("前端组件卸载时真正中止在途请求", async () => {
  const originalFetch = globalThis.fetch;
  const originalDoc = globalThis.document;
  const signals = [];
  globalThis.fetch = (url, opts = {}) => {
    signals.push(opts.signal);
    return new Promise(() => {}); // 永不返回
  };
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  try {
    const mounted = mountReadout({
      models: {
        directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: "ark" } }), subscribe: () => () => {} } }),
      },
      timer: { interval: () => () => {} },
    });
    await mounted.settle(2); // 让 effect 跑起来并发出请求

    assert.ok(signals.length >= 1, "挂载后应发起请求");
    assert.equal(signals[0].aborted, false);

    mounted.unmount();
    assert.equal(signals[0].aborted, true, "卸载后请求必须被中止（上一版这里是 false）");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDoc;
  }
});

// ===============================================================
// P1-3 凭据解析挂起不再卡死整轮
// ===============================================================

test("凭据解析永久挂起时，整轮仍在期限内结束，后续刷新不被卡死", async () => {
  const core = await loadHost();
  let arkCalls = 0;
  const clock = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  const f = installFetch(() => jsonResponse({ usage: { rolling: { percent: 20 } } }));
  const restore = stubAdapters(core, (a) => {
    if (a.id === "ark") {
      arkCalls += 1;
      return Promise.resolve(okState(a));
    }
    // 模拟真实适配器：先等凭据，再取数。凭据永不返回。
    return (async () => {
      const key = await core.resolveApiKey(
        { get: () => ({ resolve: () => new Promise(() => {}) }) },
        ["DEEPSEEK_API_KEY"],
      );
      return key ? okState(a) : { ...okState(a), status: "unconfigured" };
    })();
  });
  try {
    const ctx = makeCtx({ providers: ["ark", "deepseek"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });

    const started = Date.now();
    // 同样套一层外层期限：期限被移除时必须失败，而不是挂死
    const first = await Promise.race([
      registry.loadAll(false),
      new Promise((r) => setTimeout(() => r("__TEST_TIMEOUT__"), 12_000)),
    ]);
    const elapsed = Date.now() - started;

    assert.notEqual(first, "__TEST_TIMEOUT__", "整轮必须有期限，不能永远挂着");
    assert.equal(first.length, 2, "整轮必须结束");
    assert.equal(arkCalls, 1);
    assert.ok(elapsed <= 8000, `整轮应在期限内结束（实际 ${elapsed}ms）`);

    // 关键：inFlight 必须已复位。推进到缓存/退避都过期后，
    // 健康的那家必须能被重新取数——上一版 inFlight 卡在 true，
    // 这里会一直返回旧快照，arkCalls 永远是 1。
    now += 60_000;
    await registry.loadAll(false);
    assert.equal(arkCalls, 2, "第二轮必须能重新取数（上一版 inFlight 卡住，这里会仍是 1）");
  } finally {
    Date.now = clock;
    restore();
    f.restore();
  }
});

test("凭据解析挂起会被期限打断，而不是无限等待", async () => {
  const core = await loadHost();
  const started = Date.now();
  // 外层 race 是必需的：如果被测的期限被移除（变异测试正是这么做的），
  // 这条测试必须**失败**而不是挂死——挂死的测试等于没有验证能力。
  const result = await Promise.race([
    core.resolveApiKey({ get: () => ({ resolve: () => new Promise(() => {}) }) }, ["SOME_KEY"]),
    new Promise((r) => setTimeout(() => r("__TEST_TIMEOUT__"), 12_000)),
  ]);
  assert.notEqual(result, "__TEST_TIMEOUT__", "凭据解析必须有期限，不能无限等待");
  assert.equal(result, null, "挂起的凭据解析应超时返回 null");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, `应在凭据期限内结束（实际 ${elapsed}ms）`);
});

// ===============================================================
// 启动竞态：凭据服务还没就绪 ≠ 用户没配密钥
// ===============================================================

test("凭据服务还没就绪时报「稍后重试」，而不是误报「未配置」", async () => {
  const core = await loadHost();
  let fetched = 0;
  const stub = installFetch(() => {
    fetched += 1;
    throw new Error("没有密钥就不该发请求");
  });
  try {
    const adapter = core.ADAPTERS.find((a) => a.id === "opencode-go");
    assert.ok(adapter, "应能找到 opencode-go 适配器");
    // ctx.get("credentials") 返回 undefined：模拟 DSH 刚启动、服务还没挂上。
    // 上一版把这种情况直接当成「未配置」，界面上一直说用户没配密钥。
    // 适配器原语由 registry 注入，所以走 createRegistry 而不是裸调 fetch。
    const reg = core.createRegistry(makeCtx({ providers: ["opencode-go"] }), {
      getWebPort: () => 19387,
    });
    await reg.loadAll(false); // snapshot 读的是缓存，必须先真的取一轮
    const state = (await reg.snapshot())[0];
    assert.equal(state.status, "error", "服务没就绪是暂时性错误，不是配置错误");
    assert.match(state.message, /稍后|就绪/, `应提示稍后重试，实际: ${state.message}`);
    assert.doesNotMatch(state.message, /未配置/, "不该说用户没配置密钥");
    assert.equal(fetched, 0, "没有密钥就不该发请求");
  } finally {
    stub.restore();
  }
});

test("「未配置」不会退避到很久，配置好后很快恢复", async () => {
  const core = await loadHost();
  let calls = 0;
  let healthy = false;
  const clock = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const restore = stubAdapters(core, (a) => {
    calls += 1;
    if (!healthy) {
      return Promise.resolve({
        provider: a.id,
        label: a.label,
        status: "unconfigured",
        windows: [],
        balance: null,
        updatedAt: Date.now(),
        stale: false,
        message: "未配置",
      });
    }
    return Promise.resolve(okState(a));
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });

    // 连续 8 轮，每轮只推进 16 秒。
    //
    // 修复后：配置态 TTL 固定 15s → 每轮都真的重查 → 8 次。
    // 若退回指数退避：5s→10s→20s→40s 越滚越大，同样 128 秒里只会查 5 次。
    // 这条断言就是靠「次数」把两者区分开的。
    const rounds = 8;
    for (let i = 0; i < rounds; i += 1) {
      now += 16_000;
      await registry.loadAll(false);
    }
    assert.equal(calls, rounds, `配置态应当每轮都重查（期望 ${rounds} 次，实际 ${calls} 次）`);

    // 用户补上密钥后，很快就能恢复
    healthy = true;
    now += 16_000;
    await registry.loadAll(false);
    const ark = registry.snapshot().find((p) => p.provider === "ark");
    assert.ok(ark, "快照应含 ark");
    assert.equal(ark.status, "ok", "配置好后应快速自愈，而不是长期停在未配置");
  } finally {
    Date.now = clock;
    restore();
  }
});

// ===============================================================
// P2-1 强制刷新不再绕过失败退避
// ===============================================================

test("失败退避期间，强制刷新不能绕过退避继续打上游", async () => {
  const core = await loadHost();
  let calls = 0;
  const clock = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const restore = stubAdapters(core, () => {
    calls += 1;
    return Promise.reject(new Error("offline"));
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });

    // 模拟 10 分钟内每 16 秒强刷一次（每次都超过 15s 强刷节流窗口）。
    // 正确行为：请求次数受失败退避约束（5s→10s→20s→40s→80s…），
    // 而不是每 16 秒都真的打一次上游。
    const attempts = 38;
    for (let i = 0; i < attempts; i += 1) {
      now += 16_000;
      await registry.loadAll(true);
    }
    // 上一版 force 直接跳过 expiresAt：这里会接近 38 次。
    // 修复后应被退避压到个位数。
    assert.ok(
      calls <= 10,
      `10 分钟内强刷 ${attempts} 次，实际请求上游 ${calls} 次——退避未生效（上一版约 38 次）`,
    );
    assert.ok(calls >= 3, `仍应有正常重试（实际 ${calls} 次）`);

    // 退避真的到期后必须能恢复
    const before = calls;
    now += 20 * 60 * 1000;
    await registry.loadAll(true);
    assert.ok(calls > before, "退避到期后必须允许重试");
  } finally {
    Date.now = clock;
    restore();
  }
});

test("退避未到期时，强制刷新只返回缓存，不发起新请求", async () => {
  const core = await loadHost();
  let calls = 0;
  const clock = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  const restore = stubAdapters(core, () => {
    calls += 1;
    return Promise.reject(new Error("offline"));
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });

    await registry.loadAll(false); // streak=1，退避 5s
    assert.equal(calls, 1);

    // 连打三次强刷，但时间只推进 1 秒（退避未到期，强刷节流也没到）
    for (let i = 0; i < 3; i += 1) {
      now += 1_000;
      await registry.loadAll(true);
    }
    assert.equal(calls, 1, "退避未到期时不应发起任何新请求");
  } finally {
    Date.now = clock;
    restore();
  }
});

test("成功状态下的强制刷新仍然可以立即刷新（退避只约束失败态）", async () => {
  const core = await loadHost();
  let calls = 0;
  const restore = stubAdapters(core, (a) => {
    calls += 1;
    return Promise.resolve(okState(a));
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
    await registry.loadAll(false);
    assert.equal(calls, 1);
    await registry.loadAll(true); // 成功态 + 超过节流窗口之外的行为
    assert.equal(calls, 2, "成功态下强刷应能穿透 30s 缓存");
  } finally {
    restore();
  }
});

// ===============================================================
// P2-2 WorkBuddy 数值不再越界
// ===============================================================

test("WorkBuddy 剩余量大于套餐总量时不显示「剩余 200%」，而是标记异常", async () => {
  const core = await loadHost();
  const f = installFetch(() =>
    jsonResponse({
      status: "signed-in",
      credits: {
        total: 200,
        packages: [{ monthly: true, remain: 200, size: 100, packageName: "p" }],
      },
    }),
  );
  try {
    const adapter = core.ADAPTERS.find((a) => a.id === "workbuddy");
    const state = await adapter.fetch({}, { getWebPort: () => 19387 });
    assert.equal(state.status, "ok");
    const w = state.windows[0];
    assert.ok(w, "应产出一个窗口");
    assert.ok(w.usedPercent >= 0 && w.usedPercent <= 100, `已用百分比必须落在 0..100（实际 ${w.usedPercent}）`);
    assert.equal(w.outOfRange, true, "越界必须被标记（上一版这里是 undefined）");
    assert.ok(w.rawPercent < 0, "原始越界值应保留供提示");
    // 客户端据此算出的是「剩余 100% ⚠」，不再是 200%
    assert.ok(100 - w.usedPercent <= 100);
  } finally {
    f.restore();
  }
});

test("WorkBuddy 按剩余比例挑最紧的包，并标注积分单位", async () => {
  const core = await loadHost();
  const f = installFetch(() =>
    jsonResponse({
      status: "signed-in",
      credits: {
        total: 900,
        packages: [
          { monthly: true, remain: 800, size: 1000, packageName: "大包" }, // 80%
          { monthly: true, remain: 100, size: 1000, packageName: "小包" }, // 10%
        ],
      },
    }),
  );
  try {
    const adapter = core.ADAPTERS.find((a) => a.id === "workbuddy");
    const state = await adapter.fetch({}, { getWebPort: () => 19387 });
    // 小包剩 10% → 已用 90%
    assert.equal(state.windows[0].usedPercent, 90, "应按剩余比例选最紧的包");
    assert.match(state.detail.unitNote, /非人民币/);
  } finally {
    f.restore();
  }
});

test("WorkBuddy 走代理别名接入时，账号归属提醒进入数据结构", async () => {
  const core = await loadHost();
  const f = installFetch(() =>
    jsonResponse({
      status: "signed-in",
      credits: { total: 10, packages: [{ monthly: true, remain: 5, size: 10 }] },
    }),
  );
  try {
    const adapter = core.ADAPTERS.find((a) => a.id === "workbuddy");
    const viaNative = await adapter.fetch({}, { getWebPort: () => 19387, matchedRoutes: ["workbuddy"] });
    assert.equal(viaNative.detail.bindingNote, null, "原生路由不应有额外提醒");

    const viaProxy = await adapter.fetch({}, { getWebPort: () => 19387, matchedRoutes: ["workbuddy2api"] });
    assert.match(viaProxy.detail.bindingNote ?? "", /未独立验证/, "代理别名必须带归属提醒");
  } finally {
    f.restore();
  }
});

// ===============================================================
// P2-3 OpenCodex 陈旧与不完整数据
// ===============================================================

test("OpenCodex 解析真实结构：数值正确、上游时间被保留、不完整被标记", async () => {
  const core = await loadHost();
  const sourceAt = Date.now() - 60_000;
  const f = installFetch(() =>
    jsonResponse({
      generatedAt: Date.now(),
      reports: [
        {
          provider: "openai",
          label: "OpenAI (Codex login)",
          source: "chatgpt:wham",
          quota: { fiveHourPercent: 28.5, weeklyPercent: 28, updatedAt: sourceAt },
          aggregation: {
            incomplete: true,
            includedAccounts: 3,
            excludedAccounts: 0,
            fiveHour: { incomplete: true },
            weekly: { incomplete: false },
          },
        },
      ],
    }),
  );
  try {
    const adapter = core.ADAPTERS.find((a) => a.id === "opencodex");
    // 用接缝注入 token，绝不读真实文件
    const state = await adapter.fetch({}, { readToken: async () => "fixture-token" });

    assert.equal(state.status, "ok", "必须真的解析成功，而不是接受任意状态");
    assert.equal(state.windows.length, 2, "应解析出 5h 与本周两个窗口");
    assert.equal(state.windows[0].usedPercent, 28.5, "5h 已用百分比必须精确匹配");
    assert.equal(state.windows[1].usedPercent, 28, "本周已用百分比必须精确匹配");
    assert.equal(state.windows[0].partial, true, "5h 不完整必须标记");
    assert.equal(state.windows[1].partial, false, "本周完整不应误标");
    assert.equal(state.detail.partial, true);
    assert.match(state.detail.partialNote, /不完整/);
    assert.equal(state.detail.accounts[0].sourceAt, new Date(sourceAt).toISOString(), "必须保留上游采样时刻");
    assert.equal(state.stale, false, "1 分钟前的数据不算陈旧");
  } finally {
    f.restore();
  }
});

test("OpenCodex 上游采样过旧时标记 stale，不冒充实时数据", async () => {
  const core = await loadHost();
  const old = Date.now() - 24 * 60 * 60 * 1000; // 24 小时前
  const f = installFetch(() =>
    jsonResponse({
      generatedAt: Date.now(),
      reports: [{ provider: "openai", label: "OpenAI", quota: { fiveHourPercent: 10, updatedAt: old } }],
    }),
  );
  try {
    const adapter = core.ADAPTERS.find((a) => a.id === "opencodex");
    const state = await adapter.fetch({}, { readToken: async () => "fixture-token" });
    assert.equal(state.stale, true, "24 小时前的采样必须标成陈旧（上一版这里是 false）");
    assert.match(state.message ?? "", /未更新/);
  } finally {
    f.restore();
  }
});

test("OpenCodex token 读取失败/缺失走明确状态，不静默通过", async () => {
  const core = await loadHost();
  const adapter = core.ADAPTERS.find((a) => a.id === "opencodex");

  const missing = await adapter.fetch({}, { readToken: async () => null });
  assert.equal(missing.status, "unconfigured");

  const throwing = await adapter.fetch({}, {
    readToken: async () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(throwing.status, "error", "读取抛错应报错而不是当成未配置");

  const hanging = await adapter.fetch({}, { readToken: () => new Promise(() => {}) });
  assert.equal(hanging.status, "error", "读取挂起必须被期限打断");
  assert.match(hanging.message ?? "", /超时|失败/);
});

// ===============================================================
// 路由防护
// ===============================================================

test("路由拒绝：非 GET、缺头、跨站、跨源 Origin", async () => {
  const core = await loadHost();
  const ws = fakeWebServer();
  const ctx = makeCtx({ providers: ["ark"], webServer: ws });
  core.apply(ctx, {});
  const route = ws.__registered.get("/quota-radar/snapshot");
  assert.ok(route, "snapshot 路由应已注册");

  const call = async (method, headers) => {
    let code;
    await route.handler(
      { method, url: "/quota-radar/snapshot", headers },
      { writeHead: (c) => { code = c; }, end() {} },
    );
    return code;
  };

  const good = { "x-quota-radar": "1", host: "127.0.0.1:19387" };
  assert.equal(await call("POST", good), 403, "非 GET 应拒绝");
  assert.equal(await call("GET", { host: "127.0.0.1:19387" }), 403, "缺自定义头应拒绝");
  assert.equal(await call("GET", { ...good, "sec-fetch-site": "cross-site" }), 403, "跨站应拒绝");
  // 上一版这里返回 200：只带固定头、没有 cookie 的外部来源可以读数据
  assert.equal(
    await call("GET", { ...good, origin: "https://evil.example" }),
    403,
    "外部 Origin 必须拒绝（上一版这里是 200）",
  );
  assert.equal(
    await call("GET", { ...good, origin: "http://127.0.0.1:9999" }),
    403,
    "同主机不同端口也是跨源，必须拒绝",
  );
  assert.equal(await call("GET", { ...good, origin: "http://127.0.0.1:19387" }), 200, "同源应放行");
  assert.equal(await call("GET", good), 200, "同源 GET 不带 Origin 属正常，应放行");
});

test("history 路由受同样防护，且必须带 provider 参数", async () => {
  const core = await loadHost();
  const ws = fakeWebServer();
  const ctx = makeCtx({ providers: ["ark"], webServer: ws });
  core.apply(ctx, {});
  const route = ws.__registered.get("/quota-radar/history");
  const good = { "x-quota-radar": "1", host: "127.0.0.1:19387" };

  const call = async (method, headers, url) => {
    let code;
    await route.handler({ method, url, headers }, { writeHead: (c) => { code = c; }, end() {} });
    return code;
  };
  assert.equal(await call("POST", good, "/quota-radar/history?provider=ark"), 403);
  assert.equal(await call("GET", good, "/quota-radar/history"), 400);
  assert.equal(await call("GET", { ...good, origin: "https://evil.example" }, "/quota-radar/history?provider=ark"), 403);
});

// ===============================================================
// 生命周期
// ===============================================================

test("注入作用域销毁时路由随之释放（不是只在插件整体卸载时）", async () => {
  const core = await loadHost();
  const ws = fakeWebServer();
  const ctx = makeCtx({ providers: ["ark"], webServer: ws });
  core.apply(ctx, {});

  assert.ok(ws.__registered.has("/quota-radar/snapshot"), "注册后路由存在");

  // 模拟宿主重启 webServer 服务：注入出来的子作用域被销毁，
  // 但插件整体仍在。路由必须跟着子作用域一起回收。
  assert.ok(ctx.__scopeCleanups.length > 0, "路由清理必须登记在注入作用域上，而不是顶层 ctx");
  for (const c of ctx.__scopeCleanups) c();

  assert.equal(ws.__registered.has("/quota-radar/snapshot"), false, "服务作用域销毁后路由应释放");

  // 服务重建后重新注入，不应因为路由残留而抛 duplicate route
  assert.doesNotThrow(() => core.apply(ctx, {}), "重新注入不应报重复路由（上一版会抛错）");
});

test("插件整体卸载后路由释放、缓存清空、不再回写", async () => {
  const core = await loadHost();
  const ws = fakeWebServer();
  const ctx = makeCtx({ providers: ["ark"], webServer: ws });
  core.apply(ctx, {});

  assert.ok(ws.__registered.has("/quota-radar/snapshot"));
  assert.ok(ws.__registered.has("/quota-radar/history"));

  // 整体卸载 = 顶层清理 + 注入作用域清理（真实 Cordis 里两者都会跑）
  for (const c of ctx.__cleanups) c();
  for (const c of ctx.__scopeCleanups) c();

  assert.equal(ws.__registered.has("/quota-radar/snapshot"), false);
  assert.equal(ws.__registered.has("/quota-radar/history"), false);
});

test("卸载后在途请求不再回写缓存", async () => {
  const core = await loadHost();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const restore = stubAdapters(core, async (a) => {
    await gate;
    return okState(a);
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
    const pending = registry.loadAll(false);
    await new Promise((r) => setTimeout(r, 5));

    registry.dispose();
    release();
    await pending;

    assert.deepEqual(registry.snapshot(), [], "卸载后不应再返回数据");
    assert.equal(registry.isDisposed(), true);
  } finally {
    restore();
  }
});

test("provider 改名后，快照里的 routes 跟随当前接入，不会匹配不上", async () => {
  const core = await loadHost();
  const routes = ["ark"];
  const restore = stubAdapters(core, (a) => Promise.resolve(okState(a)));
  try {
    const ctx = makeCtx({});
    ctx.get = (n) => (n === "llm" ? { listProviders: () => routes.map((id) => ({ id })) } : undefined);
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });

    await registry.loadAll(false);
    assert.deepEqual(registry.snapshot()[0].routes, ["ark"]);

    routes.length = 0;
    routes.push("ark-coding"); // 宿主把 provider 改名了
    assert.deepEqual(
      registry.snapshot()[0].routes,
      ["ark-coding"],
      "快照必须反映当前接入名，否则界面按旧名匹配会显示不出来",
    );
  } finally {
    restore();
  }
});

test("已接入但没有适配器的 route 会被列出，不会消失", async () => {
  const core = await loadHost();
  const ctx = makeCtx({ providers: ["ark", "agnes", "workbuddy2api"] });
  const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
  assert.deepEqual(registry.unadapted().sort(), ["agnes"]);
  assert.ok(registry.registeredList().includes("workbuddy2api"));
});

test("无法发现注册表时保守处理：不取任何数", async () => {
  const core = await loadHost();
  let calls = 0;
  const restore = stubAdapters(core, (a) => {
    calls += 1;
    return Promise.resolve(okState(a));
  });
  try {
    const ctx = makeCtx({ providers: null });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
    await registry.loadAll(false);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test("未接入任何 provider 时不取数、不读凭据", async () => {
  const core = await loadHost();
  let calls = 0;
  let credentialReads = 0;
  const restore = stubAdapters(core, (a) => {
    calls += 1;
    return Promise.resolve(okState(a));
  });
  try {
    const ctx = makeCtx({
      providers: [],
      credentials: {
        resolve: async () => {
          credentialReads += 1;
          return { value: "should-not-be-read" };
        },
      },
    });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
    const states = await registry.loadAll(false);
    assert.equal(calls, 0);
    assert.equal(credentialReads, 0);
    assert.deepEqual(states, []);
  } finally {
    restore();
  }
});

test("只查询与已接入 route 匹配的适配器", async () => {
  const core = await loadHost();
  const called = [];
  const restore = stubAdapters(core, (a) => {
    called.push(a.id);
    return Promise.resolve(okState(a));
  });
  try {
    const ctx = makeCtx({ providers: ["ark", "deepseek"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
    await registry.loadAll(false);
    assert.deepEqual(called.sort(), ["ark", "deepseek"]);
  } finally {
    restore();
  }
});

// ===============================================================
// 取数原语
// ===============================================================

test("响应体超限时在读取阶段即中断，不是全读后再检查", async () => {
  const core = await loadHost();
  let cancelled = false;
  let reads = 0;
  const f = installFetch(() => ({
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          reads += 1;
          return { done: false, value: new Uint8Array(65536) };
        },
        cancel: async () => {
          cancelled = true;
        },
        releaseLock() {},
      }),
    },
  }));
  try {
    await assert.rejects(core.getJson("http://fixture"), /256KB/);
    assert.equal(cancelled, true);
    assert.ok(reads <= 6, `不应读完整流（实际 ${reads} 次）`);
  } finally {
    f.restore();
  }
});

test("非 2xx 会取消 body；带凭据的请求不跟随重定向", async () => {
  const core = await loadHost();
  let cancelled = false;
  let seen = null;
  const f = installFetch((record) => {
    seen = record.opts;
    return { ok: false, status: 500, body: { cancel: async () => { cancelled = true; } } };
  });
  try {
    await assert.rejects(core.getJson("http://fixture", { Authorization: "Bearer secret" }), /HTTP 500/);
    assert.equal(cancelled, true);
    assert.equal(seen.redirect, "error");
    assert.ok(seen.signal, "必须有超时信号");
  } finally {
    f.restore();
  }
});

test("严格数值：拒绝脏字符串，越界百分比保留原值并标记", async () => {
  const core = await loadHost();
  assert.equal(core.strictNum("12garbage"), null);
  assert.equal(core.strictNum("12"), 12);
  assert.equal(core.strictNum(""), null);
  assert.equal(core.strictNum(Infinity), null);

  const over = core.pct(150);
  assert.equal(over.value, 100);
  assert.equal(over.outOfRange, true);
  assert.equal(over.raw, 150);

  assert.equal(core.pct(-5).outOfRange, true);
  assert.equal(core.pct(50).outOfRange, false);
});

test("epochToIso 正确处理秒与毫秒，并拒绝离谱值", async () => {
  const core = await loadHost();
  const ms = 1_790_839_299_089;
  assert.equal(core.epochToIso(ms), new Date(ms).toISOString(), "毫秒应原样解析");
  assert.equal(core.epochToIso(Math.floor(ms / 1000)), new Date(Math.floor(ms / 1000) * 1000).toISOString(), "秒应乘以 1000");
  assert.equal(core.epochToIso(0), null);
  assert.equal(core.epochToIso(-1), null);
  assert.equal(core.epochToIso("abc"), null);
  assert.equal(core.epochToIso(1), null, "1 秒会被判成 1970 年，必须拒绝");
});

test("错误脱敏：token / bearer / 长密钥串被隐藏", async () => {
  const core = await loadHost();
  const cases = [
    "failed with Bearer sk-abcdef1234567890abcdef",
    "api_key=supersecretvalue123",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "token: ghp_0123456789abcdefghijklmnopqrstuvwx",
  ];
  for (const input of cases) {
    const out = core.sanitizeMessage(input);
    assert.match(out, /已隐藏/, `应脱敏: ${input}`);
    assert.ok(!out.includes("sk-abcdef1234567890abcdef"));
  }
  assert.match(core.sanitizeMessage("HTTP 404"), /HTTP 404/);

  // 下面这条是专门为 bearer 规则写的：其余规则都兜不住它
  // （没有 sk-/ghp_ 前缀，也没有 : 或 = 赋值，长度也够短）。
  // 没有它，删掉 bearer 规则测试照样全绿——变异测试正是这样抓出来的。
  const bearerOnly = core.sanitizeMessage("upstream said Bearer abc123def456ghi789");
  assert.ok(
    !bearerOnly.includes("abc123def456ghi789"),
    `bearer 后面的裸密钥必须被隐藏，实际: ${bearerOnly}`,
  );
  assert.match(bearerOnly, /Bearer \[已隐藏\]/);

  // 中文诊断不能被误伤（上一版把「读取 token 超时」后半句吃掉了）
  assert.match(core.sanitizeMessage("读取 admin token 超时或失败"), /超时或失败/);
});

test("历史只记录新鲜成功，stale 不重复写入", async () => {
  const core = await loadHost();
  let now = 100000;
  const clock = Date.now;
  Date.now = () => now;
  let failing = false;
  const restore = stubAdapters(core, (a) => {
    if (failing) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ...okState(a), windows: [{ label: "5h", usedPercent: 10 }], updatedAt: now });
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, { getWebPort: () => 19387 });
    await registry.loadAll(false);
    assert.equal(registry.historyFor("ark").length, 1);

    failing = true;
    now += 31_000;
    await registry.loadAll(false);
    now += 60_000;
    await registry.loadAll(false);
    assert.equal(registry.historyFor("ark").length, 1, "失败期间不应写入历史");
    assert.equal(registry.historyFor("ark")[0].at, 100000, "历史点应保持原成功时间");
  } finally {
    Date.now = clock;
    restore();
  }
});

test("环形缓冲有界且顺序正确", async () => {
  const core = await loadHost();
  const ring = new core.Ring(120);
  for (let i = 0; i < 100_000; i += 1) ring.push(i);
  assert.equal(ring.toArray().length, 120);
  assert.equal(ring.toArray()[0], 99880);
  assert.equal(ring.toArray()[119], 99999);
});

// ===============================================================
// 前端渲染（真正挂载，不是 grep）
// ===============================================================

function snapshotPayload({ providers, unadapted = [], registered }) {
  return {
    ok: true,
    now: Date.now(),
    providers,
    unadapted,
    registered: registered ?? providers.flatMap((p) => p.routes ?? []),
    payload: {},
  };
}

function stateFixture(id, label, routes, extra = {}) {
  return {
    provider: id,
    label,
    routes,
    status: "ok",
    windows: [],
    balance: null,
    detail: null,
    stale: false,
    message: null,
    ...extra,
  };
}

/** 真正挂载前端组件并等异步状态落地。 */
async function renderWith(payload, { route = "ark", documentStub, lang = "zh-CN", htmlLang, navLang } = {}) {
  const originalFetch = globalThis.fetch;
  const originalDoc = globalThis.document;
  const originalNav = globalThis.navigator;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  // 宿主把语言写在 document.documentElement.lang 上，这是最权威的信号。
  // htmlLang 单独可配，用来构造「系统语言与 DSH 语言不一致」的场景。
  globalThis.document = documentStub ?? {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    documentElement: { lang: htmlLang ?? lang },
  };
  // 语言必须显式指定。Node 自带 navigator.language = "en-US"，
  // 不固定住的话断言中文的测试会随宿主环境飘。
  Object.defineProperty(globalThis, "navigator", {
    value: { language: navLang ?? lang },
    configurable: true,
    writable: true,
  });

  const models = {
    directoryFor: () => ({
      store: { getSnapshot: () => ({ current: { provider: route } }), subscribe: () => () => {} },
    }),
  };
  // 组件从 props.session 取 sessionId；不传就读不到当前模型 → 整行隐藏。
  const mounted = mountReadout({
    models,
    timer: { interval: () => () => {} },
    props: { session: { sessionId: "test-session" } },
  });
  const tree = await mounted.settle();
  return {
    tree,
    mounted,
    restoreNavigator() {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNav,
        configurable: true,
        writable: true,
      });
    },
    /** 触发交互（如点击展开）后重新渲染。 */
    async click(node) {
      node.props.onClick();
      return mounted.settle();
    },
    restore() {
      globalThis.fetch = originalFetch;
      globalThis.document = originalDoc;
    },
  };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children ?? []).map(textOf).join("");
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) findAll(c, pred, out);
  return out;
}

const byAttr = (name) => (n) => Boolean(n.props && n.props[name]);

test("前端显示当前模型的读数，并把账号归属提醒真正渲染出来", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("workbuddy", "WorkBuddy", ["workbuddy2api"], {
        balance: { amount: 4221, currency: "积分", display: "4221" },
        detail: {
          unitNote: "单位为积分，非人民币",
          bindingNote: "经「workbuddy2api」接入，额度归属未独立验证",
        },
      }),
    ],
  });
  const env = await renderWith(payload, { route: "workbuddy2api" });
  try {
    const main = findAll(env.tree, byAttr("data-qr-main"));
    assert.equal(main.length, 1, "应渲染出主读数行");
    assert.match(textOf(main[0]), /WorkBuddy/);
    assert.match(textOf(main[0]), /4221/);
    // 关键：提醒必须出现在用户能看到的地方（上一版只写在数据里，界面从不显示）
    assert.match(main[0].props.title, /未独立验证/, "账号归属提醒必须渲染进 tooltip");
    assert.match(main[0].props.title, /非人民币/);
  } finally {
    env.restore();
  }
});

test("适配器给的说明文字要真的渲染进 tooltip（noteParts 曾经全被丢弃）", async () => {
  // 同一类 bug 的第二次出现：数据里写了说明，界面从不显示。
  // 上一版修了 unitNote/bindingNote，但各通路大量产出的是 note / noteParts，
  // 仍然被丢掉——Kimi、OpenRouter、中转站的「已用 / 总额度」全都看不见。
  const payload = snapshotPayload({
    providers: [
      stateFixture("woyaopro", "WoYaoPro", ["woyaopro"], {
        balance: { amount: 487.12, currency: "USD", display: "$487.12" },
        detail: {
          source: "relay",
          thirdParty: true,
          noteParts: [
            { zh: "已用 $712.88 / 总额度 $1200.00", en: "used $712.88 of $1200.00" },
            { zh: "今日 $0.19", en: "today $0.19" },
          ],
        },
      }),
    ],
  });
  const env = await renderWith(payload, { route: "woyaopro", lang: "zh-CN" });
  try {
    const main = findAll(env.tree, byAttr("data-qr-main"));
    assert.equal(main.length, 1, "应渲染出主读数行");
    assert.match(textOf(main[0]), /\$487\.12/, "余额应显示出来");
    assert.match(main[0].props.title, /已用 \$712\.88/, "noteParts 必须渲染进 tooltip");
    assert.match(main[0].props.title, /今日 \$0\.19/);
    assert.match(main[0].props.title, /第三方中转站/, "thirdParty 标记必须渲染");
  } finally {
    env.restore();
  }
});

test("只显示当前选中的那个模型，不摊开全部服务", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("ark", "Ark", ["ark"], { windows: [{ label: "5h", usedPercent: 20 }] }),
      stateFixture("deepseek", "DeepSeek", ["deepseek"], { balance: { amount: 4.44, currency: "CNY", display: "¥4.44" } }),
    ],
    unadapted: ["agnes"],
    registered: ["ark", "deepseek", "agnes"],
  });
  const env = await renderWith(payload, { route: "ark" });
  try {
    const main = findAll(env.tree, byAttr("data-qr-main"));
    assert.equal(main.length, 1, "只应有当前模型这一项");
    assert.equal(main[0].props["data-qr-main"], "ark");
    assert.equal(findAll(env.tree, byAttr("data-qr-panel")).length, 0, "默认不展开总览");

    const all = textOf(env.tree);
    assert.match(all, /Ark/);
    assert.match(all, /5h/);
    // 别的服务一概不出现
    assert.doesNotMatch(all, /DeepSeek/, "不该显示未选中的服务");
    assert.doesNotMatch(all, /¥4\.44/, "不该显示未选中服务的余额");
    assert.doesNotMatch(all, /暂不提供额度/, "不该显示未选中服务的占位");
  } finally {
    env.restore();
  }
});

test("切换模型时读数跟着切换", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("ark", "Ark", ["ark"], { windows: [{ label: "5h", usedPercent: 20 }] }),
      stateFixture("deepseek", "DeepSeek", ["deepseek"], { balance: { amount: 4.44, currency: "CNY", display: "¥4.44" } }),
    ],
    registered: ["ark", "deepseek"],
  });
  for (const [route, expect, reject] of [
    ["ark", /Ark/, /DeepSeek/],
    ["deepseek", /DeepSeek/, /Ark/],
  ]) {
    const env = await renderWith(payload, { route });
    try {
      const all = textOf(env.tree);
      assert.match(all, expect, `选中 ${route} 时应显示对应服务`);
      assert.doesNotMatch(all, reject, `选中 ${route} 时不该显示另一家`);
      assert.equal(findAll(env.tree, byAttr("data-qr-main")).length, 1);
    } finally {
      env.restore();
    }
  }
});

test("前端在已接入但无额度接口时显示说明，而不是整行消失", async () => {
  const payload = snapshotPayload({
    providers: [stateFixture("ark", "Ark", ["ark"])],
    unadapted: ["agnes"],
    registered: ["ark", "agnes"],
  });
  const env = await renderWith(payload, { route: "agnes" });
  try {
    const node = findAll(env.tree, byAttr("data-qr-unsupported"));
    assert.equal(node.length, 1, "已接入但无额度接口时应给出说明（上一版整行消失）");
    assert.match(textOf(node[0]), /暂不提供额度/);
  } finally {
    env.restore();
  }
});

test("未接入的模型整行隐藏，不拿别家数字顶替", async () => {
  const payload = snapshotPayload({
    providers: [stateFixture("ark", "Ark", ["ark"])],
    registered: ["ark"],
  });
  const env = await renderWith(payload, { route: "some-unregistered-model" });
  try {
    assert.equal(env.tree, null, "未接入的模型不应显示任何内容");
  } finally {
    env.restore();
  }
});

test("前端把陈旧与不完整标记渲染出来", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("opencodex", "OpenCodex", ["opencodex"], {
        stale: true,
        message: "上游数据约 120 分钟未更新",
        windows: [{ label: "OpenAI 5h", usedPercent: 28.5, partial: true }],
        detail: { aggregationNote: "为多账号聚合值，非单一账号余额", partialNote: "部分账号未纳入统计，数值不完整" },
      }),
    ],
  });
  const env = await renderWith(payload, { route: "opencodex" });
  try {
    const main = findAll(env.tree, byAttr("data-qr-main"));
    assert.match(textOf(main[0]), /⏱/, "陈旧数据应有可见标记");
    assert.match(textOf(main[0]), /部分/, "不完整应有可见标记");
    assert.match(main[0].props.title, /多账号聚合/);
    assert.match(main[0].props.title, /不完整/);
    assert.match(main[0].props.title, /未更新/);
  } finally {
    env.restore();
  }
});

test("全部窗口一次显示完，不再只留最吃紧的一个", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("ark", "Ark", ["ark"], {
        windows: [
          { label: "5h", usedPercent: 20 },
          { label: "本周", usedPercent: 60 },
          { label: "本月", usedPercent: 80 },
        ],
      }),
    ],
  });
  const env = await renderWith(payload, { route: "ark" });
  try {
    const main = findAll(env.tree, byAttr("data-qr-main"));
    const text = textOf(main[0]);
    // 挪到 dialog 下方的 dock 之后横向空间够了，三个窗口都要看得见
    assert.match(text, /5h/, `应显示 5h，实际: ${text}`);
    assert.match(text, /周/, "应显示本周");
    assert.match(text, /月/, "应显示本月");
    assert.match(text, /剩余 20%/, "本月已用 80% → 剩余 20%");
  } finally {
    env.restore();
  }
});

test("字号与宿主「缓存命中 / Token 速度」那组指标完全一致", async () => {
  const payload = snapshotPayload({
    providers: [stateFixture("ark", "Ark", ["ark"], { windows: [{ label: "5h", usedPercent: 20 }] })],
  });
  const env = await renderWith(payload, { route: "ark" });
  try {
    // 外层的字号/行高必须走宿主同一组 CSS 变量，
    // 这样用户调界面字号时两边一起变，不会一大一小。
    const root = env.tree;
    assert.match(
      String(root.props.style.fontSize),
      /--dsh-content-font-size-secondary/,
      "字号必须引用宿主变量，而不是写死 px",
    );
    assert.match(
      String(root.props.style.lineHeight),
      /--dsh-content-font-delta-secondary/,
      "行高必须引用宿主变量",
    );
    // 药丸本身不覆盖字号，靠 inherit 跟随外层
    const main = findAll(env.tree, byAttr("data-qr-main"));
    assert.equal(main[0].props.style.font, "inherit", "药丸字号应继承外层，不单独写死");
    assert.equal(main[0].props.style.fontSize, undefined, "药丸不应自带 fontSize");
  } finally {
    env.restore();
  }
});

test("注册在对话框下方的 dock 插槽，不再跟模型选择器抢宽度", () => {
  // 只看真正的注册调用，注释里提到旧位置不算
  assert.match(clientSource, /slots\.inject\("conversation\.composer\.dock"/, "应注册到 dock 插槽");
  assert.doesNotMatch(clientSource, /slots\.inject\("conversation\.input\.left"/, "不应再注册到模型选择器左侧");
  assert.match(clientSource, /name: "conversation\.composer\.dock"/, "register 的 name 也要对上");
});

test("前端源码里不再出现写死的 px 字号（一律跟随宿主变量）", () => {
  const hardcoded = clientSource.match(/fontSize:\s*\d+/g);
  assert.equal(hardcoded, null, `不应写死 px 字号，发现: ${hardcoded}`);
});

test("前端在页面不可见时不发起请求", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => snapshotPayload({ providers: [] }) };
  };
  const originalDoc = globalThis.document;
  globalThis.document = { hidden: true, addEventListener() {}, removeEventListener() {} };
  try {
    const mounted = mountReadout({
      models: {
        directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: "ark" } }), subscribe: () => () => {} } }),
      },
      timer: { interval: () => () => {} },
    });
    await mounted.settle();
    assert.equal(calls, 0, "页面隐藏时不应拉取");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDoc;
  }
});

test("前端不再用别家 provider 顶替当前模型", () => {
  assert.doesNotMatch(clientSource, /FALLBACK_ORDER/);
  assert.match(clientSource, /绝不拿别家的数字顶替/);
});

test("前端 bundle 结构与 DSH lazy-CJS 契约一致", () => {
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(clientSource, /id: "dsh-quota-radar"/);
  assert.match(clientSource, /exports\.apply/);
  assert.match(clientSource, /exports\.inject = \["slots", "timer", "modelDirectories"\]/);
  assert.match(clientSource, /conversation\.input\.left/);
});

test("前端使用注入的 timer，不用浏览器全局 setInterval", () => {
  assert.doesNotMatch(clientSource, /[^.\w]setInterval\(/);
  assert.match(clientSource, /timer\.interval\(/);
});

// ===============================================================
// 文档一致性
// ===============================================================

test("文档不再宣称未经验证的结论", async () => {
  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
  const risk = await readFile(new URL("./RISK.md", import.meta.url), "utf8");
  assert.match(readme, /256KB|256 KB/, "README 应写 256KB");
  assert.doesNotMatch(readme, /响应体上限 2MB/);
  assert.doesNotMatch(readme, /全部修复|全部已修复/, "不应宣称全部修复");
  assert.doesNotMatch(risk, /所有在途请求.*已?全部取消|全部请求已取消/);
});

test("展开总览按用户指定的固定顺序排列", async () => {
  // host 返回的顺序故意打乱，且混入一个不在名单里的服务
  const payload = snapshotPayload({
    providers: [
      stateFixture("ark", "Ark", ["ark"]),
      stateFixture("workbuddy-global", "WorkBuddy 全球", ["workbuddy-global"]),
      stateFixture("opencodex", "OpenCodex", ["opencodex"]),
      stateFixture("zeta", "某新服务", ["zeta"]),
      stateFixture("workbuddy", "WorkBuddy", ["workbuddy"]),
      stateFixture("opencode-go", "OpenCode Go", ["opencode-go"]),
      stateFixture("deepseek", "DeepSeek", ["deepseek"]),
    ],
    unadapted: ["agnes"],
    registered: ["deepseek", "ark", "workbuddy"],
  });
  const env = await renderWith(payload, { route: "deepseek" });
  try {
    const expanded = await env.click(findAll(env.tree, byAttr("data-qr-main"))[0]);
    const panel = findAll(expanded, byAttr("data-qr-panel"));
    assert.equal(panel.length, 1, "点击后应展开总览");

    const ids = findAll(expanded, byAttr("data-qr-panel-row")).map((r) => r.props["data-qr-panel-row"]);
    assert.deepEqual(
      ids,
      [
        "deepseek", // 1 官方账号
        "opencode-go", // 2 OpenCode
        "opencodex", // 3 OpenCodex
        "workbuddy", // 4 国内版
        "workbuddy-global", // 5 国际版
        "ark", // 6 Ark
        "zeta", // 其余往后排
        "unadapted:agnes", // 没有额度接口的排最后
      ],
      `实际顺序: ${ids.join(" → ")}`,
    );
  } finally {
    env.restore();
  }
});

test("悬停不会变成问号鼠标（不使用 cursor: help）", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("deepseek", "DeepSeek", ["deepseek"]),
      stateFixture("ark", "Ark", ["ark"]),
    ],
    unadapted: ["agnes"],
    registered: ["deepseek", "ark", "agnes"],
  });
  // 展开态和收起态都要检查，面板里的行也算
  for (const { route, expand } of [
    { route: "deepseek", expand: false },
    { route: "deepseek", expand: true },
    { route: "agnes", expand: false }, // 走到「暂不提供额度」那一支
  ]) {
    const env = await renderWith(payload, { route });
    try {
      const tree = expand ? await env.click(findAll(env.tree, byAttr("data-qr-main"))[0]) : env.tree;
      const withHelp = findAll(tree, (n) => n.props && n.props.style && n.props.style.cursor === "help");
      assert.equal(
        withHelp.length,
        0,
        `不应有任何元素用 cursor:help（会把鼠标变成问号），发现 ${withHelp.length} 个`,
      );
    } finally {
      env.restore();
    }
  }
});

// ===============================================================
// 公开适配器（Moonshot / 智谱 GLM / OpenRouter）
//
// ⚠️ 重要：写这些适配器时**没有真实密钥可验证**。
// 所以这些测试锁的是「解析逻辑对已知响应结构是否正确」，
// 而不是「真实接口现在返回什么」。字段结构来自官方文档或官方插件源码，
// 一旦上游改了结构，这里会失败——这正是我们想要的告警。
// ===============================================================

async function loadPublicAdapters() {
  const mod = await import(new URL("./dsh/adapters-public.js", import.meta.url).href);
  // 重构后是声明式通路表：按 id 取对应适配器，而不是每家一个工厂函数。
  const byId = (id) => {
    const a = mod.PUBLIC_ADAPTERS.find((x) => x.id === id);
    if (!a) throw new Error(`通路表里没有 ${id}`);
    return a;
  };
  return { ...mod, byId };
}

/** 造一个最小 deps，记录请求并把响应喂回去。 */
function makeAdapterDeps({ key = "test-key", respond }) {
  const calls = [];
  const CREDENTIALS_UNAVAILABLE = Symbol("credentials-unavailable");
  return {
    CREDENTIALS_UNAVAILABLE,
    calls,
    deps: {
      CREDENTIALS_UNAVAILABLE,
      signal: undefined,
      resolveKey: async () => key,
      getJson: async (url, headers) => {
        calls.push({ url, headers });
        return respond(url, headers, calls.length);
      },
      stateOk: (provider, label, extra) => ({
        provider, label, status: "ok",
        windows: extra.windows ?? [], balance: extra.balance ?? null,
        detail: extra.detail ?? null, stale: false, message: null,
      }),
      stateBad: (provider, label, status, message) => ({
        provider, label, status, windows: [], balance: null, detail: null, message,
      }),
    },
  };
}

test("Moonshot：解析 available_balance，并区分赠金与现金", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("moonshot");
  const { deps, calls } = makeAdapterDeps({
    respond: () => ({
      code: 0,
      data: { available_balance: 12.345, voucher_balance: 2, cash_balance: 10.345 },
    }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok");
  assert.equal(st.balance.currency, "USD");
  assert.match(st.balance.display, /12\.3/);
  // note 现在是双语对象，客户端按语言选
  const parts = st.detail.noteParts.map((p) => p.zh).join(" | ");
  assert.match(parts, /赠金/);
  assert.match(parts, /现金/);
  assert.equal(st.detail.noteParts[0].en.includes("voucher"), true, "英文也要有");
  // 必须先试国内站
  assert.match(calls[0].url, /api\.moonshot\.cn/);
  assert.match(calls[0].headers.Authorization, /^Bearer /);
});

test("Moonshot：国内站失败时自动回退海外站", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("moonshot");
  const { deps, calls } = makeAdapterDeps({
    respond: (url) => {
      if (url.includes(".cn")) throw new Error("ENOTFOUND");
      return { code: 0, data: { available_balance: 5 } };
    },
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok", "国内站挂了应回退海外站");
  assert.equal(calls.length, 2, "应尝试两个域名");
  assert.match(st.detail.source, /moonshot/, "应标出来源");
});

test("Moonshot：没有密钥时报未配置，且不发请求", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("moonshot");
  const { deps, calls } = makeAdapterDeps({ key: null, respond: () => ({}) });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "unconfigured");
  assert.match(st.message, /MOONSHOT_API_KEY/);
  assert.equal(calls.length, 0, "没密钥就不该发请求");
});

test("Moonshot：凭据服务未就绪时报 error，不误报未配置", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("moonshot");
  const built = makeAdapterDeps({ respond: () => ({}) });
  built.deps.resolveKey = async () => built.deps.CREDENTIALS_UNAVAILABLE;
  const st = await a.fetch({}, built.deps);
  assert.equal(st.status, "error", "服务未就绪是暂时性错误");
  assert.doesNotMatch(st.message, /未配置/);
});

test("智谱 GLM：按 unit 正确分出 5h 与周窗，并保留重置时间", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const reset = 1786073946574;
  const { deps } = makeAdapterDeps({
    respond: () => ({
      code: 200,
      data: {
        level: "lite",
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 500, percentage: 25, nextResetTime: reset },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 1000, percentage: 10, nextResetTime: reset },
        ],
      },
    }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok");
  const labels = st.windows.map((w) => w.label);
  assert.deepEqual(labels, ["5h", "本周"], `实际: ${labels.join(",")}`);
  assert.equal(st.windows[0].usedPercent, 25);
  assert.equal(st.windows[1].usedPercent, 10);
  assert.ok(st.windows[0].resetsAt, "应保留重置时间");
  assert.match(st.detail.note.zh, /lite/);
  assert.match(st.detail.note.en, /lite/);
  assert.equal(st.detail.unofficial, true, "非官方文档接口必须标明");
});

test("智谱 GLM：老账号的 TOKENS_LIMIT 也要认（否则老用户看不到数）", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const { deps } = makeAdapterDeps({
    respond: () => ({
      code: 200,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12 },
        ],
      },
    }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok", "老版 TOKENS_LIMIT 必须能解析");
  assert.equal(st.windows.length, 2);
});

test("智谱 GLM：忽略无关的 limit 类型（如 MCP 月度）", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const { deps } = makeAdapterDeps({
    respond: () => ({
      code: 200,
      data: {
        limits: [
          { type: "TIME_LIMIT", unit: 5, percentage: 99 },
          { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 25 },
        ],
      },
    }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.windows.length, 1, "TIME_LIMIT 不该混进窗口");
  assert.equal(st.windows[0].label, "5h");
});

test("智谱 GLM：code 500 表示 key 有效但无套餐，是状态不是故障", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const { deps } = makeAdapterDeps({ respond: () => ({ code: 500, msg: "no active plan" }) });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "unconfigured", "无套餐应报未配置，不该报 error");
  assert.match(st.message, /套餐/, `应提示没有生效套餐，实际: ${st.message}`);
});

test("智谱 GLM：裸 key 被拒后自动回退 Bearer", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const { deps, calls } = makeAdapterDeps({
    respond: (url, headers) => {
      if (!/^Bearer /.test(headers.Authorization)) return { code: 401 };
      return { code: 200, data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 7 }] } };
    },
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok", "裸 key 失败后应回退 Bearer");
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0].headers.Authorization, /^Bearer /, "第一次应是裸 key");
  assert.match(calls[1].headers.Authorization, /^Bearer /, "第二次应带 Bearer");
});

test("智谱 GLM：越界百分比保留原值并标记，不静默裁剪", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const { deps } = makeAdapterDeps({
    respond: () => ({
      code: 200,
      data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 150 }] },
    }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.windows[0].usedPercent, 100, "显示值夹到 100");
  assert.equal(st.windows[0].outOfRange, true, "必须标记越界");
  assert.equal(st.windows[0].rawPercent, 150, "必须保留原值");
});

test("OpenRouter：余额 = 总额度 - 已用，且要求 Management Key", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("openrouter");
  const { deps } = makeAdapterDeps({
    respond: () => ({ data: { total_credits: 20, total_usage: 7.5 } }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok");
  assert.equal(st.balance.amount, 12.5);
  assert.match(st.balance.display, /12\.50/);
  assert.match(st.detail.note.zh, /已用/);
  assert.match(st.detail.note.en, /used/);

  const { deps: d2, calls } = makeAdapterDeps({ key: null, respond: () => ({}) });
  const st2 = await a.fetch({}, d2);
  assert.equal(st2.status, "unconfigured");
  assert.match(st2.message, /MANAGEMENT_KEY/, "必须提示要 Management Key 而不是推理 Key");
  assert.equal(calls.length, 0);
});

test("三个公开适配器都只请求官方域名，不含任何本机地址", async () => {
  const mod = await loadPublicAdapters();
  const src = await readFile(new URL("./dsh/adapters-public.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /127\.0\.0\.1/, "公开适配器不能依赖本机服务");
  assert.doesNotMatch(src, /localhost/, "公开适配器不能依赖本机服务");
  for (const a of mod.PUBLIC_ADAPTERS) {
    assert.ok(Array.isArray(a.providers) && a.providers.length > 0, `${a.id} 必须声明接入名`);
    assert.ok(Array.isArray(a.credentialRefs) && a.credentialRefs.length > 0, `${a.id} 必须声明凭据名`);
  }
});

test("本机桥接端点可由配置覆盖（别人才能用）", async () => {
  const core = await loadHost();
  const seen = [];
  const stub = installFetch((rec) => {
    seen.push(rec.url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      body: null,
      async json() {
        return { usage: { rolling: { percent: 10, status: "ok" } } };
      },
    };
  });
  try {
    const ctx = makeCtx({ providers: ["ark"] });
    const registry = core.createRegistry(ctx, {
      getWebPort: () => 19387,
      endpoints: { ark: "http://127.0.0.1:19999/my-own-ark" },
    });
    await registry.loadAll(false);
    assert.ok(
      seen.some((u) => u.includes("19999")),
      `应请求配置的端点，实际: ${seen.join(", ")}`,
    );
    assert.ok(
      !seen.some((u) => u.includes("18901")),
      "配置了端点就不该再用内置默认值",
    );
  } finally {
    stub.restore();
  }
});

// ===============================================================
// 中英双语（发布版必备：英文用户不能看到中文界面）
// ===============================================================

test("英文环境下界面全英文，不残留中文", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("deepseek", "DeepSeek", ["deepseek"], {
        windows: [
          { label: "5h", usedPercent: 20 },
          { label: "本周", usedPercent: 60 },
        ],
        detail: { partial: true },
      }),
    ],
    unadapted: ["agnes"],
    registered: ["deepseek", "agnes"],
  });
  const env = await renderWith(payload, { route: "deepseek", lang: "en-US" });
  try {
    const collapsed = textOf(env.tree);
    assert.match(collapsed, /left/i, `英文界面应显示 "left"，实际: ${collapsed}`);
    assert.match(collapsed, /Week/, "窗口标签应本地化成 Week");
    assert.doesNotMatch(collapsed, /[\u4e00-\u9fa5]/, `收起态不应有中文，实际: ${collapsed}`);

    const expanded = await env.click(findAll(env.tree, byAttr("data-qr-main"))[0]);
    const all = textOf(expanded);
    assert.doesNotMatch(all, /[\u4e00-\u9fa5]/, `展开态也不应有中文，实际: ${all}`);
    assert.match(all, /Quota unavailable/, "无额度接口的文案也要英文");
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});

test("中文环境保持中文，不被英文污染", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("deepseek", "DeepSeek", ["deepseek"], { windows: [{ label: "本周", usedPercent: 60 }] }),
    ],
  });
  const env = await renderWith(payload, { route: "deepseek", lang: "zh-CN" });
  try {
    const text = textOf(env.tree);
    assert.match(text, /剩余/, `中文界面应显示「剩余」，实际: ${text}`);
    assert.match(text, /周/, "窗口标签应保持中文短标签");
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});

test("词典中英键集合完全一致（漏翻会立刻暴露）", () => {
  const src = clientSource;
  const start = src.indexOf("const DICT = {");
  const end = src.indexOf("let currentLang = null;");
  assert.ok(start > 0 && end > start, "应能找到词典块");
  const block = src.slice(start, end);
  const keysOf = (lang) => {
    const seg = block.slice(block.indexOf(`${lang}: {`));
    const stop = seg.indexOf("\n      },");
    const body = seg.slice(0, stop);
    return [...body.matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]).sort();
  };
  const zh = keysOf("zh");
  const en = keysOf("en");
  assert.ok(zh.length >= 15, `中文词条太少（${zh.length}），词典可能没解析到`);
  assert.deepEqual(en, zh, `英文缺这些键: ${zh.filter((k) => !en.includes(k)).join(", ")}`);
});

test("英文界面的余额/凭据类提示也不能是中文", async () => {
  const payload = snapshotPayload({
    providers: [
      stateFixture("moonshot", "Kimi", ["moonshot"], { status: "unconfigured", message: "未配置 MOONSHOT_API_KEY" }),
    ],
    registered: ["moonshot"],
  });
  const env = await renderWith(payload, { route: "moonshot", lang: "en-GB" });
  try {
    const text = textOf(env.tree);
    // host 给的 message 原文是中文，但状态文案必须走词典
    assert.match(text, /Not configured/, `应显示英文状态，实际: ${text}`);
    assert.doesNotMatch(text, /未配置/, "状态文案不该直接用 host 的中文原文");
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});

// ===============================================================
// 活体证据：用假密钥打真实接口得到的响应
//
// 这些**不是**我编的样例，是 2026-10-01 用 dummy key 真实请求
// 六个接口拿到的原始响应。它们证明：
//   1. 接口地址全部存在（没有一个 404）；
//   2. 智谱是「HTTP 200 + body 里藏 code:401」——这正是
//      adapters-public.js 里那段业务错误码判断要处理的情况；
//   3. 裸 key 认证头被智谱识别（回的是"令牌不正确"而非"格式错误"）。
//
// 用真实响应做断言，比用我自己造的样例强得多：上游一旦改了
// 错误结构，这里会失败。
// ===============================================================

/** 假密钥探测时拿到的真实响应（逐字抄录）。 */
const LIVE_PROBES = {
  zhipuCn: { http: 200, body: { code: 401, msg: "令牌已过期或验证不正确", success: false } },
  zhipuZai: { http: 200, body: { code: 401, msg: "token expired or incorrect", success: false } },
  kimiCn: { http: 401, body: { error: { message: "Invalid Authentication", type: "invalid_authentication_error" } } },
  openrouter: { http: 401, body: { error: { message: "Missing Authentication header", code: 401 } } },
};

test("活体：智谱 HTTP 200 里藏 code:401，必须识别为认证失败而不是当成功", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const { deps } = makeAdapterDeps({ respond: () => LIVE_PROBES.zhipuCn.body });
  const st = await a.fetch({}, deps);
  assert.notEqual(st.status, "ok", "code:401 绝不能当成取数成功");
  assert.equal(st.status, "error");
  assert.match(st.message, /无效|权限/, `应提示密钥问题，实际: ${st.message}`);
  assert.equal(st.windows.length, 0, "认证失败不该产出任何窗口");
});

test("活体：智谱两个域名都返回同一结构，说明双域名回退设计成立", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("zhipu");
  const seen = [];
  const { deps } = makeAdapterDeps({
    respond: (url) => {
      seen.push(url);
      return url.includes("bigmodel") ? LIVE_PROBES.zhipuCn.body : LIVE_PROBES.zhipuZai.body;
    },
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "error");
  assert.ok(seen.some((u) => u.includes("bigmodel.cn")), "应先试 bigmodel.cn");
  assert.ok(seen.some((u) => u.includes("api.z.ai")), "应回退 api.z.ai");
  assert.ok(seen.length >= 2, "两个域名都要试过");
});

test("活体：Kimi 的 401 结构化错误不会让适配器崩，且降级为明确状态", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("moonshot");
  const { deps } = makeAdapterDeps({ respond: () => LIVE_PROBES.kimiCn.body });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "error", "认证失败应是 error 状态");
  assert.ok(st.message, "必须有可读的失败原因，不能是空");
  // 401 body 里没有 data，绝不能因此抛出未捕获异常
  assert.equal(st.balance, null);
});

test("活体：OpenRouter 的 401 同样被降级，不会误报成余额 0", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("openrouter");
  const { deps } = makeAdapterDeps({ respond: () => LIVE_PROBES.openrouter.body });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "error");
  assert.equal(st.balance, null, "认证失败绝不能显示成 $0.00（那会让用户以为没钱了）");
});

// ===============================================================
// 声明式通路表（加厂商 = 加一行数据，不是加代码）
// ===============================================================

test("通路表结构完整：每条都有 id/label/providers/keyRefs/endpoint/format", async () => {
  const { CATALOG, _internals } = await loadPublicAdapters();
  assert.ok(CATALOG.length >= 8, `通路太少（${CATALOG.length}），可能没解析到`);
  const ids = CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "通路 id 不能重复");
  for (const c of CATALOG) {
    assert.ok(c.id && typeof c.id === "string", `${c.id} 缺 id`);
    assert.ok(c.label && typeof c.label === "string", `${c.id} 缺 label`);
    assert.ok(Array.isArray(c.providers) && c.providers.length > 0, `${c.id} 缺 providers`);
    assert.ok(Array.isArray(c.keyRefs) && c.keyRefs.length > 0, `${c.id} 缺 keyRefs`);
    assert.match(c.endpoint, /^https:\/\//, `${c.id} 的 endpoint 必须是 https 公网地址`);
    assert.ok(_internals.PARSERS[c.format], `${c.id} 的 format「${c.format}」没有对应解析器`);
  }
});

test("通路表不含任何本机地址（发布版硬要求）", async () => {
  const { CATALOG } = await loadPublicAdapters();
  for (const c of CATALOG) {
    const urls = [c.endpoint, ...(c.endpointFallbacks ?? [])];
    for (const u of urls) {
      assert.doesNotMatch(u, /127\.0\.0\.1|localhost|:\d{4,5}\//, `${c.id} 指向本机: ${u}`);
    }
  }
});

test("OpenCode Go 走公网地址，不再依赖本机 18900 代理", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("opencode-go");
  const { deps, calls } = makeAdapterDeps({
    respond: () => ({ usage: { rolling: { percent: 20, status: "ok" } } }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok");
  assert.match(calls[0].url, /opencode\.ai/, `应请求公网，实际: ${calls[0].url}`);
  assert.doesNotMatch(calls[0].url, /127\.0\.0\.1/);
});

test("硅基流动：解析 totalBalance，并标注充值余额", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("siliconflow");
  const { deps, calls } = makeAdapterDeps({
    respond: () => ({ code: 20000, data: { balance: 12.5, chargeBalance: 10 } }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok");
  assert.equal(st.balance.amount, 12.5);
  assert.equal(st.balance.currency, "CNY");
  assert.match(st.detail.note.zh, /充值/);
  assert.match(calls[0].url, /siliconflow\.cn/, "国内站优先");
});

test("中转站：解析预充值额度（quota.limit/used/remaining）", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("woyaopro");
  const { deps, calls } = makeAdapterDeps({
    respond: () => ({
      quota: { limit: 1200, used: 712.87712358, remaining: 487.12287642, unit: "USD" },
      remaining: 487.12287642,
      status: "active",
      unit: "USD",
      mode: "quota_limited",
      isValid: true,
      usage: { today: { actual_cost: 0.19478012, cost: 0.2017025 } },
    }),
  });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok");
  assert.equal(st.balance.display, "$487.12");
  assert.equal(st.balance.currency, "USD");
  // quota 是「预充值总额度」，不是时间窗——不该冒出一个假窗口
  assert.deepEqual(st.windows, [], "预充值额度不该被当成时间窗");
  assert.match(calls[0].url, /iiiiitoken\.com/, `实际请求: ${calls[0].url}`);
  // 光一个 $487.12 没法判断用了多少，必须说清「已用 / 总额度」
  const zh = st.detail.noteParts.map((p) => p.zh).join(" | ");
  assert.match(zh, /已用 \$712\.88/);
  assert.match(zh, /总额度 \$1200\.00/);
  assert.match(zh, /今日 \$0\.19/);
});

test("中转站：quota 缺失时用顶层 remaining 兜底（接口改版不静默失效）", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("woyaopro");
  const { deps } = makeAdapterDeps({ respond: () => ({ remaining: 12.5, unit: "CNY" }) });
  const st = await a.fetch({}, deps);
  assert.equal(st.status, "ok");
  assert.equal(st.balance.amount, 12.5);
  assert.equal(st.balance.currency, "CNY");
  assert.equal(st.balance.display, "¥12.50");
});

test("中转站端点可配置：换网关不用改代码", async () => {
  const { byId } = await loadPublicAdapters();
  const a = byId("woyaopro");
  const { deps, calls } = makeAdapterDeps({ respond: () => ({ remaining: 5 }) });
  const st = await a.fetch({}, { ...deps, endpoints: { woyaopro: "https://my-relay.example/v1/usage" } });
  assert.equal(st.status, "ok");
  assert.equal(calls[0].url, "https://my-relay.example/v1/usage", "config.endpoints 应覆盖内置地址");
});

test("第三方中转站要标出来源性质，不冒充厂商官方接口", async () => {
  const { byId, CATALOG } = await loadPublicAdapters();
  const a = byId("woyaopro");
  const { deps } = makeAdapterDeps({ respond: () => ({ remaining: 1 }) });
  const st = await a.fetch({}, deps);
  assert.equal(st.detail.thirdParty, true, "中转站必须带 thirdParty 标记");
  // 没标 thirdParty 的通路不该被误标
  const plain = byId("deepseek");
  const r2 = makeAdapterDeps({ respond: () => ({ balance_infos: [{ currency: "CNY", total_balance: 1 }] }) });
  const st2 = await plain.fetch({}, r2.deps);
  assert.notEqual(st2.detail.thirdParty, true, "官方通路不该被标成第三方");
  assert.ok(CATALOG.some((c) => c.thirdParty === true), "通路表里应能看到 thirdParty 声明");
});

test("未核实的通路必须带 unverified 标记（不假装可信）", async () => {
  // xAI 那条端点实测 404，已按用户要求删除。
  // 但「标记待核实」这个机制要留住——以后加不确定的通路时得能用。
  const { makeAdapter, CATALOG } = await loadPublicAdapters();

  // 内置通路都不该带 unverified（要么已核实，要么已删）
  const flagged = CATALOG.filter((c) => c.unverified === true);
  assert.equal(
    flagged.length,
    0,
    `已核实过的通路不该标 unverified：${flagged.map((c) => c.id).join(", ")}`,
  );

  // 机制本身可用：人为造一条未核实通路，取到数也必须带标记
  const probe = makeAdapter({
    id: "probe-unverified",
    label: "Probe",
    providers: ["probe"],
    keyRefs: ["PROBE_KEY"],
    endpoint: "https://example.invalid/balance",
    format: "siliconflow-balance",
    okCodes: [20000], // 硅基流动的成功码，不声明会被当成业务错误
    unverified: true,
  });
  const { deps } = makeAdapterDeps({ respond: () => ({ code: 20000, data: { balance: 1 } }) });
  const st = await probe.fetch({}, deps);
  assert.equal(st.status, "ok");
  assert.equal(st.detail.unverified, true, "未核实的通路取到数也要带标记");
});

test("每条通路的解析器都能拒绝垃圾输入而不抛异常", async () => {
  const { CATALOG, _internals } = await loadPublicAdapters();
  const junk = [null, undefined, {}, [], "string", 42, { code: 401 }];
  for (const c of CATALOG) {
    const parser = _internals.PARSERS[c.format];
    for (const j of junk) {
      let r;
      assert.doesNotThrow(() => {
        r = parser(j);
      }, `${c.id} 的解析器对 ${JSON.stringify(j)} 抛异常了`);
      assert.ok(r === null || typeof r === "object", `${c.id} 解析器返回值异常`);
    }
  }
});

test("字段名有两个来源时都认（接口改名不会静默失效）", async () => {
  const { byId } = await loadPublicAdapters();

  // Moonshot：官方文档写 available_balance，社区插件用 total_balance
  for (const field of ["available_balance", "total_balance"]) {
    const a = byId("moonshot");
    const { deps } = makeAdapterDeps({ respond: () => ({ data: { [field]: 7.5 } }) });
    const st = await a.fetch({}, deps);
    assert.equal(st.status, "ok", `Moonshot 用 ${field} 时应能解析`);
    assert.equal(st.balance.amount, 7.5, `Moonshot ${field} 数值应正确`);
  }

  // 硅基流动：社区插件用 balance，另一些实现用 totalBalance
  for (const field of ["balance", "totalBalance"]) {
    const a = byId("siliconflow");
    const { deps } = makeAdapterDeps({ respond: () => ({ code: 20000, data: { [field]: 3.25 } }) });
    const st = await a.fetch({}, deps);
    assert.equal(st.status, "ok", `硅基流动用 ${field} 时应能解析`);
    assert.equal(st.balance.amount, 3.25, `硅基流动 ${field} 数值应正确`);
  }
});


// ===============================================================
// 回归：i18n 取词函数被局部变量遮蔽
//
// 真实事故：resetText 里写了 `const t = Date.parse(iso)`，
// 把外层的 i18n t() 覆盖掉，随后 `t("reset.soon")` 抛
// "t is not a function"，整个组件崩掉、读数整行消失。
// 触发条件很隐蔽：只有当某个窗口带 resetsAt 时才走到那行。
// ===============================================================

test("带重置时间的窗口不会让组件崩掉（i18n 取词函数不被遮蔽）", async () => {
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const payload = snapshotPayload({
    providers: [
      stateFixture("ark", "Ark", ["ark"], {
        windows: [
          { label: "5h", usedPercent: 20, resetsAt: future },
          { label: "本周", usedPercent: 60, resetsAt: future },
        ],
      }),
    ],
    registered: ["ark"],
  });
  const env = await renderWith(payload, { route: "ark" });
  try {
    assert.notEqual(env.tree, null, "有重置时间时也必须渲染出来，不能整行消失");
    const text = textOf(env.tree);
    assert.match(text, /剩余/, `应有读数，实际: ${text}`);
    assert.match(text, /后重置/, `应显示重置倒计时，实际: ${text}`);
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});

test("重置时间已过期时也不崩（走的是另一条 t() 分支）", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const payload = snapshotPayload({
    providers: [
      stateFixture("ark", "Ark", ["ark"], {
        windows: [{ label: "5h", usedPercent: 20, resetsAt: past }],
      }),
    ],
    registered: ["ark"],
  });
  const env = await renderWith(payload, { route: "ark" });
  try {
    assert.notEqual(env.tree, null);
    assert.match(textOf(env.tree), /即将重置/, "过期应显示「即将重置」");
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});

// ===============================================================
// 语言判定必须看宿主，不只看浏览器
//
// 真实事故：系统语言是英文、DSH 界面是中文的用户，
// 整个插件变成了英文 —— 界面里唯一一块非中文，非常突兀。
// 根因：只读了 navigator.language，没读宿主写在
// document.documentElement.lang 上的真实界面语言。
// ===============================================================

test("系统英文 + DSH 中文 → 插件必须是中文（宿主优先）", async () => {
  const payload = snapshotPayload({
    providers: [stateFixture("ark", "Ark", ["ark"], { windows: [{ label: "本周", usedPercent: 60 }] })],
    registered: ["ark"],
  });
  // 这是用户真实遇到的组合：浏览器英文，DSH 中文
  const env = await renderWith(payload, { route: "ark", htmlLang: "zh-CN", navLang: "en-US" });
  try {
    const text = textOf(env.tree);
    assert.match(text, /剩余/, `DSH 是中文就该显示中文，实际: ${text}`);
    assert.doesNotMatch(text, /left/i, `不该因为浏览器是英文就切成英文，实际: ${text}`);
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});

test("系统中文 + DSH 英文 → 插件必须跟随 DSH 显示英文", async () => {
  const payload = snapshotPayload({
    providers: [stateFixture("ark", "Ark", ["ark"], { windows: [{ label: "本周", usedPercent: 60 }] })],
    registered: ["ark"],
  });
  const env = await renderWith(payload, { route: "ark", htmlLang: "en", navLang: "zh-CN" });
  try {
    const text = textOf(env.tree);
    assert.match(text, /left/i, `DSH 是英文就该显示英文，实际: ${text}`);
    assert.doesNotMatch(text, /剩余/, `不该因为浏览器是中文就切成中文，实际: ${text}`);
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});

test("宿主没给 lang 时才退回浏览器语言", async () => {
  const payload = snapshotPayload({
    providers: [stateFixture("ark", "Ark", ["ark"], { windows: [{ label: "本周", usedPercent: 60 }] })],
    registered: ["ark"],
  });
  const env = await renderWith(payload, { route: "ark", htmlLang: "", navLang: "en-US" });
  try {
    assert.match(textOf(env.tree), /left/i, "宿主没标语言时应看浏览器");
  } finally {
    env.restore();
    env.restoreNavigator();
  }
});
