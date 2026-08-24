# 05-join-easy — 计划（plan.md）

> **日期**: 2026-08-24
> **状态**: 草稿
> **来源**: [solution.md](solution.md)、[req.md](req.md)（R1–R12）；前置：04-cli-refactor（已实现）

---

## 1. 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|---|---|---|
| T1 | join_tokens 表 + CRUD | `packages/hub/src/db.ts` | ⏳ |
| T2 | join-token 创建/列表/吊销 + register 端点 | `packages/hub/src/api.ts`、`server.ts` | ⏳ |
| T3 | gateway `--token` = join token（register）+ 交互粘贴 | `packages/gateway/src/join.ts`、`bin.ts` | ⏳ |
| T4 | service install --token/--name | `packages/cli/src/bin.ts` | ⏳ |
| T5 | portal「添加主机」页 + token 列表 | `packages/portal/src/*` | ⏳ |
| T6 | 单测 + e2e + 文档 | `test/*`、`spike/`、usage/README/CHANGELOG | ⏳ |

## 2. RTTM

| 需求 | 任务 |
|---|---|
| R1 join token 创建 | T1、T2 |
| R2 join token 列表/吊销 | T1、T2 |
| R3 register 端点 | T1、T2 |
| R4 join_tokens 表 | T1 |
| R5 host join 交互注册 | T3 |
| R6 凭证解析顺序 | T3 |
| R7 service install --token | T4 |
| R8 portal 添加主机页 | T5 |
| R9 配对码保留 | T3 |
| R10 安全基线 | T2（哈希/限流） |
| R11 join 核心可复用 | T3 |
| R12 文档 | T6 |

## 3. 执行顺序

```
T1（表）→ T2（端点）→ T3（gateway register + 交互）→ T4（service install）→ T5（portal）→ T6（测试/文档）
```

每任务后 `pnpm build` + 相关 `node --test`，全绿再进下一任务；T6 全量回归后本地 commit（不 push）。

*关联文档：discussion.md | req.md | solution.md*
