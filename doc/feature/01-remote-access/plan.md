# 01-remote-access — 实施计划

**日期**: 2026-08-22
**来源**: [discussion.md](discussion.md), [req.md](req.md), [solution.md](solution.md)
**范围**: M1 MVP —— `rdsh serve` 局域网认证网关

## RTTM（需求 → 任务追踪矩阵）

| 需求（req.md） | 任务 | 验证方式 |
|---|---|---|
| R1 CLI 安装与命令 | T10 | `rdsh --version`/`--help`/`serve` 手工 |
| R2 dsh 集成 | T4 | spawn-dsh 单测 + 真实启动 |
| R3 监听配置 | T7, T8 | server 单测 + 真实监听 |
| R4 配对码认证 | T3 | pair 单测 + 端到端 |
| R5 配对校验安全 | T3, T11 | 单测（恒定时间/限流） |
| R6 会话 Cookie | T2, T11 | 单测（签名/过期/属性） |
| R7 全双工转发 | T5, T7 | proxy 单测 + 端到端 |
| R8 前端零改动 | T5 | 透传断言 + 端到端对比 |
| R9 生命周期 | T8 | 信号处理 + `ps` 验证 |
| R10 大流量转发 | T5, T11 | 流式断言 + 大文件测试 |
| R11 安全基线 | T2, T3, T8, T11 | 单测 + 代码审查 |

## 任务（含文件路径）

### T1 — gateway 包基建与依赖
`packages/gateway/package.json`
- [ ] 添加依赖 `ws`（唯一新增；DSH 同款，理由见 solution.md §5.3）
- [ ] 确认 `build: tsc -p tsconfig.json`、`test: node --test test/` 脚本可用
- **完成标准**: 安装依赖后 `pnpm build` 零错误；`ws` 可 import

### T2 — 会话模块 `packages/gateway/src/session.ts`
- [ ] `~/.rdsh/secret.key` 密钥管理：首次生成（0600 权限）、读取、`reset()` 删除
- [ ] HMAC-SHA256 签名：`sign(payload) → cookie`、`verify(cookie) → payload | null`
- [ ] payload：`{ sid: uuid, exp: ISO8601 }`；过期校验；篡改拒绝
- **完成标准**: session.test.ts 通过（签名/过期/篡改/权限/reset）

### T3 — 配对模块 `packages/gateway/src/pair.ts`
- [ ] 配对码生成：`crypto.randomInt(100000, 1000000)`（6 位）
- [ ] 校验：先 SHA-256 再 `crypto.timingSafeEqual`（恒定时间）
- [ ] 限流：`Map<ip, {fails, lockedUntil}>`，5 次失败锁 10 分钟，成功清零
- [ ] `--pair-code` 预置支持；进程生命周期内有效
- **完成标准**: pair.test.ts 通过（校验/恒定时间路径/限流锁定解锁）

### T4 — dsh 集成 `packages/gateway/src/spawn-dsh.ts`
- [ ] PATH 查找 `dsh`（`--dsh <path>` 覆盖）；未找到 → 明确报错
- [ ] spawn `dsh web --port 0 --no-open`，stdio 管道
- [ ] 解析输出 `dsh web: http://127.0.0.1:(\d+)` 取实际端口；30s 超时未就绪报错
- [ ] dsh 日志透传到 rdsh stdout/stderr；dsh 退出 → 跟随退出（透传退出码）
- **完成标准**: spawn-dsh.test.ts（正则解析/mock PATH 缺失）；真实 dsh 启动拿到端口

### T5 — 转发内核 `packages/gateway/src/proxy.ts`
- [ ] HTTP/SSE：`node:http.request` 流式 pipe（零缓冲）；**Host 重写 `127.0.0.1:<dshPort>`**；其余头透传
- [ ] WS upgrade：`ws` 客户端连 `ws://127.0.0.1:<dshPort><path>`（头透传 + Host 重写）→ 上游 101 后向客户端回写 101 → 双向二进制帧桥接
- [ ] backpressure（drain/close 联动）+ 错误/关闭双向传播
- **完成标准**: proxy.test.ts（Host 重写断言/SSE 流式/WS 双向帧/mock 上游）

### T6 — 配对页 `packages/gateway/src/pair-page.ts`
- [ ] 内联纯 HTML/CSS/JS（零外部资源）；自动聚焦；`fetch POST /pair` 提交
- [ ] 提示文案："在开发机终端查看配对码（运行 rdsh serve 的窗口）"
- **完成标准**: 页面无外部请求（检查 HTML 无外链）；错误提示（限流/错误码）

### T7 — 服务器与认证中间件 `packages/gateway/src/server.ts`
- [ ] `node:http` server；路由：`GET /pair`、`POST /pair`（JSON `{code}` → 成功 Set-Cookie + 302 `/`；失败 401/429）
- [ ] 认证中间件：其余路径有有效会话 → 转发；无 → 302 `/pair`；`upgrade` 事件同样过认证
- [ ] SameSite/Origin 兜底校验；`EADDRINUSE` 明确报错
- **完成标准**: server.test.ts（未认证 302/配对流程/Cookie 属性/失效 302）

### T8 — 编排与生命周期 `packages/gateway/src/serve.ts`
- [ ] 组装 T2–T7：spawn dsh → 建 server → 打印启动信息（LAN URL + 配对码 + dsh 端口）
- [ ] SIGINT/SIGTERM：先关网关 → 终止 dsh 子进程 → 退出
- [ ] 默认端口 8443；`--port 0` OS 分配并打印实际端口
- **完成标准**: 真实启动/退出无残留进程（`ps` 验证）

### T9 — gateway 导出 `packages/gateway/src/index.ts`
- [ ] 导出 `serve(options)`（契约：`{ host, port, pairCode?, sessionTtlSeconds, dshPath? }`）
- [ ] `pnpm build` 零错误（tsc strict）
- **完成标准**: 构建通过；`serve` 可 import

### T10 — CLI 入口 `packages/cli/src/bin.ts`
- [ ] 手写参数解析（零依赖）：`serve [--port] [--host] [--pair-code] [--session-ttl] [--dsh] [--reset]`
- [ ] `--version`/`--help`；未知命令报错退出
- [ ] `serve` 委托 `gateway.serve()`；`--reset` 触发密钥重建
- **完成标准**: `node dist/bin.js --help`/`serve --port 9000` 正常；`npm i -g` 后 `rdsh serve` 可用

### T11 — 测试完善 `packages/gateway/test/*`
- [ ] session / pair / proxy / server / spawn-dsh 单测齐全（对齐 T2–T5、T7 完成标准）
- [ ] R10：大请求体流式（不整块缓冲）断言
- **完成标准**: `pnpm test` 全绿

### T12 — 端到端验收 + 文档
- [ ] 真实 dsh（本机 PATH）+ 双设备/curl 模拟：req.md §3 场景 1–6 全通过
- [ ] `ps` 验证进程生命周期（R9）
- [ ] 写 `verification.md`（RTTM 覆盖 + 逐条确认 + 缺口清单）
- [ ] 更新 `plan.md` 任务状态
- **完成标准**: verification.md 完成，无 ❌/⏭️ 遗留（或遗留项有明确理由）

## 依赖图

```
T1 ──► T2 ──┐
     └─► T3 ─┼──► T7 ──► T8 ──► T9 ──► T10
     └─► T4 ─┤
          T5 ─┘      T6 ──┘
T11（随 T2–T5/T7 并行）──► T12
```

- T1–T5 串行核心；T6 独立；T7 依赖 T2/T3/T5/T6；T8 依赖 T7/T4
- T11 每模块随实现同步补测试；T12 最后

## 状态

| 任务 | 状态 |
|---|---|
| T1–T11 | ✅ done（构建 + 单测，最终 33/33） |
| T12 | ✅ done（端到端 14/14，verification.md） |
| T13（R4 扩展） | ✅ done（2026-08-23，`--no-code` 跳过配对；启动警告 + 单测覆盖） |

*关联文档：discussion.md | req.md | solution.md*
