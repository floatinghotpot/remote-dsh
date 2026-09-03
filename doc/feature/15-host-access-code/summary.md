# 15-host-access-code — 总结（summary.md）

> **日期**: 2026-09-02
> **结论**: 完成（R1–R9 全落地，自动化全绿；一项可选项后置，见 TODO.md）

---

## 做了什么

在 rdsh gateway 增加一道**独立于 hub 的访问口令**（纵深防御）：过 hub 账号这关不再等于直接进入主机（host 侧校验，hub 只透传一个不透明 cookie 标记）。

## 改了什么

### gateway（host 侧，校验 100% 在此）
- `packages/gateway/src/config.ts`：`gateway.accessCode` normalize（缺失/null/"" → null = off；非空 ≥4 位）；`RdshConfig.gateway` 缺省 `{ accessCode: null }`。
- `packages/gateway/src/access-gate.ts`（新）：`rdsh_gate` cookie 工具（HMAC-SHA256，key=sha256(code)，payload=exp+nonce，7 天）+ `verifyGateCode` 恒定时间比对。
- `packages/gateway/src/join.ts`：`handleOpen` gate 拦截——无 cookie 的 http → 内联 challenge 页（`Accept-Language` 含 zh → 中文，否则英文兜底）；POST `gate_code` 验证 → 302 回跳 + 发 cookie；ws → CLOSE 403；全局失败 10 次/60s 锁；raw（E2EE）流豁免；`startJoin` 读 `gateway.accessCode`，`JoinHandle.setAccessCode` 运行中切换。

### hub（D12 白名单，纯增量）
- `packages/hub/src/relay.ts`：`normalizeHeaders` 解析 cookie，仅放行 `rdsh_gate`（rdsh_session/rdsh_host 仍全剥）。

### 双通道配置
- `packages/cli/src/bin.ts`：`rdsh host join` 透传 `gateway: config.gateway`（form A，重启生效，无新命令）。
- `packages/web-remote/src/index.ts`：`set-access-code` RPC（写 host.json + live 即时生效）+ `state().hasAccessCode`（不回显 code）。
- `packages/web-remote/client.js`：面板「访问密码」行（badge 已设置/未设置 + 设置/清除 + ≥4 前端校验）+ zh/en i18n。

### 测试
- 新增 `packages/gateway/test/access-gate.test.ts`（4 例）、`packages/gateway/test/join-gate.test.ts`（5 例：challenge/302/ws403/改 code 失效/live 切换/锁定）、`packages/hub/test/relay-d12.test.ts`（3 例）、`config.test.ts` 追加 gateway 折叠校验。
- 全量 `pnpm build`（tsc strict）零缺陷；`pnpm test`：tunnel 12 + hub 85 + gateway 94 全绿。

## 关键决策落地
- gate 可选、默认关闭（不设 code = 现状）。
- code 最小 4 位（用户定案，覆盖我原 6 位建议）。
- member 共享 host 同样过 gate（host 级单值，owner 分享）。
- 部署顺序 hub 先行（新 gateway 设 code + 旧 hub 会 gate 循环）。

## 关联
[req.md](req.md) | [solution.md](solution.md) | [plan.md](plan.md) | [verification.md](verification.md) | [TODO.md](TODO.md)
