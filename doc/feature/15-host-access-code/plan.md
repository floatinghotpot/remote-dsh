# 15-host-access-code — 实施计划（plan.md）

> **日期**: 2026-09-02
> **状态**: 已批准（req §5 决策定案：CLI 形态 A、member 同过 gate）
> **来源**: [solution.md](solution.md)、[req.md](req.md)（R1–R9）

---

## 1. 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|---|---|---|
| T1 | gateway 配置：`gateway.accessCode` normalize（缺失/null/""→null；非空 ≥4 位；`saveConfig` 保留字段） | `packages/gateway/src/config.ts`、`test/config.test.ts` | ✅ |
| T2 | 访问 cookie 工具：`rdsh_gate` 签发/验签（HMAC-SHA256，key=sha256(code)，payload=exp+nonce，7 天），纯函数导出 + 常量名 | `packages/gateway/src/join.ts`（或新 `access-gate.ts`）、`test/` | ✅ |
| T3 | gate 拦截（`handleOpen`）：http/ws 无有效 cookie → 合成 challenge/拒绝；POST `gate_code` 验证（恒定时间）→ 发 cookie 302 回跳；全局失败锁定；**raw 流豁免确认**（E2EE 不逐帧重查）；hostname 用于 challenge 页 | `packages/gateway/src/join.ts`、`test/` | ✅ |
| T4 | hub D12：relay `normalizeHeaders` 解析 cookie，仅放行 `rdsh_gate`（rdsh_session 等仍全剥）+ 单测 | `packages/hub/src/relay.ts`、`test/` | ✅ |
| T5 | web-remote server：`set-access-code` RPC（null=清除）+ `state().hasAccessCode`（不回显）+ 写 host.json + live 生效 | `packages/web-remote/src/index.ts` | ✅ |
| T6 | web-remote client：面板「访问密码」行（badge 已设置/未设置 + 设置/清除 + ≥4 校验）+ i18n zh/en | `packages/web-remote/client.js` | ✅ |
| T7 | 全量 `pnpm build`（tsc strict）+ `pnpm test` 全绿；e2e 真机（challenge→进入→回跳→改 code 失效→本机恢复→旧 gateway 回归） | 各包 | ✅ |
| T8 | verification.md + summary.md + TODO.md + RTTM 复核 | `doc/feature/15-host-access-code/` | ✅ |
| T9 | challenge 页 i18n：读 `Accept-Language`（含 zh → 中文；否则英文兜底，含错误提示） | `packages/gateway/src/join.ts`、`test/join-gate.test.ts` | ✅ |
| T10 | web-remote `set-access-code` 状态机单测（复用 join-core 模式；该包现无 test runner） | `packages/web-remote/test/` | ⏭️ |

## 2. RTTM（req → 任务追溯）

| 需求 | 任务 |
|---|---|
| R1 可选开启/默认关闭 | T1、T3 |
| R2 challenge 流 | T3 |
| R3 访问 cookie（7 天/改 code 失效） | T2、T3 |
| R4 只拦隧道/本机放行/WS 查 cookie | T3 |
| R5 E2EE 引导覆盖（raw 豁免） | T3 |
| R6 防爆破（恒定时间 + 全局封顶） | T3 |
| R7 双通道配置 | T1、T5、T6 |
| R8 code ≥4 | T1、T5 |
| R9 hub D12 cookie 白名单 | T4 |

## 3. 执行顺序

```
T1（配置）→ T2（cookie 工具）→ T3（gate 拦截）→ T4（hub 白名单）→ T5/T6（插件双半）→ T7（全量+e2e）→ T8（文档）
```

每任务后 `pnpm build`（tsc strict）＋相关 `node --test` 全绿再进下一任务；T7 全量回归后本地 commit（不 push）。

## 4. 实现注意（solution 细节落地）

- gate 只做在 **plain dispatcher**（http/ws）；**raw dispatcher 不加 gate**（E2EE 豁免，D3/R5）；
- challenge POST 需对 gated 流**缓冲 DATA 帧**（≤64KB）取 `gate_code`，验证后才回 302；无 cookie 的 POST（非 code 提交）一律回 challenge 页（此时 SPA 尚未加载，唯一 POST 即 code 提交）；
- 恒定时间比较对 `sha256(input)` vs `sha256(code)`（避免长度侧信道）；
- 失败计数为**内存全局**（网关进程内），重启清零（MVP 可接受）；
- `rdsh_gate` 常量 gateway 导出、hub 硬编码同名（注释互指）。

*关联文档：req.md | solution.md | discussion.md*
