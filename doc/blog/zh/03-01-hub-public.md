# 没有公网 IP 也能远程操控：一个网址，统一访问所有机器上的 DSH 智能体

[English](../en/03-01-hub-public.md) | **中文**

> 2026-08-23 · remote-dsh 0.4.0
> 场景系列：① 局域网遥控 → ②/③/④ 云服务器部署 → **⑤ 多机 + 公网 hub（本文）** → ⑥ 移动端

---

## 场景

你的 DSH 智能体散落在**多台机器**上：

- **家里的开发机**（书房，无公网 IP）
- **云服务器**（阿里云 ECS，跑自动化）
- **旧笔记本**（公司/实验室，当构建机用）

你想：**人在任何地方，浏览器打开一个网址，登录一次，就能在几台机器之间切换操作** —— 不记 IP、不用配置路由器、不用每台单独搞 HTTPS。

**rdsh hub 就是干这个的**：一台公网服务器当"总机"，所有机器**只出站**连上来（免公网 IP、免端口映射），你在网页门户里选机器进。

## 和前面几篇的关系

| 方案 | 适用 | 说明 |
|---|---|---|
| [① 局域网遥控](../zh/01-01-lan-access.md) | 单台机器、同一 WiFi | `rdsh serve` 配对码 |
| [②③④ 云服务器直连](../zh/02-01-cloud-single-tls.md) | 单台、有公网 IP 的机器 | `rdsh serve` + HTTPS/反代 |
| **⑤ 公网 hub（本文）** | **多台、无公网 IP** | `rdsh join` 出站隧道 + hub 门户 |

## 架构

```
        你的浏览器（任何地方）
              │  https://hub.example.com（登录 → 选机器）
              ▼
        rdsh-hub（公网服务器：认证 + 路由）
         │         │         │
   wss 隧道   wss 隧道   wss 隧道   （层 2 rdsh-tunnel，全部出站）
         ▼         ▼         ▼
   家里开发机   云服务器    旧笔记本    （各跑 rdsh join + dsh web）
```

- 客户端永远只连 hub 一个域名（证书单一、配置简单）
- 机器侧**只出站**：NAT/防火墙后面也能用，无需公网 IP、无需路由器设置
- hub **纯透传**：只认证 + 路由，不解析业务报文（各机器 dsh 版本可以不同）

## 三步搭好

### ① 公网服务器上启动 hub（一次性）

```bash
npm install -g remote-dsh
rdsh hub user add admin        # 管理员建号（交互设密码；注册关闭，防 bot）
```

写 `~/.rdsh/hub.json`（TLS 证书用 acme.sh / Let's Encrypt / 云厂商，同云服务器篇）：

```jsonc
{
  "port": 8443,
  "tls": { "cert": "/etc/letsencrypt/live/hub.example.com/fullchain.pem",
           "key":  "/etc/letsencrypt/live/hub.example.com/privkey.pem" }
}
```

```bash
rdsh hub serve --config ~/.rdsh/hub.json     # 前台验证
rdsh hub service install                     # 或常驻：systemd/launchd 开机自启
```

> 公网 hub 必须 TLS（`rdsh hub serve` 无证书会拒绝启动）。

### ② 每台机器接进来（各一次）

```bash
npm install -g remote-dsh
rdsh join https://hub.example.com
```

终端显示 6 位配对码：

```
rdsh join: pair code: 385201
rdsh join: sign in to https://hub.example.com and enter this code (10 min) to bind this host.
rdsh join: waiting for binding...
```

浏览器登录 hub → 点"绑定新机器" → 输码 → 该机器自动建立隧道，出现在你的机器列表。**脚本化部署**可跳过网页：`rdsh join https://hub.example.com --token <hostToken>`。

三台机器各来一遍，列表里就有三台（含实时在线状态）。

### ③ 随时随地使用

浏览器打开 `https://hub.example.com` → 登录 → 看到机器列表（●在线/○离线）→ 点"进入" → **完整 DSH 界面**（对话/工具/文件/实时事件流全都在，WebSocket 也走隧道）。

> 小提示：同一浏览器一次只能在一个 host 的界面里（串行切换没问题：返回列表 → 再进另一台）；要同时开着看多台，用不同浏览器或隐身窗口即可。多人各自用自己的浏览器访问，互不影响。

- 断网/重启？机器侧自动重连（指数退避），列表状态实时更新
- 给机器改名：列表里"改名"；不用了："吊销"（隧道立即断开，重连被拒）

## 实际体验（0.4.0 实测）

| 项 | 体验 |
|---|---|
| 绑定 | 输一次配对码，长期有效（host token 存在机器上） |
| 多机切换 | 列表进进出出，随时换 |
| 异地访问 | 公网 https，和在家一样 |
| 实时流 | WebSocket 经隧道转发，执行过程实时可见 |
| 断线 | 自动重连，恢复后列表变回在线 |
| 吊销 | 立即断隧道，且重连被拒（token 已作废） |

## 安全要点（重要）

- **注册关闭**：hub 账号只能管理员 `rdsh hub user add` 创建 —— 公网 bot/垃圾账号进不来
- **登录限流**：同一 IP 连续错 5 次锁定 10 分钟；登录失败按真实 IP 计数
- **改密**：portal 自助改密（验证当前密码）→ **全部已登录设备立即掉线**；忘记密码找 admin 重置
- **host 归属**：机器只归绑定它的账号所有，别人看不到也进不去（403）
- **令牌**：会话 JWT（改密/吊销即时失效）；机器 token 服务端只存 SHA-256 摘要
- **纯透传**：hub 不解析业务报文，各机器 dsh 版本随意

## 运维命令

```bash
rdsh hub user add bob               # 加人
rdsh hub user passwd bob            # 重置 bob 密码（全部会话失效）
rdsh hub user ls|rm
rdsh hub host ls                    # 所有机器（含 owner）
rdsh hub host revoke <hostId>       # 吊销某台机器
rdsh hub service status             # hub 运行状态
```

## 下一步

- **共享给团队**：把某台机器共享给同事操作（M5 多租户增强，已实现：邮箱验证、TOTP 两步验证、host 共享、审计日志、账户锁定 —— 见 [usage.md §8.3](../overview/usage.md)）
- **移动端**：手机 App / 微信小程序直接连 hub（后续里程碑）
- 想了解底层协议？层 1（hub API）与层 2（隧道协议）都是冻结契约，见 `packages/tunnel/PROTOCOL.md`

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
