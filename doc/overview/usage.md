# rdsh 使用手册（usage）

> **日期**: 2026-08-23
> **适用版本**: remote-dsh ≥ 0.5.0（命令树 `rdsh host ...`，配置 `~/.rdsh/host.json`；旧 `config.json` 自动迁移）
> **性质**: 用户/部署操作手册。设计背景见 `architecture.md`、`roadmap.md`

---

## 1. 安装

```bash
npm install -g remote-dsh     # 命令是 rdsh；依赖 rdsh-gateway（自动安装）
rdsh --version                # 验证
```

要求：Node.js ≥ 22；已安装 `dsh`（DeepSeek Harness CLI，须在 PATH 中）。

## 2. 快速开始（LAN，M1 现状）

```bash
rdsh host setup lan           # 写 ~/.rdsh/host.json（mode: lan，默认 0.0.0.0:8443）
rdsh host serve               # 前台常驻，自动拉起 dsh web
```

终端显示：

```
rdsh serve: gateway on http://172.20.6.203:8443
rdsh serve: LAN: http://172.20.6.203:8443, ...
rdsh serve: dsh web on 127.0.0.1:57067
rdsh serve: pair code: 815858
rdsh serve: enter the pair code in the browser on your other device.
```

同一 WiFi 的另一台设备浏览器打开 `http://<开发机IP>:8443` → 输入配对码 → 进入 DSH。

### host setup 参数（0.5.0 起）

| 命令 | 参数 | 说明 |
|---|---|---|
| `rdsh host setup lan` | `--port <n>` | 监听端口（默认 8443；0 = OS 分配） |
| | `--pair-code <code>` | 预置配对码（默认随机生成） |
| `rdsh host setup cloud` | `--tls-cert <path>` / `--tls-key <path>` | TLS 证书与私钥（必填） |
| | `--port <n>` | 监听端口（默认 8443；0 = OS 分配） |
| | `--allow-from <cidr,...>` | IP 白名单（默认空） |

> 其余参数直接写 `~/.rdsh/host.json`（如 `host` 绑定地址、`sessionTtlSeconds` 会话时长、`dshPath`、`auth.mode: none`）。

## 3. 认证模式（M2 现状）

`~/.rdsh/host.json` 的 `auth.mode` 决定：

| mode | 说明 | 适用 |
|---|---|---|
| `pair` | 配对码（M1 现状，终端显示） | LAN / 可信网络 |
| `password` | 用户名 + 密码（M2 默认） | HTTPS 服务 / 公网 |
| `none` | 免认证 | 完全可信网络 |

> ⚠ **安全提示**：密码认证必须配合 HTTPS（TLS）使用 —— 明文 http 下输密码可被同网段嗅探。

## 4. 配置文件（M2 现状）

默认 `~/.rdsh/host.json`（`mode: lan|cloud|join`；旧 `config.json` 自动迁移）；可用 `--config <path>` 或 `$RDSH_CONFIG` 指定（全局参数，host serve/user/service 共享）。

```json
{
  "mode": "cloud",
  "host": "0.0.0.0",
  "port": 8443,
  "sessionTtlSeconds": 43200,
  "tls": { "cert": "/root/.acme.sh/example.com/fullchain.cer", "key": "/root/.acme.sh/example.com/example.com.key" },
  "allowFrom": ["192.168.1.0/24"],
  "auth": {
    "mode": "password",
    "pairCode": "",
    "users": [{ "name": "admin", "passwordHash": "scrypt:..." }]
  }
}
```

**证书来源**：`tls.cert/key` 接受任意 PEM —— acme.sh / Let's Encrypt / 云厂商 / 手动 `openssl req -x509 ...` 自签均可。**无证书时网关跑 http**（仅 pair/none 模式可用）；`auth.mode: password` 无证书且非反代时拒绝启动（需自行提供证书）。

**两种 TLS 落地方式**：

| 方式 | 配置 | 适用 |
|---|---|---|
| 内置 TLS | `tls.cert/key`（任意 PEM） | 单独运行 + 自备证书 |
| 反代 TLS（nginx/apache） | `behindProxy: true`，反代终止 TLS，rdsh 监听本地 http | 已有反代 / certbot 自动续期 |

**acme.sh 集成（内置 TLS）**（证书 90 天续期）：续期后需重启 rdsh 服务重载证书 ——

```bash
acme.sh --issue -d example.com --webroot /var/www/html
acme.sh --install-cert -d example.com \
  --reloadcmd "rdsh host service restart"     # 续期后自动重载证书
```

**原则**：持久配置一律进 host.json，CLI 只做操作（`host setup`、`host user`、`host service`）。

**`dshUiCompat.trustE2EEAsLoopback`（DSH UI 兼容，默认 `true`）**：

DSH 的持久设置（含 Models 页的 API Key 输入）默认只对 loopback 浏览器开放；开启本项后，经 rdsh 隧道访问的浏览器会被视同本机，**可直接在 DSH UI 的 Models 页填写 API Key**（rdsh 不介入 Key 管理，DSH 自存其数据文件）。

```json
{ "dshUiCompat": { "trustE2EEAsLoopback": true } }
```

> ⚠️ **共享 host 安全提示**：默认 `true` 是 **host 级**信任——所有能访问该 host 的人（含共享的 member）都可以改 DSH 设置（API Key、提供方、系统提示词）。**若把主机共享给不信任的人，请设 `false`**（或不要共享）；`false` 时隧道访问者保持 DSH 原样限制（设置不可改，Key 只能走环境变量）。

- CLI（`rdsh host serve/join/service`）：启动读一次，改配置后重启生效；
- DSH 插件（`dsh-web-remote`）：面板开关即时生效（写 host.json + 内存更新，无需重启）。

**`gateway.accessCode`（主机访问密码，默认关闭）**：

经 hub 隧道访问本主机时，gateway 在转发到本机 DSH **之前**要求输入访问密码——**独立于 hub 账号的第二道防线**（hub 只中继、不持有该密码，校验全在网关侧）。不设置 = 无密码 = 与之前行为一致；本机 `127.0.0.1` 直连永远放行（忘记密码时的恢复通道）。

```json
{ "gateway": { "accessCode": "my-secret" } }
```

- 密码最小 4 位，只存本机 `host.json`（0600），hub 全程不接触；
- 访问者验证通过后浏览器保存 7 天 `rdsh_gate` cookie（改密码 → 旧 cookie 全部失效，需重输）；
- CLI（`rdsh host serve/join`）：启动读一次，改配置后重启生效；
- DSH 插件（`dsh-web-remote`）：面板「访问密码」设置/清除即时生效（写 host.json + 内存更新，无需重启）。

## 5. 用户管理（M2 现状）

```bash
rdsh host user add admin        # 添加用户（交互设密码，scrypt 哈希存储）
rdsh host user passwd admin     # 改密码（改密 = 全部旧会话立即失效）
rdsh host user ls               # 列出用户
rdsh host user rm admin         # 删除用户
```

## 6. 服务化（M2 现状）

```bash
rdsh host service install       # 生成并安装 systemd unit（Linux）/ launchd plist（macOS）
rdsh host service status
rdsh host service uninstall
```

- 开机自启 + 崩溃自动重启（`Restart=on-failure`）
- 用户级安装，**无需 sudo**
- 由系统进程管理器托管 rdsh（连带其 spawn 的 dsh）

## 7. 云服务器部署（M2 现状）—— 三种用例

> 公共前置：`npm i -g remote-dsh`；`rdsh host user add admin`（设密码）；`~/.rdsh/host.json` 中 `auth.mode: password`（也可先用 `rdsh host setup cloud --tls-cert <p> --tls-key <p>` 生成再手改）。
> 三种部署方式任选其一（博客 02/03/04 分别详解）。

### 用例 1：rdsh 单独运行 + 内置 TLS（用户证书）

```jsonc
// ~/.rdsh/host.json
{
  "mode": "cloud",
  "port": 8443,
  "tls": { "cert": "/etc/rdsh/cert.pem", "key": "/etc/rdsh/key.pem" },   // 证书：acme.sh/云厂商/手动 openssl 自签
  "auth": { "mode": "password", "users": [{ "name": "admin", "passwordHash": "..." }] }
}
```

```bash
rdsh host service install                # 常驻（systemd/launchd）
rdsh host service status
```

- 证书来源任选：acme.sh 自动签发、云厂商证书、手动 `openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem -subj "/CN=example.com"`（自签浏览器需手动信任一次）
- 适用：个人使用/内部测试，快速可用

### 用例 2：rdsh 在 apache2 后面（apache2 管 HTTPS，cron + acme.sh 自动续期）

```jsonc
// ~/.rdsh/host.json
{
  "mode": "cloud",
  "host": "127.0.0.1",               // 只监听本机，由 apache2 转发
  "port": 8443,
  "behindProxy": true,               // 信任外部 TLS + X-Forwarded-For
  "auth": { "mode": "password", "users": [{ "name": "admin", "passwordHash": "..." }] }
}
```

```apache
# /etc/apache2/sites-available/rdsh.conf
<VirtualHost *:443>
    ServerName example.com
    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/example.com/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8443/
    ProxyPassReverse / http://127.0.0.1:8443/
    # WebSocket（DSH 依赖）：
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8443/$1 [P,L]
</VirtualHost>
```

```bash
# acme.sh 签发 + cron 自动续期
acme.sh --issue -d example.com --webroot /var/www/html
# cron 每 60 天跑一次续期（acme.sh 自带续期，未到期自动跳过）：
# 0 3 * * 0 acme.sh --cron --home /root/.acme.sh > /dev/null
```

- 证书由 **certbot/acme.sh + cron** 全自动管理（90 天续期，rdsh 无需重启 —— 反代重载配置即可）
- 适用：正式域名 + 自动续期 + 多服务共端口

### 用例 3：rdsh 在 nginx 后面

```jsonc
// ~/.rdsh/host.json —— 同用例 2（mode: cloud，behindProxy: true，监听 127.0.0.1）
```

```nginx
# /etc/nginx/sites-available/rdsh
server {
    listen 443 ssl;
    server_name example.com;
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket（DSH 依赖）
        proxy_set_header Connection "upgrade";
    }
}
```

- 与用例 2 同理，nginx 生态（certbot 插件自动续期）
- 适用：已有 nginx / 偏好 nginx

### 三种用例对比

| 用例 | HTTPS | 证书续期 | 复杂度 | 适用 |
|---|---|---|---|---|
| ① rdsh 单独 + 内置 TLS | rdsh | 手动（或 acme.sh hook） | 低 | 快速起步/个人 |
| ② apache2 + cron acme.sh | apache2 | **cron 全自动** | 中 | 正式域名/多服务 |
| ③ nginx | nginx | certbot/手动 | 中 | 已有 nginx |

- **公网安全**：必须 TLS（①内置 / ②③反代）；多机场景推荐后续经 hub（M3，gateway 只出站不暴露）

## 8. 公网 hub（M3 现状）

> 里程碑：M3 公网 hub（2026-08-23 验收通过，单测 92 + e2e 23 + M1/M2 回归 57）。

让无公网 IP 的开发机（gateway）经 hub **出站隧道**被异地浏览器访问；客户端永远只连 hub 一个域名。

**进入 host 的访问架构**（2026-08-23 定案）：点"进入" → 浏览器访问 `/h/<hostId>/` → hub 校验归属 → Set-Cookie `rdsh_host` → **302 到根路径** → DSH 在根路径运行（绝对路径 /assets /api 原生可用，**零前端改动**）。portal 部署在 `/portal` 前缀。

> ⚠ **同一浏览器一次只能在一个 host 上下文**（cookie 单值）：串行使用（进 A → 返回 → 进 B）正常；多标签页并行看不同 host 需多浏览器/隐身窗口。**多用户（不同浏览器/设备）互不影响**。

### 8.1 组件与命令

```
浏览器 ──https://hub.example.com──► rdsh-hub ──wss 隧道──► rdsh-gateway (join) ──► dsh web
```

```bash
# ---- 本机（DSH 主机）：rdsh host ----
rdsh host setup lan                            # 配置为 LAN 网关（pair + http）
rdsh host setup cloud --tls-cert <c> --tls-key <k> [--port <n>] [--allow-from <cidr,...>]
                                               # 配置为云 HTTPS 网关（password + tls + allowFrom）
rdsh host join https://hub.example.com          # 连 hub：粘贴 join token（--token 脚本）
rdsh host serve                                # 前台运行（读 host.json，按 mode 分发 join/lan/cloud）
rdsh host service install|status|uninstall     # 服务化（rdsh-host.service / rdsh-join.service）
rdsh host leave                                # 从 hub 注销（self-revoke + 清理，回到未配置）
rdsh host user add|passwd|ls|rm                # 本机网关用户（写 host.json auth.users）

# ---- 服务器：rdsh hub ----
rdsh hub serve                                 # 启动 hub（需 tls.cert/key，公网必须 TLS）
rdsh hub user add alice [--no-password]        # 管理员建号（注册关闭，防 bot）
rdsh hub user passwd|rm|ls|unlock|reset-2fa    # unlock=解锁被锁账户；reset-2fa=重置用户 2FA
rdsh hub audit ls [--user <n>] [--event <e>] [--since 24h|7d]   # 审计日志查询
rdsh hub host ls|revoke <hostId>               # revoke = 隧道立即断开、重连被拒
rdsh hub service install|status|uninstall      # hub 服务化（rdsh-hub.service）

# host 配置唯一事实源 ~/.rdsh/host.json（mode: lan|cloud|join；token 只进 session 文件）
#   { "mode": "lan", "host": "0.0.0.0", "port": 8443, "auth": { "mode": "pair", ... } }
#   { "mode": "cloud", "tls": {...}, "auth": { "mode": "password" }, "allowFrom": [...] }
#   { "mode": "join", "hub": "https://...", "name": "my-ecs", "insecure": false }
# 旧 ~/.rdsh/config.json 自动迁移到 host.json（按 tls/password 推断 mode）；--config <path> 可指定。
# join 后 host token 持久化到 ~/.rdsh/join-<host>.token（0600），重启/服务化自动复用免配。
```

### 8.2 hub 配置（~/.rdsh/hub.json）

```jsonc
{
  "host": "0.0.0.0",
  "port": 8443,
  "tls": { "cert": "/etc/letsencrypt/live/example.com/fullchain.pem",
            "key": "/etc/letsencrypt/live/example.com/privkey.pem" },
  // dbPath / jwtKeyPath 省略时默认 ~/.rdsh/hub.db、~/.rdsh/hub-jwt.key（node:sqlite；自动生成，0600）
  // 注意：config 字段值不展开 "~"，自定义路径必须写绝对路径
  "behindProxy": false,             // true = 反代终止 TLS（apache2/nginx），hub 监听 http、免证书

  // ---- M5 多租户（可选；不配 email = 邮箱验证/找回密码禁用）----
  "email": {
    "provider": "smtp",              // smtp | aliyun | log
    "from": "noreply@example.com",   // 发信地址
    "fromAlias": "remote-dsh",       // 可选，发件人昵称
    "smtp": {                        // provider=smtp 时必填（嵌套在 email.smtp 下，平铺/缺失会启动报错）
      "host": "smtpdm.aliyun.com",
      "port": 465,                   // 465=SSL(secure:true)；587=STARTTLS(secure:false)
      "secure": true,
      "user": "noreply@example.com",
      "password": "SMTP独立密码"
    }
  },
  "captcha": { "provider": "arithmetic" },   // arithmetic | none（找回密码页防 bot）
  "security": {                              // 可选，全部有默认值
    "emailDailyLimit": 5,                    // 同收件人每日发信上限（防轰炸）
    "globalEmailDailyLimit": 200,            // 全局每日发信上限（防配额烧钱）
    "loginLockThreshold": 10,                // 连续失败锁账户阈值
    "loginLockMinutes": 15,                  // 锁定时长（分钟）
    "auditRetentionDays": 90                 // 审计保留天数（到期自动清理）
  }
}
```

> **`email` 二选一**：`provider` 与凭据必须匹配——`smtp` 要 `email.smtp` 嵌套对象；`aliyun` 要 `email.aliyun` 嵌套对象（`{ "accessKeyId", "accessKeySecret", "endpoint?" }`，手写 RPC 签名、无需 region_id，endpoint 默认 `dm.aliyuncs.com`）；`log` 只需 `provider`（不真发，正文打到日志，本地验证用）。凭据平铺或缺失会在**启动时**报清晰错误。

路径：`--config <path>` > `$RDSH_HUB_CONFIG` > 默认 `~/.rdsh/hub.json`。

### 8.3 账号与安全模型

- **注册关闭**：账号只能 `rdsh hub user add` 创建（防 bot/垃圾注入）；登录失败限流（IP 5 次/10 分钟）+ 账户锁定（10 次/15 分钟，`rdsh hub user unlock` 解锁）
- **JWT 会话**：access（1h，改密/吊销即时失效）+ refresh（7d 轮换）；host token 只存 SHA-256 摘要
- **邮箱 + 2FA**：用户登录后自助绑定邮箱（发 PIN 验证，可找回密码）+ 开 TOTP 两步验证；admin 可 `hub user reset-2fa` 重置
- **改密**：portal 自助（验证当前密码，全部会话失效）或 admin `hub user passwd` 重置
- **host 归属 + 共享**：host 归 owner；owner 可共享给 member（member 可进 DSH 使用、不可管理 host）
- **审计**：login/改密/2FA/共享/发信等关键操作留痕，`rdsh hub audit ls` 查询，默认保留 90 天
- **纯透传**：hub 只认证+路由，不解析/改写业务报文（dsh 版本兼容）

### 8.4 层 1 API（冻结契约）

`POST /api/auth/login|refresh|logout|password|first-password`、`GET /api/hosts`、
`POST /api/hosts/register|self-revoke|join-token`、`GET /api/hosts/join-tokens`、
`DELETE /api/hosts/join-tokens/:id`、`PATCH/DELETE /api/hosts/:id`、`WSS /api/events`（在线推送）、
`/h/<hostId>/...` 进入 host（校验归属 → Set-Cookie → 302 根路径；之后根路径流量按 `rdsh_host` cookie 路由）。错误统一 `{error:{code,message}}`。

其中 `join-token`（需登录，生成用户级 join token，明文只显示一次）、`register`（gateway 持 join token 注册换 host token，未认证+限流）、`self-revoke`（host 持自己的 token 注销）为 05-join-easy 新增；**join 的配对码（pending/bind）流程已移除**——join 只走 join token，配对码仅保留给 LAN/cloud 网关的 pair 认证。

**M5 多租户新增端点**：`POST /api/auth/totp`（2FA 二次校验）、`POST /api/captcha/arithmetic`（算术验证码）、`POST /api/auth/password/reset{/confirm}`（找回密码，反枚举）、`POST /api/account/email{/verify,/unbind}`（邮箱绑定）、`POST /api/account/2fa/{enable,verify,disable}`（TOTP 管理）、`POST /api/hosts/:id/share` + `GET/DELETE /api/hosts/:id/share[/:userId]`（host 共享）。完整契约见 `doc/feature/07-multi-tenant/solution.md` §6。

### 8.5 服务化要点（linger / PATH / 运维速查）

`rdsh host service install <hub> --token <t>` 一条命令即可把本机常驻化（生成 `rdsh-join.service`，unit 不含 token，`rdsh host serve` 读 host.json 运行）。三个必知点：

- **开机免登录自启（linger）**：用户级服务默认只在登录期间运行 —— 忘了这步，"开机自启"是假的：
  ```bash
  sudo loginctl enable-linger <user>
  loginctl show-user <user> | grep Linger    # 期望 Linger=yes
  ```
- **nvm/自装 Node 的 PATH 坑**：systemd 用户服务环境的默认 PATH 不含 node 目录，`rdsh host serve` spawn 的 dsh（`#!/usr/bin/env node`）会起不来（`dsh exited before reporting a port (code 127)`）。workaround：服务 drop-in 补 PATH：
  ```bash
  mkdir -p ~/.config/systemd/user/rdsh-join.service.d
  cat > ~/.config/systemd/user/rdsh-join.service.d/env.conf <<'EOF'
  [Service]
  Environment=PATH=<node-bin-dir>:/usr/local/bin:/usr/bin:/bin
  EOF
  systemctl --user daemon-reload && systemctl --user restart rdsh-join
  ```
  （已报 bug `doc/fix/20260824-join-service-path/bug-report.md`，后续版本自动处理。）
- **systemctl --user 运维速查**：
  | 操作 | 命令 |
  |---|---|
  | 启动/停止/重启 | `systemctl --user start|stop|restart rdsh-join` |
  | 开机自启 | `systemctl --user enable/disable rdsh-join` |
  | 状态/日志 | `systemctl --user status rdsh-join` / `journalctl --user -u rdsh-join -f` |
  | 服务环境属性 | `systemctl --user show rdsh-join -p Environment` |
  | 进程真实环境 | `tr '\0' '\n' < /proc/<pid>/environ` |

  需要给 dsh 注入环境变量（如 `DEEPSEEK_API_KEY`）时用 `EnvironmentFile=-<绝对路径>`（0600 文件，`~` 不展开）；API key 更推荐由 DSH 自管（portal 内粘贴，见 `doc/fix/20260824-portal-apikey-pastebox`）。

## 9. 安全注意事项


| 项 | 说明 |
|---|---|
| DSH 无认证 | 本网关是唯一认证层 —— 别在无认证/`none` 模式下暴露到不可信网络 |
| 明文 http | 仅限可信 LAN；公网必须 TLS |
| `auth.mode: "none"` | 等同把 DSH 暴露给同网段所有人（任意命令执行）—— 仅限完全可信网络 |
| 密钥文件 | `~/.rdsh/secret.key`（0600）—— 泄露=会话可伪造 |
| 改密 | 改密会自动轮换密钥使旧会话失效 —— 这是特性不是 bug |

## 10. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 浏览器报 `crypto.randomUUID is not a function` | 旧版网关（0.2.0 已修复 polyfill） | 升级 |
| `/api/...` 报 403 | Host/Origin 未改写（0.2.0 已修复） | 升级 |
| 配对后目录选择失败 | 同上 | 升级 |
| Ctrl+C 后 dsh 残留 | 0.2.0 已修复（SIGINT/SIGTERM/SIGHUP 优雅退出） | 升级 |
| 端口被占 | — | `--port` 换端口 |
| 手机打不开 | AP 隔离 / 防火墙 | 确认同一 WiFi、允许传入连接 |
| 配对码在哪里 | 终端 `pair code:` 行 | 重启会生成新码 |

## 11. 相关文档

- 架构：`architecture.md`
- 路线图：`roadmap.md`（里程碑状态）
- 产品提案：`proposal.md`
- M1 需求管线：`doc/feature/01-remote-access/`

*本文档随 M2 落地更新（config/user/service/TLS 章节从「规划中」转为正式）*
