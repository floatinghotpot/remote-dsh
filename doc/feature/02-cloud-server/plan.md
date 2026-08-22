# 02-cloud-server — 实施计划

**日期**: 2026-08-23
**来源**: [discussion.md](discussion.md), [req.md](req.md), [solution.md](solution.md)
**范围**: M2 —— 云服务器直连（TLS + user/pass + 配置文件 + 服务化 + 三种部署用例）

## RTTM（需求 → 任务追踪矩阵）

| 需求（req.md） | 任务 | 验证方式 |
|---|---|---|
| R1/R2 TLS（内置证书 + 反代） | T4, T6 | tls/server 单测 + 用例①/1b 验收 |
| R3 user/pass 认证 | T2, T5, T6 | auth 单测 + 登录流程 |
| R4 改密失效会话 | T2, T7 | auth 单测 + 端到端场景 4 |
| R5 登录限流 | T2, T6 | auth 单测 + 场景 3 |
| R6 配置文件 | T1 | config 单测 |
| R7 用户管理 CLI | T2, T10 | auth 单测 + CLI 实测 |
| R8 IP 白名单 | T3, T6 | cidr 单测 + 场景 3 |
| R9 服务化 | T8, T10 | service 单测 + 场景 5 |
| R10 登录页 | T5, T6 | server 单测 + 场景 2 |
| R11 安全基线 | T2, T6, T7 | 单测 + 代码审查 |
| R12 M1 兼容回归 | T6, T12 | M1 e2e 回归（14/14） |

## 任务（含文件路径）

### T1 — 配置模块 `packages/gateway/src/config.ts` + `test/config.test.ts`
- [ ] 默认 `~/.rdsh/config.json`；`--config <path>`/`$RDSH_CONFIG` 覆盖
- [ ] 字段：host/port/sessionTtlSeconds/tls{cert,key}/behindProxy/allowFrom[]/auth{mode,pairCode,users[{name,passwordHash}]}/dshPath
- [ ] 优先级 CLI > config > 默认；非法字段明确报错；缺失字段用默认
- **完成标准**: config.test.ts 全绿（默认/覆盖/优先级/非法）

### T2 — 认证模块 `packages/gateway/src/auth.ts` + `test/auth.test.ts`
- [ ] scrypt 哈希：`scrypt:$N$r$p$salt$hash`（每用户随机盐）；verify 恒定时间
- [ ] UserManager：add/passwd/ls/rm（读写 config users）
- [ ] 登录限流：复用 M1 PairManager 的限流模式（5 次/10 分钟，按 IP）
- [ ] 改密 → 返回"需轮换会话密钥"信号（serve 层调 SessionManager.reset()）
- **完成标准**: auth.test.ts 全绿

### T3 — CIDR 模块 `packages/gateway/src/cidr.ts` + `test/cidr.test.ts`
- [ ] IPv4 CIDR 解析（`a.b.c.d/n`）；`ipInCidr`；边界（/0、/32、前缀）
- **完成标准**: cidr.test.ts 全绿

### T4 — TLS 模块 `packages/gateway/src/tls.ts`
- [ ] 有 `tls.cert/key` → 读 PEM 返回 `{key, cert}`（任意 PEM：acme.sh/Let's Encrypt/云厂商）
- [ ] 无 → 返回 null（http）；`behindProxy: true` → 返回 null（反代终止 TLS）
- [ ] **不内置自签生成**（2026-08-23 修订：无证书即 http；password 无证书由 server 层安全约束拒绝启动）
- **完成标准**: 代码审查 + 用例①实测（用户证书 https 启动）+ 用例 1b（password 无证书拒绝启动）

### T5 — 登录页 `packages/gateway/src/login-page.ts`
- [ ] user/pass 表单（内联零依赖，风格同配对页）；错误/限流提示
- [ ] 可选改密入口占位（M2 预留）
- **完成标准**: 页面无外部请求；错误提示正确

### T6 — 服务器改造 `packages/gateway/src/server.ts` + `test/server.test.ts`（扩展）
- [ ] `node:https` 当 tls 配置（否则 http 原样 —— M1 行为不变）
- [ ] auth mode 路由：pair（现状）/ password（登录页 + POST /login → Set-Cookie + 307 /）/ none（直通）
- [ ] `allow_from` 中间件：认证前检查；`behindProxy` 时取 X-Forwarded-For（仅连接来自回环时信任）
- [ ] 无 TLS + password 且非 behindProxy → 启动拒绝（明确错误）
- [ ] `X-Forwarded-Proto` 识别 https（behindProxy）
- **完成标准**: server.test.ts 扩展全绿（password 登录/改密 307/allow_from 403/拒绝启动）

### T7 — 编排改造 `packages/gateway/src/serve.ts`
- [ ] 从 config 组装（CLI 覆盖）；`--reset` 语义保留
- [ ] 改密后调用 `sessions.reset()`（轮换密钥）
- **完成标准**: 启动日志含生效配置摘要（模式/白名单/证书来源）

### T8 — 服务化 `packages/gateway/src/service.ts` + `test/service.test.ts`
- [ ] systemd 用户级 unit（`~/.config/systemd/user/rdsh.service`：ExecStart、Restart=on-failure、WantedBy=default.target）
- [ ] launchd plist（`~/Library/LaunchAgents/com.rdsh.plist`，KeepAlive=true）
- [ ] install/uninstall/status（systemctl --user / launchctl）
- [ ] 模板内容测试（断言关键字段）
- **完成标准**: service.test.ts 全绿；本机 install/status 实测（不启用）

### T9 — 导出 `packages/gateway/src/index.ts`
- [ ] 导出 config/auth/cidr/tls/service
- **完成标准**: `pnpm build` 零错误

### T10 — CLI 重构 `packages/cli/src/bin.ts`
- [ ] 子命令：`serve [--config] [--reset]` / `user add|passwd|ls|rm [--config]` / `service install|uninstall|status [--config]` / `--version`/`--help`
- [ ] `--config` 全局解析（先于子命令）
- **完成标准**: 各子命令可执行；`--help` 输出完整

### T11 — 测试完善
- [ ] config/auth/cidr/service/server 扩展单测齐全（对齐 T1–T8 完成标准）
- **完成标准**: `pnpm test` 全绿

### T12 — 端到端验收 + 文档
- [ ] 用例①（内置 TLS https + user/pass 全流程，curl/浏览器模拟）
- [ ] 用例②/③（behind_proxy + XFF + WS upgrade，本机模拟反代）
- [ ] M1 e2e 回归（14/14）
- [ ] `verification.md`（RTTM 覆盖 + 缺口）+ plan.md 状态更新
- **完成标准**: verification.md 完成；无 ❌ 遗留（或明确理由）

## 依赖图

```
T1 ──► T2 ──► T6 ──► T7 ──► T9 ──► T10
T3 ─┘   T4 ─┘   T5 ─┘
T8（独立）──────► T10
T11（随模块）──► T12
```

## 状态（2026-08-23 实现中）

| 任务 | 状态 |
|---|---|
| T1 config.ts | ✅ done（config.test 4/4） |
| T2 auth.ts（scrypt+UserManager） | ✅ done（auth.test 8/8） |
| T3 cidr.ts | ✅ done（cidr.test 4/4） |
| T4 tls.ts（PEM/behindProxy，无自签） | ✅ done |
| T5 login-page.ts | ✅ done |
| T6 server.ts（https/auth mode/allow_from/版本会话） | ✅ done（server-m2 9/9 + server 7/7） |
| T7 serve.ts（config 组装） | ✅ done |
| T8 service.ts（systemd/launchd） | ✅ done（service.test 2/2） |
| T9 index.ts 导出 / T10 cli bin.ts 子命令 | ✅ done |
| T11 测试完善 | ✅ done（`node --test "test/*.test.ts"` glob 57/57 全绿、正常退出 —— 挂起问题已解：根因是排查期临时调试文件 m2-debug/m2-net 创建 server 不关闭，删除后 glob 与显式列表行为一致） |
| T12 端到端验收 + verification.md | ✅ done（M2 e2e 43/43：用例① 内置 TLS https 全流程 + 用例①b password 无证书拒绝启动 + 用例② behind_proxy/XFF/WS；M1 e2e 回归 14/14；**2026-08-23 需求修订：去自动自签，无证书即 http** —— 见 verification.md §6） |

*关联文档：discussion.md | req.md | solution.md*
