# 把 rdsh-hub 与 rdsh-join 部署为 systemd 用户服务（免 sudo、开机自启、崩溃重启）

[English](../en/04-01-run-as-user-service-ubuntu.md) | **中文**

> 2026-08-24 · remote-dsh 0.4.9
> 运维系列 ①：让 hub 与 gateway 真正"常驻"——关掉 SSH 也不停、重启机器自动起、崩溃自动恢复。

---

## 场景

你按 [03-01 hub 公网直连](../zh/03-01-hub-public.md) / [03-02 hub 反代](../zh/03-02-hub-behind-apache-https.md) 把 hub 跑起来了，但发现两个问题：

- **`rdsh hub serve` / `rdsh join` 是在 SSH 终端里跑的** —— 关掉终端（或断线）服务就停，只能 `nohup ... &` 续命，还没法开机自启；
- **机器重启后**要手动一个个把 hub、join 拉起来，顺序错了还要等重试。

解法：**systemd 用户服务**。和系统服务不同，用户级服务**不需要 sudo**（文件放 `~/.config/systemd/user/`），支持：

- ✅ **随登录会话脱离**：SSH 关掉照常运行
- ✅ **开机自启**：配合 `loginctl enable-linger`，无需登录
- ✅ **崩溃自动重启**：`Restart=on-failure`
- ✅ **顺手吃满 0.4.9 新特性**：join 服务重启后自动复用持久化 token，**免重新配对**

## 架构

```
SSH 终端（可随时关掉）
   │
   ▼
systemd --user 管理器
   ├── rdsh.service      (hub:  rdsh hub serve --config hub.json)
   └── rdsh-join.service (join: rdsh join <hub-url>)
          └── spawn → dsh web（子进程，随 join 一起被托管）
```

- join 服务启动时按 `EnvironmentFile` 注入环境（API key 等），spawn 的 dsh 自动继承
- join 重启 → 读取 `~/.rdsh/join-*.token` → 直接复用，不打印配对码

## 步骤

### ① 确认 systemd 用户管理器可用

```bash
systemctl --user is-system-running    # 期望 running
```

### ② hub：一条命令安装

```bash
rdsh hub service install
```

生成的 unit（`~/.config/systemd/user/rdsh.service`）：

```ini
[Unit]
Description=rdsh — remote access for DeepSeek Harness
After=network.target

[Service]
Type=simple
ExecStart=<node> <rdsh-bin> hub serve --config <hub-config>
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

> `<node>` / `<rdsh-bin>` 由安装命令自动填入绝对路径（`process.execPath` + CLI 脚本路径），无需手改。

```bash
systemctl --user status rdsh        # 应 active (running)
journalctl --user -u rdsh -f        # 实时日志
```

### ③ join：手写 unit（0.4.9 尚无内置命令）

`rdsh join` 目前没有 `service install` 子命令（可关注后续版本），手写一份（约 10 行）：

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/rdsh-join.service <<EOF
[Unit]
Description=rdsh join tunnel (<hub-url>)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=<node-bin-dir>:/usr/local/bin:/usr/bin:/bin
ExecStart=<node> <rdsh-bin> join <hub-url>
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now rdsh-join
```

> **`Environment=PATH` 是必配项**（本系列最大的坑）：systemd 用户服务的默认 PATH 不含 nvm/自装 Node 目录，没有它 join 的 `findDsh` 找不到 `dsh`，服务会反复启动失败。
> 路径获取：`command -v node` 得 node 路径；`readlink -f $(command -v rdsh)` 得 rdsh 真实路径；`dirname $(command -v node)` 即 node 所在目录。

### ④ 注入环境变量（API key 等）

**systemd 用户服务不读 `~/.profile` / `~/.bashrc`** —— 你在登录 shell 里 export 的 `DEEPSEEK_API_KEY`，服务里没有，spawn 的 dsh 会报 `no API key for provider route`。正确姿势：

```bash
# 1) 密钥放独立 0600 文件（不进 unit）
echo 'DEEPSEEK_API_KEY=sk-xxx' > ~/.rdsh/join.env
chmod 600 ~/.rdsh/join.env

# 2) 用 drop-in 挂载（不污染主 unit，reinstall 也不丢）
mkdir -p ~/.config/systemd/user/rdsh-join.service.d
cat > ~/.config/systemd/user/rdsh-join.service.d/env.conf <<'EOF'
[Service]
EnvironmentFile=-/home/<user>/.rdsh/join.env
EOF
systemctl --user daemon-reload && systemctl --user restart rdsh-join
```

> `EnvironmentFile` 路径**不支持 `~` 展开**，必须写绝对路径；开头的 `-` 表示文件不存在不报错。
> 验证注入：`tr '\0' '\n' < /proc/<dsh-pid>/environ | grep DEEPSEEK_API_KEY`（看实际进程环境，而不是 `systemctl show` —— EnvironmentFile 不进管理器的 Environment 属性，属正常现象）。

### ⑤ 开机免登录自启（关键一步）

```bash
sudo loginctl enable-linger <user>
loginctl show-user <user> | grep Linger    # 期望 Linger=yes
```

> 忘了这步：服务**只在登录期间**运行，重启后不会自动起。用户级服务 + linger = 系统级常驻的免 sudo 替代。

### ⑥ 停掉手跑实例再启动服务

端口/隧道被手跑实例占着会导致服务启动失败（`EADDRINUSE` 反复重启）：

```bash
kill -TERM <手跑join的PID> <手跑hub的PID>    # SIGTERM 会优雅回收 dsh 子进程
systemctl --user restart rdsh rdsh-join
```

## 运维速查

| 操作 | 命令 |
|---|---|
| 启动 | `systemctl --user start rdsh-join` |
| 停止 | `systemctl --user stop rdsh-join` |
| 重启 | `systemctl --user restart rdsh-join` |
| 状态 | `systemctl --user status rdsh-join` |
| 日志 | `journalctl --user -u rdsh-join -f` |
| 开机自启 | `systemctl --user enable/disable rdsh-join` |
| 改环境配置 | `systemctl --user edit rdsh-join`（drop-in） |
| 服务实际环境 | `systemctl --user show rdsh-join -p Environment` |
| 进程真实环境 | `tr '\0' '\n' < /proc/<pid>/environ` |

（hub 同理，服务名是 `rdsh`。）

## 要点/坑（生产实测，2026-08-24 阿里云 ECS）

- **PATH**：服务默认 PATH 无 nvm/自装 Node → join 找不到 dsh → 必配 `Environment=PATH=...`（见 ③）
- **环境变量**：服务不读 `~/.profile` → API key 必须 `EnvironmentFile`（0600）注入（见 ④）
- **drop-in 优先**：`rdsh hub service install` 会重新生成主 unit，环境配置写 `.service.d/` 才不怕覆盖
- **linger 别忘**：否则"开机自启"是假的（见 ⑤）
- **时序不用愁**：join 先于 hub 启动也能恢复 —— `Restart=on-failure` 每 3 秒重试 + 隧道内部指数退避重连
- **token 持久化红利**：join 服务重启日志出现 `reusing persisted host token` 即免配对恢复（0.4.9 特性，配套 [bug 修复](../../../doc/fix/20260824-join-token-persist/bug-report.md)）
- **密钥安全**：`join.env` 0600、unit 文件 600、日志不打印 token（hub 侧只存 SHA-256 摘要）

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
