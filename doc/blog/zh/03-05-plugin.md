# 不用装 CLI：给 DSH 装个插件，界面里点一下就远程访问

[English](../en/03-05-plugin.md) | **中文**

> 2026-08-24 · dsh-web-remote 0.1.0（M4 开发版，未发布）
> 服务器转发模式系列：⑤ 多机 + 公网 hub → **本文：DSH 插件免 CLI 接入**

---

## 场景

你已经在这台机器上跑着 `dsh web`（DSH 的网页界面），想从任何地方远程访问它，但不想再装 rdsh CLI、也不想折腾 systemd 服务。

给 DSH 装个插件 `dsh-web-remote`，DSH 界面里就会出现一个「**远程访问**」面板：粘贴 hub 地址 + 授权令牌，点「接入」，就上线了。**复用与 CLI 完全相同的 join 隧道**，只是把入口做进了 DSH 界面。

## 架构

```
DSH web 进程（本机）
  ├─ server 插件：进程内跑 join 隧道，转发到「自己」（127.0.0.1:<dsh 端口>）
  └─ client 插件：设置页「远程访问」面板（状态点 + 表单 + 接入/断开/注销）
        │  RPC /remote-access（connect/disconnect/revoke/state）
        ▼
   hub ──wss 隧道──► 本机 dsh web
```

- **免装 CLI**：`dsh plugin add` 即得能力；
- **内嵌不 spawn**：插件跑在 dsh 进程内，不额外起第二个 dsh；
- **双通道分发**：CLI 与插件共用同一 host 核心、同一 host 身份（单身份铁律）。

## 步骤

### ① 安装插件

```bash
dsh plugin --profile web add dsh-web-remote
```

（`dsh web` 就是 `--profile web` 的别名，所以装到 web profile。）

### ② 重启 dsh web，打开面板

```bash
# 先 Ctrl+C 停掉当前 dsh web，再重新启动（插件在 boot 时加载，不热加载）
dsh web
```

浏览器打开 `http://127.0.0.1:3080` → **设置（Settings）** → 找到「**远程访问 Remote Access**」面板。

### ③ 接入

1. 去 hub portal「添加主机」生成**授权令牌**（一次性明文，只显示一次）；
2. 面板填 **Hub 地址** + **授权令牌** + **主机名**；
3. 点「**接入**」→ 状态点变「连接中…」→「**已连接**」；
4. 面板下方提示会给出 **hub 地址**（可点击）——从任何地方登录 hub 门户 → 主机列表 → 找到这台主机，即可访问它。

### ④ 日常

| 操作 | 说明 |
|---|---|
| 断开 | 停隧道，**配置与授权保留**（令牌框显示 `••••••••`），点「接入」即恢复，无需重贴令牌 |
| 注销 | 停隧道 + hub 侧吊销 + 本地清空 → 回到「未接入」空表单 |
| 断线 | 自动指数退避重连，无需手动操作 |

## 面板状态一览

| 状态 | 含义 |
|---|---|
| 未接入 | 首次，需填 hub + 授权令牌 |
| 连接中 / 已连接 / 断线重连 | 隧道生命周期（断线自动重连） |
| 未接入（已断开，配置保留） | 断开后；令牌已保存，留空点接入即恢复 |
| 已接入（由 rdsh CLI/服务托管） | 本机另有 CLI join 在跑，插件只读 |

## 与 CLI 的关系

- **同一 host 身份**：CLI 和插件共用 `~/.rdsh/host.json` + session 令牌，**同机同一时刻只跑一条隧道**（pid 锁防双隧道）；
- 已用 CLI 接入时，面板显示「外部托管」只读态，避免抢隧道；
- 想切回 CLI 管理：面板「注销」后，用 `rdsh host join <hub>` 重新接入即可。

## 要点 / 坑

- 插件会自动装上依赖 `rdsh-gateway`；
- 授权令牌只显示一次、服务端只存哈希，请像密码一样保管；
- token 被 hub 吊销后，面板提示「host token rejected」，重新贴新授权令牌接入即可。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 插件：`dsh plugin add dsh-web-remote`；CLI：`npm i -g remote-dsh`（MIT 协议，开源）
