# Record — `rdsh host service install` macOS(launchd) 修复：ProgramArguments 空格切分谬误

> **日期**: 2026-09-08
> **状态**: 已修复并验证（Linux 真机已测；macOS Intel/Apple Silicon 待实机回归）
> **入口**: README 场景①新增 `rdsh host service install`（常驻、开机自启）——承诺 macOS 可用前审查实现
> **结论**: macOS 路径存在 P0 阻断 bug（launchd `ProgramArguments` 单字符串），已修；Linux(systemd) 路径保持原样（Ubuntu 已测）

---

## 1. 事实（代码定位）

- `service.ts`（`packages/gateway`，cli 经 `rdsh-gateway` 依赖引入）按平台分发：Linux → systemd user unit；macOS → launchd plist（`~/Library/LaunchAgents/com.<name>.plist`）。
- **P0 根因**：`installService` 构造 `execStart = "${process.execPath} ${process.argv[1]}"`（单串 `node 脚本`）；systemd 的 `ExecStart=` 按 shell 规则解析，两 token 正常；但 launchd plist 模板把整个 `execStart` 放进**一个** `<string>`：
  `ProgramArguments` 每个 `<string>` 是一个 argv 元素、**不做空格切分** → 首元素被当作名为 `"/path/node /path/rdsh"` 的单一可执行文件 → exec 失败，服务起不来。
- 既有测试 `service.test.ts` L25 断言 `<string>/usr/local/bin/node /usr/local/bin/rdsh</string>` —— 把错误行为固化为预期。
- P1/P2/P3（同轮顺手修正）：
  - 重装幂等：mac 分支未先卸旧 job，`launchctl load` 对已加载 label 报错；
  - 语义：mac `KeepAlive=true` 干净退出也重启，与 Linux `Restart=on-failure` 不一致；
  - `serviceStatus`（mac）：`launchctl print` 对「已加载但进程已死」的 job 仍成功 → 误报 active。

## 2. 修复

文件：`packages/gateway/src/service.ts` + `test/service.test.ts`

- `launchdPlist(program: string[], spec)`：argv 拆分模板——`[...program, ...commandArgs(spec)]` 每项独立 `<string>`；命令参数仍以 `ServiceSpec` 为唯一来源（与 `systemdUnit` 对称），node 与脚本不再合并；
- `installService`：mac 分支先 `launchctl unload`（失败忽略）再 `load`（重装幂等）；
- KeepAlive 改 `<dict><key>SuccessfulExit</key><false/></dict>`（仅失败退出重启，对齐 on-failure）；
- `serviceStatus`（mac）按 `state = running` 细分 active / loaded (not running)；
- 测试：断言逐 argv 拆分 + 无合并串；新增 KeepAlive 语义测试。

## 3. 验证

- `pnpm build`（tsc strict）：全包零 issue；
- `pnpm --filter rdsh-gateway test`：**109 通过 / 0 失败**（service 6/6）；
- 新模板实测（macOS）：`ProgramArguments` 逐项（node / rdsh / host / serve / --config / path），`plutil -lint` OK，无合并空格项。

## 4. 未决 / 注意（非代码）

- **发版**：修复在 rdsh-gateway 包内——发布版 `rdsh-gateway@0.8.0`/`remote-dsh@0.10.0` 仍带 P0，需发 `rdsh-gateway@0.8.1` + `remote-dsh@0.10.1` 后 README 承诺才对 macOS 成立（发布需用户显式确认）；
- **自启时机**：launchd LaunchAgent / systemd user unit 均为**用户登录后**自启（无头重启不登录则不启；Linux 可 `loginctl enable-linger` 兜底，macOS 无对应）；
- **node 升级 / pnpm -g 重装**会改变 `process.execPath`/`argv[1]` → 服务指向旧路径失效，需重跑 `rdsh host service install`；
- **真机回归**：Intel + Apple Silicon 各验一次（同 README 该行的 verify 计划）。

*关联：README(.zh) 场景① `rdsh host service install` 行 ｜ `packages/gateway/src/service.ts` ｜ `packages/gateway/test/service.test.ts`*
