# 01-remote-access — 需求（req.md）

> **日期**: 2026-08-22
> **状态**: 草稿，**待用户批准**
> **范围**: M1 MVP —— 仅 rdsh-gateway（LAN 模式）
> **来源**: [discussion.md](discussion.md), [proposal.md](../../marketing/proposal.md)（Q9 决策）

---

## 1. 目标

一条命令把 DSH 从"本机工具"变成"局域网可访问"：开发机 `npm i -g remote-dsh` 后执行 `rdsh serve`，同一 WiFi/局域网内的另一台笔记本或手机浏览器，输入终端显示的配对码即可完整操作该机器上的 DSH。**不引入 hub、不引入账号体系。**

## 2. 范围

### 2.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **CLI 安装与命令**：`npm i -g remote-dsh` 提供 `rdsh` 命令；支持 `--version`、`--help`、`serve` 子命令 | 安装后 `rdsh --version` 输出版本；`rdsh --help` 列出 `serve` 等命令；`rdsh serve` 可启动 |
| R2 | **dsh 集成**：自动发现 PATH 中的 `dsh`；spawn `dsh web --port 0 --no-open`（OS 分配端口，避免 3080 冲突）；读取实际监听端口 | 启动后日志打印 dsh 实际端口；`dsh` 不在 PATH 或启动失败时，`rdsh serve` 以非零状态退出并输出明确原因 |
| R3 | **监听配置**：默认监听 `0.0.0.0`（LAN 可达）；支持 `--port`、`--host` 覆盖；打印 `http://<本机LAN-IP>:<port>` 访问提示 | 同 LAN 设备可访问；`--port 9000` 后端口生效；打印的 URL 可在另一台设备打开 |
| R4 | **配对码认证**：启动时生成随机配对码（终端显示）；支持 `--pair-code` 预置；未认证请求一律拒绝。**新增（2026-08-23）：`--no-code` 可选跳过配对认证**（启动打印显著警告；仅限完全可信局域网/开发调试） | 未输入配对码时浏览器只看到配对页，无法触达 DSH 任何功能；`--pair-code abc123` 后用 abc123 可配对；`--no-code` 时无 Cookie 直接访问 DSH |
| R5 | **配对校验安全**：配对码比较为恒定时间；配对接口按 IP 限流（失败超阈值锁定一段时间） | 代码审查 + 自动化测试覆盖恒定时间比较与限流逻辑 |
| R6 | **会话 Cookie**：配对成功后签发签名会话 Cookie（HttpOnly + SameSite=Lax，HMAC-SHA256，默认 12h 可配 `--session-ttl`）；`rdsh serve --reset` 使全部会话失效 | 配对后浏览器带 Cookie 可直接使用；Cookie 带 HttpOnly/SameSite 属性；`--reset` 后旧 Cookie 失效需重新配对 |
| R7 | **全双工转发**：HTTP 请求、SSE 流、WebSocket upgrade（含 `/api/events.mux`、`/api/events.host`）全部原样透传给 dsh，不修改业务报文 | 另一台设备上 DSH 的对话、工具执行、文件浏览、实时事件推送全部正常 |
| R8 | **前端零改动**：完全复用 dsh 自带前端与 `/api` 契约；网关不修改、不重写任何 DSH 产物 | DSH 界面与直连本机时一致（逐项对比核心功能） |
| R9 | **生命周期**：`SIGINT`/`SIGTERM` 优雅退出（先停网关、再终止 dsh 子进程）；端口被占用时报错退出而非挂起 | Ctrl+C 后无残留 dsh 进程（`ps` 验证）；占用端口时启动报错 |
| R10 | **大流量转发**：请求体上限对齐 dsh（300 MB），流式转发、禁止整体缓冲；支持多客户端并发 | 自动化测试：大文件/大图片上传不内存暴涨；两个设备同时使用互不干扰 |
| R11 | **安全基线**：默认拒绝一切未认证流量；不落盘业务流量与配对码；会话密钥文件权限 600；日志不记录配对码/Cookie | 代码审查 + 测试：无认证流量被拒、无敏感数据写盘、密钥文件权限正确 |

### 2.2 不含（Out of Scope，明确排除）

- ❌ 公网 hub（`rdsh join`、rdsh-hub、rdsh-portal）—— M3
- ❌ 用户注册/账号体系/多租户 —— M4
- ❌ rdsh-app（Flutter）—— M5；rdsh-weapp —— M8
- ❌ 端到端加密（仅协议层预留）—— M7+ / SaaS 化时
- ❌ profile/workspace 级授权（整实例授权）—— 后置
- ❌ 修改 DSH 本体（不改 dsh 源码、不打补丁）

## 3. 端到端验收场景（Acceptance Scenario）

> **场景**：开发机 A 与笔记本 B 在同一 WiFi。
> 1. A 上：`npm i -g remote-dsh`（dsh 已装）→ `rdsh serve`，终端显示配对码与 `http://<A的IP>:<port>`。
> 2. B 浏览器打开该 URL → 看到配对页（非 DSH 界面）→ 输入配对码 → 进入 DSH 界面。
> 3. B 上完整操作：新建会话并对话、执行一个 shell 工具、浏览工作区文件、观察实时事件流正常。
> 4. B 关闭浏览器后重新打开 → 会话 Cookie 有效期内免配对直接进入。
> 5. 未配对的第三方设备访问同一 URL → 始终停留在配对页，无法触达 DSH。
> 6. A 上 `rdsh serve --reset` → B 再次访问需重新配对。

## 4. 验收执行方式

- 自动化：`node --test`（恒定时间比较、限流、Cookie 签名/过期、转发基础路径、密钥文件权限）
- 手工：上述端到端场景全流程（真实双设备）；`ps` 验证进程生命周期
- 文档：`verification.md` 逐条对照 R1–R11 + RTTM

## 5. 待定项（留给 solution.md 定稿，不阻塞 req 批准）

- 默认监听端口数值（建议 8443，可 `--port` 覆盖）
- 配对码有效期语义（建议：进程生命周期内有效，重启失效；`--pair-code` 可预置）
- 限流具体参数（失败次数/锁定时长）
- 会话 TTL 默认值确认（建议 12h）

*关联文档：discussion.md | proposal.md | 下一步：solution.md（待 req 批准后）*
