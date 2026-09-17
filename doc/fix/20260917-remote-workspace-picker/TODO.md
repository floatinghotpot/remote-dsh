# TODO — 远程浏览器无法选择宿主目录

> 机械抽取自 [plan.md](plan.md) 的 `❌` / `⏭️` 项（手工撰写禁止）。非空 = 本 fix 尚未关闭。

| # | 项 | 状态 | 阻塞原因 / 下一步 |
|---|---|---|---|
| R9 / — | 不做 per-client 自适应选择器 | ⏭️ 本轮明确不做 | 上游未提供 per-client capability 与 wire 通告（discussion F5）；若上游将来支持，应删除插件侧的 pin |
| R10 / T9 | 版本号提升 + 发布 npm + 真机重装后复验 AC1/AC4 | 🔸 准备就绪，**发布未做** | 已完成：bump `rdsh-gateway 0.8.6` / `dsh-web-remote 0.5.5` / `remote-dsh 0.10.7`；CHANGELOG 双语 `[Unreleased]` → 正式条目（2026-09-17）；`pnpm build` 零 issue、`pnpm test` 全绿。**阻塞：npm publish 需用户显式确认**（CLAUDE.md §2 环境隔离）。发布后步骤：`npm publish`（gateway → web-remote → cli）→ `dsh plugin --profile web add dsh-web-remote@latest` → 确认安装副本与 npm 版本一致 |

> 注：G1（用户机器上已安装副本仍旧 patch）已由**用户批准的就地热修**解决，见 verification §6；
> 发布后重装插件会让该副本与 npm 版本重新一致（内容相同）。
