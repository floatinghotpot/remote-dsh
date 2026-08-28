# 09-e2e-encryption — 需求（req.md）

> **日期**: 2026-08-28
> **状态**: 草稿，**待用户批准**
> **来源**: [discussion.md](discussion.md)（方案 A：raw stream + Noise；5 项决策）
> **范围**: 端到端加密（E2EE）—— hub 中转 DSH 流量但**无法读取内容**；**社区 + SaaS 通用**；SaaS 正式上线时实现（09 独立里程碑提前排期）。

## 1. 目标

让 hub 对 DSH 数据面（`/h/<hostId>/`）保持「路由 / 可用性 / 认证」，但**看不到内容**（prompt、代码、文件、API key、会话结果）。浏览器 ↔ host 端到端加密，hub 只看到密文。**DSH 前端代码零改动**。

> **威胁边界**：web 版 E2EE 防「**被动/好奇**的 hub」（读中转流量），**不防「主动/恶意」的 hub**（改 portal JS 偷内容）——所有 web 版 E2EE 的固有边界（hub 即发 JS 者）。承诺止于「hub 读不到中转内容」。

## 2. 需求（R 编号）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **协议先行**：`packages/tunnel/PROTOCOL.md` 定义 **raw stream 模式**（`flags` bit0 = E2E 标记；hub 纯字节双向转发、不解析 HTTP）；向后兼容（bit=0 走现有 HTTP 感知转发） | 协议文档更新先于实现；TS↔Go conformance 覆盖 raw stream；老 gateway/hub 组合回归通过 |
| R2 | **内层 Noise 通道**：浏览器 ↔ host 内层 **Noise**（X25519 + AES-256-GCM，**NK 握手**：host 静态密钥 + 浏览器临时密钥，浏览器靠 pin 认证 host）；会话密钥 = ECDH → HKDF；前向保密 + 防重放 | Noise 握手单测（双方派生一致密钥）；密文篡改被拒；密钥每连接轮换 |
| R3 | **透明拦截（DSH 零改动）**：service worker 拦 `fetch`/SSE；注入 `window.WebSocket` 包装拦 WS；DSH 前端不改 | DSH 前端无改动即可走 E2EE；HTTP / SSE / WS 全通过 |
| R4 | **密钥与 pinning（portal TOFU）**：host 生成 X25519 长期密钥对，join 时公钥指纹上送；portal 展示指纹、用户首次信任（TOFU）；**指纹变更 = 拒绝 + 手动重信任**（展示新旧指纹 + 说明原因 + 二次确认）；**pin 存浏览器本地（localStorage），绝不存 hub**（hub 是潜在敌手） | join 后 portal 可见指纹；首次=信任弹窗；变更=告警弹窗（旧新指纹对照 + 二次确认）；未信任/变更未确认不建 E2EE；pin 仅客户端存储 |
| R5 | **配置开关**：hub `e2ee: { mode: "off" \| "optional" \| "required" }`（默认 `optional`）+ **host `e2ee: true \| false`（默认 `true`）**（`host.json` / 插件配置）；交互矩阵：off→明文；optional×host true→E2EE、optional×host false/老 host→明文；required×host false→拒绝连接 | off/optional/required 枚举校验；host 布尔校验；三档 × host 开关行为正确 |
| R6 | **数据面边界**：仅 DSH 流量（`/h/<hostId>/`）E2EE；portal（`/portal/`）不加密 | `/h/` 密文、`/portal/` 明文 |
| R7 | **返回条注入迁移**：返回条（「← rdsh · 返回」）注入从 hub 移到 gateway（E2E 后 hub 不可读 HTML） | E2EE 开启时返回条仍正常显示 |
| R8 | **兼容性**：老 gateway/hub（bit=0）向后兼容；协商失败按 mode 回退（off/optional 明文、required 拒绝） | 新旧 gateway 混部回归通过；required 下无 E2EE 的连接被拒且有明确提示 |

## 3. 不含（Out of Scope）

- ❌ portal 流量加密（hub 即 portal 服务端，无意义）
- ❌ padding 防大小/时序侧信道 —— MVP 接受 hub 可见元数据（大小/时序），承诺仅止于「内容不可读」，后置评估
- ❌ 指纹的 CLI 比对（host 可能是 DSH 插件、无 CLI，用 portal TOFU）
- ❌ 移动端 App（M8）/ 小程序（M9）的 E2EE（后置，随各自里程碑）

## 4. 前置依赖

| 依赖 | 说明 |
|---|---|
| 隧道协议（M3） | raw stream 模式基于现有 tunnel 帧（`flags` bit0 已预留） |
| join 流程（05） | host 密钥对生成 + 公钥指纹上送走 join/注册路径 |
| DSH 插件（M4） | host 可能是 DSH 插件（无 CLI），pin 走 portal 而非 CLI |
| 浏览器 crypto | WebCrypto（X25519 / AES-GCM / HKDF 原生）+ 被审计 JS Noise 库（选型待定，见 §5） |

## 5. 待定（不阻塞批准，solution 阶段定）

- 内层 Noise 库选型（浏览器 JS 库 + gateway Node 库）与审计；
- 注入 WS 包装脚本的 CSP / Web Worker 兼容；
- 是否 padding 防侧信道（后置评估）。

## 6. 验收执行方式

- **自动化**：单测（Noise 握手/AEAD、raw stream 帧编解码、`e2ee` config 校验）+ conformance（TS↔Go）+ 端到端（hub 侧抓包不可读明文）。
- **手工**：portal 添加 host → 信任指纹 → 浏览器操作 DSH → hub 日志/抓包确认 `/h/` 为密文、`/portal/` 为明文。
