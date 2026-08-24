# 06-dsh-plugin — 计划（plan.md）

> **日期**: 2026-08-24
> **状态**: 已批准（用户「start plan and implement」）
> **来源**: [solution.md](solution.md)（§5 Tasks）、[req.md](req.md)（R1–R9）

---

## 1. 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|---|---|---|
| T1 | `join()` 拆 `startJoin`（no-spawn/外部 target/`stop()`/`onState`/`onLog`）+ 保留 CLI `join()` | `packages/gateway/src/join.ts` | ✅ |
| T2 | pid 锁 `lock.ts`（acquire/release/read/stale） | `packages/gateway/src/lock.ts` | ✅ |
| T3 | 导出新 API + 版本 0.4.0 | `packages/gateway/src/index.ts`、`package.json` | ✅ |
| T4 | CLI 回归（`join()` 签名不变）+ 全量 build/test | `packages/cli/src/bin.ts`（不改） | ✅ |
| T5 | 插件包骨架：package.json（dsh.bundle.patch + dsh.client）+ cordis.patch.yml | `packages/web-remote/{package.json,cordis.patch.yml}` | ✅ |
| T6 | server 半：Cordis 插件（`connection.rpc.handle` + `webServer.port` + 状态机 + 动作） | `packages/web-remote/src/index.ts` | ✅ |
| T7 | client 半：module-loader 工厂 + React settings 页（四态 + 外部托管） | `packages/web-remote/lib/client.js` | ✅ |
| T8 | 单测：`startJoin` 状态机 + `lock` 读写/stale | `packages/gateway/test/{join-core,lock}.test.ts` | ✅ |
| T9 | 文档：CHANGELOG（zh/en） | `CHANGELOG.md`、`CHANGELOG.zh.md` | ✅ |
| T10 | verification.md + summary.md + TODO.md + RTTM 复核 | `doc/feature/06-dsh-plugin/` | ✅ |
| T11 | 真实 DSH 冒烟：`dsh plugin add` → 面板出现 → 接入/断开/注销 | 用户本机 DSH 实测 | ✅（2026-08-24：面板出现 + 接入 hub.unicgames.com「已连接」+ 断开/注销；i18n/DSH 主题/提示/遮罩令牌对齐） |
| T12 | 发布 `rdsh-gateway@0.4.0` + `dsh-web-remote@0.1.0`（覆盖 0.0.0 占位） | npm（用户终端 + passkey） | ✅（2026-08-24 发布；`dsh plugin --profile web add dsh-web-remote` 验证通过） |

## 2. RTTM（req → 任务追溯）

| 需求 | 任务 |
|---|---|
| R1 分发形态（npm 插件） | T5 |
| R2 内嵌 join 核心（no-spawn/stop/onState） | T1、T3 |
| R3 面板四态 + 外部托管 | T6、T7 |
| R4 配置记忆（host.json + session token） | T6 |
| R5 进程托管（无守护 + dispose→stop） | T1、T6 |
| R6 CLI 共存（档1 mode 冲突 + 档2 pid 锁） | T2、T6 |
| R7 断开/注销语义 | T6 |
| R8 安全（token 只落 session 0600） | T1、T6、T8 |
| R9 文档/发布纪律 | T9、T10 |

## 3. 执行顺序

```
T1（join 核心）→ T2（锁）→ T3（导出/版本）→ T4（回归）→ T5（包骨架）→ T6（server）→ T7（client）→ T8（单测）→ T9（CHANGELOG）→ T10（verification/summary/TODO）
```

每任务后 `pnpm build`（tsc strict）＋相关 `node --test`，全绿再进下一任务；T4/T8 全量回归后本地 commit（不 push）。

*关联文档：discussion.md | req.md | solution.md*
