# 安装风险评估：dsh-quota-radar

评估日期：2026-10-01（第二轮审计后更新）
评估依据：`MEMORY.md` 的「DSH 操作红线（2026-09-25 事故后确立）」
当前结论：**第二轮审计发现的问题已修复，并有变异测试守着；但真实宿主验收尚未进行，安装仍需单独确认。**

> ⚠️ **上一轮结论已撤回**。第一轮曾写「审计问题已修复并通过隔离测试」，随后独立复核发现：Ark 与前端在卸载时都没有真正取消请求、缺少总览、账号归属提醒从未渲染、凭据解析挂起会卡死整轮刷新、强制刷新仍能绕过退避。那些问题现已修复，但"测试通过"这件事本身也曾是假的——详见下方「测试有效性」。

---

## 一、四项必查项

### 1️⃣ 是否会动宿主共享依赖（`node_modules` 里的 `@deepseek-ai/*`）？

**✅ 不会。**

| 检查项 | 结果 |
|---|---|
| `dependencies` | **无**（零运行时依赖） |
| `devDependencies` | **无** |
| `peerDependencies` | `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver` |
| 两个 peer 是否 `optional: true` | **是**（写在 `peerDependenciesMeta`） |

插件只 import Node 内置模块（`node:fs/promises`、`node:os`、`node:path`），且用动态 `import()`。

> ⚠️ **诚实说明**：`optional: true` 表示安装器不会因缺少 peer 而报错，但**不构成"绝不会重解依赖树"的保证**。2026-09-25 事故的根因正是 pnpm 解析升级了宿主共享包。因此安装前**必须**备份并核对版本差异。

### 2️⃣ peer 依赖与宿主版本的兼容性？

**✅ 兼容（已从源码确认接口存在）。**

| 项 | 值 |
|---|---|
| 宿主版本真源 | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/runtime.json` → `desktopVersion: "0.2.0-rc.2"` |
| 本插件 peer 写法 | `@deepseek-ai/dsh-host-webserver": ">=0.2.0-rc.1 <0.3.0"` |
| 是否满足 | ✅ `0.2.0-rc.2` 落在区间内 |
| `@deepseek-ai/cordis` | `~4.0.4` |

**已从宿主源码逐条确认的接口：**

| 接口 | 源码位置 | 确认结果 |
|---|---|---|
| `ctx.llm.listProviders()` | `dsh-llm/lib/index.js:1899` | 返回 `[{...provider}]`，含 `id` / `name` |
| `ctx.webServer.register()` | `dsh-host-webserver/lib/index.js:177` | **返回 disposer，不自动挂 fiber** |
| `ctx.webServer.port` | 同上 `:164` | getter，返回实际监听端口 |
| `credentials.resolve(ref)` | `dsh-credentials-local/lib/index.js` | 返回 `{value, source}` 或 `undefined` |
| `ctx.interval/timeout/effect` | `cordis-plugin-timer/lib/index.js` | 回调形式返回 disposer，挂 fiber |
| webServer 监听范围 | 配置 schema `:142` | 仅 `127.0.0.1` 或 `0.0.0.0`，实测为 loopback |

**为什么用区间而不是精确 pin**：DSH 的版本门禁（`dsh-app-boot/lib/index.js:930-945`）在 peer 不匹配时会把 bundle **静默推进 `skippedBundles`**，不抛错。精确 pin 会让插件在宿主小版本升级后无声消失。

### 3️⃣ 是否需要重启宿主？重启是否中断当前会话？

**⚠️ 部分需要。**

| 动作 | 是否需要重启 |
|---|---|
| **安装插件本身** | ✅ 需要重启 DSH 应用 |
| 之后改 `cordis.patch.yml` 的 config | ❌ 热生效 |
| 之后改 `dsh/client.js` | ❌ 只需刷新页面（`Cmd+Shift+R`） |
| 之后改 `dsh/index.js` | ✅ 需要重启应用 |

**中断影响**：重启会中断当前会话。建议在**没有正在跑的 agent 任务**时安装。

### 4️⃣ 回滚路径是否明确？

**✅ 明确。**

安装前必须备份（红线要求）：

```bash
cd ~/.dsh/profiles/desktop
TS=$(date +%Y%m%d-%H%M%S)
cp package.json "package.json.bak-$TS-before-quota-radar"
cp pnpm-lock.yaml "pnpm-lock.yaml.bak-$TS-before-quota-radar"
cp cordis.patch.yml "cordis.patch.yml.bak-$TS-before-quota-radar"
```

回滚三层粒度：

1. **只禁用**：插件页面关掉开关，或从 `package.json` 的 bundles 移除 `dsh-quota-radar`
2. **删配置**：`cordis.patch.yml` 里删掉 `- id: quota-radar`（本插件只 insert 这一行）
3. **完整还原**：`cp` 回三个 `.bak` 文件 → 重启

**本插件不写任何持久化文件**，卸载时主动停止轮询、中止在途请求、释放缓存、注销路由。

---

## 二、第二轮审计问题的修复情况

独立复核（不读真实凭据、不安装）确认了 6 个具体问题。修复状态：

| 优先级 | 问题 | 状态 | 验证方式 |
|---|---|---|---|
| P1 | **Ark 卸载时不取消请求**：适配器没把取消信号传下去，请求跑满 12s 超时才结束 | ✅ 已修复 | 测试在 `dispose()` 后**同步**断言 `signal.aborted === true`，并断言耗时 < 1s |
| P1 | **前端卸载时不取消请求**：`AbortController` 建在 `fetchSnapshot` 内部，cleanup 拿不到 | ✅ 已修复 | controller 上提到 effect 作用域；测试挂载后卸载，断言在途请求被 abort |
| P1 | **测试假通过**：取消测试写成 `await pending` 再断言，注入 bug 仍全绿 | ✅ 已修复 | 新增 `verify-tests-catch-bugs.mjs` 变异测试，15 个变异体全部被抓到 |
| P1 | **测试不隔离**：OpenCodex 测试会读真实 `~/.opencodex/admin-api-token`，且断言接受任意状态 | ✅ 已修复 | 加 `readToken` 接缝；测试断言精确数值（28.5 / 28），不再接受「任意状态都行」 |
| P2 | **凭据解析挂起会卡死整轮**：`credentials.resolve` 无期限，`inFlight` 永不复位 | ✅ 已修复 | 凭据 5s、token 读取 5s、每个适配器 15s 硬期限；测试模拟永不返回的 resolver |
| P2 | **强制刷新绕过失败退避**：`force` 直接跳过 `expiresAt` | ✅ 已修复 | 退避期间强刷无效；测试模拟 10 分钟强刷 38 次，断言实际请求 ≤ 10 次 |
| P2 | **WorkBuddy 越界未校验**：`remain > size` 会算出「剩余 200%」 | ✅ 已修复 | 走统一 `pct()`；测试断言 `usedPercent` 落在 0..100 且 `outOfRange === true` |
| P2 | **账号归属提醒从未显示**：数据里有 `bindingNote`，界面不渲染 | ✅ 已修复 | 提醒进入 tooltip + 主行 `?` 标记；测试真实挂载组件后断言 tooltip 内容 |
| P2 | **缺少总览**：只有当前模型一行，看不到全部已接入服务 | ✅ 已修复 | 点击展开总览面板；测试断言面板含全部 provider 与 unadapted 项 |
| P2 | **已接入但无额度接口时整行消失** | ✅ 已修复 | 显示「暂不提供额度」；测试断言该节点存在 |
| P3 | **OpenCodex 旧数据冒充实时**：忽略上游 `updatedAt`，不完整聚合不标记 | ✅ 已修复 | 保留上游采样时刻；超 30 分钟标 `stale`；`partial` 标记逐窗口透出 |
| P3 | **跨源可读**：只带固定头、无 cookie 的外部来源能读到数据 | ✅ 已修复 | Origin 存在时必须与本机 Host 完全一致；测试断言外部 Origin 返回 403 |
| P3 | **provider 改名后匹配不上**：快照 `routes` 用缓存旧值 | ✅ 已修复 | 快照跟随当前接入刷新；测试模拟 `ark → ark-coding` |
| P3 | **路由清理挂在父 ctx**：宿主重启 webServer 服务后路由残留，重新注入报 duplicate route | ✅ 已修复 | 清理登记到注入作用域；测试断言作用域销毁后路由释放且可重新注入 |

### 测试有效性（这是本轮最重要的改动）

第一轮 26 项测试全绿，但功能没修好。所以现在多了一道验证：

```bash
node verify-tests-catch-bugs.mjs
```

它把每个已修复的 bug **重新注入回去**，检查对应测试是否会失败。一条测试只有「装回 bug 就挂」才算有效。

当前：**15 个变异体全部被抓到**。

**这不能证明什么**：它只证明测试对**已知的** bug 敏感，不能证明没有未知 bug。

---

## 三、安全设计（含重要事实）

### 宿主鉴权边界（已从源码确认）

宿主的启动令牌 + 签名 cookie 鉴权（`dsh-client-connection/lib/index.js:388` `authorizeIndex`）**只保护首页 HTML**。

实测验证：

```
GET /                                        → 401
GET /plugins/dsh-connect-workbuddy/usage     → 200   ← 插件路由不受该鉴权保护
```

**结论：任何 webServer 插件路由对本机所有进程可达。** 因此本插件自带防护层：

| 防护 | 做法 |
|---|---|
| 来源校验 | 要求自定义头 `x-quota-radar: 1`；跨站简单请求无法携带自定义头，预检被拒 |
| `sec-fetch-site` | 非 `same-origin` / `none` 拒绝 |
| **Origin 同源校验** | Origin 存在时必须与本机 Host 完全一致，否则拒绝（第二轮补上） |
| 方法白名单 | 仅 GET |
| 缓存 | `no-store` + `nosniff` |
| 重定向 | `redirect: "error"`，带 Bearer 的请求不跟随 |
| 刷新限流 | 强制刷新 15s 最小间隔，且不能绕过失败退避 |

> 这一层是**本插件自己的防护**，不是宿主提供的。
>
> **边界要说清楚**：它防的是**浏览器跨站请求**。它**不防本机其他进程**——本机任意程序都能直接带上正确的头访问这个路由。要做到那一步需要宿主层面的鉴权，插件做不到。
>
> 所以这条路由只暴露「余额/额度」这类低敏感只读数据，**不暴露任何凭据**。

### 密钥处理

- API Key 只在 host 侧通过 `credentials.resolve()` 取用，**不暴露给浏览器**
- 不写日志、不落盘、不外传
- 错误信息经脱敏后才出网（测试验证：错误里不含密钥片段，且「读取 token 超时」这类中文诊断不会被误伤）
- OpenCodex admin token 先检查文件大小（≤4KB）再读，且读取有 5s 期限
- WorkBuddy 完全复用 `dsh-connect-workbuddy` 的现成路由，本插件不碰它的凭据

---

## 四、OOM 风险的诚实表述

**已做到的**：

| 机制 | 值 |
|---|---|
| session/缓存文件读取 | **代码中 0 处** |
| 流量 hook | **0 处** |
| 响应体上限 | 256KB，流式读取，超限立即断开 |
| 分片数上限 | 4096 |
| 历史容量 | 环形缓冲 120 点/provider |
| 请求超时 | host 12s / client 10s |
| 单轮硬期限 | 15s（防凭据挂起卡死整轮） |

**不能说做到的**：

- `payload.approxBytes` 只是**序列化长度估算**，不是进程 RSS，也不是插件真实堆占用。用它断言"占用 < 20MB"没有意义。
- 上一版插件崩溃的**根因未经证实**。121.9MB JSONL 全量解析的实验证明了该模式危险，但不能证明那就是上次崩溃的原因。
- **长时间运行的内存行为未实测**。需要装后观察趋势。

---

## 五、安装步骤（待用户确认后执行）

```bash
# 1. 备份（红线要求）
cd ~/.dsh/profiles/desktop
TS=$(date +%Y%m%d-%H%M%S)
cp package.json "package.json.bak-$TS-before-quota-radar"
cp pnpm-lock.yaml "pnpm-lock.yaml.bak-$TS-before-quota-radar"
cp cordis.patch.yml "cordis.patch.yml.bak-$TS-before-quota-radar"

# 2. 记录安装前依赖版本
ls -la node_modules/@deepseek-ai/ > /tmp/deps-before.txt

# 3. 通过 DSH 界面安装
#    侧边栏「插件」→「+ 添加插件」→ 粘贴：
#    link:<你 clone 下来的目录>  或  dsh-quota-radar
#    → 安装 → 立即启用 → 重启 DSH → 刷新页面

# 4. 装后核对依赖未被改动
ls -la node_modules/@deepseek-ai/ > /tmp/deps-after.txt
diff /tmp/deps-before.txt /tmp/deps-after.txt && echo "✅ 依赖未变"
```

---

## 六、装后验收清单

**基础**

- [ ] DSH 正常启动，未崩溃
- [ ] `diff` 显示宿主 `@deepseek-ai/*` 无变化
- [ ] 插件页面显示为已启用

**功能**

- [ ] 切到 Ark 模型 → 显示三窗口剩余%
- [ ] 切到 OpenCode Go → 显示三窗口
- [ ] 切到 WorkBuddy → 显示月度包 + 积分（标注"非人民币"）
- [ ] 切到 DeepSeek → 显示余额
- [ ] 切到 agnes（已接入但无额度接口）→ 显示"暂不提供额度"
- [ ] 切到未接入的模型 → **不显示**
- [ ] **点一下读数 → 展开总览，能看到全部已接入服务**
- [ ] 走 `workbuddy2api` 时 → 主行有 `?`，hover 有"未独立验证"

**安全与降级**

- [ ] 无自定义头的 `curl` 返回 403
- [ ] `curl -H "x-quota-radar: 1"` 返回 200
- [ ] 带外部 `Origin` 的请求返回 403
- [ ] 停掉 18901 → Ark 显示"读取失败"，其它不受影响，DSH 不崩
- [ ] 错误信息中不含任何密钥片段

**资源（2 小时后）**

- [ ] `/quota-radar/snapshot` 的 `payload.approxBytes` 不单调增长
- [ ] 活动监视器里 DSH 主进程内存无异常增长
- [ ] 页面切到后台再回来，读数能恢复刷新

**卸载**

- [ ] 移除插件后 DSH 正常
- [ ] `curl` 路由返回 404（已注销）
- [ ] 无残留文件

---
