# 在家或办公室，用手机/笔记本/台式机遥控开发机的 DSH 智能体（局域网篇）

[English](../en/01-01-lan-access.md) | **中文**

> 2026-09-28 · remote-dsh ≥ 0.14（命令按当前命令树；0.14 起局域网认证由"配对码"改为"**访问口令**"）
> 场景系列：① 局域网遥控（本文）→ ② 云服务器 → ③ 多机/团队 → ④ 移动端

---

## 场景

你的开发机（或构建机）上跑着一个 **DeepSeek Harness（DSH）智能体** —— 它能理解你的任务、调用工具、读写文件、执行命令、跑工作流。

但问题是：它被锁在那台机器上。

- **在家里**：智能体在书房的开发机上跑，你躺在客厅沙发上 —— 想在手机上给它派个新任务、看看它执行到哪一步？
- **在办公室**：智能体在工位台式机上，你抱着笔记本去开会/去别的工位 —— 想继续遥控它？
- **构建机**：公司有一台专用构建机跑 DSH 做自动化 —— 你需要在任何一台电脑上操作它？

**remote-dsh（rdsh）** 就是干这个的：一条命令，让**任何一台设备（手机/笔记本/台式机）都变成 DSH 智能体的遥控器**，在同一局域网内即可。

## 安装（一次性）

```bash
npm install -g remote-dsh
```

要求：Node.js ≥ 22；跑智能体的机器上已安装 `dsh`（PATH 中）。

## 三步开始遥控

**① 开发机上启动遥控服务：**

```bash
rdsh host setup lan           # 写 ~/.rdsh/host.json（mode: lan，默认 0.0.0.0:8442）+ 生成访问口令
rdsh host serve               # 前台常驻，自动拉起 dsh web
```

终端显示（访问口令**只打印这一次**，请记下）：

```
rdsh: host 配置为 LAN 网关（访问口令，端口 8442）→ /Users/you/.rdsh/host.json
rdsh: 访问口令（请记录，可用 `rdsh host gate set` 修改）：Xy3kPq9vLm2
rdsh: 运行 `rdsh host serve` 前台启动，或 `rdsh host service install` 常驻。

rdsh serve: gateway on http://172.20.6.203:8442
rdsh serve: LAN: http://172.20.6.203:8442
rdsh serve: dsh web on 127.0.0.1:57067
rdsh serve: auth mode: accessCode
rdsh serve: 访问口令已启用（经隧道或直连访问都需先输入口令）。
```

**② 遥控设备（手机/笔记本/台式机，同一 WiFi）浏览器打开** `http://172.20.6.203:8442`：

- 看到 **rdsh 访问口令页**（认证闸门，不是 DSH 界面）
- 输入开发机终端的**访问口令**

**③ 进入 DSH 智能体界面，完整遥控：**

- 给智能体派新任务、继续会话
- 实时看它调用工具、执行 shell、写文件
- 浏览/管理智能体工作区的文件
- 事件流实时推送（它在干什么，一目了然）

## 访问口令 = 你的遥控器密钥

访问口令在 `rdsh host setup lan` 时**由本机随机生成、只在终端打印一次** —— 这是"物理信任锚点"：只有坐在智能体机器前的人看得到；口令**不过网络**（改口令前旧凭据也全部作废）。

- 口令正确 → 签发 **HttpOnly 签名 Cookie（7 天）**，同一设备免重复输入
- **没输入过口令的设备**永远停在访问口令页 —— 外人碰不到你的智能体
- 多台设备（手机 + 笔记本 + 台式机）可用同一口令各自登录
- 想换口令：`rdsh host gate set`（改完旧 Cookie 立即失效）

## 真实体验

- **认证**：输一次访问口令，7 天免重复。
- **手机遥控**：完整 DSH 界面（响应式），对话/工具/文件/实时流都正常。
- **目录选择**：正常（secure-context 兼容已在网关侧处理）。
- **大文件/长任务**：流式转发，无感。
- **Ctrl+C 退出**：干净退出，不留残留进程。

## 小技巧

```bash
rdsh host setup lan --port 9000     # 换端口（默认 8442；0 = 系统自动分配）
rdsh host gate set                  # 重新设置访问口令（旧的口令与 Cookie 立即失效）
rdsh host gate status               # 查询当前是否已设置口令
rdsh host gate clear                # 清除口令（⚠ 网关随后不再认证，仅限完全可信网络）
```

> **端口为什么是 8442**：本机网关默认 8442，rdsh **hub 服务端**默认 8443 —— 两个端口分开，同一台机器上同时跑 hub 和 host 也不会撞。

## 常见问题

- **访问口令在哪**：`rdsh host setup lan` 时终端打印一次（之后可用 `rdsh host gate set` 重设）；值保存在 `~/.rdsh/host.json`（0600）。
- **忘了口令**：重新 `rdsh host gate set`（旧口令与所有已签发 Cookie 立即失效）。
- **手机打不开**：同一 WiFi；macOS 防火墙允许传入连接；路由器无 AP 隔离。
- **端口被占**：`rdsh host setup lan --port <n>` 换一个（或 `"port": 0` 让系统分配）。
- **换设备要重配吗**：不用 —— 同一口令有效期内多设备共用；Cookie 各自独立。

## 安全说明（重要）

- DSH 智能体**本身无认证**（能执行任意命令）—— **rdsh 网关是唯一的认证层**，别在无保护时暴露
- 局域网明文 http 是**设计内**的：访问口令不过网络、Cookie 是 HttpOnly 签名会话，威胁模型低
- **端口仅建议内网/可信网络暴露**；`gate clear` 后网关不再认证 —— 只在完全可信网络使用
- **不要**把 `rdsh host serve`（LAN 模式明文 http）直接暴露公网 —— 云服务器场景用 HTTPS + 用户名密码（见下），或自己前置 TLS 反向代理

## 下一步：出了家门 / 出了办公室怎么办？

两种场景，两条路：

- **智能体部署在云服务器（阿里云 ECS 等）**：**云服务器直连**：HTTPS + 用户名/密码 + systemd 常驻，公网直接访问（[云服务器部署系列 ②/③/④](../zh/02-01-cloud-single-tls.md)）。
- **智能体在家里的开发机（无公网 IP），出差在外想访问**：**rdsh 云 hub 隧道**：机器只**出站**连接 hub，不暴露任何端口 —— 从 [注册 rdsh.cn 账号](01-03-rdsh-account.md) → [获取 join token](01-04-join-token.md) 开始。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
