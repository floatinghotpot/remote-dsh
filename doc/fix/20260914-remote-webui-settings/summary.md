# 修复总结：远程 Web UI 的设置与 API key（summary）

> **日期**: 2026-09-14 ｜ **类型**: 回归缺陷（E2EE 引入）+ 同源缺口 ×2 + 两个"隐形杀手" ｜ **状态**: **✅ 已修复并端到端验证**（用户在浏览器确认 AC1/AC2）
> **关联**: [discussion.md](discussion.md) · [solution.md](solution.md) · [verification.md](verification.md) · [TODO.md](TODO.md)

## 用户看到的问题（本 fix 的唯一判定对象）

远程打开 DSH 设置页报 `settings are unavailable in this browser`，**无法在 Web UI 里输入/保存 API key**；局域网访问同样。**不是树莓派/Linux 问题** —— 任何 OS、任何 host，只要经 hub + E2EE（或经 LAN 代理）远程访问都会遇到。

## 一个结果、三个阻碍因素、外加两个隐形杀手

| # | 内容 | 修复 |
|---|---|---|
| ① | 浏览器侧 E2EE shim 的 WebSocket 门面缺 `addEventListener`/静态常量 ⇒ DSH API 网关远端流建不起来 | 补全门面（订阅方法、静态常量、属性、close 语义、双通道派发、handlers 前移） |
| ② | host 侧 loopback 补丁**从未真正落地**：dsh 会按 `accept-encoding` **gzip 压缩 JS**，补丁在压缩字节上必然 miss（fail-open 静默） | **编码感知补丁**：解压 → patch → 按原编码重压；**OPEN 帧后移**到补丁之后（否则 `content-length` 对不上）；**未命中留痕日志** |
| ③ | LAN 转发路径**完全没有**该补丁 | `forwardHttp` 新增 `jsPatch` + LAN 两个分支接线 + 开关 `dshUiCompat.trustPairedAsLoopback`（默认 on，可关为严格模式） |
| ④ | 补丁改了 body 却改不了 URL（`rev=` 由上游内容决定），上游 `immutable` + 一年 max-age 把**旧的未补丁 bundle** 钉在浏览器里 | 补丁命中时把 `cache-control` 改为 `public, max-age=300` |
| ⑤ | `fetch` 包装的流式/二进制（范围外，登记 TODO） | 未做 |

## 端到端证据（决定性）

- 同一真实 combo URL（11 MB，含 `dsh-client-connection`）：修复前 `gzip` 未补丁 / `identity` 已补丁；**修复后两者都已补丁**（11 MB → 补丁 → 3.9 MB）；
- **浏览器实测**：本地 hub（`http://e2e.localhost:8799`，非 loopback + 安全上下文）+ 隔离 HOME 的 host，硬刷新后设置页正常、API key 可输入保存（用户确认）；
- 质量门：`pnpm build` 0 error；`pnpm test` gateway 116 / hub 99 / tunnel 12 / web-remote 16 / agent-mesh 1，0 fail。

## 经验教训

1. **测试上游必须模拟真实编码**：上一轮集成测试用"不压缩的假上游"，于是"补丁落地"通过了 —— 而真实 dsh 会 gzip。压缩/deflate/br/未知编码都该进用例。
2. **缓存头与"内容被本地改写"天然冲突**：只要我们在传输层改 body，就必须处理 `immutable`/长 max-age（否则修复永远到不了用户）。
3. **fail-open 必须留痕**：静默失败让这个 bug 潜伏了很久；现在未命中会打一条 `[patch] miss`（每路径一次）。
4. **一个用户结果 = 一条 fix**：三处任一未修都会复现同一症状，必须一并验收。
5. **测试环境的隔离要彻底**：本地 E2E 曾因未隔离 `DSH_HOME` 而加载了真实 profile（插件抢 join 锁）⇒ 结论失真；隔离 HOME 与 DSH_* 后才拿到可信结果。
