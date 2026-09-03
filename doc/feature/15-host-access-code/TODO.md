# 15-host-access-code — 待办（TODO.md）

> 机械提取自 [plan.md](plan.md) 的 `⏭️` 项。非空 = 本特性尚有后置项，由人复核决定：close / defer / abandon。

| # | 任务 | 决策理由 |
|---|---|---|
| T10 | web-remote `set-access-code` 状态机单测（复用 join-core 模式；该包现无 test runner） | 本轮后置——RPC 为薄胶水（config normalize + `handle.setAccessCode` 均已测）；补 harness 待后续 |
