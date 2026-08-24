# 04-cli-refactor — 需求（req.md）

> **日期**: 2026-08-24
> **状态**: 草稿，**待用户批准**
> **范围**: CLI 面重构 —— 组件化命令树（`rdsh host` / `rdsh hub`）、`host.json` 配置模型（3 模式）、自动迁移、self-revoke、证书自动检测；**`05-join-easy` 的前置**
> **来源**: [discussion.md](discussion.md)（D1–D9 定案）；用户拍板：3 模式（lan/cloud/join）、leave→未配置、自动迁移、保留 `--config`、服务名独立、直接重构不留别名

---

## 1. 目标

按「组件环境」重构 rdsh CLI，消除动词/组件混排（`serve`/`join` vs `hub`），建立清晰的**本机 vs 服务器**心智模型，并统一 host 侧配置模型：

```
本机（DSH 主机）：rdsh host { setup lan|cloud, join, serve, service, leave, user }
服务器：          rdsh hub { serve, user, host, service }（行为不变）
```

- 配置唯一事实源 = `~/.rdsh/host.json`（3 模式：lan / cloud / join；token 只进 0600 session 文件）；
- 证书处理全自动（用户路径不出现 `--insecure`）；
- `rdsh host leave` 支持从 hub 自注销（self-revoke）；
- 旧 `config.json` 自动迁移；旧命令移除（breaking change）；
- 为 `05-join-easy`（`host join` 交互注册 UX）铺路。

## 2. 范围

### 2.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **命令树重构**：`rdsh host {setup lan\|cloud, join, serve, service, leave, user}`；顶层 `serve/join/user/service` **移除**；`rdsh hub {serve,user,host,service}` 行为不变 | `rdsh --help` / `rdsh host --help` 输出完整新树；旧命令报「未知命令」；hub 命令回归不破坏 |
| R2 | **host.json 配置模型**：`~/.rdsh/host.json` 唯一事实源，`mode: "lan"\|"cloud"\|"join"`；字段：standalone（host/port/sessionTtlSeconds/tls/auth{mode,pairCode,users}/behindProxy/allowFrom）、join（hub/name/insecure）、共用 dshPath；token 只进 session 文件 | 读写/校验正确；3 模式字段互不串扰；DB/配置无明文 token |
| R3 | **配置命令**：`setup lan`（pair+http 预设）、`setup cloud`（password+tls+allowFrom 预设）交互向导写 host.json；`join <hub-url>` 交互（token 粘贴或 `--token`、name 默认 hostname 可改、`--dsh`）→ 注册（现有配对码/--token 流程）→ 写 host.json + session，**配置完退出** | 各向导生成正确 host.json；join 注册成功后 session 落盘、`serve` 可起隧道 |
| R4 | **configure/run 分离**：`rdsh host serve` 前台常驻，按 host.json 的 mode 分发（lan/cloud→起网关，join→起隧道）；未配置时报错并引导 | `serve` 按 mode 正确运行；无 host.json 时明确报「未配置，请先 setup lan/cloud 或 join」 |
| R5 | **`--config <path>`**：默认 `~/.rdsh/host.json`；`setup`/`serve`/`service` 均接受 | 指向临时配置可写/可读/可服务化；默认路径不受影响 |
| R6 | **自动迁移**：配置加载层检测旧 `~/.rdsh/config.json`（无 host.json 时）→ 按 tls/auth.mode 推断 mode → 写入 host.json（原文件保留）；`--config` 指向旧格式同理转换；**无显式 migrate 命令** | 旧 config.json 用户升级后 `host serve` 直接可用（行为等价）；迁移幂等 |
| R7 | **证书自动检测**：`join` 时先正规校验连接，证书失败自动回退 insecure 重连并持久化 `insecure: true` + 打印一行提示 | 自签 hub join 成功且 host.json 记 insecure；正规证书 hub 不触发回退；用户路径无 `--insecure` flag |
| R8 | **self-revoke 端点**：`POST /api/hosts/self-revoke {token}`（host 持自己的 host token 注销，断隧道 + 删条目 + offline 推送）；IP 限流（复用 pending 限流模式，10 次/分钟） | 有效 token 自注销成功；无效/吊销 token 401；限流生效；`rdsh host leave` 调用后 hub 无残留 |
| R9 | **`rdsh host leave`**：self-revoke + 清 session 文件 + **删 host.json**（回到未配置，`serve` 报未配置）；非 join 模式（lan/cloud）跑 leave 报错提示 | leave 后本地配置清空、hub 条目删除、隧道断；再 `serve` 提示先 setup/join |
| R10 | **服务名对齐 + 服务化**：host 独立服务 → `rdsh-host.service`，join → `rdsh-join.service`，hub → `rdsh-hub.service`（原 `rdsh.service` 改名）；`rdsh host service install\|status\|uninstall` 读 host.json mode 装对应服务 | 三种服务名互不覆盖；install 生成正确 unit（读 host.json，无长参数）；status/uninstall 对应 |
| R11 | **用户管理**：`rdsh host user add\|passwd\|ls\|rm`（写 host.json `auth.users`，scrypt 哈希） | 增删改查生效；host.json 只存哈希；与旧 `rdsh user` 行为一致 |
| R12 | **文档/迁移全量更新**：usage.md §8、博客（zh/en）、README、e2e 脚本同步到新命令；发布说明标注 breaking change 与「升级后重跑 `rdsh host service install` / `rdsh hub service install`」 | 文档无旧命令残留；e2e 新命令全绿 |

### 2.2 不含（Out of Scope）

- ❌ join token / register 端点 / portal「添加主机」页（→ `05-join-easy`）
- ❌ `host join` 的交互注册新 UX（--token 语义改为注册、`--name` 注册命名）→ `05-join-easy`
- ❌ paste-box 修复（API key 由 DSH 管理）→ 独立 `doc/fix/20260824-portal-apikey-pastebox`
- ❌ hub 命令行为变更（仅服务名 `rdsh-hub.service` 调整，属 R10）
- ❌ 双通道（一台机器同时 serve + join）——3 模式互斥，一次只跑一种

## 3. 端到端验收场景

> **场景**：一台开发机从零开始走「配置 → 运行 → 注销」全流程；一台旧用户机器走迁移。

1. **LAN 场景**：`rdsh host setup lan`（交互：端口等）→ host.json `{mode:"lan"}` → `rdsh host serve` → 局域网配对码认证可用；`rdsh host service install` → 生成 `rdsh-host.service`。
2. **Cloud 场景**：`rdsh host setup cloud`（交互：tls 路径 + 密码 + allowFrom）→ host.json `{mode:"cloud", tls, auth:{mode:"password"}, allowFrom}` → `rdsh host serve` → https + 密码登录可用。
3. **Join 场景**：`rdsh host join https://hub.example.com`（粘贴 token / --token）→ 注册 → host.json `{mode:"join", hub, name}` + session → `rdsh host serve` → 隧道建立，hub 显示在线；**重启 serve 复用 session 免配**。
4. **证书**：`rdsh host join https://self-signed-hub` → 自动回退 insecure + host.json 记 `insecure:true` + 一行提示。
5. **注销**：`rdsh host leave` → hub 条目删除（self-revoke）+ session/host.json 清空 → `rdsh host serve` 报「未配置」。
6. **迁移**：旧机器（有 `~/.rdsh/config.json` + 旧 `rdsh.service`）升级 → 首次 `rdsh host serve` 自动迁移出 host.json（mode 推断）→ 重跑 `rdsh host service install` → `rdsh-host.service` 正常运行。
7. **回归**：`rdsh hub serve/user/host/service` 行为不变（仅服务名变 `rdsh-hub.service`）；`--config` 临时配置全流程可用。

## 4. 验收执行方式

- 自动化：`node --test`（config 读写/迁移/校验、host.json schema、self-revoke 限流、service unit 模板、证书检测逻辑）+ 本机双进程 e2e（setup→serve / join→serve / leave）
- 回归：M1/M2/M3 相关 e2e 更新命令后全绿（hub 行为不变）
- 文档：`verification.md` 逐条对照 R1–R12 + RTTM

## 5. 待定项（留给 solution.md，不阻塞 req 批准）

- host.json 具体 schema 字段命名与旧 config.json 字段映射表
- `setup lan/cloud` 交互向导的提问项与默认值
- 证书自动检测的判定实现（连接层错误分类：cert 错误 vs 网络错误）
- self-revoke 端点与 `handleRevokeHost` 的重构/复用方式
- 服务 unit 模板对 `host serve` 的 ExecStart 形态

*关联文档：discussion.md | 下游依赖：05-join-easy（discussion.md）| 下一步：solution.md（待 req 批准后）*
