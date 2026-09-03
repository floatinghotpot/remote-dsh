# 15-host-access-code — 需求讨论记录（discussion.md）

> **日期**: 2026-09-02
> **状态**: 讨论记录（初始稿；已定方向见 §3/§6，req.md 定稿后 READ-ONLY）
> **来源**: 用户提出——希望在 **rdsh gateway 侧**为 host 增加一道**独立于 hub 的访问保护**（密码/口令），与 hub 账号体系形成纵深防御
> **关联**: `01-remote-access`（gateway/中继）、`06-dsh-plugin`（dsh-web-remote 面板）、`09-e2e-encryption`（E2EE 信任）、hub 管理面

---

## 1. 背景与动机

当前信任模型：host 出站隧道连 hub（host token），hub 负责会话签发、host cookie 与流量中继。作为**纵深防御**，任何单一组件都不应成为唯一信任边界：

- 因此在 **host 侧（gateway）**增加一道**独立于 hub 的访问口令**——hub 只中继、不持有 code（code 只存 host 侧）；
- 效果：会话失陷 / 账号复用 / 越权等「过 hub 这一关」的威胁，在 host 侧仍被第二道独立关口拦住——多一层防线，而非依赖 hub 单点。

## 2. 安全边界（各层职责）

| 威胁 | 网关 access code 防护 | 说明 |
|---|---|---|
| 偷到 rdsh 会话 token / hub 账号复用 | ✅ **挡住** | code 只在 host 侧配置 |
| hub 管理员越权直连 host | ✅ **挡住** | 同上 |
| **主动 hub 侧 MITM**（控制 hub 进程、观察中继流量） | ❌ **挡不住** | passcode 提交时请求体**经 hub 中继**，攻击者可看到并重放 |
| 对恶意 hub 的终极防护 | → 靠 **E2EE**（浏览器↔host 端到端加密 + TOFU PIN，hub 只看密文） | 两者互补 |

**结论**：access code 是**有价值的纵深防御**（独立信任层），**不是恶意 hub 的终极防护**——那是 E2EE 的职责。

## 3. 设计：网关访问密码

### 3.1 拦截位置与作用域（关键前提）

- 拦截点：gateway `makeInnerDispatcher`（**plain HTTP/WS 分支**），在转发到本机 dsh **之前**检查；
- **只拦「经隧道进来的流量」；本机 127.0.0.1 访问永远放行**——恢复通道（设了 code 忘记/面板进不去时，本机 UI 或 CLI 可关；面板经隧道访问也需过 gate，但本机访问面板不过）；
- **E2EE raw 流豁免（精化）**：raw 流本身**不逐帧重查**（密文流无法注入 challenge），但**入口已被 gate 覆盖**——所有进入都先走 `/h/<hostId>/` plain HTML（gate 拦截点），页面里的 E2EE shim 之后才启动 raw 流，因此 E2EE 引导无法绕过 gate（想纯 raw 绕过需手写 E2EE 协议 = 主动 hub 威胁类，不在本 gate 防护目标内）。

### 3.2 Challenge 流（plain 路径）

1. 无访问 cookie 的请求 → 网关返回**内置 HTML 输入页**（经中继，浏览器看到的是 hub 域名下的页面）；
2. 用户提交 code（POST）→ 网关**恒定时间比对**；
3. 通过 → 发 **HMAC 签名访问 cookie**（key = `sha256(accessCode)`，无状态验签，见 D8；经中继 Set-Cookie 落在浏览器）→ 回跳；
4. **hub 侧配合（D12）**：hub relay 剥离会话 cookie（F7）但**放行网关专用 `rdsh_gate` cookie**——否则网关永远收不到浏览器 cookie（见 §3.4）。
5. 之后带 cookie 的请求正常转发；WS 升级（`events.mux` 等）同样查 cookie。

### 3.3 防爆破

- 恒定时间比较（`timingSafeEqual`）；
- **全局失败计数**（隧道流量网关看不到真实客户端 IP，无法按 IP 限速 → 全局封顶 + 指数退避，达限后短时拒绝）。

### 3.4 hub 侧配合（D12）与兼容性

- **F7 冲突**：hub relay `normalizeHeaders` 剥离全部 cookie → 网关收不到浏览器 cookie → cookie 型 gate 无法工作。解法：**载流豁免**——hub 剥离 `rdsh_session`/`rdsh_host`/`authorization`（F7 安全目的不变），但**放行网关专用 `rdsh_gate` cookie**（网关验证 code 后签发；对 hub 是不透明标记，hub 不知 code、无法伪造——校验 100% 在网关）。
- **旧 gateway 兼容**：纯增量——旧 gateway 从不设/查 `rdsh_gate` → 浏览器不带它 → hub 行为与现状一致，旧 host 无感；
- **部署顺序**：**hub 先上 D12**（对旧 host 零影响），之后 gateway 启用 code 功能；反向（旧 hub + 新 gateway 开 code）→ cookie 到不了网关 → gate 循环不可用。自托管组合文档注明版本配对；
- 其他 hub 接触点：challenge 页会收到 relay 注入的 E2EE shim/返回条（外观小事，无功能影响）。

## 4. 双通道配置

### 4.1 配置字段

- `host.json` → `gateway.accessCode?: string`（**明文 + 0600**，已定——比对最简单，trust base 即 host.json，与 hub.json 存商户密钥同理）；
- 两通道读写**同一字段**（镜像 `dshUiCompat` 模式）：CLI 重启生效、插件即时生效。

### 4.2 CLI 通道（`rdsh host serve`）

现状无 `rdsh host config` 子命令，候选（复杂度递增）：
- **A. 直接 host.json**（MVP 最简）：文档写明字段，serve 启动读一次（同 dshUiCompat），重启生效；
- B. serve flag：`rdsh host serve --access-code <code>`（本次生效 + 可持久化写 host.json）；
- C. 专门子命令：`rdsh host access-code set|unset`（最完整）。

### 4.3 插件通道（dsh-web-remote 面板）——镜像 `set-ui-compat`

```
设置 → 远程访问 面板：
│ 访问密码                        [已设置] │
│ （经隧道访问本主机需先输入此密码）       │
│ [ 设置 ] [ 清除 ]                      │
```

- 新 RPC `set-access-code { code? }`：写 host.json + **内存即时生效**（运行中隧道立刻启用 gate）；
- 密码**不回显**（已设置显示 `••••••`，可更改/清除）；
- i18n zh/en。

## 5. 安全细节（记录）

- code 只存 host 侧（host.json 0600），**hub 全程不接触**（配置、比对、签名全在 gateway）；
- 明文 + 0600：trust base 即 host.json 文件权限；泄露风险与 hub.json 私钥同级，遵循同样保管纪律；
- 签名 cookie 绑定会话版本/过期（7 天类比 host cookie），code 变更 → 旧 cookie 失效（签名密钥随 code 派生则天然失效）。

## 6. 已定决策

| # | 议题 | 决定 |
|---|---|---|
| D1 | code 存储 | **host.json 明文 + 0600**（已定）；恒定时间比对 |
| D2 | 作用域 | **只拦隧道流量；本机 127.0.0.1 永远放行**（恢复通道） |
| D3 | E2EE raw 流 | **豁免**（E2EE 有 TOFU PIN；密文流无法注入 challenge） |
| D4 | 双通道 | CLI（重启生效）+ 插件面板 `set-access-code`（即时生效），同写 host.json |
| D5 | 防爆破 | 恒定时间比较 + 全局失败封顶/退避（隧道流量无真实客户端 IP） |
| D7 | 访问 cookie TTL | **7 天**（对齐 host cookie）；code 变更 → 旧 cookie 全失效（D8 天然实现） |
| D8 | cookie 签名 | **HMAC-SHA256(payload, key=sha256(accessCode))**，无状态验签；payload = expiry + 随机 nonce；改 code 即吊销全体旧 cookie |
| D9 | challenge 页 | gateway **内联 HTML**（零外部依赖，不能用 DSH/portal 资源）；显示主机名 +「密码由主机所有者设置，hub 无法绕过」；**深链接回跳**原路径；移动端/PC/微信浏览器兼容；语言按 `Accept-Language`（或中英兜底） |
| D10 | code 最小长度 | **强制 ≥4 位**（设置时拒绝更短；建议 ≥8 或短句，不强制强熵——恒定时间 + D5 已覆盖爆破） |
| D11 | LAN/云直连 | **MVP 不启用**（LAN 已有配对认证、云直连已有 TLS 密码认证，无 hub 中间人环节）；只覆盖 join/hub 隧道路径 |
| D12 | hub 侧配合 | **F7 载流豁免**：hub relay 剥离会话 cookie，但放行网关专用 `rdsh_gate`（不透明标记，校验仍在网关）；hub 先发布、向后兼容旧 gateway |
| D13 | 默认关闭 | **不设 code = 无 gate = 现状**；每 host 自愿开启（opt-in），不强制存量 host |

## 7. 开放问题

- ~~CLI 配置形态~~ ✅ 已定：**A（直接 host.json）**（req §5）
- ~~共享 host 语义~~ ✅ 已定：**member 同样过 gate**（code host 级、owner 分享，req §5）

## 8. 参考

- `packages/gateway/src/join.ts`（`makeInnerDispatcher` plain 分支、jsPatch、startJoin）
- `packages/gateway/src/config.ts`（`dshUiCompat` 模式：host.json 字段 + normalize + 默认）
- `packages/web-remote/src/index.ts`（`set-ui-compat` RPC 模式）、`client.js`（面板 UI）
- `packages/hub/src/relay.ts` + `server.ts`（hub 侧中继与 host cookie）
- `09-e2e-encryption`（E2EE/TOFU：为什么 raw 流豁免、恶意 hub 场景的正解）
