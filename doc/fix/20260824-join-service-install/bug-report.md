# Bug 报告：`rdsh join service install` 未实现 —— join 无法用内置命令服务化

> **日期**: 2026-08-24
> **严重度**: P3（功能缺口，非阻塞 —— 已有手写 unit 的可用 workaround，见博客 04-01）
> **影响组件**: rdsh CLI（`packages/cli/src/bin.ts`）、服务化模块（`packages/gateway/src/service.ts`）
> **发现环境**: 阿里云 ECS（Ubuntu 26.04，systemd 用户服务部署实测，remote-dsh 0.4.9）
> **来源**: 生产部署中需要将 `rdsh join` 常驻化，发现 serve/hub 有 `service install` 而 join 没有（2026-08-24）

---

## 1. 现象（症状）

- `rdsh service install`（serve/LAN 网关）与 `rdsh hub service install`（hub）均已实现，一条命令即可生成 systemd/launchd 服务；
- **`rdsh join service install` 不存在**：`rdsh join` 的选项里没有 service 相关子命令，执行会报 `usage: rdsh join <hub-url> [--token <t>] [--dsh <path>]`；
- 用户想把 join 常驻化（开机自启/崩溃重启），只能**手写 unit**（当时见博客 04-01，该博客已移除——服务化要点现见 `doc/overview/usage.md` §8.5），且必须手工处理 PATH、环境变量注入等坑。

## 2. 复现步骤

1. 运行 `rdsh join service install http://127.0.0.1:8443`（或任何 URL）；
2. 观察：被当作参数解析失败，输出 usage 报错退出（`rdsh join <hub-url> [--token <t>] [--dsh <path>]`）；
3. 对比：`rdsh hub service install` 正常工作（生成 `~/.config/systemd/user/rdsh.service` 并 enable）。

## 3. 根因（代码事实）

- `packages/cli/src/bin.ts:185-189`：`case "join"` 直接 `parseJoinArgs(rest)` → `join(opts)`，**没有 service 子命令分发**（对比 `case "hub"` 有 `handleHub` 内部分发 user/host/service）；
- `packages/cli/src/bin.ts:292-302`（`parseJoinArgs`）：仅支持 `--token` / `--reset` / `--dsh` / `--insecure` 四个选项，hubUrl 为位置参数，无 `service` 分支；
- `packages/cli/src/bin.ts:281`：usage 文案即"无 service"的直接证据；
- **可复用基础已存在**：`packages/gateway/src/service.ts:85-98`（`installService(configPath, subcommandArgs)`）已支持传子命令参数（serve 用 `["serve"]`、hub 用 `["hub","serve"]`），join 只需扩展为 `["join", hubUrl]` —— 属于"模板已有、缺接线"的缺口，不是架构缺失。

## 4. 影响

| 项 | 影响 |
|---|---|
| 用户体验 | join 常驻化需要手写 unit + 手工处理两个坑（PATH、API key 环境注入），门槛高于 serve/hub 的一条命令 |
| 一致性 | 三组件（serve/hub/join）服务化能力不对称，`--help` 也无从知晓 |
| 安全 | 手写 unit 容易把密钥写进 unit 文件（应 0600 独立 env 文件）—— 内置命令可强制正确姿势 |
| 阻塞性 | **无**：博客 04-01 的手写方案已在生产验证可用 |

## 5. 修复方案（候选 + 推荐）

### 方案 A（推荐）：`rdsh join service install|status|uninstall <hub-url>`

- `packages/cli/src/bin.ts`：join 分支增加 `service` 子子命令解析（`rdsh join service install <hub-url> [--dsh <path>]`）；
- 复用 `service.ts` 模板：`installService(configPath, ["join", hubUrl, ...(dshPath ? ["--dsh", dshPath] : [])])`；
- **规避 PATH 坑**：join 已有 `--dsh <path>`（`join.ts:100-103` 用 `findDsh(opts.dshPath)` 直接解析，不经 PATH 查找）—— 服务化时**自动探测并内嵌 `--dsh <绝对路径>`**，unit 里就不依赖 `Environment=PATH`；
- **环境变量注入**：生成的 unit 附 `EnvironmentFile=-<homedir>/.rdsh/join.env`（0600，缺省不报错），文档说明 API key 放该文件（对齐博客 04-01 ④）；
- `status` / `uninstall` 复用现有 `serviceStatus()` / `uninstallService()`。

### 方案 B（最小）：仅文档

- 不动代码，把博客 04-01 的手写 unit 方案补进 usage.md §8 —— 缓解但不解决，不推荐单独采用。

### 方案 C（不做）：join 并入 `rdsh service install`

- 把 join 塞进现有 `rdsh service` 语义会破坏 serve 的既有行为与参数解析，不推荐。

## 6. 验收标准

1. `rdsh join service install <hub-url>` 生成 unit（`~/.config/systemd/user/rdsh.service` 或 `rdsh-join.service`），ExecStart 为绝对 node + 脚本 + `join <hub-url> --dsh <绝对路径>`，含 `EnvironmentFile=-<homedir>/.rdsh/join.env`，`Restart=on-failure`；
2. `systemctl --user enable --now` 后服务 active，日志出现 `reusing persisted host token`（免配对恢复），spawn 的 dsh 进程环境含 `DEEPSEEK_API_KEY`（若 join.env 配置）；
3. `status` 反映运行态；`uninstall` 移除 unit 并 disable；
4. `rdsh join <hub-url>` 原有行为与参数完全不变（回归：`--token`/`--reset`/`--dsh`/`--insecure`）；
5. 单测：`service.test.ts` 增加 join 场景的模板内容断言（ExecStart 含 join+hubUrl+--dsh、EnvironmentFile 行）；全量 `pnpm test` 绿；
6. 文档：usage.md §8 补 `rdsh join service install` 用法；博客 04-01 的手写方案可保留（作为无内置命令时代的参考）或标注已被内置命令替代。

## 7. 参考

- 相关代码：`packages/cli/src/bin.ts`（join/hub 分发、parseJoinArgs）、`packages/gateway/src/service.ts`（模板与 installService）、`packages/gateway/src/join.ts:100-103`（findDsh 与 --dsh）
- 关联文档：`doc/overview/usage.md` §8.5（服务化要点；原手写方案博客 04-01 已移除）
- 关联修复：`doc/fix/20260824-join-token-persist/bug-report.md`（join 重启免配对，本需求的前置）
