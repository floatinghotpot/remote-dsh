# 用 join token 把新主机接入 hub：portal 生成 → 机器一条命令（免浏览器配对）

[English](../en/03-04-join-token.md) | **中文**

> 2026-08-24 · remote-dsh 0.4.9+（04/05 开发版，未发布）
> 服务器转发模式系列：⑤ hub 公网直连 → **本文：join token 一键接入（推荐）**

---

## 场景

hub 接入原本依赖**配对码**，但它要求"有人在浏览器前输码"——对 headless 的云服务器、以及用 systemd 服务常驻的机器（见 [usage.md §8.5 服务化要点](../overview/usage.md#85-服务化要点)）很不友好：码只打印在 journal 里，还得赶 10 分钟窗口。**该流程已随 04/05 重构移除（token-only）**，现在统一用 join token：

**join token** 把接入变成两步：

```
hub portal「添加主机」→ 生成接入命令（含一次性 join token，明文只显示一次）
  → 机器终端粘贴执行 → 注册完成 → host 上线
```

- **用户自助**：token 属于你的 hub 账号，不用找管理员；
- **服务化友好**：`rdsh host service install <hub> --token <t>` 一行完成注册 + 常驻服务，**unit 里不含 token**；
- **重启免配**：注册后 host token 持久化，进程/服务重启自动复用；
- **纯 token 接入**：配对码流程已随 04/05 重构移除（token-only），所有主机接入统一走 join token。

## 架构

```
浏览器（你的账号）                    机器（无浏览器 / 常驻服务）
   │ 登录 hub                            │
   ├─「添加主机」→ 生成 join token ──────► 粘贴执行：
   │                                     │   rdsh host service install <hub> --token <t>
   │                                     │     或 rdsh host join <hub> --token <t>
   │                                     ▼
   │   POST /api/hosts/register（持 token，IP 限流）
   │  ◄────────── hostId + hostToken ────┘
   │   建立 wss 隧道（host token 持久化，重启免配）
   ▼
hub 列表见 host 在线 ●
```

## 步骤

### ① portal 生成接入命令

1. 浏览器打开 `https://hub.example.com` → 登录；
2. 进入「**添加主机**」→ 填**机器名**（如 `my-ecs`，默认取主机名，可改）；
3. 勾选「**常驻服务**」（要开机自启 + 崩溃重启时勾选；否则不勾 = 前台运行）；
4. 选**有效期**（默认 30 天；可选 1d/7d/30d/90d/1y）；
5. 点「生成」→ **接入命令明文只显示这一次** → 点「复制命令」。

命令形如：

```bash
# 常驻服务（推荐，机器无浏览器/无人值守）：
rdsh host service install https://hub.example.com --token <t> --name my-ecs

# 前台运行（调试/有人在场）：
rdsh host join https://hub.example.com --token <t> --name my-ecs
```

### ② 机器上粘贴执行

```bash
# 未装 rdsh 先装：
npm i -g remote-dsh

# 粘贴刚才复制的命令（常驻服务版）：
rdsh host service install https://hub.example.com --token <t> --name my-ecs
```

一条命令完成：**注册（持 token 调 register）→ 写 host.json（mode: join）→ 生成并启动 `rdsh-join.service`**（unit 跑 `rdsh host serve`，**不含 token**）。

```bash
systemctl --user status rdsh-join        # active (running)
journalctl --user -u rdsh-join -f        # 期望: tunnel established (heartbeat 30s)
```

### ③ 验证 + 日常

- hub portal 主机列表：新 host **在线 ●**；
- 重启机器/服务：**自动恢复，无需重新配对**（日志 `reusing persisted host token`）；
- 前台运行版：`rdsh host join` 注册后 `rdsh host serve` 起隧道；
- 解绑：`rdsh host leave`（注销本机在 hub 的注册）。

## join token 的语义（重要）

| 项 | 说明 |
|---|---|
| 归属 | **你的 hub 账号**（注册的 host 归你，他人 403） |
| 有效期 | 默认 30 天，可选 1d/7d/30d/90d/1y |
| 一次性显示 | portal 只展示一次明文，**服务端只存 SHA-256** |
| 可吊销 | portal 列表可随时吊销 → **只阻止未来注册**，已注册主机不受影响 |
| 多机 | **一个 token 可注册多台主机**（各得独立 host token） |
| 安全 | register 端点有 IP 限流；请像密码一样保管 token |

## 接入方式（token-only）

配对码流程已随 04/05 重构移除，接入统一走 join token：

| 方式 | 适用 |
|---|---|
| **`rdsh host service install <hub> --token <t>`**（本文，推荐） | 服务化/headless/多台机器、无人在机器前 |
| `rdsh host join <hub>`（交互粘贴 token）或 `--token <t>` | 前台运行/调试 |

## 要点/坑（生产实测，2026-08-24 阿里云 ECS）

- **nvm 管理 Node 的机器**：systemd 服务环境默认 PATH 没有 node 目录，dsh 可能起不来（code 127）—— 见 [usage.md §8.5 服务化要点](../overview/usage.md#85-服务化要点) 的 PATH 一节补 drop-in（该坑已报 bug，后续版本自动处理）；
- 自签 hub：命令加 `--insecure`（正式证书无需）；
- token 过期/吊销后注册 → 401；已注册主机不受影响；
- 多台机器可用同一 token 各自注册，portal 列表分别管理。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
