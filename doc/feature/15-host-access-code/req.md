# 15-host-access-code — 需求（req.md）

> **日期**: 2026-09-02
> **状态**: 草稿（待用户批准）
> **范围**: rdsh **gateway（host 侧）**访问口令——经 hub 隧道访问主机 DSH 时，需先通过主机所有者设置的密码；**hub 侧仅配合透传一个不透明标记（D12），校验 100% 在网关**
> **来源**: [discussion.md](discussion.md)（D1–D13 已定 + 信任边界分析）
> **一句话**: 为 host 增加一道**独立于 hub 的访问口令**（纵深防御）；过 hub 账号这关不再等于直接进入主机

---

## 1. 目标

在 rdsh gateway 增加**独立于 hub 的访问口令**（access code）：浏览器经 hub 隧道访问主机时，gateway 在转发到本机 dsh **之前**要求输入密码；密码只存 host 侧（host.json 0600），hub 全程不接触。**纵深防御**——挡「会话窃取 / hub 管理员越权」，不承诺挡主动 hub MITM（那是 E2EE 的职责）。

## 2. 范围

### 2.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **网关访问口令（可选开启，默认关闭）**：`host.json` `gateway.accessCode`（明文 0600）；未设置 = 无 gate = 现状；设置 = 开启 | 存量 host（未设 code）经隧道访问行为与现在完全一致；设 code 后经隧道访问需先过密码 |
| R2 | **Challenge 流**：无访问 cookie 的隧道请求 → gateway 返回内联 HTML 密码页（零外部依赖、显示主机名 +「密码由主机所有者设置，hub 无法绕过」、移动/PC/微信兼容、深链接验证后回跳原路径）→ 提交 code → 恒定时间比对 → 通过发签名访问 cookie | 首访被 challenge 拦截；验证后回跳原 URL 正常进入 DSH；失败有错误提示 |
| R3 | **访问 cookie（7 天）**：HMAC-SHA256 签名，key = `sha256(accessCode)`，无状态验签（payload = expiry + 随机 nonce）；**改 code → 旧 cookie 全部失效** | 改 code 后旧浏览器需重新输入；签名 cookie 无法伪造/篡改 |
| R4 | **作用域：只拦隧道流量**：本机 `127.0.0.1` 访问永远放行（恢复通道——设 code 忘记时本机 UI/CLI 可关）；WS 升级（`events.mux` 等）同样查 cookie | 本机直连 dsh 不受 gate 影响；隧道内 WS 无 cookie 被拒 |
| R5 | **E2EE 引导覆盖**：入口 `/h/<hostId>/` plain HTML 被 gate 拦截 → E2EE shim 的 raw 流在通过 gate 的页面内才启动（raw 流本身不逐帧重查） | 未过 code 无法获得 DSH 页面（含 E2EE 引导）；过 code 后 E2EE 正常 |
| R6 | **防爆破**：恒定时间比较 + **全局失败封顶/退避**（隧道流量无真实客户端 IP） | 连续错 N 次后短时锁定；`timingSafeEqual` 无时序侧信道 |
| R7 | **双通道配置（同写 host.json `gateway.accessCode`）**：CLI（重启生效）+ dsh-web-remote 面板 `set-access-code` RPC（写 host.json + 内存即时生效，运行中隧道立刻启用 gate）；密码不回显（显示 •••••• + 更改/清除） | 两通道设置/清除一致；CLI 重启后生效、面板即时生效 |
| R8 | **code 最小长度 ≥4**（设置时校验，拒绝更短） | 设置 <4 位被拒；中文提示 |
| R9 | **hub 侧 D12 配合**：hub relay 剥离会话 cookie（F7 不变），**放行网关专用 `rdsh_gate` cookie**；对旧 gateway 纯增量（旧 host 无感） | 新 hub + 新 gateway 开 code 全链路可用；旧 gateway 在新 hub 上行为不变 |

### 2.2 不含（Out of Scope）

- ❌ LAN / 云直连模式启用 gate（已有配对/口令认证）
- ❌ 主动 hub MITM 防护（E2EE 的职责，raw 流豁免）
- ❌ code 的强熵强制（≥4 即可，恒定时间 + 全局封顶兜底）
- ❌ 每 host 多 code / per-user code（code 为 host 级单值）

## 3. 端到端验收场景

1. **未设 code（存量）**：host 经隧道访问 → 直接进 DSH，与现状一致。
2. **设 code 后首次**：浏览器经隧道访问 → challenge 页 → 输对 → 进 DSH；刷新/跳转不再提示（cookie 已发）。
3. **输错**：错误提示；连续错到上限 → 短时锁定。
4. **改 code**：已带旧 cookie 的浏览器再访问 → 重新要求输入。
5. **本机恢复**：设了 code 但从本机 `127.0.0.1` 访问 dsh → 无 gate 直接进 → 可从面板/CLI 清除 code。
6. **插件面板**：设置页设置/清除 code → 即时生效（运行中隧道立刻 gate）；再经隧道访问验证。
7. **共享 host**（若决策 member 过 gate）：owner 共享给 member → member 经隧道进入也需 code（owner 分享 code）。
8. **旧 gateway 回归**：旧 gateway host 连新 hub → 行为与升级前一致。

## 4. 验收执行方式

- 自动化：`node --test`（cookie 签发/验签/过期、改 code 失效、恒定时间比对、challenge 拦截、全局失败锁定、配置校验 ≥4 位、D12 载流——hub relay 白名单单测）；`pnpm build` 零缺陷
- e2e：本机 gateway + hub + 浏览器（真实走隧道验证 challenge → 进入 → 回跳）；CLI 与插件面板双通道各设一次
- 文档：verification.md 逐条对照 R1–R9 + RTTM

## 5. 决策定案

1. **CLI 配置形态：A（直接 host.json）**——MVP 最简，零新增 CLI 命令；文档写明 `gateway.accessCode` 字段，serve 启动读一次，重启生效。B/C 后置评估。
2. **共享 host 语义：member 同样过 gate**——code 为 host 级单值；owner 把 code 分享给允许访问者（与 F6 共享逻辑一致）。

*关联文档：discussion.md | 前置依赖：F7（会话 cookie 剥离，已上线）| 下一步：solution.md（req 批准后）*
