# rdsh 使用手册（usage）

> **日期**: 2026-08-23
> **适用版本**: remote-dsh ≥ 0.2.0（M1 现状）；M2（云服务器直连）章节标注「规划中」
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
rdsh serve                    # 默认 0.0.0.0:8443，自动拉起 dsh web
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

### serve 参数（M1）

| 参数 | 说明 |
|---|---|
| `--port <n>` | 监听端口（默认 8443；0 = OS 分配） |
| `--host <ip>` | 绑定地址（默认 0.0.0.0） |
| `--pair-code <code>` | 预置配对码（默认随机生成） |
| `--session-ttl <sec>` | 会话 Cookie 有效期（默认 43200 = 12h） |
| `--dsh <path>` | dsh 可执行文件路径（默认 PATH 查找） |
| `--reset` | 轮换会话密钥，全部设备重新配对 |
| `--no-code` | ⚠ 跳过配对（仅限完全可信网络） |

## 3. 认证模式（M2 起，规划中）

`~/.rdsh/config.json` 的 `auth.mode` 决定：

| mode | 说明 | 适用 |
|---|---|---|
| `pair` | 配对码（M1 现状，终端显示） | LAN / 可信网络 |
| `password` | 用户名 + 密码（M2 默认） | HTTPS 服务 / 公网 |
| `none` | 免认证（--no-code 语义） | 完全可信网络 |

> ⚠ **安全提示**：密码认证必须配合 HTTPS（TLS）使用 —— 明文 http 下输密码可被同网段嗅探。

## 4. 配置文件（M2 起，规划中）

默认 `~/.rdsh/config.json`；可用 `--config <path>` 或 `$RDSH_CONFIG` 指定（全局参数，serve/user/service 共享）。

```json
{
  "host": "0.0.0.0",
  "port": 8443,
  "session_ttl_seconds": 43200,
  "tls": { "cert": "/path/cert.pem", "key": "/path/key.pem" },
  "allow_from": ["192.168.1.0/24"],
  "auth": {
    "mode": "password",
    "pair_code": "",
    "users": [{ "name": "admin", "password_hash": "scrypt:..." }]
  }
}
```

**原则**：持久配置一律进 config.json，CLI 只做操作（`--reset`、`user`、`service`）。

## 5. 用户管理（M2 起，规划中）

```bash
rdsh user add admin        # 添加用户（交互设密码，scrypt 哈希存储）
rdsh user passwd admin     # 改密码（改密 = 全部旧会话立即失效）
rdsh user ls               # 列出用户
rdsh user rm admin         # 删除用户
```

## 6. 服务化（M2 起，规划中）

```bash
rdsh service install       # 生成并安装 systemd unit（Linux）/ launchd plist（macOS）
rdsh service status
rdsh service uninstall
```

- 开机自启 + 崩溃自动重启（`Restart=on-failure`）
- 用户级安装，**无需 sudo**
- 由系统进程管理器托管 rdsh（连带其 spawn 的 dsh）

## 7. 云服务器部署（M2 起，规划中）

```bash
# 1. 配置 TLS + 密码认证（见 §4）
# 2. 用户管理（见 §5）
# 3. 服务化（见 §6）
rdsh --config /etc/rdsh/config.json service install
```

- **headless 配对码替代**：密码认证免终端；部署时 `rdsh user add` 设一次
- **IP 白名单**：config 的 `allow_from`（CIDR 列表）
- **公网安全**：必须 TLS；多机场景推荐后续经 hub（M3，gateway 只出站不暴露）

## 8. 安全注意事项

| 项 | 说明 |
|---|---|
| DSH 无认证 | 本网关是唯一认证层 —— 别在无认证/`none` 模式下暴露到不可信网络 |
| 明文 http | 仅限可信 LAN；公网必须 TLS |
| `--no-code` | 等同把 DSH 暴露给同网段所有人（任意命令执行）—— 仅限完全可信网络 |
| 密钥文件 | `~/.rdsh/secret.key`（0600）—— 泄露=会话可伪造 |
| 改密 | 改密会自动轮换密钥使旧会话失效 —— 这是特性不是 bug |

## 9. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 浏览器报 `crypto.randomUUID is not a function` | 旧版网关（0.2.0 已修复 polyfill） | 升级 |
| `/api/...` 报 403 | Host/Origin 未改写（0.2.0 已修复） | 升级 |
| 配对后目录选择失败 | 同上 | 升级 |
| Ctrl+C 后 dsh 残留 | 0.2.0 已修复（SIGINT/SIGTERM/SIGHUP 优雅退出） | 升级 |
| 端口被占 | — | `--port` 换端口 |
| 手机打不开 | AP 隔离 / 防火墙 | 确认同一 WiFi、允许传入连接 |
| 配对码在哪里 | 终端 `pair code:` 行 | 重启会生成新码 |

## 10. 相关文档

- 架构：`architecture.md`
- 路线图：`roadmap.md`（里程碑状态）
- 产品提案：`proposal.md`
- M1 需求管线：`doc/feature/01-remote-access/`

*本文档随 M2 落地更新（config/user/service/TLS 章节从「规划中」转为正式）*
