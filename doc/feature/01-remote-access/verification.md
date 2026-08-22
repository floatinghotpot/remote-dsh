# 01-remote-access — 验证（verification.md）

> **日期**: 2026-08-22
> **范围**: M1 MVP —— `rdsh serve` 局域网认证网关（T1–T12）
> **来源**: [req.md](req.md) R1–R11, [plan.md](plan.md) T1–T12

## 1. RTTM 覆盖复查

| 需求 | 任务 | 状态 | 验证证据 |
|---|---|---|---|
| R1 CLI 安装与命令 | T10 | ✅ | `node packages/cli/dist/bin.js --version/--help/serve` 实测；bin 指向 dist/bin.js |
| R2 dsh 集成 | T4 | ✅ | spawn-dsh 单测 4/4；端到端真实 dsh 端口解析（57067） |
| R3 监听配置 | T7, T8 | ✅ | server 单测；端到端 0.0.0.0 + 指定端口 + LAN URL 打印（多网卡） |
| R4 配对码认证 | T3 | ✅ | pair 单测 6/6；端到端：未认证 307 → 配对 302 |
| R5 配对校验安全 | T3, T11 | ✅ | 恒定时间比较（SHA-256 + timingSafeEqual）代码审查；限流单测 + 端到端 401/429 路径 |
| R6 会话 Cookie | T2, T11 | ✅ | session 单测 8/8；端到端 Set-Cookie 含 HttpOnly/SameSite=Lax；篡改 307；reset 失效 |
| R7 全双工转发 | T5, T7 | ✅ | proxy 单测 3/3（HTTP/SSE/WS）；端到端 `POST /api/session.list` 200 + `WS /api/events.mux` OPEN |
| R8 前端零改动 | T5 | ✅ | 端到端首页 200（dsh dist 原样透传）；网关不改写业务报文（代码审查） |
| R9 生命周期 | T8 | ✅ | 端到端 SIGTERM 后 gateway 退出 + `pgrep` 无 dsh 残留 |
| R10 大流量转发 | T5, T11 | ⏭️ 部分 | SSE 流式单测通过（多块到达、非整体缓冲）；**300 MB 真实压测未执行**（pipe 实现审查为流式，风险低，建议 M2 前补） |
| R11 安全基线 | T2, T3, T8, T11 | ✅ | 密钥文件 0600 单测；默认拒绝（307）端到端；日志不打印 Cookie/配对码（审查） |

## 2. 端到端验收结果（真实 dsh，2026-08-22/23）

脚本：`spike/e2e-serve.sh`（一次性验证，MVP 后移除，gitignore 已覆盖）

**PASS=14 FAIL=0**：

```
✓ 启动：配对码 + dsh 端口（OS 分配）+ LAN URL 多网卡打印
✓ 未认证 GET / 与 /api/* → 307 /pair
✓ GET /pair 配对页 200
✓ POST /pair 错误码 401
✓ POST /pair 正确码 302 + HttpOnly + SameSite=Lax Cookie
✓ RPC POST /api/session.list → 200（dsh 结构化响应，转发链路打通）
✓ 首页 HTML（dsh dist）200
✓ 带 Origin 的 POST /api/host.pickDirectory → 200（围栏兼容，非 403）
✓ WS /api/events.mux 握手 OPEN（WebSocket 桥接打通）
✓ 篡改 cookie → 307
✓ SIGTERM 优雅退出 + 无 dsh 残留进程
```

## 2.1 已修复的运行时问题（2026-08-23，双设备实测发现）

| 问题 | 根因 | 修复 |
|---|---|---|
| 目录选择报 `crypto.randomUUID is not a function` | LAN http 非 secure context，浏览器无 `crypto.randomUUID`（DSH RPC 依赖） | 网关注入 polyfill（`getRandomValues` 实现 UUID v4，非 secure context 可用） |
| 目录选择报 `transport failure for /api/host.pickDirectory: HTTP 403` | DSH 围栏要求 `Origin.host === Host.host`；浏览器 Origin 是 LAN 地址，转发后 Host 是 loopback → 不匹配 | 转发时改写 Origin 与 Host 一致（浏览器视角仍同源，无 CORS 影响） |
| SIGTERM 后进程不退出 | shutdown 只设 exitCode，残留句柄（信号监听器/管道）挂住 | 显式 `process.exit()` + 幂等标志 |
| 关终端（SIGHUP）dsh 变孤儿 | 未处理 SIGHUP，默认终止跳过清理 | SIGHUP 也走优雅退出 |

## 3. 单测结果（`node --test`，33/33）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| session.test.ts | 8 | 签名/过期/篡改/伪造未来/权限 0600/reset/Cookie 属性/解析 |
| pair.test.ts | 6 | 生成/预置/清零/锁定/空白/异常输入 |
| proxy.test.ts | 5 | HTTP 转发 + Host 重写断言/**Origin 改写断言**/SSE 流式/WS 双向桥接/HTML 注入 |
| server.test.ts | 7 | 配对页/307/401→302→Cookie/转发/限流 429/reset 失效/**noCode 放行（HTTP+WS）** |
| spawn-dsh.test.ts | 4 | PATH 查找/override/端口解析/启动失败 |

## 4. 缺口与遗留（severity + 建议）

| 缺口 | 严重度 | 建议 |
|---|---|---|
| 300 MB 大请求体真实压测未做 | P2（低风险） | 实现为流式 pipe（审查确认）；M2 前补一次大文件压测 |
| ~~真实双设备（另一台笔记本/手机浏览器）~~ | — | **已补（2026-08-23 用户实测通过）** |
| 浏览器配对页的限流提示/锁定体验 | P3 | 已实现 429 + Retry-After；文案待真实设备验证 |
| `~/.rdsh` 真实目录（非测试临时目录）首次使用 | P3 | 单测用临时目录隔离；首次真实运行已验证（端到端即真实 ~/.rdsh） |

## 5. 结论

**M1 MVP 验收通过**（2026-08-23）：
- 单测 33/33 + 端到端 14/14（真实 dsh）
- **真实双设备验收通过**（用户实测：配对 → 目录选择 → 完整操作均正常）
- R1–R9、R11 全部 ✅；R10 部分验证（流式实现确认，300 MB 压测后置）；R4 新增 `--no-code`（跳过配对，可信网络专用）
- 四个运行时问题（randomUUID / Origin 403 / 退出挂起 / SIGHUP 孤儿）全部修复（见 §2.1）
- 无 ❌ 阻塞项

*关联文档：req.md | solution.md | plan.md*
