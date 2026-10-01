# dsh-quota-radar · 模型余额雷达

> 在 DSH composer 工具栏里实时显示**已接入** provider 的余额 / 额度，跟随当前模型自动切换。未接入的不显示。

---

## 这是什么

在 DSH 对话框的模型选择器**左侧**加一行读数。切到 Ark 就显示 Ark 的三窗口，切到 OpenCode Go 就显示 Go 的三窗口，切到没接入的 provider 就**什么都不显示**。

点一下这行读数会展开**总览面板**，列出所有已接入的服务；已接入但没有额度接口的（如 `agnes`）也会列出来并标注「暂不提供额度」，而不是凭空消失。

**为什么贴着模型选择器**：因为"切模型时哪个还能用"这个判断就发生在那个视野内。做成一个要点开的面板，就失去了意义。

---

## 支持的 provider

分两类。**A 类是给所有人用的**，只请求厂商官方域名，装上就能用；**B 类依赖你本机跑的服务**，默认按本机端口试，连不上会明确告诉你，不会静默失败。

### A 类 · 公开接口（任何人都能用）

**加厂商 = 在 `CATALOG` 里加一行数据，不用改解析逻辑。**

| Provider | 接入名 | 凭据名 | 显示 | 接口 |
|---|---|---|---|---|
| **DeepSeek** | `deepseek` | `DEEPSEEK_API_KEY` | `¥4.44` | `api.deepseek.com/user/balance` |
| **Kimi** | `moonshot` `kimi` | `MOONSHOT_API_KEY` | `$12.35`（赠金/现金分列） | `api.moonshot.cn/v1/users/me/balance` |
| **Kimi Code** | `kimi-coding` | `KIMI_CODING_API_KEY` | 5h / 周窗 | `api.kimi.com/coding/v1/usages` |
| **智谱 GLM** | `zhipu` `glm` `bigmodel` | `ZHIPU_API_KEY` | `5h 剩余 75% · 本周 剩余 90%` | `open.bigmodel.cn/api/monitor/usage/quota/limit` |
| **OpenRouter** | `openrouter` | `OPENROUTER_MANAGEMENT_KEY` | `$12.50` | `openrouter.ai/api/v1/credits` |
| **硅基流动** | `siliconflow` | `SILICONFLOW_API_KEY` | `¥12.50` | `api.siliconflow.cn/v1/user/info` |
| **MiniMax** | `minimax` | `MINIMAX_API_KEY` | 套餐余量 | `api.minimaxi.com/v1/token_plan/remains` |
| **阶跃星辰** | `stepfun` | `STEPFUN_API_KEY` | `¥12.50` | `api.stepfun.com/v1/accounts` |
| **OpenCode Go** | `opencode-go` | `OPENCODE_GO_API_KEY` | `5h 剩余 100% · 本周 剩余 94%` | `opencode.ai/zen/go/v1/usage` |

**全部端点已用假密钥实测存在**（2026-10-01）：没有一个返回 404，全是认证类错误，证明地址正确。

> xAI 的 `api.x.ai/v1/billing/credits` 实测返回 404（端点可能已变更），已**移除**——宁可少一个厂商，也不显示错数字。

**关于 Qwen / 通义千问**：阿里百炼没有公开的余额接口。扒了 10 个社区同类插件，**没有任何一个支持** —— 不是遗漏，是上游没这个能力。

#### 几个容易踩的坑（都已处理）

- **成功码各家不统一**：智谱 `200`、硅基流动 `20000`、多数网关 `0`。写死「不是 200 就是错」会把硅基流动的成功响应当成失败。按通路声明 `okCodes`。
- **字段名有多个来源**：Moonshot 官方文档写 `available_balance`，社区实现用 `total_balance`；硅基流动 `balance` vs `totalBalance`。**两个都认**，否则接口改名会静默失效。
- **智谱认证头无官方说明**：社区两派（裸 key / Bearer）都能跑通 → 先裸 key，401 回退 Bearer。
- **智谱新旧账号 `type` 不同**：`CREDIT_LIMIT`（新）/ `TOKENS_LIMIT`（旧），只认一个会让一半用户看不到数。
- **OpenRouter 要 Management Key**，不是推理用的 `OPENROUTER_API_KEY`。

### B 类 · 本机服务（默认端口，可用配置覆盖）

| Provider | 接入名 | 显示 | 默认接口 | 配置项 |
|---|---|---|---|---|
| **Ark 火山方舟** | `ark` `volcengine` | `5h 剩余 21% · 本周 剩余 60% · 本月 剩余 34%` | `127.0.0.1:18901/ark-coding-plan` | `endpoints.ark` |
| **WorkBuddy** | `workbuddy` `codebuddy` | 最紧月度包剩余% + 总积分 | `<宿主端口>/plugins/dsh-connect-workbuddy/usage?region=cn` | 需装 `dsh-connect-workbuddy` |
| **WorkBuddy 全球** | `workbuddy-global` | 同上（国际版账号） | 同上 `region=global` | 同上 |
| **OpenCodex** | `opencodex` | 各上游 provider 的 5h / 本周剩余% | `127.0.0.1:10100/api/provider-quotas` | `endpoints.opencodex` |

**Ark 为什么必须走本机桥**：方舟额度只在控制面（OpenTOP）提供，鉴权是 SSO（V4 签名 + `X-Security-Token`），API Key 做不到。数据面带真实 key 实测 `/api/v3/balance` 与 `/api/v3/usage` 均 404，而 `/api/v3/models` 是 200。所以这类适配器需要你本机有一个桥；没有就显示「不可达」，并告诉你去哪配。

### 配置端点

```yaml
# cordis.patch.yml 或 profile 的插件配置
- id: quota-radar
  name: dsh-quota-radar
  config:
    endpoints:
      ark: http://127.0.0.1:18901/ark-coding-plan
      opencodex: http://127.0.0.1:10100/api/provider-quotas
```

### 只显示已接入的

插件启动时通过 DSH 的 `llm.listProviders()` 读取**实际注册的 provider 路由**，只对匹配上的数据源取数。

- 没接入的 provider **不会被查询**，也就不会去读它的凭据。
- 已接入但没有额度接口的 provider（如 `agnes`）会出现在总览里，标注「暂不提供额度」。
- 读不到注册表时**保守处理**：不取任何数。宁可什么都不显示，也不乱查。

### 前置依赖

- **Ark**：需要一个本机桥接提供额度（默认 `127.0.0.1:18901`，可用 `endpoints.ark` 改）。
- **WorkBuddy**：需要 `dsh-connect-workbuddy` 插件已装且已登录（它负责 token 刷新，本插件不碰密钥）。
- **OpenCodex**：需要本机网关（默认 `127.0.0.1:10100`，可用 `endpoints.opencodex` 改）。
- **DeepSeek / Kimi / GLM / OpenRouter 等**：只需要对应的 API Key。

**任何一条不通，只影响那一条**，其它照常显示。

### ⚠️ 账号归属：有一条不确定

`workbuddy2api` 是本地 8200 代理，它读的是同一套 WorkBuddy 凭据，但**「代理账号 == WorkBuddy 国内账号」这一点没有独立证据**。

所以当你用的模型走的是这条代理路由时，读数会带一个 `?` 标记，hover 里写明「额度归属未独立验证」。

**实际影响**：如果你有多个 WorkBuddy 账号，这里显示的可能是另一个账号的积分。请以 WorkBuddy 官方界面为准。

---

## 安装

### 桌面端

1. 侧边栏点 **插件**
2. 点 **+ 添加插件**，粘贴：
   ```
   dsh-quota-radar
   ```
3. **安装** → **立即启用**

> 从源码装用 `link:<你 clone 下来的目录>`。
4. 重启 DSH 应用，然后刷新页面（`Cmd+Shift+R`）

> ⚠️ 改 host 半边（`dsh/index.js`）后需要**重启 DSH 应用**；改 client 半边（`dsh/client.js`）后只需**刷新页面**。

### 卸载

插件页面移除即可。本插件不写任何持久化文件，卸载时：

- 停止轮询定时器
- **中止在途 HTTP 请求**（AbortController）
- 释放缓存与历史
- 注销 webServer 路由

> 关于「中止在途请求」：这条曾经是**假的**——Ark 适配器没把取消信号传下去，前端也没在卸载时 abort，请求实际会跑满 12 秒超时。现已修复，并且有专门的测试在守着（见「测试」一节）。

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│ DSH 前端 (React)                                     │
│  conversation.composer.dock 槽 ← 一行读数（对话框下方）│
│    · 只显示当前选中模型对应的服务，不做全量总览          │
│    · 字号/行高复用宿主 CSS 变量，与「缓存命中 / Token    │
│      速度 / 上下文」那组指标完全一致                     │
│    · 订阅 ctx.modelDirectories 跟随当前模型              │
│    · 60s 轮询 + 单飞 + 10s 超时                          │
│    · 页面隐藏时暂停轮询                                   │
│    · 卸载时真正 abort 在途请求                            │
│    · 失败时整行隐藏，不刷屏                               │
└──────────────┬──────────────────────────────────────┘
               │ 同源 fetch（相对路径 + 自定义头）
               │ GET /quota-radar/snapshot
               ▼
┌─────────────────────────────────────────────────────┐
│ DSH Host (Node) — 本插件                              │
│  · llm.listProviders() 发现实际接入 → 只查匹配的适配器 │
│  · 60s 轮询 + 30s TTL + 指数退避(5s→15min) + 单飞     │
│  · 每轮 15s 硬期限（凭据解析挂起也不会卡死整轮）        │
│  · 环形缓冲 120 点/provider（内存恒定）                │
│  · webServer 路由：/snapshot、/history                │
│    （GET + 自定义头 + Origin 同源校验）                │
└──────────────┬──────────────────────────────────────┘
               │ 小 JSON HTTP GET（只读，不跟随重定向）
               ├─→ 9 条公开通路：api.deepseek.com / api.moonshot.cn /
               │     open.bigmodel.cn / openrouter.ai / api.siliconflow.cn /
               │     api.minimaxi.com / api.stepfun.com / api.kimi.com /
               │     opencode.ai（只请求厂商官方域名）
               └─→ 本机通路（默认端口，可配置）：
                     18901 Ark 桥接 · 10100 OpenCodex · <宿主端口> WorkBuddy
```

### 统一状态形状

所有 provider 都归一成同一个 `QuotaState`，**UI 只认它、不认 provider**：

```ts
{
  provider: string,
  label: string,
  routes: string[],          // 该适配器服务的 DSH route id（跟随实际接入刷新）
  status: "ok" | "unconfigured" | "unsupported" | "error",
  windows: [{
    label, usedPercent,
    resetsAt,
    outOfRange?, rawPercent?,  // 越界时保留原值
    partial?,                  // 部分账号未纳入统计
    sourceAt?                  // 上游自己的采样时刻
  }],
  balance: { amount, currency, display } | null,
  detail: {
    unitNote?, aggregationNote?, partialNote?, bindingNote?,
    sourceAgeMs?, accounts?
  } | null,
  updatedAt: number,
  stale: boolean,            // 数据过期或取数失败后保留的上次成功值
  message: string | null     // 已脱敏
}
```

### 状态语义（诚实降级）

| status | 显示 |
|---|---|
| `ok` | 数字 |
| `unconfigured` | "未配置" |
| `unsupported` | "该网关不提供额度接口" |
| `error` | "读取失败" + hover 看原因 |

**禁止编造数字。** 拿不到就说拿不到。

---

## 数值语义（重要）

这是最容易看错的地方，逐条说明：

| 场景 | 显示 | 说明 |
|---|---|---|
| 百分比窗口 | `剩余 X%` | 上游给的是**已用**百分比，插件换算成剩余。hover 里显示已用值 |
| WorkBuddy 积分 | `4221 积分` | **单位是积分，不是人民币** |
| OpenCodex | 各上游 5h/本周剩余% | 取自 `/api/provider-quotas`。**是多账号聚合值，不是单一账号余额**，hover 里有说明 |
| DeepSeek | `¥4.44` | 真实货币余额 |
| 越界百分比 | `剩余 0% ⚠` | 上游给 150% 这类异常值时，**保留原始值并打警示**，不静默裁剪 |
| 统计不完整 | `剩余 72%部分` | 聚合只统计了部分账号，数值不完整 |
| 数据过期 | `⏱` | 上游采样超过 30 分钟，hover 里写明多久没更新 |
| 账号归属未验证 | `?` | 走代理别名接入，hover 里写明原因 |

---

## 内存与资源设计

上一版插件据称因全量读缓存 + 抓流量导致崩溃。本插件从架构上禁止这两类动作。

### 已知的量化风险

某些本地缓存文件可能非常大，全量 `JSON.parse` 会吃掉大量堆内存。

**余额只是 1KB 级的数据，读那些是纯粹的架构错误。** 所以本插件的设计红线是：只做小 JSON 的 HTTP GET。

> 说明：这是**风险量化实验**，证明该模式危险。它**不能证明**上一版插件崩溃的根因就是它——那个结论需要崩溃日志或源码证据，目前没有。

### 四条硬约束

1. **不读 session 日志 / 缓存文件** —— 只做小 JSON 的 HTTP GET。
2. **不抓流量 / hook 请求体** —— 宿主 UI 与 agent loop 与本插件同进程。
3. **所有历史结构有硬上限** —— 环形缓冲 120 点/provider。
4. **响应体在读取阶段限制 256KB** —— 不是先全读进内存再检查。

### 资源保护

| 机制 | 值 |
|---|---|
| 响应体上限 | **256KB**（流式读取，超限立即断开并 cancel） |
| 分片数上限 | 4096（防大量极小 chunk） |
| 请求超时 | 12s（host）/ 10s（client） |
| 单轮硬期限 | **15s**（每个适配器独立计时） |
| 凭据解析期限 | **5s** |
| token 读取期限 | **5s** |
| 失败退避 | 5s → 15min（指数，上限 32 次） |
| 强制刷新限流 | 15s 最小间隔，**且不能绕过失败退避** |
| 单飞 | host 全轮 + client 各自 |
| 历史容量 | 120 点/provider |
| 在途取消 | 卸载时 AbortController（host + client 都有测试守着） |

### 关于内存数字

插件提供一个自检字段 `payload.approxBytes`，但**它只是序列化长度估算，不是进程 RSS，也不是插件真实堆占用**。

用它观察**趋势**（是否单调增长）有意义，用它断言"插件占用 < 20MB"没有意义。

---

## 安全

| 项 | 做法 |
|---|---|
| 监听范围 | webServer 只绑 `127.0.0.1`（宿主配置） |
| CSRF | 要求自定义头 `x-quota-radar: 1`。跨站简单请求无法携带自定义头，预检被拒 |
| 来源校验 | 检查 `sec-fetch-site`，非 same-origin/none 拒绝 |
| 跨源校验 | **Origin 存在时必须与本机 Host 完全一致**，否则拒绝 |
| 方法白名单 | 仅 GET |
| 缓存 | `cache-control: no-store` |
| 重定向 | `redirect: "error"` —— 带 Bearer 的请求不跟随重定向，防凭据外送 |
| 错误脱敏 | 上游错误经 `sanitizeMessage` 剥离 token / bearer / 长密钥串后才出网 |
| 凭据 | 只在 host 侧 `credentials.resolve()` 取用，不落盘、不写日志、不进浏览器 |
| token 文件 | 先 `stat` 检查大小（≤4KB）再读，不无界读入 |

> **注意**：宿主 webServer **没有全局鉴权**（源码确认）。上面的头校验与来源校验是本插件自己的防护层，不是宿主提供的。这也是为什么 force 刷新要限流——路由对本机任何进程可达。

---

## 已知限制

- **OpenCodex 显示的是多账号聚合值**，不是单一账号余额。hover 里有明确标注。
- **`workbuddy2api` 的账号归属未验证**：走这条代理路由时显示的积分可能属于另一个账号。
- **Ark 依赖外部桥接**：方舟额度只在控制面提供且必须 SSO，API Key 做不到（实测 `/api/v3/balance` 返回 404）。
- **历史数据不持久化**：只有内存里最近 120 点，重启即清空。刻意如此——避免引入落盘逻辑和相应的内存风险。
- **不做跨屏置顶 / 系统托盘**：DSH 没有对应槽位。
- **WorkBuddy 端口动态获取**：从 `ctx.webServer.port` 读取，不再硬编码。
- **测试未覆盖真实宿主**：见下节。

---

## 测试

```bash
# 行为测试
node --test audit-regression.test.mjs

# 验证这些测试是否真的有效（变异测试）
node verify-tests-catch-bugs.mjs
```

### 为什么要跑第二个命令

第一轮交付时 26 项测试全绿，但独立审计发现功能根本没修好。根因不是测试数量不够，而是**测试假通过**：

「卸载会取消请求」那条测试写成 `await pending` 之后再断言。注入 bug（Ark 不传取消信号）后它**依然通过**——因为请求是被它自己的 12 秒超时中止的，测试耗时 12014ms 却显示绿色。

所以现在多了一道验证：`verify-tests-catch-bugs.mjs` 会把每个已修复的 bug **重新注入回去**，检查对应测试是否会失败。一条测试只有「装回 bug 就挂」才算真的在验证行为。

当前状态：**15 个变异体全部被抓到**（输出 `✅ 全部变异体都被测试抓到`）。

### 测试覆盖

接入发现、路由防护（含 Origin 同源校验）、卸载取消（host + client 各自）、路由生命周期、错误脱敏、严格数值、越界百分比、历史污染、流式上限、非 2xx 清理、重定向防护、环形缓冲、凭据挂起、退避不被强刷绕过、OpenCodex 陈旧/不完整标记、前端真实渲染（读数 / 总览 / 暂不支持 / 陈旧标记 / 可见性暂停）。

### 这些测试**不能**证明什么

- 没有加载真实 Cordis 运行时（Cordis 的作用域生命周期是按契约模拟的）
- 没有验证真实宿主上的槽位渲染与模型切换
- 没有验证真实 `credentials.resolve()` 契约（已从源码确认返回 `{value, source}`）
- 没有验证长时间运行的内存行为
- **没有验证安装过程不会改动宿主依赖**

真实宿主验收必须在隔离环境单独进行，且安装前要备份。

---

## 调试

> 路由需要自定义头，curl 也要带上。同源请求不带 Origin 是正常的；带上 Origin 时必须与本机 Host 一致，否则会被拒。

```bash
# 看当前快照
# <DSH端口> 就是你打开 dsh web 的那个端口，在浏览器地址栏能看到
curl -s -H "x-quota-radar: 1" "http://127.0.0.1:<DSH端口>/quota-radar/snapshot" | python3 -m json.tool | head -40

# 强制刷新（15s 内重复调用会被降级；失败退避期间不会真的打上游）
curl -s -H "x-quota-radar: 1" "http://127.0.0.1:<DSH端口>/quota-radar/snapshot?force=1"

# 看某个 provider 的历史
curl -s -H "x-quota-radar: 1" "http://127.0.0.1:<DSH端口>/quota-radar/history?provider=ark"

# 只看某一家
curl -s -H "x-quota-radar: 1" "http://127.0.0.1:<DSH端口>/quota-radar/snapshot?provider=ark"
```

---

## 版本兼容

- 宿主：DSH desktop **0.2.0-rc.2**
- `peerDependencies` 里 `@deepseek-ai/dsh-host-webserver` 写的是 `>=0.2.0-rc.1 <0.3.0`，**故意用区间而不是精确 pin**——因为 `@deepseek-ai/dsh-*` 的版本不匹配时，DSH 会**静默跳过**整个 bundle（不报错），精确 pin 会让插件在宿主小版本升级后无声消失。
- `optional: true` 的 peer **不保证**安装器绝不会重解依赖树，安装前仍需备份并核对版本差异。

---

## License

MIT
