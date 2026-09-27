# 内网直连优先（direct-first）— 待办（TODO.md）

> 机械提取自 plan.md 的 `⏭️`/`❌` 项与 verification.md 的已知缺口。非空 = 本特性尚有后置项，由人复核决定：close / defer / abandon。

| # | 任务 / 缺口 | 决策理由 |
|---|---|---|
| 1 | **P2：App 侧（garsync 另一仓库）**——取候选、试连测速、切换直连、自动回落、指纹固定交互（R5/R8/R11 的 App 部分、R15 度量）；`112_rdsh_direct_first/req.md` 已起草，待审批后进 solution/plan | 计划内后续阶段；不本仓交付 |
| 2 | **P3：https 档位**——TLS 自签 + App 指纹固定（R8），证书纯 JS `selfsigned` 生成、身份绑 host 不绑 IP、两形态共享 `~/.rdsh`（C8） | 计划内后续阶段 |
| 3 | **历史文档仍以配对码为"当时设计"**：`doc/feature/01-remote-access/`、`doc/overview/proposal.md` §4.6、`doc/overview/roadmap.md` 的 M1/05 里程碑行——**用户已决定：历史记录不改写**，保留原文 | 当前面向文档（usage/blog/README/features/architecture）已同步 |
| 4 | `pnpm test`（`pnpm -r test` 递归，含 e2e）未整体跑通（e2e 启动 hub 常驻进程会挂起） | 需在 e2e 环境单独跑；gateway 单测已全绿 |
