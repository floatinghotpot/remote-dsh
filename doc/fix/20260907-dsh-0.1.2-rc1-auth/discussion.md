# Discussion — dsh 0.1.2-rc.1 适配 + 版本兼容管理

> **日期**: 2026-09-07
> **状态**: 讨论已收敛，待 solution.md
> **涉及**: `packages/gateway`（spawn-dsh/proxy/join/serve）、`packages/web-remote`、`.github/workflows/ci.yml`、README（兼容表）
> **来源**: 复核结论见 `doc/review/20260907-dsh-0.1.2-rc.1-auth-gate-compat.md`（推翻 09-03 静态核验）
> **关联**: dsh4vscode `doc/fix/20260907-dsh-0.1.2-rc1-auth/record.md`（同款破坏实测，先于本仓库 4 天）

---

## 1. 触发与背景

- DeepSeek Harness 于 09-03 发布 0.1.2-rc.1（npm `next`）；09-07 实测 **`latest` 已指向 0.1.2-rc.1**——裸 `npm i -g @deepseek-ai/dsh` 即装到与 remote-dsh 不兼容的版本，属 **P0 现网默认路径风险**；
- dsh4vscode 于 09-07 实测 0.1.2-rc.1 暴露三层破坏（URL 带 token + Cookie 认证 / dist 布局 / Typert RPC），完成适配（v0.3.4）；
- remote-dsh 09-03 的静态核验（3 个硬点 + release notes）漏掉了运行期认证行为，结论失效。

## 2. 审计事实（remote-dsh × dsh 交互面盘点）

| # | 接触面 | 现状 | 版本敏感度 |
|---|---|---|---|
| 1 | `dsh web --port 0 --no-open` spawn | `spawn-dsh.ts`；就绪行 0.1.2 起带 `?token=`，正则不锚定行尾 → 端口仍能解析，token 被丢弃 | 低（非冻结，属 DSH 内部行为） |
| 2 | HTTP/WS 透传层 | index/assets/JS/WS 全字节透传，仅 `rewriteHeadersForDsh` 重写 Host/Origin；rdsh 不解析前端、不组装 dist | **版本无关**（hub 中继"每台机器不同 dsh 版本"的根基） |
| 3 | `patchLoopbackJs` | 字符串匹配 `isLoopbackHostname(pageLocation.hostname)`（`join.ts` L229）；0.1.2 client.js L4755 仍在 | 高（DSH 前端内部字符串，重构即失效） |
| 4 | web-remote 插件宿主 API | `connection.rpc.handle(channel,handler,{authority})` + 客户端 `rpc.call(channel,ep,{args})` + `cordis.patch.yml` loader row | 中（宿主 API 随版本演进） |

### 与 dsh 通信的三条路径（共享内核判定）

- **CLI serve**（LAN/云直连）：`serve.ts` spawn → `server.ts` `forwardHttp`/`createUpgradeProxy`（proxy.ts）；
- **CLI join**（隧道）：`join.ts` spawn + `startJoin` → `openStream`/`openWsStream` 转发；
- **web-remote 插件**（进程内）：`web-remote/src/index.ts` `startTunnel` → **`startJoin`（从 rdsh-gateway import，同一份 join.ts 内核）**，target = `127.0.0.1:ctx.webServer.port`。

**结论**：CLI join 与插件共享 `join.ts` 隧道内核 + `proxy.ts` 头重写（三方共用）；serve 与 join/插件仅最后一跳实现不同。**一个适配（cookie 注入点放共享转发层）覆盖全部三条路径**。

## 3. 实测证据（本机 dsh 0.1.2-rc.1，隔离 DSH_HOME，2026-09-07）

| 探测 | 结果 |
|---|---|
| `GET /`（无 cookie，网关转发形态） | **401** `dsh web authentication required` |
| `POST /api/workspace.list`（无 cookie） | **401** |
| WS upgrade `/api/remote.mux`（无 cookie） | **401** |
| `GET /?token=` 换发 | 303 + `Set-Cookie: dsh-auth-<sha256(127.0.0.1:<port>)>=v1…; HttpOnly; SameSite=Strict` |
| 换发后带 cookie `GET /` | **200** text/html |
| 带 cookie `POST /api/workspace.list` | 404（点号端点已废除，Typert 化佐证） |

### Q4 验证：插件宿主 shape 在旧线是否可用（npm tarball 0.1.1-rc.2）

| shape | 0.1.1-rc.2 | 0.1.2-rc.1 |
|---|---|---|
| 客户端 `rpc.call(channel,endpoint,{args})` | ✅ | ✅ |
| 服务端 `rpc.handle(...,{authority:"loopback"})` | ✅ | ✅ |
| 信封 client-request + rpcId + method + payload | ✅ 相同 | ✅ 相同 |
| launchToken / browserAuth（cookie 认证） | ❌ 无 | ✅ 新增 |

**结论**：0.1.1→0.1.2 **没有破坏插件用的 RPC 宿主 API**；唯一破坏 = 0.1.2 新增认证层拦截转发数据面（`/`、`/api`、WS），CLI 与插件同一转发路径一起中招。**不存在插件版本门；同一个适配修好两者。**

### npm registry 事实

- dist-tags：`latest = 0.1.2-rc.1`、`next = 0.1.2-rc.1`、`alpha = 0.1.3-alpha.2`；
- 0.1.1 线**只有 rc.1/rc.2**（无 rc.7——dsh4vscode 兼容表与 registry 不一致，以 registry 为准）；
- 兼容表应记录 **registry 实际存在的版本**。

## 4. 目标（用户三支柱）

1. **支持 dsh 0.1.2-rc.1**：cookie 认证适配（换发 + 注入），同时保持 0.1.1 线可用（就绪行无 token → 不换发，自适应）；
2. **版本提示（零文档导向）**：系统替用户判断版本——正常静默；真不兼容（运行时探测）或未实测版本（版本号 warn 兜底）才提示，给动作指令（升级 rdsh / 暂用某 dsh 版本），用户不查表；
3. **保证 latest remote-dsh ↔ latest dsh**：dsh 发版 → 回归冒烟（CI）→ 发现不兼容即修复。

## 5. 决策记录（讨论收敛项）

| # | 决策 | 说明 |
|---|---|---|
| D1 | **兼容机制 = 两者结合** | 行为探测决定工作方式（就绪行是否带 `?token=` → 换发；首个 `GET /` 200/401 验证）；版本号只用于门槛 + 提示/升级建议，不做硬兼容判断 |
| D2 | **未适配期 = warn 继续**（不硬拒） | serve/join spawn 前探测 dsh ≥ 0.1.2-rc.1（未适配时）→ 醒目警告 + 照常启动；适配后**不删**，固化为通用"新 dsh 版本未验证"提示（0.1.3/0.2.0 复用），避免"临时门适配后移除"的维护陷阱 |
| D3 | **提示带命令建议** | 按安装方式（PATH/全局 npm/npx）推断：降级 `npm i -g @deepseek-ai/dsh@0.1.1-rc.2` / 等待 `remote-dsh@latest`；复用 dsh4vscode `compareVersions`（semver + rc 后缀，MIT 同作者） |
| D4 | **版本兼容记录 = README 极简一行 + CHANGELOG 完整表**（Q1，后修正） | README 不再放兼容表（用户查表负担 + 随版本膨胀无读者）——只留极简一行 + "详见 CHANGELOG"；完整逐版表进 CHANGELOG（每组件一行、实测 dsh 版本单元格内逐个包裹、不用区间记号；每次发布追加，天然不膨胀 README） |
| D5 | **CI = GitHub Actions 版本矩阵冒烟**（Q2） | 仓库已有 `.github/workflows/ci.yml`（pnpm 9 + Node 22 + build/test）；扩展 dsh 版本矩阵 job：`[0.1.1-rc.2, 0.1.2-rc.1, 0.1.3-alpha.2]` × 隔离 DSH_HOME spawn → 换发 → 断言 `GET /` 200 而非 401。**第一阶段只做 CLI 数据面冒烟**（覆盖 401 类破坏 + 共享内核）；插件冒烟（cordis 装载 + `/remote-access/state` RPC）第二阶段 |
| D6 | **插件与 CLI 同项目同仓库，各自独立版本发布**（Q3） | CI 检测到任一不兼容即修（共享内核 → 通常一起修） |
| D7 | **入口 × 提示渠道** | CLI serve/join → spawn 前 stdout；插件面板 → 复用现有 `lastMessage` 机制；serve 配对/登录页 HTML 注入（可选）；hub portal 主机列表需 gateway 上报版本，**本期不做** |
| D8 | **通知 = GitHub issue 自动开（去重）+ GitHub 邮件** | 不建自建 SMTP；issue 留痕可回溯 + 可 assign；Actions 默认失败邮件发给"触发者"（schedule 时发给改 workflow 的人）不可靠。**去重**：key = dsh 版本号（**不含 rdsh commit**——兼容状态随 rdsh 演进红↔绿，固定 key 让转绿自动 close 正确命中）；创建前按 `[compat-ci] dsh <version>` 标题查 open issues，命中则跳过；标签 `compat-ci`；矩阵转绿自动 close 对应 issue（留痕不删）。一个版本一个 issue，多断言失败合并正文（同根因），不同版本各自 key（0.1.2 latest 优先修、0.1.3-alpha 前瞻可推迟） |
| D9 | **触发机制 = schedule 每日 dist-tag 变化检测 + push 时 current latest 冒烟** | 只 schedule 则适配 push 后隔天才验证；只 push 则 dsh 夜里发新版无人知。dist-tag 检测 job（每日，比较 npm `latest/next/alpha` 与记录，变化才跑全矩阵）+ push 时对 current latest 跑冒烟（常规回归门，2-3 分钟） |
| D10 | **冒烟基线 = 7 项无 key 断言** | 见 §6 冒烟基线。理由：rdsh 是传输层，承诺"经 rdsh 转发 = 直连语义不变"，非"dsh agent 能跑"；需要 API key 的完整会话是 dsh×LLM 契约，与 rdsh 无关，CI 也不该有 key（E2EE 下 hub 连密文都不解） |

## 6. 冒烟基线（D10，7 项无 key 断言）

| # | 契约点 | 断言 | 抓什么 |
|---|---|---|---|
| S1 | spawn | `dsh web --port 0 --no-open` 启动成功 | 破坏面外回归 |
| S2 | 就绪行解析 | 解析出端口；记录是否带 `?token=` | 版本行为差异（决定是否换发） |
| S3 | **认证路径（核心）** | 换发 `GET /?token=` → 303+Set-Cookie；带 cookie `GET /` → 200 | **本次 0.1.2 破坏** |
| S4 | `/api` 门 | 带 cookie POST `/api/…` → 非 401（404/400/200 均可） | 认证门放行（rdsh 不调用 dsh API，无需具体端点） |
| S5 | WS upgrade | 带 cookie upgrade `/api/remote.mux` → 101 | WS 通道认证 |
| S6 | 静态资源 | index 引用的 assets/plugins GET → 200 | 透传层可达 |
| S7 | **patch 命中** | 下载真实 client.js → `patchLoopbackJs(body) !== null` | DSH 前端重构导致 `trustE2EEAsLoopback` 静默失效（fail-open 不炸但功能悄悄没） |

不在范围：完整 agent 会话/模型往返（要 key）、浏览器真实渲染（要 headless，dsh 自身问题与 rdsh 无关）、dsh 自身功能 bug。

## 7. 待核实 / 开放问题

1. CI 冒烟 job 在 GitHub Actions runner 上 `npm i -g @deepseek-ai/dsh@<v>` 的多版本共存方式（matrix job 内各自隔离安装即可，无需共存）；插件冒烟（第二阶段）的真实 dsh 宿主装载方式待设计；
2. 插件进程内取 token：0.1.2 `ctx.connection.authenticatedUrl()` 是否存在/可调（solution 前在真实 0.1.2 宿主验证）；0.1.1 无此方法 → 行为探测分支（有则换发、无则跳过 cookie）；
3. README 兼容表双语同步（README.md + README.zh.md）。

*关联：doc/review/20260907-dsh-0.1.2-rc.1-auth-gate-compat.md（复核依据）｜ dsh4vscode doc/fix/20260907-dsh-0.1.2-rc1-auth/record.md（同款破坏实测）*
