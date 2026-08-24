# Bug 报告：`rdsh join service install` 生成的 unit 缺少 PATH，nvm 环境下 dsh 启动失败（code 127）

> **日期**: 2026-08-24
> **严重度**: P2（新特性在"node 不在 systemd 默认 PATH"的环境（nvm/自装 Node）下完全不可用；阻塞 0.4.10 发布）
> **影响组件**: `packages/cli/src/bin.ts`（`handleJoinService`）、`packages/gateway/src/service.ts`（unit 模板）
> **发现环境**: 阿里云 ECS（Ubuntu 26.04），Node 由 nvm 管理（`~/.nvm/versions/node/v22.23.2/bin`），remote-dsh 0.4.9 + 未发布 commit `d177849`（`feat(join): add 'rdsh join service install'`）
> **来源**: 2026-08-24 生产环境验收 `rdsh join service install` 时发现（服务崩溃循环，restart counter 41）

---

## 1. 现象（症状）

- 执行 `rdsh join service install <hub-url>` 成功生成 unit 并启动服务；
- 服务随即进入**崩溃循环**（`Restart=on-failure`），journal 反复报：
  ```
  rdsh: dsh exited before reporting a port (code 127)
  rdsh-join.service: Failed with result 'exit-code'.
  ```
- **exit 127 = 命令找不到**；服务永远起不来，直到手工补上 PATH。

## 2. 复现步骤

1. 在 **nvm 管理 Node** 的机器上：`rdsh join service install http://127.0.0.1:8443`（自动探测到 `~/.nvm/.../bin/dsh` 并内嵌 `--dsh <绝对路径>`）；
2. `systemctl --user status rdsh-join`：active (auto-restart)，日志见 `dsh exited before reporting a port (code 127)`；
3. 对比：node 装在 `/usr/bin` 的机器上不出现此问题（默认服务 PATH 含 /usr/bin）。

## 3. 根因（代码事实 + 机制）

- **unit 生成**（`bin.ts handleJoinService`）：`joinArgs = ["join", hubUrl, "--dsh", resolveDshPath(dshPath), ...]` —— 用 `--dsh <绝对路径>` 绕过了 `findDsh` 的 PATH 查找；
- **但 `dsh` 可执行文件是 shebang 脚本**：`#!/usr/bin/env node` —— 内核 exec 该脚本时执行 `/usr/bin/env node`，`env` 按**执行进程的 PATH** 找 node；
- **systemd 用户服务的默认 PATH 是** `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`（不含 nvm/自装目录）→ `env node` 找不到 → **127**；
- 结论：`--dsh` 只解决了"**找到** dsh 文件"，没解决"**执行** dsh 时解析 shebang 所需的 node"。nvm 环境必现；`/usr/bin` 环境偶发不暴露（开发机未覆盖此场景）。

## 4. 影响

| 项 | 影响 |
|---|---|
| 功能可用性 | nvm/自装 Node 环境（国内开发者常见）下 `rdsh join service install` **完全不可用** |
| 发布风险 | 该特性未发布（0.4.9 无此命令），若按现状发布，用户装上即坏 |
| 一致性 | 与博客 04-01 手写 unit 的教训一致（"Environment=PATH 是必配项"）—— 内置命令反而没继承这条经验 |
| 阻塞性 | **高**（特性级）—— 但本地有 workaround（见 §6） |

## 5. 修复方案（候选 + 推荐）

### 方案 A（推荐）：生成 join unit 时内嵌 `Environment=PATH=<node bin dir>:<system path>`

- `bin.ts handleJoinService` 或 `service.ts`：unit 增加
  ```
  Environment=PATH=<dirname(process.execPath)>:/usr/local/bin:/usr/bin:/bin
  ```
  （`process.execPath` 即启动 rdsh 的 node 绝对路径，其 dirname 就是 node 所在目录，天然覆盖 nvm/自装场景）；
- 在 `ServiceSpec` 增加 `pathEnv?: string` 字段（join 用，serve/hub 不需要——它们不 spawn 子进程），`systemdUnit` 模板输出该行；
- 保留 `--dsh <绝对路径>`（双保险：即使 PATH 被用户改掉也能找到 dsh 文件）；
- launchd：`launchdPlist` 同样补 `EnvironmentVariables`（可选，与 systemd 对齐）。

### 方案 B（次选）：spawn dsh 时解析 shebang

- 让 `spawnDsh` 探测 dsh 的 shebang 并用绝对 node 执行（`node <dsh路径>`）—— 改动面大、侵入 spawn 逻辑，且 `dsh` 未来可能换解释器，不推荐。

### 方案 C（最小，不推荐单独采用）：文档警告

- usage.md 注明"nvm 环境需手动补 Environment=PATH" —— 把已知缺陷甩给用户，不解决。

## 6. 临时 workaround（已验证，本机已应用）

在 drop-in 里补 PATH（不依赖修复发布）：

```bash
cat > ~/.config/systemd/user/rdsh-join.service.d/env.conf <<'EOF'
[Service]
EnvironmentFile=-/home/<user>/.rdsh/join.env
Environment=PATH=<node-bin-dir>:/usr/local/bin:/usr/bin:/bin
EOF
systemctl --user daemon-reload && systemctl --user restart rdsh-join
```

## 7. 验收标准

1. nvm 环境：`rdsh join service install <hub-url>` → unit 含 `Environment=PATH=<node-bin-dir>:...` → 服务 active，dsh 正常 spawn（journal 出现 `dsh web on 127.0.0.1:<port>` + `tunnel established`），**无 code 127**；
2. `/usr/bin` 环境回归：行为不变（PATH 行存在但不影响）；
3. serve/hub 的 unit 模板不受影响（回归：`rdsh service install` / `rdsh hub service install` 生成的 unit 内容与改动前一致）；
4. `service.test.ts` 增加断言：join unit 含 `Environment=PATH=` 且含 `dirname(execPath)`；全量 `pnpm test` 绿；
5. 文档：usage.md 的 `rdsh join service install` 说明补"自动注入 node PATH"一句。

## 8. 参考

- 相关代码：`packages/cli/src/bin.ts`（`handleJoinService`/`resolveDshPath`）、`packages/gateway/src/service.ts`（`ServiceSpec`/`systemdUnit`）、`packages/gateway/src/spawn-dsh.ts`（dsh spawn）
- 关联文档："Environment=PATH 是必配项"现记录于 `doc/overview/usage.md` §8.5（原博客 04-01 已移除）、`doc/fix/20260824-join-service-install/bug-report.md`（本特性的需求来源）
- 关联验证：本机 workaround 已应用并通过（两个 dsh 进程均带 API key、隧道恢复）
