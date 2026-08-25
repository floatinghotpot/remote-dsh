# 多用户与团队：邮箱验证、两步验证、机器共享、审计日志

[English](../en/03-06-account-security.md) | **中文**

> 2026-08-24 · remote-dsh 0.6.x / rdsh-hub 0.4.0（M5，开发版未发布）
> 服务器转发模式系列：⑤ 多机 + 公网 hub → 本文：账号安全与团队共享

---

## 场景

你已经搭好了自己的 hub（见 [在 ECS 部署 hub](03-01-hub-public.md)），单机用得挺顺。现在想把它用成**团队工具**：

1. 让**同事也能操作某台机器**，但别让他改你的机器配置；
2. 账号**丢了密码能找回**（而不是只能找管理员重置）；
3. 加一层**两步验证**，密码泄露也不至于账号失守；
4. 谁在什么时候干了什么，**有审计可查**。

这些都在 **M5 多租户增强** 里，**全部落在 hub 控制面，机器侧的 rdsh 零改动**。

## 一次配置（hub.json）

编辑 `~/.rdsh/hub.json`。`email` 二选一（示例 1 = SMTP，示例 2 = 阿里云 DirectMail HTTP API）；`captcha` / `security` 通用；不配 `email` 则邮箱验证/找回密码禁用。

整体结构（`email` / `captcha` / `security` 都是**顶层键**，可各自独立省略）：

```jsonc
{
  "host": "0.0.0.0",
  "port": 8443,
  "tls": { "cert": "/path/cert.pem", "key": "/path/key.pem" },
  "behindProxy": false,               // 反代终止 TLS 时才 true

  "email": { /* …示例 1 或示例 2 的内容… */ },
  "captcha": { "provider": "arithmetic" },
  "security": { /* …「通用：验证码 + 风控」的内容… */ }
}
```

### 示例 1：SMTP（最通用，任何邮件服务商）

```jsonc
"email": {
  "provider": "smtp",
  "from": "noreply@example.com",
  "fromAlias": "remote-dsh",            // 可选，发件人昵称
  "smtp": {
    "host": "smtpdm.aliyun.com",        // 阿里云邮件推送 SMTP 端点（可换任意服务商）
    "port": 465,                        // 465 = SSL(secure:true)；587 = STARTTLS(secure:false)
    "secure": true,
    "user": "noreply@example.com",      // 发信地址/账号
    "password": "SMTP独立密码"           // 控制台设置的 SMTP 独立密码（非 AccessKey）
  }
}
```

### 示例 2：阿里云 DirectMail HTTP API（走 443，绕开 25 端口）

```jsonc
"email": {
  "provider": "aliyun",
  "from": "noreply@example.com",        // 阿里云控制台的「发信地址」
  "fromAlias": "remote-dsh",
  "aliyun": {
    "accessKeyId": "LTAI...",
    "accessKeySecret": "...",            // 手写 RPC 签名，无需 region_id
    "endpoint": "https://dm.aliyuncs.com/"  // 可选：国内默认；海外填 dm.ap-southeast-1.aliyuncs.com
  }
}
```

### 通用：验证码 + 风控（可选，全有默认值）

```jsonc
"captcha": { "provider": "arithmetic" },   // 找回密码页防 bot
"security": {
  "emailDailyLimit": 5,              // 同收件人每日发信上限（防轰炸）
  "globalEmailDailyLimit": 200,      // 全局每日发信上限（防烧钱）
  "loginLockThreshold": 10,          // 连续失败锁账户
  "loginLockMinutes": 15,
  "auditRetentionDays": 90           // 审计保留 90 天
}
```

重启 hub 生效。

> **阿里云发信前置**（一次性，控制台 + DNS）：开通「邮件推送」→ 添加并验证发信域名（SPF/DKIM）→ 创建发信地址 `noreply@example.com`。用 **SMTP** 则在该发信地址下设置「SMTP 独立密码」；用 **HTTP API** 则创建 RAM AccessKey 并授权。邮箱验证/找回密码的邮件量很小，免费额度够用。想本地调试用 `provider: "log"`（不真发、只落日志）。

## 用户侧：绑定邮箱 + 找回密码 + 2FA

这些都在 portal 里自助完成，管理员不用插手：

1. 登录 → 右上角「**账户**」→ 输邮箱 →「发送验证码」→ 填码「验证邮箱」；
2. 绑定后忘记密码 → 登录页「**忘记密码**」→ 输邮箱 + 算术验证码 → 收重置码 → 设新密码（**旧会话全部失效**）；
3. 同一页「开启 2FA」→ 复制密钥到 Google Authenticator / 1Password → 填当前 TOTP 码确认。之后再登录就要输密码 + 验证码。

## 把机器共享给同事

owner 在「我的机器」列表里点某台机器的「**共享**」→ 输入同事**用户名** → 确认：

- 同事登录后列表里能看到这台机器（标记「共享」），点「进入」就是完整 DSH；
- 但同事**看不到/用不了**「改名 / 共享 / 吊销」按钮 —— 管理操作仍是 owner 专属；
- 想收回：共享管理里「移除」。

> **重要提醒**：共享 = 把机器完全交给对方（DSH 是整实例授权，member 进入后能执行任意命令）。只共享给你信任的人。

## 管理员：审计 + 解锁

```bash
# 审计：谁在什么时候干了什么（登录成败/改密/2FA/共享/发信…）
rdsh hub audit ls
rdsh hub audit ls --user alice --event host.share
rdsh hub audit ls --since 24h

# 有人被锁（连续 10 次密码错）：
rdsh hub user unlock alice

# 有人换了手机、丢了 2FA 密钥：
rdsh hub user reset-2fa alice
```

## 要点 / 坑

- **邮件是找回密码的前提**：不配 `email`，用户忘密码只能找管理员 `hub user passwd` 重置；
- **反枚举**：找回密码时无论邮箱是否存在都返回「已发送」——不泄露「哪个邮箱注册了」；
- **防刷**：发信三层限流（收件人 / 触发者 / 全局）+ 找回密码算术验证码，脚本刷不动、也烧不了你配额；
- **验证码只存哈希**：PIN / 重置码 / TOTP secret 都不落明文。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
