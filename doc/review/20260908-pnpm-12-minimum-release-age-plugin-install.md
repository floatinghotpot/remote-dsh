# pnpm 12 `minimumReleaseAge` 默认策略致 `dsh plugin add` 安装静默降级——实测复核

> **日期**: 2026-09-08
> **状态**: 事实记录（真实用户环境 + 隔离复现）
> **对象**: `dsh plugin --profile web add`（dsh-web-remote / rdsh-gateway 安装路径）与 pnpm v12.3.4
> **关联**: `dsh-web-remote@0.5.0 · rdsh-gateway@0.8.0 · remote-dsh@0.10.0`（2026-09-08 发布，dsh 0.1.2-rc.1 认证适配）；`doc/fix/20260907-dsh-0.1.2-rc1-auth/`
> **一句话结论**: 新版本发布 **24 小时内**，`dsh plugin add dsh-web-remote`（裸名或 `@latest`）会**静默装上一版本**；「插件修了但没用」的排查必须先查实际安装版本。此前的 npmmirror 同步延迟归因**错误**，真因是 pnpm 12 内置 24 小时 release-age 策略（registry 无关，直连 npmjs 可复现）。

---

## 1. 现象

真实用户（dsh 0.1.2-rc.1）安装 `dsh-web-remote` 插件后，经 hub 远程访问 DSH 报 dsh 自己的 401：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

dsh 0.1.2 的浏览器会话 Cookie 认证适配已在 `dsh-web-remote@0.5.0`（含 T6 进程内换发 + `rdsh-gateway@0.8.0` join 内核注入）修好，但安装后**修复不生效**。安装输出：

```
dependencies:
+ dsh-web-remote ^0.4.0
```

## 2. 排查过程与归因修正

| 步骤 | 假设 | 结论 |
|---|---|---|
| 1 | npmmirror 镜像同步延迟 → `latest` 仍为 0.4.0 | ❌ 错误。查证时镜像已同步 0.5.0；**直连 `registry.npmjs.org` 复现同样结果** |
| 2 | caret 语义 `^0.4.0`（0.x 只允许补丁级）→ 后续 update 上不去 | ✅ 部分成立（是二次放大因素，非首因） |
| 3 | pnpm 12 默认 release-age 策略排除「太新」版本 | ✅ **真因**（见 §3 复现） |

修复动作本身正确：显式钉 `dsh-web-remote@0.5.0` 安装成功，重启 `dsh web` 后经 hub 远端访问恢复正常（0.5.0 修复链真实有效，见 §6）。

## 3. 根因事实（pnpm v12.3.4，实测）

### 3.1 机制

- `dsh plugin --profile web add <spec>` = 在 profile 目录（`~/.dsh/profiles/web`）执行 `pnpm add <spec>` 的透传包装（`@deepseek-ai/dsh` 的 `plugin-*.js` `runPlugin` → `spawnSync("pnpm", args)`），随后 reconcile loader 行。因此 pnpm 的解析策略直接决定安装结果。
- pnpm 12 内置默认 `minimumReleaseAge = 1440 分钟（24 小时）`、**非 strict**。pnpm CHANGELOG（12.x，[pnpm/pnpm#14409](https://github.com/pnpm/pnpm/issues/14409) 相关）原文：

  > `minimumReleaseAgeStrict` now defaults to `true` when `minimumReleaseAge` is explicitly configured … **The built-in 1440-minute default stays non-strict.** Previously an explicit cutoff was treated as non-strict, so immature versions were silently added to `minimumReleaseAgeExclude` instead of being gated with a prompt.

- 非 strict 行为：**发布不足 24h 的版本不参与 tag/range 解析**（裸 `add` / `@latest` / `^x.y.z` 均静默回退上一成熟版本）；**显式钉 `@x.y.z` 放行**，并把该版本写入项目 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。
- `pnpm view` 不受 age 策略影响 → 元数据显示 `latest` 正确，但 `add` 结果不同，极具迷惑性。

### 3.2 实测复现（2026-09-08，pnpm v12.3.4，`--registry=https://registry.npmjs.org`，全新 store/state，无任何项目配置）

| 命令 | 结果 | manifest 写入 |
|---|---|---|
| `pnpm add dsh-web-remote@latest` | **0.4.0** | `^0.4.0` |
| `pnpm add dsh-web-remote@0.5.0` | 0.5.0，自动在 pnpm-workspace.yaml 记 `minimumReleaseAgeExclude: dsh-web-remote@0.5.0, rdsh-gateway@0.8.0` | `0.5.0` |
| （已有 exclude 后）`pnpm add dsh-web-remote@latest` | 0.5.0 | `0.5.0` |
| `pnpm view dsh-web-remote dist-tags` / registry 原始与 corgi 元数据 | `latest: 0.5.0`（一致，无缓存问题） | — |

时间窗口实测：`dsh-web-remote@0.5.0` npm 发布时间 `2026-09-07T17:07:59Z`（= 09-08 01:07 +0800）；排查时刻 09-08 10:51 +0800 → 发布 **9h43m**，远小于 24h。

真实 profile 现状（钉版动作的副作用，恰好使后续 `@latest` 在该 profile 可用）：

```yaml
# /Users/liming/.dsh/profiles/web/pnpm-workspace.yaml
minimumReleaseAgeExclude:
  - dsh-web-remote@0.5.0
  - rdsh-gateway@0.8.0
```

### 3.3 与版本差异的印证

`dsh-web-remote@0.4.0` 依赖 `rdsh-gateway@0.7.0`（join 内核无 cookie 注入）；`0.5.0` 依赖 `rdsh-gateway@0.8.0`（含注入）——装上 0.4.0 等价于回到认证适配前，必然 401，与现象吻合。

## 4. 影响面与判别法

- **影响面**: 任何 remote-dsh 组件以 `dsh plugin add`（裸名 / `@latest`）安装、且目标新版本发布 < 24h 时——新版修复「看起来没生效」。registry（npmjs / npmmirror）与网络均无责任。
- **判别法**（一步定位）:
  1. `dsh plugin --profile web ls <pkg>` —— 先看**实际装的版本**，别信 registry `latest`；
  2. 安装输出含 `minimumReleaseAgeExclude` / `Lockfile passes supply-chain policies` 字样 = 策略已介入；
  3. `pnpm view <pkg> dist-tags` 正确 ≠ `add` 会装到它。
- **规避**: 版本敏感时显式钉精确版本 `dsh plugin --profile web add <pkg>@<x.y.z>`；装完核对 `ls`。钉版一次后 exclude 持久化于该 profile，同 profile 后续 add/update 正常；**新 profile / 新机器**在发布 24h 内仍需重新钉版。

## 5. 对 remote-dsh 的启示

- 发布说明 / CHANGELOG / 博客的安装命令（裸 `dsh plugin add dsh-web-remote`）在新版本发布 24h 内会静默装上一版本——文档可给出「钉精确版本」示例，或提示以 `dsh plugin ls` 核对。
- 不建议关闭该策略（pnpm 供应链安全特性）；确需放开时在 profile `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`（或 `minimumReleaseAgeStrict: true` 改为显式提示），须自知取舍。

## 6. 关联验证

- 钉版升级到 `dsh-web-remote@0.5.0` + 完全重启 `dsh web` 后，真实用户经 rdsh hub 远端浏览器访问 DSH 正常——补上了 `doc/fix/20260907-dsh-0.1.2-rc1-auth/verification.md` §5 G1（插件模式远端浏览器端到端）缺口的实机证据。

*关联文档: `doc/fix/20260907-dsh-0.1.2-rc1-auth/` ｜ `doc/review/20260907-dsh-0.1.2-rc.1-auth-gate-compat.md` ｜ CHANGELOG(.zh) 2026-09-08 段 ｜ pnpm CHANGELOG（12.x，minimumReleaseAge 条目）*
