# 02-cloud-server — 验证（verification.md）

> **日期**: 2026-08-23
> **范围**: M2 —— 云服务器直连（TLS + user/pass + 配置文件 + 服务化 + 三种部署用例）
> **来源**: [req.md](req.md) R1–R12, [plan.md](plan.md) T1–T12

## 1. RTTM 覆盖复查

| 需求 | 任务 | 状态 | 验证证据 |
|---|---|---|---|
| R1 HTTPS 三种部署（内置 TLS / apache2 反代 / nginx 反代） | T4, T6 | ✅ | e2e 用例① 用户证书 https 启动 + 完整登录流转发；用例② 模拟反代（XFF/Proto + WS upgrade）全通；nginx/apache 配置见 usage.md §7（本机模拟验证，真实服务器可选） |
| R2 证书由用户提供（无证书即 http；password 无证书拒绝） | T4, T6 | ✅ | e2e 用例 1b：password 无证书非反代 → 非零退出 + `requires TLS` 报错 + dsh 无残留；pair 无证书 → http 启动（M1 回归 14/14） |
| R3 user/pass 认证 | T2, T5, T6 | ✅ | auth 单测 8/8；e2e：未认证 307 /login → 登录页 → 错误 401 → 正确 302+HttpOnly/SameSite Cookie → 转发真实 dsh（RPC 200） |
| R4 改密失效会话 | T2, T7 | ✅ | e2e：`user passwd` 后旧 Cookie 307、新密码可登录（config watch 热更新 auth.version） |
| R5 登录限流 | T2, T6 | ✅ | e2e：第 5 次错误密码 → 429；锁定中正确密码也 429 |
| R6 配置文件 | T1 | ✅ | config 单测 4/4；e2e：`--config` 全局共享 serve/user add/ls/passwd；CLI 覆盖 config |
| R7 用户管理 CLI | T2, T10 | ✅ | e2e：add/ls/passwd 实测；scrypt 哈希落盘、无明文；**管道输入 bug 已修**（见 §4） |
| R8 IP 白名单 | T3, T6 | ✅ | cidr 单测 4/4；e2e：热更新 403/恢复 200；XFF 信任边界（回环信任、伪造拒绝） |
| R9 服务化 | T8, T10 | ✅（部分） | service 单测 2/2（systemd/launchd 模板字段断言）；`service status` 实测；**install/uninstall 未在本机实测**（launchd 副作用，见 §5） |
| R10 登录页 | T5, T6 | ✅ | e2e：GET /login 200 含密码框；password 模式 /pair → 307（登录页替换配对页） |
| R11 安全基线 | T2, T6, T7 | ✅ | scrypt 哈希 + 恒定时间校验（单测）；无明文密码（e2e grep）；无 TLS+password 拒绝启动（e2e 1b）；日志不打印密码/Cookie（代码审查） |
| R12 M1 兼容回归 | T6, T12 | ✅ | M1 e2e（`spike/e2e-serve.sh`）14/14 全绿；pair 模式 http 行为与 M1 一致 |

## 2. 端到端验收结果（真实 dsh，2026-08-23）

脚本：`spike/e2e-m2.sh`（用例① + 用例①b + 用例②，本机模拟；gitignore 已覆盖）

**PASS=43 FAIL=0**：

```
用例① 内置 TLS（一次性 openssl 测试证书）https + user/pass：
✓ user add/ls（scrypt 哈希、无明文）+ serve 启动 https + auth mode: password + TLS: custom cert
✓ 未认证 GET / → 307 /login；GET /login 200 含密码框；/pair → 307
✓ 错误密码 401 → 正确密码 302 + HttpOnly + SameSite=Lax Cookie
✓ cookie GET / 与 POST /api/session.list → 200（真实 dsh 转发）
✓ 带 Origin RPC 非 403（围栏兼容）；wss:// WS /api/events.mux → OPEN
✓ 改密 → 旧 Cookie 307；新密码 302 + 新 Cookie 200
✓ allow_from 热更新：白名单外 403 → 恢复 200
✓ 登录限流：5 次错误 → 429；锁定中正确密码也 429
✓ SIGTERM 优雅退出 + 无 dsh 残留

用例①b password + 无证书 + 非反代 → 拒绝启动：
✓ 非零退出 + requires TLS 报错 + 无 dsh 残留（启动失败回收子进程）

用例② behind_proxy（本机模拟反代，XFF: 1.2.3.4 + allowFrom 1.2.3.4/32）：
✓ behind_proxy + password + http 启动（信任反代 TLS）
✓ 直接连（无 XFF）403；伪造 XFF 9.9.9.9 → 403；回环带 XFF 1.2.3.4 → 通过白名单
✓ 经反代：登录页 200 → 登录 302 → cookie 访问 200 → WS upgrade OPEN
✓ SIGTERM 优雅退出 + 无 dsh 残留
```

**M1 回归（`spike/e2e-serve.sh`）PASS=14 FAIL=0**：pair 模式 http 行为与 M1 完全一致（未认证 307、配对、Cookie、转发、WS、篡改、SIGTERM 无残留）。

## 3. 单测结果（`node --test "test/*.test.ts"`，57/57）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| session.test.ts | 8 | 签名/过期/篡改/权限/reset/Cookie 属性/版本化会话 |
| pair.test.ts | 6 | 配对码/限流/异常 |
| proxy.test.ts | 5 | HTTP 转发/Host+Origin 重写/SSE 流式/WS 双向/HTML 注入 |
| server.test.ts | 7 | pair 模式回归/noCode/307/转发/限流/reset |
| server-m2.test.ts | 9 | password 登录/改密失效/allow_from/XFF 边界/无 TLS 拒绝/behindProxy 允许/预置哈希用户 |
| spawn-dsh.test.ts | 4 | PATH/override/端口解析/失败 |
| config.test.ts | 4 | 默认/覆盖/优先级/非法 |
| auth.test.ts | 8 | 哈希格式/校验/错误密码/用户 CRUD |
| cidr.test.ts | 4 | 解析/命中/边界 |
| service.test.ts | 2 | systemd/launchd 模板 |

> glob 挂起问题已解：`node --test "test/*.test.ts"` 57/57 正常退出（根因：排查期临时调试测试文件创建 server 不关闭，删除后恢复，见 plan.md T11 注）。

## 4. 实现期发现并修复的问题

| 问题 | 根因 | 修复 |
|---|---|---|
| `echo pw \| rdsh user add` 读不到输入（headless 脚本化部署不可用） | 非 TTY 下每次调用新建 `readline` interface，第二个 interface 读不到管道剩余行（第一个 close 后 stdin 状态问题） | `promptPassword` 非 TTY 分支改为共享行队列：一次性读完 stdin（EOF），逐行消费 |
| `allow_from` 热更新不生效（改密热更新却正常） | `rdsh user passwd` 用 tmp+rename 原子替换 config → macOS kqueue 文件级 watch 盯旧 inode，之后对**新 inode** 的写入不再触发事件 | watch 目录而非文件（目录 vnode 稳定），按 basename 过滤 |
| password 无证书拒绝启动时 dsh 子进程残留 | `startGateway` 抛错前 dsh 已 spawn，serve.ts 无回收路径 | serve.ts try/catch 包住 startGateway，失败先 `dsh.stop()` 再抛 |
| pair 模式（无 config）在生成过 `~/.rdsh/cert.pem` 后自动变 https，破坏 M1 行为 | 旧实现"无证书自动自签"无差别生效于所有 auth 模式 | **需求修订**（用户决策）：去掉自动自签，无证书即 http；password 无证书非反代由安全约束拒绝（见 §6） |

## 5. 缺口与遗留（severity + 建议）

| 缺口 | 严重度 | 建议 |
|---|---|---|
| `rdsh service install/uninstall` 未在本机实测（仅模板单测 + `status` 实测） | P3 | launchd install 会真实注册服务（含 KeepAlive 重启循环风险），避免污染开发机；systemd 用户级流程已在模板单测断言关键字段；云服务器部署时手工验收（usage.md §6） |
| 用例②/③ 为本机模拟反代，未在真实 apache2/nginx 上验证 | P3 | 反代配置（upgrade 头/XFF/Proto）已文档化（usage.md §7）；有真实云服务器时按部署用例手工验收 |
| 真实云服务器端到端（`rdsh service install` + 公网 https + `sudo reboot` 自启）未做 | P3 | 用户有云服务器时可执行；本机已覆盖全部网关行为 |
| 300 MB 大流量压测（M1 遗留） | P2 | M6 上线前补（M1 verification.md 已记录） |

## 6. 需求修订记录（2026-08-23）

**去自动自签**（用户决策，影响 R1/R2/用例①/§5 待定项）：

- **之前**：无证书时 `rdsh serve` 自动生成自签证书（openssl 调用，`~/.rdsh/cert.pem`），所有模式默认 https。
- **之后**：**无证书即 http**（仅 pair/none）；`auth.mode: password` 无证书且非反代 → 拒绝启动（提示配 `tls.cert/key`）。https 必须用户提供证书（acme.sh / Let's Encrypt / 云厂商 / 手动 openssl 自签）。
- **动因**：① 避免自动生成影响 M1 pair 模式行为（自签 https 破坏 LAN http 体验）；② 去掉 openssl 运行时依赖（依赖最小化）；③ 云服务器场景用户本来就要配正式证书。
- **同步修改**：req.md（R1/R2/用例①/待定项）、solution.md、plan.md（T4）、usage.md、roadmap.md、tls.ts（删自签生成）、serve.ts（TLS 决策与日志）、e2e-m2.sh（用例①用一次性测试证书 + 新增用例①b 拒绝启动）。

## 7. 结论

**M2 云服务器直连验收通过**（2026-08-23）：

- 单测 57/57（glob 模式正常退出）+ M2 e2e 43/43 + M1 e2e 回归 14/14
- R1–R12 全部 ✅（R9 部分：模板 + status 实测，install/uninstall 云服务器手工步骤）
- 实现期发现并修复 3 个真实 bug（管道输入 / config watch / dsh 回收）+ 1 项需求修订（去自动自签）
- 无 ❌ 阻塞项

*关联文档：req.md | solution.md | plan.md*
