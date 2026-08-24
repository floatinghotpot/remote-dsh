# 04-cli-refactor — 计划（plan.md）

> **日期**: 2026-08-24
> **状态**: 草稿
> **来源**: [solution.md](solution.md)（§5 Tasks）、[req.md](req.md)（R1–R12）

---

## 1. 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|---|---|---|
| T1 | host.json 3 模式 + 自动迁移 | `packages/gateway/src/config.ts` | ✅ |
| T2 | CLI 命令树重写（`rdsh host *`） | `packages/cli/src/bin.ts` | ✅ |
| T3 | serve 按 mode 分发 + join `--name` + 证书自动检测 | `packages/gateway/src/{join,serve}.ts` | ✅ |
| T4 | 服务名对齐（`rdsh-host`/`rdsh-join`/`rdsh-hub`） | `packages/gateway/src/service.ts` + `bin.ts` | ✅ |
| T5 | self-revoke 端点 + 限流 | `packages/hub/src/{api,server}.ts` | ✅ |
| T6 | 单测 + e2e + 文档同步 | `test/*`、`spike/e2e-*.sh`、`doc/overview/usage.md`、README | ✅（单测/usage/README；e2e 脚本随 05 全量更新） |

## 2. RTTM（req → 任务追溯）

| 需求 | 任务 |
|---|---|
| R1 命令树重构 | T2 |
| R2 host.json 3 模式 | T1 |
| R3 配置命令（setup/join 向导） | T2、T3 |
| R4 configure/run 分离 | T2、T3 |
| R5 `--config` 保留 | T1、T2 |
| R6 自动迁移 | T1 |
| R7 证书自动检测 | T3 |
| R8 self-revoke | T5 |
| R9 leave → 未配置 | T2、T5 |
| R10 服务名对齐 | T4 |
| R11 host user 管理 | T2 |
| R12 文档/e2e | T6 |

## 3. 执行顺序

```
T1（config 地基）→ T2（命令树）→ T3（serve/join）→ T4（服务名）→ T5（self-revoke）→ T6（测试/文档）
```

每个任务完成后 `pnpm build`（tsc strict）＋ 相关 `node --test`，全绿再进下一任务；T6 全量回归后本地 commit（不 push）。

*关联文档：discussion.md | req.md | solution.md*
