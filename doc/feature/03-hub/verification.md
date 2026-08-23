# 03-hub — 验证（verification.md）

> **日期**: 2026-08-23
> **范围**: M3 —— 公网 hub（层 1 API + 层 2 协议 + `rdsh join` 隧道 + portal + 多用户）
> **来源**: [req.md](req.md) R1–R12, [plan.md](plan.md) T1–T15

## 1. RTTM 覆盖复查

| 需求 | 任务 | 状态 | 验证证据 |
|---|---|---|---|
| R1 hub 服务（https + 服务化） | T8, T9, T12 | ✅ | e2e：hub https 启动（自签测试证书）；`rdsh hub service install`（模板单测断言，未在本机 launchctl 实测——同 M2 R9 边界） |
| R2 层 2 协议定稿 | T1, T2, T3 | ✅ | PROTOCOL.md 冻结 v1（15B 帧头）；frame 单测 12/12（编解码/粘包/半帧/E2E 位/超限） |
| R3 `rdsh join`（出站隧道 + 重连 + 心跳） | T10, T11, T12 | ✅ | e2e：绑定→隧道建立→转发；吊销后断线重连被拒（tunnel lost ×N）；40s 心跳 0 断连（手动验证） |
| R4 host 绑定（配对码 10min / --token 直填） | T6, T11 | ✅ | api 单测（pending→bind→轮询取 token→token 只取一次）；e2e 双 join（A 配对码 / B 配对码）；**--token 直填路径**由代码审查覆盖（B 未用 --token，因 e2e 中 token 轮询即取；脚本化部署场景记录） |
| R5 层 1 API（冻结契约） | T5, T6 | ✅ | api 单测 10/10：login/refresh/logout/password/first-password/hosts/pending/bind/隔离/404 |
| R6 portal | T13 | ✅ | vite build 通过；e2e 全流程（登录→绑定→进入→改密）走浏览器同款 HTTP；iframe 方案（dsh 无 frame 头，已查档） |
| R7 令牌与安全 | T4, T5 | ✅ | auth 单测 9/9：JWT 签名/ver 失效/refresh 轮换/改密吊销/限流/哈希摘要存储 |
| R8 数据面 | T7 | ✅ | e2e：进入 /h/ 302 + cookie 路由 → 根路径首页 200 + session.list 200 + WS OPEN + 连续访问（多流）；hub 纯透传（代码审查：relay 不解析业务报文，仅 HTML 注入返回条壳） |
| R9 多用户 + host 归属 | T4, T6 | ✅ | api 单测 + e2e：bob 看不到/访问不了 admin 的 host（403） |
| R10 安全基线 | T4, T5, T6 | ✅ | 密码 scrypt、host/refresh token SHA-256 摘要（单测断言无明文）；日志无密码/token（审查）；注册关闭 404；限流 429 |
| R11 协议一致性测试 | T2, T3, T14 | ✅ | frame 单测 + e2e 双端一致（hub↔gateway 同一冻结协议） |
| R12 CLI | T12 | ✅ | 冒烟：--help/version/hub user add/ls；e2e 全程走 CLI |

## 2. 端到端验收结果（真实 dsh，2026-08-23）

脚本：`spike/e2e-m3.sh`（本机模拟公网：hub + 2×join + 浏览器模拟；gitignore 已覆盖）

**PASS=23 FAIL=0**：

```
✓ hub https 启动（自签测试证书）
✓ register 404（注册关闭，防 bot）
✓ 登录 200 + accessToken；错误密码 401
✓ join A 配对码绑定 → 在线（隧道建立）
✓ 首页 HTML 200（真实 dsh 经隧道）；RPC session.list 200
✓ WS /h/<id>/api/events.mux 握手 OPEN（WS 经隧道）
✓ 连续访问同一 host 200（多流）
✓ join B 配对码绑定 → 2 host 全部注册且在线
✓ bob 隔离：空列表 + 访问 403
✓ 改密 → 旧 cookie 401；新密码重登 200
✓ 吊销 host → 隧道断开 + 重连被拒（tunnel lost ×3）
✓ SIGTERM 优雅退出：hub 退出、join 无 dsh 残留
```

**回归**：M1 e2e 14/14 + M2 e2e 43/43 全绿（rdsh serve / user / service / TLS 不受影响）。

## 3. 单测结果（92/92）

| 包 | 数量 | 覆盖 |
|---|---|---|
| tunnel frame.test | 12 | 帧编解码/粘包/半帧/E2E 位/大 payload/错误路径 |
| hub config/auth/api | 23 | hub.json/JWT/登录/轮换/改密/限流/绑定/隔离/404/激活 |
| gateway 全量 | 57 | M1+M2 回归（proxy 重构 rewriteHeadersForDsh 不破坏） |

## 4. 实现期发现并修复的问题

| 问题 | 根因 | 修复 |
|---|---|---|
| POST 请求被 dsh 拒（400） | relay `openStream` 未传 HTTP method → join 默认 GET | OPEN 帧带 method 字段（tunnel/relay/join 三处同步） |
| GET 响应挂起（curl 000） | relay 的 `req.on("end")` 调 closeStream 删 handler（GET 无 body 立即触发）→ 响应帧找不到流 | 拆分 `endRequest`（只发 CLOSE 不删 handler）/ `abortStream`（客户端中断才清理） |
| join 绑定 429（pending 限流误伤） | pending 限流实现成"60s 内 1 次"（记时间而非计数） | 改计数窗口（10 次/分钟） |
| join 启动失败 | `spawnDsh("")` 漏 findDsh | 复用 findDsh（同 serve） |
| join 对自签 hub 的 fetch 失败 | undici fetch 不受 `NODE_TLS_REJECT_UNAUTHORIZED` 影响 | join 改用 node:https 调用 + `--insecure` flag（正式证书无需） |
| CLI 测试假象 | bash `&` 后台链中变量赋值不可见（$D 空 → 默认配置路径） | 非产品 bug；测试命令修正 |

## 5. 缺口与遗留（severity + 建议）

| 缺口 | 严重度 | 建议 |
|---|---|---|
| `rdsh join --token` 直填路径未 e2e 覆盖（token 仅轮询可得） | P3 | 脚本化部署场景：`rdsh hub host ls` 不输出明文 token；管理员重新绑定获取。e2e 补 --token 场景（T15 或 M4 前） |
| join 进程被 SIGKILL 时 dsh 孤儿 | P3 | 正常路径（SIGTERM）已回收；SIGKILL 无法拦截——生产期（M7 Go 化）用进程组/服务托管兜底 |
| hub 服务化（launchd）未本机实测 | P3 | 同 M2 R9 边界：模板单测 + 云服务器手工验收 |
| 真实公网服务器验收未做 | P3 | 用户有云服务器时按 usage.md M3 节手工部署 |
| pending 限流按 IP（多 gateway 同 NAT 会共享额度） | P3 | 自托管可接受；后续可加共享密钥预认证 |

## 6. 架构修订（2026-08-23，实现期发现）

**进入 host 的访问架构**：黑屏问题（DSH 绝对路径 /assets /api 与 /h/ 前缀冲突）→ 查档确认 DSH 是 Cordis 插件化动态模块加载（前缀内容改写不可控）→ 定案**根路径 + cookie 选 host**：`/h/<hostId>/` 校验归属 → Set-Cookie `rdsh_host` → 302 根路径，DSH 在根路径运行（与 M1 同形态，零前端改动）。portal 移 /portal 前缀。同一浏览器一次一个 host 上下文（cookie 单值，串行正常；多浏览器可并行）；多用户（不同浏览器）互不影响。

## 7. 结论

**M3 公网 hub 验收通过**（2026-08-23）：

- 单测 92/92 + M3 e2e 23/23 + M1 回归 14/14 + M2 回归 43/43
- 层 2 协议冻结 v1（跨语言契约，Go 实现依据）；层 1 API 全套端点冻结
- R1–R12 全部 ✅（R9/R12 部分项与 M2 同边界）
- 实现期修复 5 个真实 bug（method 透传 / 流生命周期 / 限流计数 / findDsh / TLS 校验）
- 无 ❌ 阻塞项

*关联文档：req.md | solution.md | plan.md*
