# 把 DSH 智能体部署到云服务器，公网浏览器直接遥控（单独 + 内置 TLS 篇）

[English](../en/02-cloud-single-tls.md) | **中文**

> 2026-08-23 · remote-dsh 0.3.0
> 云服务器部署系列：② rdsh 单独 + 内置 TLS（本文）→ ③ apache2 反代 → ④ nginx 反代

---

## 场景

你在阿里云（或腾讯云/华为云等）租了一台 **Ubuntu 云服务器**，把 **DeepSeek Harness（DSH）智能体** 部署在上面跑自动化任务。

现在你希望：**人在任何地方，浏览器打开一个 https 地址，输入用户名密码，就能完整操作这台服务器上的 DSH 智能体** —— 派任务、看实时执行、管理工作区文件，和坐在服务器前一样。

本系列讲的就是这件事（云服务器三部署用例）。本文是**最简单的一种**：rdsh 单独运行，自己持 HTTPS 证书，公网单端口直连。

## 架构

```
你的浏览器 ──https──► 云服务器:8443 (rdsh) ──认证──► 127.0.0.1:<port> (dsh web)
                          ▲
                    config.json + systemd 常驻
```

- rdsh 网关是**唯一的认证层**（DSH 本身无认证）：HTTPS + 用户名/密码 → 签发 HttpOnly 会话 Cookie → 之后全双工转发（HTTP / SSE / WebSocket）
- 证书由 **rdsh 直接使用**（`tls.cert/key`），不需要额外装 nginx/apache

## 前置条件

| 项 | 要求 |
|---|---|
| 云服务器 | 阿里云 ECS 等，Ubuntu 22.04+（headless 即可） |
| Node.js | ≥ 22（`node -v` 确认） |
| dsh | 已安装且 `dsh` 在 PATH 中 |
| 域名 | **可选**：有域名可自动签发可信证书（acme.sh/Let's Encrypt）；没有域名可手动自签（浏览器需信任一次） |

## 六步部署

### ① 安装 remote-dsh

```bash
npm install -g remote-dsh
rdsh --version   # 0.3.0
```

### ② 添加登录用户（交互设密码，scrypt 哈希存储）

```bash
rdsh user add admin
# 输入并确认密码（终端不回显）
```

密码**只以 scrypt 哈希形式**写入配置，绝不明文落盘。

### ③ 准备证书（三选一）

**A. 有域名 → acme.sh 自动签发（推荐，90 天续期）：**

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d rdsh.example.com --webroot /var/www/html
acme.sh --install-cert -d rdsh.example.com \
  --key-file /root/.rdsh/key.pem \
  --fullchain-file /root/.rdsh/cert.pem \
  --reloadcmd "rdsh service restart"   # 续期后自动重载证书
```

**B. 云厂商证书**：在云控制台申请免费证书（如阿里云 SSL 证书），下载 Nginx 格式 PEM，放到服务器（如 `/etc/rdsh/`），权限 `chmod 600`。

**C. 无域名快速起步 → 手动自签**（浏览器首次访问需手动信任）：

```bash
mkdir -p /etc/rdsh && cd /etc/rdsh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=<服务器公网IP>"
```

### ④ 写配置文件 `~/.rdsh/config.json`

```jsonc
{
  "port": 8443,                                  // 公网访问端口（安全组需放行）
  "tls": {                                       // 证书路径（上面三选一的产物）
    "cert": "/root/.rdsh/cert.pem",
    "key": "/root/.rdsh/key.pem"
  },
  "auth": {
    "mode": "password",                          // 用户名/密码认证（M2 主认证）
    "users": []                                  // 由 rdsh user 命令管理，勿手改
  }
  // 可选：
  // "allowFrom": ["1.2.3.0/24"],                // IP 白名单（CIDR），白名单外 403
  // "sessionTtlSeconds": 43200,                 // 会话时长，默认 12 小时
}
```

> ⚠ 安全基线：`auth.mode: password` 必须配 TLS（或 behindProxy）。无证书硬要 password 模式，rdsh 会**拒绝启动**并提示 —— 这是故意的，别关掉。

### ⑤ 服务化常驻（开机自启 + 崩溃重启）

```bash
rdsh service install    # 生成 systemd unit（Ubuntu）/ launchd plist（macOS），无需 sudo
rdsh service status     # active 即常驻中
```

- rdsh 不自带 fork 后台，交给 systemd 托管（连带它 spawn 的 dsh 一起管理）
- 崩溃自动重启（`Restart=on-failure`）；重启机器后自动恢复

### ⑥ 放行端口 + 浏览器访问

- 云安全组（阿里云控制台 → 安全组 → 入方向）放行 **TCP 8443**（或你配置的端口）
- 浏览器打开 `https://<服务器公网IP>:8443`
  - 自签证书：会提示"证书不受信"→ 手动信任后继续
  - 正式证书：直接进入
- 输入 **admin + 密码** → 进入 **DSH 智能体界面** → 完整遥控

## 日常运维

```bash
rdsh user passwd admin    # 改密 —— 全部已登录设备立即掉线（需重登）
rdsh user ls              # 用户列表
rdsh user rm bob          # 删除用户
rdsh service status       # 运行状态
rdsh service uninstall    # 卸载服务（停止 + 移除自启）
rdsh serve --reset        # 轮换会话密钥（紧急踢掉所有会话）
```

## 安全要点（重要）

- DSH 智能体**本身无认证**（能执行任意命令）—— **rdsh 网关是唯一的认证层**
- 公网直连 = **必须 HTTPS + 密码认证**；云安全组只放行你用的端口
- 登录失败**限流**：同一 IP 连续错 5 次 → 锁定 10 分钟（防爆破）
- 会话 Cookie 是 **HttpOnly + SameSite=Lax** 的 HMAC 签名值，浏览器脚本拿不到
- 可选 `allowFrom` 白名单：只允许特定来源 IP 段访问（多层防御）
- 证书私钥/配置文件权限保持 600；日志不打印密码与 Cookie

## 什么时候改用反向代理（下一篇）

| 需求 | 用哪种 |
|---|---|
| 就想单端口快速用 | **本文：单独 + 内置 TLS** |
| 已有域名，想 443 标准端口、证书全自动续期 | [③ apache2 反代](../zh/03-cloud-apache-acme.md) |
| 已在用 nginx 管别的站点，想共端口 443 | [④ nginx 反代](../zh/04-cloud-nginx.md) |

多服务共 443、证书由反代统一管理时，rdsh 只需 `behindProxy: true` 监听 127.0.0.1 —— 下一站见。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
