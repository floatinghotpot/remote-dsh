# 15-host-access-code — 验收（verification.md）

> **日期**: 2026-09-02
> **结论**: 通过（R1–R9 全部落地，代码存在且被调用；自动化全绿）
> **依据**: [req.md](req.md)、[solution.md](solution.md)、[plan.md](plan.md)

---

## 1. RTTM 复核（req → plan → 实现）

| 需求 | 任务 | 实现文件 | 单测 | 结论 |
|---|---|---|---|---|
| R1 可选开启/默认关闭 | T1、T3 | `config.ts` normalize 折叠 + `join.ts` `gate={accessCode: opts.gateway?.accessCode ?? null}`、`dio.gate && accessCode!==null` 才拦 | config.test.ts（折叠+≥4）、join-gate.test.ts（off→直接转发） | ✅ |
| R2 challenge 流 | T3 | `gateChallengeHtml` + `sendSyntheticHttp` + `handleGateSubmit`（302 回原 path） | join-gate.test.ts（challenge HTML / 错误提示 / 302） | ✅ |
| R3 访问 cookie（7 天/改 code 失效） | T2、T3 | `access-gate.ts` `signGateCookie`/`verifyGateCookie`（HMAC-SHA256 key=sha256(code)） | access-gate.test.ts（roundtrip/过期/篡改/改 code）、join-gate.test.ts（改 code 旧 cookie 失效） | ✅ |
| R4 只拦隧道/本机放行/WS 查 cookie | T3 | gate 仅 plain dispatcher；`127.0.0.1` 直连不经 dispatcher（结构豁免）；ws `kind==="ws"` 无 cookie → CLOSE 403 | join-gate.test.ts（ws 403） | ✅ |
| R5 E2EE 引导覆盖（raw 豁免） | T3 | `startRawStream` 用 `makeInnerDispatcher(...,{jsPatch})` **无 `gate:true`**（入口 `/h/<hostId>/` plain 页已 gate） | 结构审查（见 §3 G3） | ✅ |
| R6 防爆破（恒定时间+全局封顶） | T3 | `verifyGateCode` timingSafeEqual(sha256)；`gateFailures` 10 次→60s 锁 | access-gate.test.ts（恒定时间）、join-gate.test.ts（10 次锁定） | ✅ |
| R7 双通道配置 | T1、T5、T6 | CLI form A（`join()` 透传 `config.gateway`，重启生效）+ 面板 `set-access-code` RPC（写 host.json + live）+ `state().hasAccessCode`（不回显） | join-gate.test.ts（`setAccessCode` off→on→off live） | ✅ |
| R8 code ≥4 | T1、T5 | config normalize `<4` 抛错；RPC 前端 disable<4 + 后端校验 | config.test.ts（≥4） | ✅ |
| R9 hub D12 cookie 白名单 | T4 | `relay.ts` `normalizeHeaders` 仅放行 `rdsh_gate` | relay-d12.test.ts（3 例） | ✅ |

## 2. 调用面审计（代码存在 AND 被调用）

| 入口 | 调用链 | 状态 |
|---|---|---|
| CLI `rdsh host join` | `bin.ts:327` `join({..., gateway: config.gateway})` → `join()` → `startJoin({gateway: opts.gateway})` | ✅ 已确认 |
| dsh-web-remote 插件 | `index.ts:162` `startJoin({gateway: config.gateway, name})` | ✅ 已确认 |
| hub relay | `relay.ts:159` `normalizeHeaders` 导出并在 `onRequest`/`onUpgrade` 调用（`GATE_COOKIE="rdsh_gate"` 与 gateway `access-gate.ts` 同名互指） | ✅ 已确认 |
| 面板 server RPC | `index.ts` `case "set-access-code"` → `setAccessCode(args)`；`handle?.setAccessCode(code)` 运行中生效 | ✅ 已确认 |

## 3. 缺口清单

| # | 严重度 | 描述 | 处理 |
|---|---|---|---|
| G1 | 低 | `packages/web-remote` 无独立单测（该包无 test runner）；`set-access-code` 为薄胶水（config normalize + `handle.setAccessCode` 均已测），client.js 以 `node --check` 语法校验 | 记 TODO（T10，可选，join-core 模式可复用） |
| G2 | 信息 | raw（E2EE）流 gate 豁免为结构性事实（`startRawStream` 无 `gate:true`），无自动化测（需 Noise 握手 harness）；已代码审查确认 | 不阻塞，随 e2e 手动覆盖 |
| G3 | 部署 | 真机 e2e（本机 gateway+hub+浏览器）未在本环境执行（无浏览器；`e2e/` 为 TS↔Go conformance，M6 才激活） | 记部署清单（§4） |

> 注：challenge 页 i18n（原 G1）已补——读 `Accept-Language`，含 `zh` → 中文，否则英文兜底（含错误提示）；`join-gate.test.ts` 第 6 例覆盖 zh/en/缺 header。

## 4. 部署/手动验收清单（G3 落点）

1. **hub 先部署**（D12 白名单），再升级 gateway——新 gateway 设 code + 旧 hub 会 cookie 传不到网关而 gate 循环（版本配对）。
2. 未设 code 存量 host：经隧道访问行为不变。
3. 设 code 后：浏览器 challenge → 输对 → 302 回跳进 DSH；刷新免输（cookie 已发）。
4. 改 code：旧 cookie 立即失效需重输。
5. 本机 `127.0.0.1` 直连：无 gate，可从面板/CLI 清除 code 恢复。
6. 面板与 CLI 双通道各设/清除一次验证一致。
7. 旧 gateway 连新 hub：行为不变（纯增量）。
