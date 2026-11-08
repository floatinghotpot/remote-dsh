# 变更日志

[English](CHANGELOG.md) | **中文**

本文件记录项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [remote-dsh 0.22.0 · rdsh-gateway 0.18.0 · rdsh-hub 0.21.0 · rdsh-hub-cli 0.21.0 · rdsh-portal 0.4.0] - 2026-11-07

### 新增

- **重绑去重**（gateway、cli、hub）：`rdsh` 持久化每台设备的 `device_id` 并在 join 时上送；hub 按 `(owner, device_id)` 复用已有主机行（含已吊销的），解绑后重新绑定不再每次新建一条。吊销会记录来源（`user` / `admin`），只有 `user` 吊销可被设备复活。
- **主机启动状态**（gateway、hub、portal）：`POST /api/hosts/self/meta` 支持可选的 `status: "starting" | "ready"`。网关在进程启动时（`dsh` 启动之前）就报 `starting`，隧道连上后报 `ready`；hub 只存内存（5 分钟 TTL，隧道断开即清除），并由 `GET /api/hosts` 返回。门户在盒子 `dsh` 冷启动的约 30 秒里显示「启动中」而不是「离线」。

### 变更

- **吊销改为软删除**（hub、hub-cli）：吊销保留行（供后续重绑复用）但清空凭证；管理员吊销不可被设备复活。
- **`registerJoin` 提前到 `spawnDsh` 之前**（gateway）：首次状态上报不再等 `dsh` 就绪。

## [remote-dsh 0.21.0 · rdsh-gateway 0.17.0 · dsh-web-remote 0.15.0] - 2026-11-07

### 新增

- **主机元数据文件**（gateway、cli、web-remote）：`rdsh-meta.json`，由外层写在 `host.json` 同目录——`rdsh join` / `rdsh serve`（CLI）、插件首次连接、盒子安装流程（`rdsh-boxd --write-meta`）。gateway 只**读**它并上报到 `POST /api/hosts/self/meta`，不再在 `rdsh/device.json`、`dsh --version`、`/run/rdsh-boxd/status.json` 之间探测。

### 变更

- **`versions` 的键改为 npm 包全名**（gateway）：`remote-dsh`、`rdsh-gateway`、`dsh-web-remote`、`@deepseek-ai/dsh`、`rdsh-boxd`。旧键名有误导——`rdsh` 实际是 gateway 包版本，`gateway` 是 `"gateway"` / `"plugin"` 角色字符串而不是版本，插件版本则从未上报。
- **设备形态移入元数据文件**（gateway、cli）：`host.json` 不再带 `deviceKind`；`rdsh join --device-kind` 把它写进 `rdsh-meta.json`。
- **插件显示名**（web-remote，承接未发布的 0.14.2）：DSH 插件卡片与设置区显示 `WhaleLink` / `鲸语通`。

## [dsh-web-remote 0.14.2] - 2026-11-07

### 变更

- **插件显示名**：DSH 的插件卡片与设置区只显示品牌名——英文 `WhaleLink`、中文 `鲸语通`，不再带 `Voice` / `语音助手`；指南、插件模式博客与 App 内引导同步。

## [rdsh-gateway 0.16.1 · dsh-web-remote 0.14.1] - 2026-11-04

### 修复

- **插件收尾从未执行**（web-remote + gateway）：插件把收尾注册在 `ctx.on("dispose")` 上，而 Cordis 4 不会触发该事件，导致宿主关闭时隧道、局域网直连口（8442）与上报定时器从未被停掉。残留的监听口让宿主进程活过桌面端 10s 优雅窗口，in-app 升级被拒（`desktop update: Host did not complete graceful task teardown`）。现在收尾改走 `ctx.effect(...)`（宿主会 await），并加 `disposed` 守卫堵住 `autoConnect` 竞态。
- **最终用量上报有界**（gateway）：`UsageReporter.flush`/`stop` 与 `JoinHandle.stop` 增加可选 `timeoutMs`/`flushTimeoutMs`（默认不变）；收尾传 1.5s，hub 慢时不会把进程拖过关闭死线。`hubRequest` 同时支持 `AbortSignal`、且不再复用 keep-alive 连接池，在途上报可被中止、socket 即时释放。
- **重连定时器泄漏**（gateway）：退避重连的 `setTimeout` 现在会存句柄并在 `stop()` 时取消——隧道在退避期被停时，不再把进程最多再拉 60s。

### 变更

- **更正**（web-remote）：0.14.0 的「`dispose` 一并停掉直连口」挂在永不触发的 `dispose` 事件上、实际未生效；本版才真正修复，并配了「真实 Cordis 生命周期」与「`getActiveResourcesInfo()` 无残留」两条回归测试。

### 已知问题

- 启动 `autoConnect` 窗口内（开机后数秒），若恰逢关闭，在途的 `registerJoin` HTTP 请求仍可能把进程最多拖到其 10s 超时；已记录、暂不修（概率极低）。

## [rdsh-gateway 0.16.0 · rdsh-hub 0.20.0 · rdsh-hub-cli 0.20.0 · remote-dsh 0.20.0 · dsh-web-remote 0.14.0] - 2026-11-03

### 新增

- **产品分析**（hub）：`POST /api/analytics/event` 接收客户端事件（`app_open` / `purchase_start`），`event_id` 幂等、按 UTC+8 归日，累进 `analytics_daily` 与 `analytics_first_seen` 聚合；`GET /api/admin/analytics` 支撑管理台看板（付费留存队列、订阅漏斗、收入、流失、每日注册）。契约见 `packages/hub/API.md` §19。
- **云端语音路由**（hub、cli、portal）：语音计费落 `voice_usage_daily`（幂等水位 + 三段扣费）；`POST /api/voice/session` 签发短时效 ASR/TTS 票据；语音路由经 `/api/internal/voice/{routers/join,config,usage}` 注册并拉取封签配置。上游 key 增加 `service` / `credential_type` 与按供应商的凭据 schema（volcengine / aliyun / tencent / iflytek / baidu / minimax）；Router 与 join token 复用 `llm_routers` / `llm_router_join_tokens` 表并带 `service` 列。`rdsh-hub router --service` 及 `llm` / `voice` 别名；portal 渲染结构化 key 表单与 Router 类型列。
- **语音供应商配置**（hub、portal）：新增 `voice_provider_configs` 表（migration 0020），把供应商级参数（URL、resource id、音色列表）与 key 机密分离；没有配置行的供应商直接跳过。管理 API 新增 `upstream-providers`（供应商枚举 + 凭据 schema）、`upstream-provider-configs`（增删改查）、key `reveal`，以及 key 更新（label / weight / secret 重加密）。`GET /api/voice/config` 向 App 下发音色白名单。
- **权益文件**（hub）：`billing.entitlementsFile` 读取 App 的 `entitlements.json`（`levels.<档位>.package.{hosts,credits}`），订阅档主机数与每月赠点同源；文件缺失或格式错误直接启动失败，不再静默兜底。
- **细分活动状态**（gateway）：`activityOf` 上报 8 种（commands / edit / read / web / tools / subagents / plan / questions），详情取自进程头部。
- **加入后引导装服务**（cli）：扫码 join 成功后，`rdsh` 会询问是否安装主机服务并开启 `loginctl` linger，主机不再需要手动 `rdsh service install` 才能在退出登录后存活。

### 变更

- **WebView API v2**（gateway）：注入的 `window.__rdshWebViewApi` 将 `version` 升至 `2`；`readReply` 新增返回 `userText` / `reasoning` / `activity` / `rich` / `question`；`fillAndSend` 改用全局标记 `window.__rdshInserting` 表示插入窗口，取代内置键盘守卫。契约见 `packages/gateway/WEBVIEW_API.md`。
- **单例化 apply**（web-remote）：桌面壳会在同一进程 apply 本插件两次；`apply()` 现在只让第一个实例干活（第二个实例在注册任何东西之前就返回），隧道、直连口、RPC 路由、dispose 都只跑一次。删除 `processTunnel` / `adoptProcessTunnel` / `ownsTunnel` 共享补丁及其衍生问题（断开/注销 no-op、卸载时直连口泄漏）；`describeLock` 现在把「本进程 pid 被复用」的残锁判为 `pid-reuse`（可回收）供 `autoConnect` 清掉；`startDirect` 撞 `EADDRINUSE`（上一实例异步释放端口）时重试一次。
- **套餐状态**（hub）：`plan_status="internal"` 取代 `NULL` 作为内部无限档，`NULL` 变为 fail-closed（无任何权益）；赠点改为由订阅事件驱动（started / renewed / changed，升级补档位差额），取消按自然月扫描；`rdsh-hub user add` 建号即为 internal，管理台套餐动作拒绝 `null`。
- **每日点数消耗**（hub、portal）：`GET /api/credits/spend-daily` 按天聚合 `relay_charge` / `llm_usage_daily` / `voice_usage_daily`；移除逐笔扣费账本视图。
- **按 service 选活跃 Router**（hub）：Router 选择统一按 `service` 收敛，主机 LLM key 与语音配置不会再选中对方的 Router。
- **迁移安全**（hub）：迁移执行用会话级 advisory lock 串行化，`schema_migrations` 记录 `source` / `pid` 供审计。
- **Portal**（portal）：套餐卡片、档位矩阵与导航与 App 对齐；导航重排（主机在账号之前），内部账号也展示套餐。

### 修复

- **装/升级插件后需重启 DSH**（web-remote）：在 DSH 已运行时安装或升级插件，boot 期挂上的自适应选择器（`native`）无法被热补丁替换，`directory-picker-browse` 会报 `service "directoryPicker" has been registered at <NativeDirectoryPicker>`，直到重启 DSH。README 安装步骤、使用文档故障排查与面板「目录选择」提示现在都说明要先重启 DSH，并给出原因。
- **管理台套餐文案**（portal）：管理台用户列表与用户详情页的「套餐」列现在本地化所有 `plan_status`（`internal` / `trial` / `grace` / `free` / `subscribed`）；此前只有 `internal` 有文案，其余直接显示英文枚举。未知值改为显示本地化占位，不再回显后端原值。
- **管理台账号状态文案**（portal）：管理台用户列表与用户详情页的「状态」列现在本地化 `account_status`（`active` / `banned` / `deleted` / `pending`），不再直出英文枚举。
- **卸载插件时直连口泄漏**（web-remote）：插件 `dispose` 只停了隧道、没停局域网直连口（8442），导致不重启 DSH 就重装插件时旧直连口仍占端口、`startDirect` 撞 `EADDRINUSE` 失败、直连候选为空。现在 `dispose` 会一并停掉直连口。_（0.14.1 更正：此修复挂在永不触发的 `ctx.on("dispose")` 上，实际未生效。）_
- **强制清锁可顶替存活持有者**（web-remote）：锁闸门现在把「持有者进程确认存活」的 `alive` 视为 `allowed`（面板二次确认风险），让重新安装的插件能夺回被「未退出的旧 DSH 进程」占着的锁。`self` / `fresh-corrupt` 仍为 `blocked`。
- **停止按钮判定对齐**（gateway）：`activityOf` 改用与 App 相同的停止按钮判定，已停止的会话不再上报残留活动状态。
- **危险 PG 测试护栏**（hub）：会清空数据表的测试在目标不像测试库时拒绝执行。

### 说明

- **`dsh-web-remote`** 与 **`remote-dsh`** 重新发布，使其钉住的 `rdsh-gateway` 从 `0.15.3` 升到 `0.16.0`；两者自身也有上述改动。
- **`rdsh-tunnel`** 本次无改动 —— 线协议未动。
- portal 产物须与源码一起提交；生产只 pull、部署、验证，不构建、不提交产物。

## [rdsh-gateway 0.15.3 · remote-dsh 0.19.1 · dsh-web-remote 0.13.1] - 2026-10-24

### 新增

- **自动配置 LLM Provider**（gateway）：配置了 `llm` 时，`rdsh host serve` 每次启动都会自动配置 DSH 的 `llm-router` provider 和 API key，不再需要手动改 DSH 设置。配置的模型会带上上游 `reasoningEfforts`；key 列表支持新建/编辑/删除，并显示创建与最后使用时间。新增 `llm-provision.ts`；CLI 把 `config.llm` 透传给 gateway 的 `join()`。
- **`llm` 开关**（gateway）：可按主机关闭自动配置。

### 变更

- **就绪超时**（gateway）：`dsh web` 冷启动等待从 30s 放宽到 120s，老机器不再在启动中途被杀。
- **Provider 显示名**（gateway）：改为产品名。

### 修复

- **DSH 设置/凭据 RPC**（gateway）：把 RPC 载荷包进 `args` 信封并发送真实 `expectedRevision`，使 `settings/mutate` 能真正持久化；去掉可选的 `settings/describe` 调用并加固 `dshJson` 超时。
- **残留的凭据锁**（gateway）：拉起前清理 DSH 遗留的凭据锁。
- **`reasoningEfforts.off`**（gateway）：改发 `null`，不再发空字符串。

### 说明

- **`dsh-web-remote`**：本次无源码变更；重新发布是为了把 pin 的 `rdsh-gateway` 依赖从 `0.15.0` 升到 `0.15.3`。
- **`rdsh-hub` / `rdsh-hub-cli`**：不受影响——它们走 git 部署，本批不发 npm。

## [rdsh-hub 0.19.0 · rdsh-hub-cli 0.19.0 · remote-dsh 0.19.0] - 2026-10-20

### 新增

- **PostgreSQL 后端**（hub）：`hub.json` 新增 `db.driver`（默认 `sqlite`，或 `postgres` + `db.dsn`）；hub 提供 `createPgPool` / `migratePg` / `createPgStore`，并以 `HubStore` 抽象统一，配套 pg-store 与 SQLite 的对等测试。
- **独立服务端 CLI**（hub-cli）：新增 `rdsh-hub` 包，提供 `rdsh-hub serve|user|audit|host|service` 以及 `setup`、`db`；`rdsh` 只保留用户/网关命令，`rdsh host ...` 作为兼容别名保留。
- **Hub 初始化与数据库管理**（hub-cli）：`rdsh-hub setup` 生成 `hub.json`（后端选择、TLS、`--force`）；`rdsh-hub db migrate` 执行 SQLite→PostgreSQL 迁移（preflight → backup → copy → verify → 序列重置），`db verify` / `db check` 校验结果。
- **后端感知的管理命令**（hub-cli）：`user`、`audit`、`host` 通过 `HubStore` 同时支持两种后端。

### 变更

- **CLI 拆分**（cli）：`rdsh hub ...` 与 `rdsh node` 桩从 `remote-dsh` 移出；短形式命令（`rdsh serve|join|setup|service|leave|user|gate`）为主，`rdsh host ...` 保留为兼容别名。
- **迁移工具**（hub）：一次性的 `tools/migrate-sqlite-to-pg` 工具并入 `rdsh-hub db migrate`，`tools/` 工作区条目移除。

## [rdsh-gateway 0.15.0 · rdsh-hub 0.15.0 · rdsh-portal 0.3.0 · remote-dsh 0.17.3 · dsh-web-remote 0.12.0] - 2026-10-17

### 新增

- **中继自服务接入**（relay + hub）：`rdsh-relay join <hub-url> --join-token <token> [--relay-url <url>] [--name <name>]` 用入网令牌注册中继节点（初始为 disabled，待管理员审批）；`--relay-url` 与 `--name` 缺省为机器 `{hostname}`。中继配置新增 `listen` 与 TLS 模式（`behindProxy` / `acme` / `tls`），serve 时校验。
- **管理台列表过滤**（hub + portal）：用户按角色 / 状态 / 登录时间范围，主机按在线 / E2EE / 加入时间范围，账单按订单号 / 套餐 / 状态。
- **管理台中继节点接入**（portal）：新的「添加节点」流程由入网令牌生成可直接执行的 `rdsh-relay join` 命令与完整 `relay.json`（监听地址 + TLS 模式：反代默认 `127.0.0.1:8444`、直连 `0.0.0.0:443`），不再预先建节点。
- **管理台分页**（hub + portal）：用户 / 主机 / 中继节点 / 订单 / 审计列表均分页，并提供每页条数选择（10/20/50/100，默认 20）。

### 变更

- **用量页与用户导航重做**（portal）。
- **中继分配令牌无状态化**（relay + hub）：host 分配令牌不再由 relay 侧 host token 派生，relay 侧故障不会销毁 host token。

### 修复

- **relay 侧 401 不再销毁 host token**（relay）：分配时的 401 按瞬时故障处理，不再自毁 host token（P0）。
- **网关加固**（gateway）：崩溃循环封顶、用量 flush 串行化、请求面加固；歧义 401 不再永久停机、读错误不再静默重建用户侧身份、直连用量补齐计量。
- **web-remote revoke/disconnect 封顶**（web-remote）：revoke/disconnect RPC 封顶使面板不再挂起；正确处理被信号杀死的 `dsh`，并透出 revoke 提示。

## [rdsh-gateway 0.14.0 · rdsh-hub 0.14.0 · remote-dsh 0.17.2 · dsh-web-remote 0.11.0] - 2026-10-16

### 新增

- **点数钱包与充值**（hub + portal）：点数账本（分桶余额）、`GET /api/credits/tiers`，以及门户充值页。点数档位与套餐改由共享商品清单（`iap_products.json`）提供，不再硬编码；A 类下单代理同时接受点数档位与套餐。
- **商店（B 类）购买入账**（hub）：unicpay 的 `store.purchase.succeeded|refunded|revoked` 事件计入/冲正 purchased 桶。`store/verify` 成功后**就地入账**，Apple/Google 购买即刻到账，webhook 退化为幂等兜底。
- **支付订单查单**（hub + portal）：`POST /api/billing/order/check` 对平台已收款订单做幂等补发（与 webhook 同一幂等键）。门户支付弹窗接入主动查单；A 类下单响应回传平台 `ticket`，客户端可自行查单并自绘二维码。
- **验证邮件本地化**（hub）：验证邮件按用户语言（中/英）发送。
- **朗读用量统计**（hub + portal）：按日朗读字数统计与响应式用量页。
- **join 锁自助诊断与强制解锁**（web-remote + gateway）：插件会报告是哪个进程持锁，可覆盖死进程持有的锁、清理陈旧锁，不再只给一个看不懂的报错。

### 变更

- **破坏性变更：billing 套餐的 `intervalDays` 更名为 `intervalMonths`**（hub）。订阅改为按日历月计费（`intervalDays: 30` → `intervalMonths: 1`）。若仍残留旧字段 `intervalDays`，hub 启动时快速失败并给出迁移提示。
- **微信 H5 / 公众号（JSAPI）订阅支付迁移到 unicpay**（hub + portal）。原直连微信支付与招商银行商户接入下线。
- **门户充值档位**（portal）：卡片响应式布局，带「推荐 / 最划算」角标，窄屏最多两列。
- **门户验证码与主题**（portal）：支持 host 下发主题，算术验证码不再依赖图片文字。
- **依赖刷新**（cli）：`remote-dsh` 0.17.2 重新锁定 `rdsh-gateway` 0.14.0 / `rdsh-hub` 0.14.0，使 `npm i -g remote-dsh` 装到新组件。

### 修复

- **直连引导注入在请求头被转小写后失效**（gateway + relay）：请求头键统一归一化为小写，恢复注入的直连引导。
- **store/verify 失败可诊断**（hub）：透传上游状态码/错误码/消息，不再一律返回 `502`；出站 unicpay 调用增加超时与传输错误兜底。
- **订阅二维码在到期时间真正延长前不再自动关闭**（portal）。
- **验证与重置密码页补充「重新发送验证码」入口（带验证码）**（portal）。
- **relay 节点心跳/用量上报的错误不再被吞掉；注册时签发 `relayNodeToken`**（relay + hub）。

## [rdsh-gateway 0.11.0 · rdsh-hub 0.9.0 · remote-dsh 0.14.0 · dsh-web-remote 0.7.0] - 2026-09-28

### 新增

- **内网直连优先**（gateway + cli + web-remote）：join 模式下 host 额外监听一个内网端口（默认 **8442**，host 配置），转发到**同一个** dsh 实例。gateway 经 E2EE 通道把私网 IPv4 候选 + **一次性直连票**下发给页面（`window.__rdshDirectInfo`），同网段客户端可绕开公网 hub 一圈；`?ticket=` 换取会话并跳转，已消费/伪造/过期的票一律拒绝。**hub 零改动**，且永远看不到内网拓扑。
- **统一访问口令门禁**（gateway + cli）：门禁覆盖 LAN/cloud 网关、join 隧道与直连口三条路径。`rdsh host setup lan` 自动生成口令；`rdsh host gate set|clear|status` 管理口令。
- **管理端权益操作**（hub + portal）：新增 grant-trial / grant-subscription；`adjustPlan` 拒绝"已订阅却无订阅记录"与"无限套餐却带到期时间"；`creditOrder` 保证同时只有一条有效订阅；门户用户菜单改为"延长试用 / 赠送订阅 / 永久无限"，不再手改原始 plan 字段；新增只读运维脚本 `inspect-entitlements.mjs`。
- **`readReply` 增加 `turn` / `userTurn`**（gateway）：注入的 WebView 契约可据此触发"立即停止朗读"；缺省为 `-1`。
- **明文 http 页面的剪贴板 polyfill**（gateway）：用 `document.execCommand('copy')` 垫 `navigator.clipboard`，使 http 直连页的复制可用。

### 变更

- **破坏性：动态配对码移除**（gateway + cli）。旧 `auth.mode: "pair"` 载入时迁移为 `"none"`、`pairCode` 迁移为访问口令；`--pair-code` 参数删除。
- **破坏性：host 默认端口改为 8442**（原 8443；hub 仍为 8443），使 `rdsh hub serve` 与 `rdsh host serve` 可同机共存不冲突。
- 门禁、直连票与登录的跳转码统一为 **303**（Post/Redirect/Get），此前为 302。
- **dsh-web-remote 在 join 模式下始终启动直连口**，并在访问口令变化时重启它。

### 修复

- **设了口令的 host 不再把 E2EE 客户端锁死**（gateway）：页面授权脚本此前只在 plain dispatcher 注入，导致 E2EE（raw）客户端永远无法满足 fail-closed 的 raw 门禁、DSH 界面一直停在 "connecting"。现改为两条 dispatcher 共用同一个 helper。
- **阿里云验证码校验**（hub + portal）：`VerifyCaptcha` 成功码是 `"Success"`（非旧式 `"OK"`），此前每次验签都抛错并被吞成 `BAD_CAPTCHA`；票据不再被重复使用（提交失败即清票、提交中禁用按钮）。
- **`rdsh host gate clear|status` 文案**（cli）不再声称"无口令则直连口关闭"——按现行设计它始终监听、只认一次性直连票。

## [rdsh-hub 0.8.0 · remote-dsh 0.13.0] - 2026-09-25

### 修复

- **门户在 WebView 客户端不再被迫重新登录**（hub + portal）：7 天续期令牌从 `sessionStorage`（页面会话级，garsync WKWebView 每次页面实例都会丢弃）改为 **HttpOnly cookie `rdsh_hub_refresh`**（`Path=/api/auth`），1 小时访问票过期后门户经该 cookie 静默续期，不再掉回登录页。续期令牌不再暴露给页面 JS。

### 变更

- **破坏性（cookie）**：hub 会话 cookie 由 `rdsh_session` 改名为 **`rdsh_hub_session`**，避免与 gateway 同名 cookie 冲突。未硬编码 cookie 名的客户端无感。
- `POST /api/auth/refresh` 改为 cookie 优先、body `refreshToken` 回退（向后兼容，先发 hub 再发 portal）。
- 微信登录的一次性交接 cookie `rdsh_wechat_refresh` 已移除（改为直接下发续期 cookie）。

## [rdsh-gateway 0.10.0 · remote-dsh 0.12.0 · dsh-web-remote 0.6.0] - 2026-09-25

### 新增

- **rdsh WebView API 契约**（gateway）：gateway 现在往反代的 DSH 页面注入 `window.__rdshWebViewApi`（version 1：`isDshPage` / `readReply` / `fillAndSend`），覆盖 lan/cloud 与 join 两种接入模式，让 WebView 客户端（如 garsync）通过稳定契约读写 DSH 页面，而非脆弱的 DSH DOM 细节。注入脚本幂等、防御式、采用 UTF-8 安全 base64。

### 修复

- **dsh 0.1.7-rc.1 不再被误报为"超出实测范围"**（gateway）：实测窗口上界 `DSH_COMPAT_MAX` 由 `0.1.5-rc.2` 扩到 `0.1.7-rc.1`，跑在该版本上的 host 不再打印误导性的启动警告。0.1.7 只改前端 dist 形态（`<base href="./">` + 相对 `plugins/…`），同源网关天然免疫；认证与 RPC 未变。G1–G7 清单已对真实包重跑通过——见 the internal review record。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 已实测兼容的 dsh | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve` / `join`） | 0.12.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>dsh `0.1.7-rc.1` ✅ | 就绪行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.6.0 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>（`0.1.7-rc.1` 本轮未复验） | 原生 `webServer` 路由，无版本分支 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继，不解析流量 |

## [rdsh-gateway 0.9.0 · rdsh-hub 0.7.4 · remote-dsh 0.11.0 · dsh-web-remote 0.5.6] - 2026-09-22

### 新增

- **服务手动起停/重启**（cli + gateway）：`rdsh host service` / `rdsh hub service` 新增 `start|stop|restart`，手动起停/重启已装服务而不改变开机自启。host 按 `host.json` 的 mode 定位服务（`rdsh-join` / `rdsh-host`），hub 用 `rdsh-hub`。

### 修复

- **portal 构建类型检查**（portal）：构建时 type-check，清除 97 处累积的类型错误（补 DOM lib、portal 优先构建、copy-portal 防陈旧/缺失 dist）。
- **iOS 表单自动放大**（portal）：手机/平板表单字段 ≥ 16px，避免 iOS 聚焦时自动放大。
- **iOS 面板输入自动放大**（web-remote）：窄屏/触屏下面板输入字号提到 16px。
- **返回条遮挡**（hub）：注入的「返回主机列表」悬浮条降到 `top:90px;right:20px`，不再遮挡 DSH 顶栏 / Session Log。
- **loopback 补丁可观测**（gateway）：记录 loopback 补丁命中日志，不再重扫 shell 资源。

## [rdsh-gateway 0.8.6 · dsh-web-remote 0.5.5 · remote-dsh 0.10.7] - 2026-09-17

### 修复

- **远端浏览器可以正常选择工作区目录**（web-remote + gateway）：DSH 的目录选择器在启动时一次解析；宿主是桌面操作系统且非 SSH 启动时会选成**宿主原生对话框**——它弹在宿主自己的屏幕上，远端浏览器无法操作。现在插件在自己的 bundle patch 里把选择器固定为**浏览器内**形态（无条件，与隧道状态无关）；CLI（`rdsh host serve` / `rdsh host join`）在 spawn `dsh web` 时注入 DSH 判定所用的远端会话信号。面板会显示实际生效的选择器形态。
- **静默回归护栏**（gateway）：`rdsh host serve` / `join` 启动后检查 spawn 出的 dsh 的 boot graph 是否含浏览器内选择器，缺失时告警，而不是让操作者面对一个用不了的目录选择器。

> ⚠️ 选择器是**单占用**的：不要再加第二个 pin 通道（手工写 profile 的 `cordis.patch.yml`，或给 `dsh web` 传 `--patch`）——重复的条目会让 dsh **启动失败**。重装插件（或升级 CLI）即可生效，无需部署 hub。

## [rdsh-gateway 0.8.5 · dsh-web-remote 0.5.4 · remote-dsh 0.10.6] - 2026-09-15

### 修复

- **一台机器只允许一条隧道**（gateway）：join 锁改为原子发布（临时文件 + `link`），只回收确定已死的锁，任何活锁（含本进程自己）一律拒绝。此前两个 `dsh web` 实例会争夺同一个 host，互相踢下线（约 1.2 秒一轮）。
- **锁冲突可见**（web-remote）：面板显示停在 disconnected 的原因，而不是静默失败。

> 线协议未变，无需部署 hub。重装插件（或升级 CLI）即可拿到 `rdsh-gateway` 0.8.5。

## [rdsh-gateway 0.8.4 · rdsh-hub 0.7.3 · remote-dsh 0.10.5 · dsh-web-remote 0.5.3] - 2026-09-14

### 修复

- **E2EE 数据面现在真正生效**（hub）：注入 hostId、门面可构造、`fetch` 输入归一化，修掉三个此前让数据面一直静默明文的缺陷。
- **E2EE 下大文件上传可用**（hub）：请求体按 1 MiB 分片，不再整包一帧。
- **预览字节保真且流式**（hub）：响应按字节流式返回、在 OPEN 时 resolve，JSON 走原生解析，中止/错误正确上抛。
- **请求体全类型支持**（hub）：Blob/File、ReadableStream、FormData、URLSearchParams；其余抛错。
- **manifest 兜底**（hub）：不带 cookie 的 `manifest.webmanifest` 请求不再回传 portal HTML。
- **上游失败分类**（gateway）：只有真连接错误才报"不可达"，中途断开带 errno。
- **LAN 配对会话也打 loopback 补丁**（gateway）：配对模式下设置/API key 同样可用。
- **远程 UI 设置/API key 可用**（gateway）：编码感知补丁、content-length 正确、不再继承 immutable 缓存、补丁未命中留日志。

### 安全

- **超大帧不再打死 hub 或 host（远程 DoS）**：两侧有界发送器按流失败，而不是崩进程。

> hub ↔ host 新旧版本混跑已验证兼容；dsh 兼容性不变。

## [rdsh-hub 0.7.1 · remote-dsh 0.10.3] - 2026-09-11

### 新增

- **Portal 深色模式**：hub 网页门户现跟随系统浅/深偏好，用 30 个语义色 token（`--rdsh-*`）+ `prefers-color-scheme` 驱动；深色取值对齐 DSH token，浅色逐字不变（WCAG AA 已核验，18 组 ≥ 4.5:1）。
- 说明：portal 随 `rdsh-hub` 分发，`remote-dsh` 精确锁 `rdsh-hub`，故两包一起发。

## [rdsh-gateway 0.8.2 · dsh-web-remote 0.5.1 · remote-dsh 0.10.2] - 2026-09-11

### 修复

- `dsh-web-remote`（0.5.1）：不再让 dsh `0.1.5-rc.2` 上的 `dsh web` 启动失败——浏览器 RPC 通道改为原生 `/remote-access` 路由，替代 `connection.rpc.handle(...)`（上游回归，discussion #5926）。同一份代码无版本分支，`0.1.2-rc.1` 与 `0.1.5-rc.2` 双版本实测。
- `rdsh-gateway` / CLI：dsh `0.1.5-rc.2` 兼容性端到端实测（spawn、cookie 换发、`/api`、HTML polyfill、WS `remote.mux`、loopback 补丁）；`DSH_COMPAT_MAX` → `0.1.5-rc.2`。
- 提醒：DSH 的 WebSocket 端点自 `0.1.2` 起就是单一 `/api/remote.mux`；rdsh 按 URL 原样透传 WS，更名不影响转发。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 兼容 dsh（冒烟实测） | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve` / `join`） | 0.10.2 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅ | ready 行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.5.1 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>（`0.1.1` 未实测） | 原生 `webServer` 路由，无版本分支 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继不解析业务流量 |

## [rdsh-gateway 0.8.1 · remote-dsh 0.10.1] - 2026-09-08

### 修复

- macOS（launchd）上的 `rdsh host service install`：`ProgramArguments` 正确拆分、重装幂等、`KeepAlive` 仅失败重启、`service status` 区分 active 与 loaded。尚未在真实 Apple Silicon 上回归（Linux systemd 不变）。

## [rdsh-gateway 0.8.0 · dsh-web-remote 0.5.0 · remote-dsh 0.10.0] - 2026-09-08

### 新增

- dsh `0.1.2-rc.1` 兼容：rdsh 换发并注入 dsh 的浏览器会话 cookie，覆盖三条路径（LAN / hub join / 插件）；`0.1.1` 仍靠 ready 行自适应探测；超出测试窗口时运行时打版本告警。
- 修复：dsh 0.1.2 对 index 文档 gzip；rdsh 现在文档导航时剥离 `accept-encoding`，使注入的返回条 / E2EE shim 重新生效。
- 安装提示（pnpm ≥ 12）：发布后 24h 内 `dsh plugin add` 可能装到上一版（`minimumReleaseAge`）；必要时钉精确版本。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 兼容 dsh（冒烟实测） | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve`/`join`） | 0.10.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅ | ready 行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.5.0 | dsh `0.1.2-rc.1` ✅<br>（`0.1.1` 待测） | 同构 API，无版本门 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继不解析业务流量 |

## [dsh-web-remote 0.3.0] - 2026-08-31

> 补记（2026-09-11）：按 npm 发布时间与 tarball 记录——`0.3.0` 是首个含以下特性的版本。

### 新增

- `dsh-web-remote`（0.3.0）：远程访问面板新增「E2EE 下视作本地访问」开关（`dshUiCompat.trustE2EEAsLoopback`，默认开），使 Models/API key 设置可远程使用；插件在 join 模式 + 已持久化 token 且无 CLI 占用隧道时启动即自动连接。

## [0.6.0] - 2026-08-24

### 新增

- `rdsh hub` 新增子命令：`audit ls`（审计日志查询）、`user unlock`（解锁被锁账户）、`user reset-2fa`（重置用户 2FA）。（`remote-dsh@0.6.0`，依赖 `rdsh-hub@0.4.0`）

## [rdsh-hub 0.4.0] - 2026-08-24

### 新增

- M5 多租户：邮箱验证 + 找回密码（可配置 `EmailSender` —— `smtp`/`aliyun`/`log`）、TOTP 两步验证、host 共享（owner/member）、审计日志（`rdsh hub audit ls`）、账户锁定（10 次/15 分钟，`rdsh hub user unlock`）、发信限流（收件人/触发者/全局三层）。
- 配置：`hub.json` 增 `email`、`captcha`、`security` 段。邮件是首个外部服务依赖（smtp 用 `nodemailer`；`aliyun` provider 手写 DirectMail RPC 签名，零依赖）。

## [rdsh-gateway 0.4.0 · dsh-web-remote 0.1.0] - 2026-08-24

### 新增

- M4 插件 `dsh-web-remote@0.1.0`（新包）：`dsh plugin add dsh-web-remote` 在 DSH 界面安装「远程访问」面板（接入 / 断开 / 注销 + 实时状态），复用 join 隧道、免装 rdsh CLI。server 半在进程内跑隧道并暴露 `/remote-access` RPC 通道；client 半渲染设置页。
- `rdsh-gateway@0.4.0`：`startJoin()` —— join 隧道作为可复用的进程内核心（不 spawn、外部 target、`stop()` 句柄、`onState`/`onLog` 钩子）；`join()` 保留为 CLI 封装。新增 join pid 锁（`~/.rdsh/join.lock`），强制 CLI 与插件同机单隧道。

## [0.2.0] - 2026-08-23

### 新增

- M1 MVP：`rdsh serve` 局域网认证网关 —— 配对码 + 签名会话 Cookie、HTTP/SSE/WebSocket 全双工转发、自动拉起 `dsh web`。
- `--no-code` 跳过配对（仅限完全可信网络，启动警告）。
- 运行时修复：secure-context polyfill（明文 http 下 `crypto.randomUUID`）、DSH Host 围栏兼容（Host + Origin 改写）、优雅退出（SIGINT/SIGTERM/SIGHUP）、无 dsh 孤儿进程。
- 发布 `rdsh-gateway@0.1.0` + `remote-dsh@0.2.0` 到 npm。

## [0.1.0] - 2026-08-22

### 新增

- 名称保留发布：`remote-dsh@0.1.0` 已发布到 npm。
- monorepo 骨架：`packages/{tunnel,gateway,hub,cli,portal}`、`apps/{app,weapp}`、`go/`、`e2e/`。
- 开源文档：LICENSE（MIT）、README（中/英）、CONTRIBUTING、CODE_OF_CONDUCT、NOTICE、CI 工作流。
- 产品提案（`doc/overview/proposal.md`），含 Q1–Q10 已定路线。

## [0.5.0] - 2026-08-24

### 新增

- 组件化 CLI：`rdsh host {setup lan|cloud, join, serve, service, leave, user}`；`rdsh hub` 不变。（`remote-dsh@0.5.0`）
- `~/.rdsh/host.json`（mode `lan` | `cloud` | `join`）取代 `config.json`，自动迁移。
- 用户级 join token：portal 生成 / 复制 / 列表 / 吊销（默认 30 天，可配 1 天–1 年，只显示一次，哈希存储）。（`rdsh-hub@0.3.0`）
- `POST /api/hosts/register`（join token → host token，限流，对 host token 幂等）+ `POST /api/hosts/self-revoke`。
- `rdsh host join` 交互粘贴 token；TLS 证书自动检测（无需 `--insecure`）。
- portal「添加主机」页（生成/复制接入命令或 token、token 列表/吊销）。
- 服务名独立（`rdsh-host` / `rdsh-join` / `rdsh-hub`），host 服务 unit 注入 node PATH（nvm 下 `#! /usr/bin/env node` 127 修复）。（`rdsh-gateway@0.3.0`）

### 移除（breaking）

- join 的配对码流程（`--code`、`/api/hosts/pending` + `/api/hosts/bind`）——join 现在只用 join token；配对码仅保留给 LAN/cloud 网关的 pair 认证。
- 旧顶层命令 `rdsh serve` / `rdsh join` / `rdsh user` / `rdsh service`。

## [0.4.9] - 2026-08-24

### 修复

- DSH host 访问不再受 1 小时 access token 过期影响：进入 host（`/h/<hostId>`）现在会签发 HMAC 签名 Cookie（7 天、绑定用户会话版本），relay 改由该 Cookie 认证，而非反复校验短期 access token。改密会使版本 +1，旧 Cookie 立即失效。（`rdsh-hub@0.2.4`）
- `rdsh join` 现在把 host token 持久化到 `~/.rdsh/join-*.token`（0600）并在重启时复用：gateway 重启不再强制重新配对，也不再在 hub 上累积死条目。token 被吊销（401）时自动回退配对码流程；`--reset` 可忘记已持久化的 token。显式 `--token` 被拒时明确报错退出，不再静默无限重连。（`rdsh-gateway@0.2.3`）

## [0.4.7] - 2026-08-24

### 修复

- WebSocket 转发改为文本帧：隧道此前把 DSH 的 WS 消息当 binary 发，前端丢弃（"malformed binary WebSocket frame"）导致界面不实时刷新，需刷新页面才看到新输出。

## [0.4.6] - 2026-08-24

### 修复

- portal 静态资源已打包进 hub 包内（构建时从 packages/portal/dist 复制）。此前 npm 安装的 hub 的 `/portal` 返回 404（dist 只存在于 workspace）。

## [0.4.5] - 2026-08-24

### 修复

- 常驻命令（`rdsh serve` / `rdsh join` / `rdsh hub serve`）恢复进程保持：0.4.3 的显式退出修复导致它们打印启动横幅后即退出。现改为 await 一个永不 resolve 的 Promise，仅通过信号退出（管理命令仍正常退出）。

## [0.4.4] - 2026-08-24

### 修复

- `rdsh hub serve` 等 hub 命令在未传 `--config` 时正确解析 hub 配置路径（`~/.rdsh/hub.json`）。原 parseGlobal 用了 gateway 的解析器（`~/.rdsh/config.json`），导致 hub 静默回退到空配置并拒绝启动（"hub requires TLS"）。

## [0.4.3] - 2026-08-23

### 修复

- 管理命令（user/hub/service）完成后显式退出 —— 修复真实终端交互输入密码（含重试）后进程挂住不退出（TTY stdin 残留句柄）。

## [0.4.2] - 2026-08-23

### 新增

- hub `behindProxy` 反代模式：rdsh-hub 部署在 apache2/nginx 后面（监听本机 http，仅回环信任 X-Forwarded-For —— 限流按真实 IP）。
- 博客 03-02/03-03：hub 经 apache2 / nginx 反代部署（443 + 证书自动续期）。

## [0.4.1] - 2026-08-23

### 修复

- `rdsh --version` 改为从 package.json 读取（原为硬编码，0.4.0 发布后仍显示 0.2.0）。

## [0.4.0] - 2026-08-23

### 新增（M2 — 云服务器直连）

- HTTPS（用户自备证书 `tls.cert/key`）；无证书即 http；`auth.mode: password` 无证书拒绝启动（behindProxy 例外）。
- 密码认证：scrypt 哈希、登录页、限流（5 次/10 分钟）、改密吊销全部会话（版本化）。
- 配置文件（`~/.rdsh/config.json`、`--config` / `$RDSH_CONFIG`）、IP 白名单（`allowFrom` CIDR）、systemd/launchd 服务化。
- CLI：`serve` 子命令、`rdsh user add/passwd/ls/rm`、`rdsh service ...`。

### 新增（M3 — 公网 hub）

- 公网 hub：`rdsh hub serve`（必须 TLS、SQLite 控制面、托管 portal 静态资源）。
- 层 2 线协议冻结 v1（`packages/tunnel/PROTOCOL.md`）：帧格式、payload 编码（open/data/close/ping/pong/error）、E2E 预留位透传。
- 层 1 对外 API 冻结：认证（login/refresh/logout/password/first-password）、host（list/pending/bind/改名/吊销）、WSS `/api/events`、`/h/<hostId>` 透传。
- `rdsh join <hub-url>`：出站隧道 —— 配对码绑定（10 分钟，门户输码）或 `--token` 脚本化直填；心跳；指数退避重连；`--insecure`（自签 hub）。
- `rdsh hub user add/passwd/rm/ls`（注册关闭 —— 管理员建号防 bot/垃圾）、`rdsh hub host ls/revoke`（吊销即断隧道）、`rdsh hub service ...`。
- portal（React）：登录、host 列表（实时在线状态）、绑定、改名、吊销、修改密码、iframe 进入 host（`/h/<hostId>`）。
- 多用户 host 归属与隔离；JWT 会话（ver 版本化即时失效）；host/refresh token 只存 SHA-256 摘要。
- host 访问改为根路径承载：经 `/h/<hostId>` 进入（校验归属 → Set-Cookie `rdsh_host` → 302 根路径），DSH 绝对路径（/assets、/api）原样可用。portal 移到 `/portal`。同一浏览器一次在一个 host 上下文（cookie）；多用户/多浏览器互不影响。
- 修复：隧道 HTTP method 透传（POST 被降级为 GET）、流生命周期（GET 响应挂起）、配对码限流计数、join 漏 findDsh、自签 hub 的 TLS 处理。

## [0.2.0] - 2026-08-23
