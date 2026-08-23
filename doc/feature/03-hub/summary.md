# 03-hub — 总结（summary.md）

> **日期**: 2026-08-23
> **范围**: M3 公网 hub —— 验收通过

## 结果

- **层 2 协议冻结 v1**（`packages/tunnel/PROTOCOL.md`）：帧格式 + payload 编码 + E2E 预留位；`frame.ts` 编解码 + 12/12 一致性测试
- **层 1 API 冻结**：auth/hosts/pending/bind/events/透传全套端点 + api 单测 10/10
- **`rdsh join`**：出站隧道（配对码/--token 绑定、心跳、指数退避重连、--insecure）；**`rdsh hub`**：serve/user/host/service 子命令
- **hub 服务器**：https（TLS 必需）+ node:sqlite 控制面 + 隧道注册表 + 纯透传数据面 + portal 静态
- **portal**：React 登录/host 列表/iframe 进入/改密/绑定/吊销
- **多用户 + host 归属**：注册关闭（管理员建号防 bot）、JWT 会话（ver 即时失效）、token SHA-256 摘要

## 验收

- 单测 92/92（tunnel 12 + hub 23 + gateway 57）+ M3 e2e 23/23 + M1 回归 14/14 + M2 回归 43/43
- 实现期修复 5 个 bug：method 透传、流生命周期（GET 挂起）、pending 限流计数、join findDsh、自签 TLS

## 变更

- 新增：`packages/tunnel/src/{frame,constants}.ts`、`packages/hub/src/{config,db,jwt,auth,api,tunnel,events,relay,portal,server,serve}.ts`、`packages/gateway/src/join.ts`、portal React 页面、`doc/feature/03-hub/*`
- 修改：`packages/gateway/src/proxy.ts`（提取 rewriteHeadersForDsh）、`packages/gateway/src/service.ts`（subcommandArgs）、`packages/cli/src/bin.ts`（join/hub 子命令）、`packages/tunnel/PROTOCOL.md`（冻结）、usage/roadmap/README/CHANGELOG

*关联文档：discussion.md | req.md | solution.md | plan.md | verification.md*
