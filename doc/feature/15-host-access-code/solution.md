# 15-host-access-code — 实现方案（solution.md）

> **日期**: 2026-09-02
> **状态**: 草稿（待用户批准）
> **依据**: [req.md](req.md)（R1–R9 + §5 决策定案：CLI 形态 A、member 同过 gate）、[discussion.md](discussion.md)（D1–D15）
> **前置**: F7（hub relay 剥离会话 cookie，已上线）——本 feature 在其上加 D12 白名单口子

---

## 1. 目标与关键事实

### 1.1 事实（代码核查）

- gateway 侧**看不到浏览器请求本体**——它收到的是 hub relay 的帧：`OPEN {kind, method, path, headers}` + `DATA`（请求体）+ `CLOSE`（[join.ts](packages/gateway/src/join.ts) `makeInnerDispatcher.handleOpen`，259 行起）；
- 拦截点 = **`handleOpen`**：校验通过才 `openWsStream`（ws）或 `httpRequest`（http）到本机 dsh；未过 gate → **网关自己合成 HTTP 响应**（用 `send` 发 OPEN/DATA/CLOSE 帧），不碰 dsh；
- hub relay 对 text/html 响应会注入 E2EE shim/返回条（外观影响，见 D9）；
- hub relay 已剥离请求 cookie（F7）；响应头（含 Set-Cookie）**原样透传**（relay.ts `onResponse`）。

### 1.2 架构一句话

> gate 全在 gateway：`handleOpen` 查 `rdsh_gate` cookie（hub D12 透传）→ 没有则合成 challenge 页 → 用户 POST code → 恒定时间比对 → 发 HMAC cookie → 302 回跳。hub 只做 cookie 白名单透传，不知 code。

## 2. Gateway 配置（host.json）

- 字段：`gateway.accessCode?: string`（嵌套对象，为未来 gateway 设置留位；与现有 `dshUiCompat` 平级于 host.json）；
- `config.ts` normalize：`gateway` 须为对象；`accessCode` **折叠语义**：缺失 / `null` / `""` → `null`（gate off）；非空字符串 → 校验 ≥4 位 → 保留；
- `RdshConfig.gateway: { accessCode: string | null }`（缺省 `{ accessCode: null }`）；
- 清除 = 面板/CLI 写 `null` 或删字段（**不得**把 `""` 当有效 code）。

## 3. Gateway gate（`makeInnerDispatcher`/`handleOpen`）

### 3.1 gate 状态

- 由 `startJoin` 传入：`gateway.accessCode`（null = off）；运行中可切（面板 `set-access-code` → 内存引用更新，同 `uiCompat` 的 live 变量模式）。

### 3.2 http 拦截（handleOpen, kind="http"）

```
accessCode === null ? 直接转发 : 
  检查 headers.cookie 里的 rdsh_gate：
    有效 → 转发（openWsStream/httpRequest）
    无效/缺失 →
      该流不转发，由网关合成响应：
      method=POST 且 body 含 gate_code 字段 → 验证：
        对 → 302（回原路径，Set-Cookie rdsh_gate=<signed>）
        错 → 200 challenge 页 + 错误提示（全局失败计数 +1，达限锁定）
      其余 → 200 challenge 页（内联 HTML，含表单，action=当前路径）
```

- **challenge POST 数据**：OPEN 后 DATA 帧是请求体——网关需为该流**缓冲 body**（≤64KB），解析 `gate_code`；
- 验证用恒定时间比较（`timingSafeEqual`，对 `sha256(input)` vs `sha256(code)` 比较，避免长度侧信道）；
- 全局失败计数：内存 Map/计数，N=10 次/分钟 → 该分钟拒绝（403 锁定页）；隧道流量无真实 IP，按全局。

### 3.3 ws 拦截（kind="ws"）

- accessCode 开启时：无有效 `rdsh_gate` → 拒绝（`ERROR` 帧或直接 CLOSE），不 `openWsStream`；
- DSH 的 `events.mux/events.host` 升级都带 cookie（同源请求自动带）→ 过 gate 后正常。

### 3.4 合成响应（不走 dsh 的 HTTP 回包）

- 复用 `send(encodeFrame(...))`：`OPEN`（status + headers）→ `DATA`（HTML/302 body）→ `CLOSE`；
- 302 响应头：`location` = 原请求 path + `set-cookie` = 访问 cookie；
- **不注入 E2EE shim**（网关自产 HTML，与 relay 注入无关——relay 注入发生在 hub 侧对 text/html 的透传，challenge 页会中招但惰性无害，D9 已记）。

## 4. 访问 cookie（D7/D8）

- 名字：`rdsh_gate`（hub D12 白名单需同名常量，放 `rdsh-tunnel` 或各包导出？——放 gateway 导出 + hub 侧硬编码同名，注释互指）；
- 值：`base64url( exp_ms + "." + nonce(16B) + "." + hmac )`，`hmac = HMAC-SHA256(exp_ms + "." + nonce, key=sha256(accessCode))`；
- 验签：无状态（重算 hmac 比对，`timingSafeEqual`）；`exp > now`；
- **改 code → key 变 → 旧 cookie 全失效**（无需黑名单/版本）；
- 过期 7 天（对齐 host cookie）；httpOnly + SameSite=Lax + Path=/（经隧道 origin 为 hub 域名，浏览器按该域存）。

## 5. challenge 页（内联，零外部依赖）

- 纯字符串 HTML + 内联 CSS（system-ui 字体、居中卡片、错误态）；
- 文案：`主机「<hostname>」受访问密码保护` + `此密码由主机所有者设置，hub 无法绕过`；
- 表单：password input（`autofocus`）+ 提交按钮；POST 回当前 path；
- 深链接回跳：302 到原请求 path；
- 语言：读 `Accept-Language`（zh → 中文；否则英文兜底）；
- 移动/PC/微信浏览器通用（无 JS 依赖也行，纯表单）。

## 6. 双通道配置

### 6.1 dsh-web-remote（插件）

- server 半：`set-access-code` RPC（`{ code: string | null }`——null = 清除）→ 写 host.json（`loadConfig`/`saveConfig`）+ `liveAccessCode` 内存更新（运行中即时生效）+ `state()` 返回 `hasAccessCode: boolean`（**不回显 code**）；
- client 半：面板加「访问密码」行（badge 已设置/未设置 + 设置/清除按钮 + code 输入，≥4 校验前端 + 后端）；
- i18n zh/en。

### 6.2 CLI（形态 A：直接 host.json）

- 文档：`rdsh host serve` 手册 + host.json 示例；字段 `gateway.accessCode`；重启生效；
- 无新 CLI 命令（B/C 后置）。

## 7. hub 侧（D12 cookie 白名单）

- `relay.ts normalizeHeaders`（F7 剥离处）：改为解析 `cookie`，**仅放行 `rdsh_gate`** 重新拼回 `cookie` 头（rdsh_session/rdsh_host 等仍全剥）；
- 单测：带 `rdsh_gate` 的请求 → gateway 收到该 cookie；只带 rdsh_session → gateway 收不到；
- 兼容：旧 gateway 从不发 `rdsh_gate` → 行为不变（纯增量）。

## 8. 测试

- gateway：`test/` 新增——config normalize（""/null/缺失→null、<4 拒绝）、cookie 签发/验签/过期、改 code 旧 cookie 失效、challenge 拦截（无 cookie GET → challenge HTML；POST 对/错）、恒定时间、全局失败锁定、ws 拦截；
- hub：relay 白名单单测（D12）；
- web-remote：set-access-code 状态机单测（可复用 join-core 模式）；
- e2e：本机 gateway + hub + 浏览器走隧道验证（challenge → 输 code → 进入 DSH → 刷新免输 → 改 code 后重输）。

## 9. 文件改动清单（调用面）

| 文件 | 改动 |
|---|---|
| `packages/gateway/src/config.ts` | `gateway.accessCode` normalize（折叠 + ≥4 校验） |
| `packages/gateway/src/join.ts` | `handleOpen` http/ws gate + challenge 合成 + cookie 签发/验签 + 全局失败锁定；`startJoin` 读 `gateway` |
| `packages/gateway/src/token-store.ts` 或新文件 | 放 `rdsh_gate` 常量 + cookie 工具（签发/验签纯函数） |
| `packages/hub/src/relay.ts` | D12 cookie 白名单（仅放行 `rdsh_gate`） |
| `packages/web-remote/src/index.ts` | `set-access-code` RPC + live 更新 + state.hasAccessCode |
| `packages/web-remote/client.js` | 面板访问密码行 + i18n |
| 各包 `test/` | 见 §8 |

## 10. 兼容性与风险

- 旧 gateway + 新 hub：纯增量，无感（§7）；
- 新 gateway 设 code + 旧 hub（无 D12）：cookie 到不了网关 → gate 循环 —— 版本配对文档（req §3 场景 8 已含回归）；
- 不设 code = 零行为变化；本机 127.0.0.1 不 gate（恢复通道——本地 dsh 直连不经 dispatcher 的 gate 分支）；
- challenge 页经 hub 会被注入 E2EE shim/返回条（惰性无害）。

*关联文档：req.md | discussion.md | 前置：F7（已上线）*
