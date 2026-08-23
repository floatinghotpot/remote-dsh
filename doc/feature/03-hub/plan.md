# 03-hub — 实施计划

**日期**: 2026-08-23
**来源**: [discussion.md](discussion.md), [req.md](req.md), [solution.md](solution.md)
**范围**: M3 —— 公网 hub（层 1 API + 层 2 协议定稿 + `rdsh join` 隧道 + portal + 多用户）

## RTTM（需求 → 任务追踪矩阵）

| 需求（req.md） | 任务 | 验证方式 |
|---|---|---|
| R1 hub 服务（https + 服务化） | T8, T9, T12 | hub serve 单测 + e2e |
| R2 层 2 协议定稿（PROTOCOL 冻结） | T1, T2, T3 | frame 单测（编解码/E2E 位）+ 双端一致 |
| R3 `rdsh join`（出站隧道 + 重连 + 心跳） | T10, T11, T12 | join 单测 + e2e 断线重连 |
| R4 host 绑定（配对码 10min / --token 直填） | T6, T11 | auth/api 单测 + e2e 绑定 |
| R5 层 1 API（冻结契约） | T5, T6 | api 单测 + 契约文档对照 |
| R6 portal（登录/列表/进入/改密/改名/吊销） | T13 | portal 构建 + e2e 全流程 |
| R7 令牌与安全（JWT/refresh 轮换/SHA-256 摘要/限流） | T4, T5 | jwt/auth 单测 |
| R8 数据面（隧道注册表 + 多流 + 纯透传） | T7 | relay 单测 + e2e 并发 + WS |
| R9 多用户 + host 归属 | T4, T6 | 隔离单测 + e2e |
| R10 安全基线（哈希存储/日志脱敏/限流） | T4, T5, T6 | 代码审查 + 单测 |
| R11 协议一致性测试 | T2, T3, T14 | frame 单测 + e2e 双端 |
| R12 CLI（join / hub 子命令） | T12 | CLI 实测 + e2e |

## 任务（含文件路径）

### T1 — 协议冻结 `packages/tunnel/PROTOCOL.md`
- [ ] DRAFT → 冻结：payload 编码定稿（OPEN/DATA/CLOSE/PING/PONG/ERROR 语义 + HTTP/WS 封装，见 solution §5.1）
- [ ] E2E 预留位说明（flags bit0 忽略透传）
- **完成标准**: 文档完整；实现（T2）与文档一一对应

### T2 — 帧编解码 `packages/tunnel/src/frame.ts`
- [ ] `encodeFrame(type, streamId, payload, flags?)` / 流式解析器（半帧缓冲、粘包处理）
- [ ] 类型常量（OPEN/DATA/CLOSE/PING/PONG/ERROR）、长度上限校验、E2E 位原样透传
- **完成标准**: 与 PROTOCOL.md 逐字段一致（magic/version/flags/type/streamId/length）

### T3 — 协议一致性测试 `packages/tunnel/test/frame.test.ts`
- [ ] 编解码往返、粘包/半帧、边界（0 负载、大 payload 分片）、E2E 位忽略
- **完成标准**: 全绿

### T4 — hub 配置与 DB `packages/hub/src/config.ts` + `db.ts`
- [ ] hub.json（host/port/tls{cert,key}/dbPath）；默认 `~/.rdsh/hub.json`，`--config`/`$RDSH_HUB_CONFIG` 覆盖
- [ ] `node:sqlite` 四表（users/hosts/pending/refresh_tokens）+ 查询封装；密码 scrypt、token SHA-256 摘要
- **完成标准**: config/db 单测全绿；无明文 token/密码落盘

### T5 — JWT 与认证 `packages/hub/src/jwt.ts` + `auth.ts`
- [ ] 手写 JWT（HMAC-SHA256，三段式，`~/.rdsh/hub-jwt.key` 0600 自动生成）；access 1h 带 ver
- [ ] login（限流 5 次/10 分钟）/ refresh（轮换：旧 refresh 吊销）/ logout / password（改密 → ver+1 全会话失效）
- [ ] host token：随机 32B + SHA-256 摘要存储；pending 配对码（6 位数字唯一、10 分钟）
- **完成标准**: jwt/auth 单测全绿（签发/校验/ver 失效/轮换/改密/限流/吊销）

### T6 — 层 1 API `packages/hub/src/api.ts`
- [ ] `POST /api/auth/login|refresh|logout|password`；`GET /api/hosts`（归属过滤）；`POST /api/hosts/pending`（生成配对码）；`POST /api/hosts/bind`（输码绑定 → 建 host + hostToken）；`PATCH/DELETE /api/hosts/:id`（改名/吊销）；`GET /api/hosts/pending/:id`（gateway 轮询取 token）
- [ ] 无 register 端点（404）；错误统一 `{error:{code,message}}`；ISO 8601
- [ ] 中间件：Bearer JWT 或 httpOnly Cookie 均可；ver 校验（改密即时失效）；host 归属校验（非 owner → 403）
- **完成标准**: api 单测全绿（登录/刷新/改密/绑定/隔离/吊销/404）

### T7 — 数据面 `packages/hub/src/tunnel.ts` + `relay.ts` + `events.ts`
- [ ] 隧道注册表（hostId → WSS + 帧循环）；token 校验（SHA-256 对比）；断开摘除/重连恢复
- [ ] `/h/<hostId>/*` HTTP 透传：OPEN http → DATA 流式 → CLOSE；WS upgrade：OPEN ws → 双向 DATA
- [ ] WSS `/api/events`：登录态订阅，host 在线/离线推送（隧道注册/摘除事件）
- [ ] 并发多流（streamId 原子递增）；错误映射（HOST_OFFLINE 503 / 上游 502）
- **完成标准**: relay/tunnel/events 单测 + e2e 并发 + WS

### T8 — hub 服务器与编排 `packages/hub/src/server.ts` + `serve.ts` + `portal.ts`
- [ ] node:https（复用 loadTls 逻辑：PEM 或报错；无证书拒绝 hub 启动——公网必须 TLS）
- [ ] 静态服务 portal dist（Vite 产物）；`rdsh hub serve` 编排（config/DB/监听/SIGTERM 优雅退出）
- **完成标准**: 启动日志含生效配置（端口/TLS/DB 路径）；portal 首页可访问

### T9 — 导出 `packages/hub/src/index.ts`
- [ ] 导出 config/db/jwt/auth/api/tunnel/relay/serve
- **完成标准**: `pnpm build` 零错误

### T10 — 提取 Host/Origin 重写 `packages/gateway/src/proxy.ts`
- [ ] `rewriteHeadersForDsh(headers, target)` 提取（forwardHttp/createUpgradeProxy 行为不变）
- **完成标准**: 现有 proxy 单测全绿（重构不破坏）

### T11 — join 隧道客户端 `packages/gateway/src/join.ts`
- [ ] `join(hubUrl, {token?, dshPath?})`：spawn dsh（复用）→ 绑定（配对码轮询 5s/10min 超时 或 --token 直填）→ WSS 隧道（?token=）
- [ ] 帧循环：OPEN http → 本地 `node:http.request`（rewriteHeadersForDsh）→ OPEN/DATA/CLOSE 回传；OPEN ws → ws 客户端连本地 dsh → 双向 DATA
- [ ] 重连指数退避（1s→60s + 抖动）；心跳 30s；SIGTERM 优雅退出（复用 serve 模式）
- **完成标准**: join 单测（帧→HTTP/WS/退避）+ e2e 断线重连

### T12 — CLI `packages/cli/src/bin.ts`
- [ ] `rdsh join <hub-url> [--token] [--dsh]`；`rdsh hub serve [--config] [--port] [--host]`；`rdsh hub user add [--no-password]|passwd|rm|ls`；`rdsh hub host ls|revoke`；`rdsh hub service install|status|uninstall`
- [ ] `--help` 完整
- **完成标准**: 各子命令可执行；M1/M2 子命令回归（serve/user/service 不变）

### T13 — portal `packages/portal/src/*`
- [ ] 路由：/login、/hosts（列表 + 绑定弹窗 + 改名/吊销）、/host/:id（iframe + 返回条）、/settings/password
- [ ] api client（fetch + credentials include；cookie 会话）；WSS /api/events 在线状态
- **完成标准**: `pnpm build` 零错误；e2e 全流程走通

### T14 — 端到端验收 + 文档
- [ ] `spike/e2e-m3.sh`：本机 hub + 2×join 模拟公网 → 建号 → 登录 → 绑定（配对码/--token）→ 进入 host 完整 DSH → 并发 → WS → 改密重登 → 吊销断线 → 断网重连
- [ ] 回归：M1 e2e 14/14 + M2 e2e 43/43
- [ ] `verification.md` + plan.md 状态更新
- **完成标准**: e2e 全绿；verification.md 完成；无 ❌ 遗留

### T15 — 文档收尾
- [ ] `doc/overview/usage.md` M3 节（join/hub 命令 + 部署）；roadmap M3 状态
- **完成标准**: 文档与实现一致

## 依赖图

```
T1 ─► T2 ─► T3
T4 ─► T5 ─► T6 ─► T7
T8（依赖 T4/T6/T7）──► T9
T10 ─► T11（依赖 T2）
T12（依赖 T9/T11）
T13（依赖 T6/T7）
T14（依赖 T11/T12/T13）
T15（最后）
```

## 状态（2026-08-23 规划）

| 任务 | 状态 |
|---|---|
| T1 协议冻结 | ✅ done（PROTOCOL.md v1：payload 编码定稿 + 15B 帧头修正） |
| T2 frame.ts | ✅ done（编解码 + FrameParser + E2E 位透传 + 上限校验） |
| T3 frame.test | ✅ done（12/12：往返/粘包/半帧/E2E 位/大 payload/错误路径） |
| T4 config/db | ✅ done（hub.json + sqlite 四表 + 行映射 + pending.token_plain） |
| T5 jwt/auth | ✅ done（手写 JWT + login/refresh 轮换/改密 ver 失效/限流） |
| T6 api.ts | ✅ done（全套端点 + 注册 404 + 隔离 + 配对码流程；api.test 9/9） |
| T7 数据面 | ✅ done（tunnel 注册表 + relay HTTP/WS + events 推送） |
| T8 server/serve/portal | ✅ done（https 组装 + /tunnel + events upgrade + 静态 portal） |
| T9 index 导出 | ✅ done（pnpm build 全绿；hub 单测 22/22） |
| T10 提取 Host 重写 | ✅ done（proxy 单测 5/5 回归；join 复用 rewriteHeadersForDsh） |
| T11 join.ts | ✅ done（findDsh 修复 + --insecure + 绑定轮询 + 重连退避 + 心跳） |
| T12 CLI | ✅ done（join/hub serve/user/host/service 子命令；service.ts subcommandArgs 扩展） |
| T13 portal | ✅ done（React 页面 + api client + **2026-08-23 架构修订**：/portal 前缀 + 整页进入 host（302+cookie 根路径），替代 iframe） |
| T14 e2e-m3 + verification | ✅ done（e2e 26/26：绑定/进入 302+cookie/根路径转发/WS/并发/隔离/改密/吊销/断连重连；回归 M1 14/14 + M2 43/43） |
| T15 文档收尾 | ⏳ pending（usage/roadmap/README/CHANGELOG） |

> **实现期修复**（2026-08-23）：relay 未传 method（POST 被转成 GET → dsh 400）；req end 误删流 handler（GET 响应挂起）；pending 限流计数 bug（60s 内 1 次）；join 漏 findDsh。

*关联文档：discussion.md | req.md | solution.md*
