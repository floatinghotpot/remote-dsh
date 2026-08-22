# 01-remote-access — 需求讨论记录（discussion.md）

> **日期**: 2026-08-22
> **状态**: 讨论记录（req.md 定稿后本文档转为 READ-ONLY 需求来源）
> **来源**: 产品提案 `../../overview/proposal.md` + 2026-08-22 需求讨论 + DSH 源码查档

---

## 1. 背景与目标

在 DeepSeek Harness（DSH）之上构建**安全远程访问层**：本机照常 `dsh web`，之后用任意设备（同 LAN 笔记本/手机浏览器 → 公网 hub → 移动 App/小程序）操作该机器上的 DSH。

核心痛点：
1. DSH 默认只绑 `127.0.0.1`，本机锁定；
2. 直接 `--host 0.0.0.0` 暴露 = 无认证裸奔（DSH 自身无 HTTP 认证层，见 §2）；
3. 公网无路（无公网 IP / NAT）。

## 2. DSH 查档事实（代码核查，非猜测）

核查对象：已安装 `@deepseek-ai/dsh@0.1.1-rc.2` 的源码。

| 事实 | 出处 |
|---|---|
| `dsh web` 默认绑 `127.0.0.1:3080`；`--host` 仅接受 `127.0.0.1`/`0.0.0.0`；`--port 0` 由 OS 分配 | `dsh-web-app/cordis.patch.yml`（`host: !!js ctx.webStartup.host ?? '127.0.0.1'`，`port: ?? 3080`） |
| **DSH 无 HTTP 认证层**（无用户名/密码/token/会话） | `dsh-host-webserver/lib/index.js`（裸 `node:http`） |
| 安全仅靠 Host 围栏：Host 须为 loopback / LAN IP 字面量 / `--trusted-host`；`sec-fetch-site: cross-site` 拒绝；带 Origin 须同源；**注释明确 "this fence is not an auth layer"** | `dsh-client-connection/lib/index.js`（`isTrustedApiRequest`） |
| 全部能力走 `/api/*`：HTTP RPC + `/api/events.mux`、`/api/events.host` 两条 WebSocket 通道；静态 dist 走 fallback | `dsh-client-connection/lib/index.js`（`API_PATH` 等常量） |
| LAN 模式已有雏形：绑 `0.0.0.0` 时自动推导本机 IPv4 并打印 `(LAN: http://<ip>:<port>)`，配合 `--trusted-host` 扩展围栏 | `dsh-web-app/lib/index.js`（`resolveLanTrust`） |
| 前端独立包 `@deepseek-ai/dsh-web-frontend`（Vite + React 18，`dist/index.html`）可整体复用；`/api` 契约类型 browser-safe | `dsh-web-app/lib/index.js`（`resolveDistIndex`）、`dsh-host-apiproxy` |
| 检测 SSH 启动（`SSH_CONNECTION`/`SSH_TTY`）时跳过自动开浏览器 | `dsh-web-app/lib/index.js`（`launchedThroughSsh`） |
| 请求体上限 300 MB；聚合图片上限 200 MiB | `dsh-client-connection/lib/index.js`（`DEFAULT_MAX_REQUEST_BODY_BYTES`） |

**推论（写进需求的依据）**：
- 任何远程暴露方案必须**自带认证**（DSH 围栏不是认证层）；
- 网关/隧道必须**全双工转发**（HTTP + SSE + WS upgrade 都要透传）；
- 前端零重写（复用 `dsh-web-frontend`）。

## 3. 决策历程（Q1–Q10，已定 / 待确认）

| # | 决策点 | 结论 | 状态 |
|---|---|---|---|
| Q1 | 产品形态 | **自用/自托管工具**起步；架构预留多租户扩展 | ✅ 已定 |
| Q2 | 命名 | 产品 **remote-dsh**、代码名 **rdsh**；组件 rdsh-hub / rdsh-gateway / rdsh-tunnel / rdsh-portal / rdsh-app / rdsh-weapp；命名三原则（统一 rdsh- 前缀、不与 DSH 概念冲突、CLI 动词直观） | ✅ 已定 |
| Q3 | 微信小程序 | **后置**（先 LAN → 公网 → App）；备案可提前并行启动 | ✅ 已定 |
| Q4 | 授权粒度 | **整实例授权**（绑定 host 即全权访问）；profile 级隔离后置 | ✅ 已定 |
| Q5 | 端到端加密 | **MVP 不实现，协议层预留**（tunnel 帧格式留加密扩展位）；公共 SaaS 化时实现（客户端原生化后 E2E 才真正成立——Web 端有"改页面 JS"局限） | ✅ 已定 |
| Q6 | hub 分发形态 | **提供 Docker 镜像**（2026-08-22 用户确认）：原型期包装 npm 包、生产期包装 Go 单二进制；Docker 是包装非唯一路径，主分发形态分别为 npm 包 / 单二进制 | ✅ 已定 |
| Q7 | 移动端范围 | **纯 WebView 壳**（Flutter）+ 登录态原生存储；验收须含 WebView 交互验证（剪贴板/输入法/文件下载），剪贴板不可用时加最小原生桥 | ✅ 已定 |
| Q8 | 技术栈 | **分阶段双栈**：原型期全 TS/Node（hub 随 npm 包）；生产期 rdsh-hub 用 **Go 重写**（标准生态：net/http + gorilla/websocket + modernc.org/sqlite 免 CGO + golang-jwt + x/crypto；go:embed 内嵌 portal）；rdsh-app 用 **Flutter/Dart**；rdsh-weapp 原生小程序；**契约前提：tunnel 协议与 hub API 文档先行** | ✅ 已定 |
| Q9 | MVP 范围 | **仅 rdsh-gateway（LAN 模式）**：`npm i -g remote-dsh` 与 dsh 同装，另一台笔记本即刻可用；hub/portal/App/小程序全部后置 | ✅ 已定 |
| Q10 | 安装形式 | MVP：**独立 npm 包 `remote-dsh`**；未来同时提供 **dsh 插件形态**（薄适配层复用核心包，命名 `dsh-plugin-rdsh`） | ✅ 已定 |

## 4. 架构决策（讨论产出）

### 4.1 组件与数据路径

```
客户端（浏览器 / App / 小程序）
          │  HTTPS/WSS（层1）
          ▼
      rdsh-hub
          │  WSS 隧道（层2）
          ▼
   rdsh-gateway
          │  127.0.0.1:<port>
          ▼
     dsh web
```

- gateway 只**出站**连接 hub（免公网 IP / 免端口映射）；MVP（LAN）无 hub，gateway 自身即认证网关。

### 4.2 协议分层（两协议层，客户端只碰层 1）

- **层 1：hub 对外 API**（所有客户端 ↔ hub）：`JSON over HTTPS`（REST）+ `WSS` 事件流；契约文档先行，是 weapp/App 原生实现/未来第三方接入的依据。雏形：`/api/auth/login`、`/api/auth/refresh`、`/api/hosts`、`WSS /api/events`、`/h/<hostId>/...` 透传入口；统一约定 `/api/*` 路径、`{ error: { code, message } }` 错误结构、ISO 8601、Bearer JWT。
- **层 2：rdsh-tunnel**（hub ↔ gateway）：WSS 承载 + 帧复用；原型期 TS 双端、未来 Go 侧；**App 不实现**。

### 4.3 rdsh serve 认证流程（MVP：配对码 + 会话 Cookie）

1. 启动生成配对码（6 位随机，终端显示，仅"人在开发机前"可见 —— 物理信任锚点）；支持 `--pair-code` 覆盖。
2. 浏览器首次访问（无会话 Cookie）→ 返回极简配对页。
3. `POST /pair` 提交配对码 → 恒定时间比较 + IP 维度限流。
4. 通过后签发**签名会话 Cookie**（HMAC-SHA256，HttpOnly + SameSite=Lax，默认 12h 可配；密钥存 `~/.rdsh/`，无状态，重启不失效）。
5. 之后全部请求（HTTP/SSE/WS upgrade）校验 Cookie 后原样转发 dsh。
6. `rdsh serve --reset` 重置密钥（所有会话失效）。
7. LAN 为 http（Cookie 无 Secure），靠"只监听内网 + SameSite + Origin 校验"兜底；公网阶段全链路 https 自动升级。

## 5. 命名与发布事实

- npm 包名 **`remote-dsh`**（`rdsh` 裸名被 npm **typo-squatting 防护**拒绝——与 rbush/radash/fresh 判相似，发布时才触发校验，`npm view` E404 查不出）；`remote-dsh@0.1.0` 已于 2026-08-22 发布（占名）。
- 子包待发：`rdsh-tunnel` / `rdsh-gateway` / `rdsh-hub` / `rdsh-portal`（E404 可用）；`dsh-plugin-rdsh` 可用（插件形态）。
- GitHub 仓库：`floatinghotpot/remote-dsh`（Public，main）。
- 2FA 发布链路（教训记录）：npm 已弃用 TOTP（只剩 passkey）；npm 10 的 publish 不支持 passkey → 升级 npm 12（浏览器认证流程）；`npm config fix` 修复旧 email 配置。

## 6. 开放问题 / 后续决策点

- 网关默认监听端口（如 8443？）与 `--port` 语义 → 留给 solution.md 定稿。
- 配对码有效期（进程生命周期内 vs 短时效）→ 留给 solution.md 定稿。
- M3+ 的 hub API 契约冻结时机。

*关联文档：`../../overview/proposal.md` | 下一步：`req.md`*
