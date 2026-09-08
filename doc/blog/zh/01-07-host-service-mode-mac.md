# 后台服务 · macOS：登录后自启，在哪都能安全连回你的 DSH

> 2026-09-08 · rdsh.cn 云服务
> rdsh.cn 上手系列：③ 接入方式三：后台服务 —— **macOS（launchd）篇（本文，待新版验证）**（Linux / Windows 另有分篇）

---

## 适合谁

你的 Mac 常开在家或办公室，希望**登录后 DSH 自动在线、出问题自动恢复**——不用每次手动去启动命令行或插件。macOS 后台服务会：

- 你登录进桌面后，自动连上 rdsh.cn；
- 连接进程意外退出时，自动重新拉起；
- 不占终端窗口，日志写入文件。

## 先说清楚：它"做不到"什么

macOS 的后台服务是**用户级 LaunchAgent**：它在你**用图形界面登录后**才加载。因此：

- **开机停在登录窗、没人登录，它不会启动**——它不是"完全无人值守"；
- 和命令行/插件方式的真正差别，是**不用你手动启动 + 崩溃自动拉起**这两点，而不是"没人碰也能开机即连"；
- 想要**开机即启、无需任何登录**的效果：请用本系列 **Linux 篇**（systemd + `enable-linger` 已支持）；macOS 的这种能力需要**系统级 LaunchDaemon**，目前尚未提供——有需要的话欢迎到项目 GitHub 反馈推动；
- 另外提醒：开着 FileVault 时，重启后仍需在控制台解锁一次。

## 你需要先有

- 一台 macOS 电脑（Intel 或 Apple Silicon），装好了 `dsh`（服务会自动拉起 DSH 网页版）；
- 一个 rdsh.cn 账号（令牌用的时候现生成即可）。

> ⚠️ **版本前提**：macOS 的后台服务（launchd）支持依赖**尚未发布的新版本**——需要 remote-dsh ≥ 0.10.1 / rdsh-gateway ≥ 0.8.1（当前 npm 上为 0.10.0 / 0.8.0，尚未包含该修复）。开始前先确认：

```bash
npm view remote-dsh version    # 应显示 0.10.1 或更高
```

## 开始：一条命令装好

先登录 rdsh.cn →「添加主机」→ 点生成，把显示一次的**令牌**复制下来（临时凭证，用完即弃，丢了再生成一张即可）。然后在这台电脑的终端里执行：

```bash
npm i -g remote-dsh        # 第一次才需要（请装到上面的新版本）
rdsh host service install https://rdsh.cn --token <t> --name my-host
```

（把 `<t>` 换成刚才复制的令牌。）这一条命令完成全部：**用令牌绑定电脑 → 写好配置 → 安装并启动后台服务**。

> 已经用命令行方式接入过？直接运行 `rdsh host service install` 即可（配置和绑定都还在），不用再给令牌。

## 验证装好了

- **看状态**：`rdsh host service status` → 显示 `active`（运行中）；
- **看日志**：`tail -f ~/.rdsh/rdsh-join.log`；
- **最直接的确认**：浏览器登录 **rdsh.cn** → 主机列表 → 这台电脑显示**在线**。

## 开机自启的细节（请读一下）

- 服务在你**登录桌面后**自动加载：桌面 Mac 登录即自启，无需手动启动；
- 想尽量"免人守着"：可在「系统设置 → 用户与群组」开启**自动登录**（开着 FileVault 时，重启仍需先控制台解锁一次）；
- 需要**完全无人值守、开机即启**？——见上文"它做不到什么"（macOS 目前需要 LaunchDaemon，尚未提供；可改用 Linux 篇）。

## 日常操作

- **手动重启**：`launchctl kickstart -k gui/$(id -u)/com.rdsh-join`；
- **彻底移除**：先 `rdsh host service uninstall` 停掉并删除服务，再 `rdsh host leave` 解绑——顺序别反；
- **改名**：登录 rdsh.cn → 主机列表 → 点这台电脑的「改名」，网页上直接改；
- **升级 Node / 重装 remote-dsh 后**：服务指向的路径可能变化——重新执行一次 `rdsh host service install` 即可。

## 电脑接进来之后，它安全吗？

- **它是"只认你"，不是"开了门"**——接入后只有你的账号能进入它；别人看不到，也进不去（除非你主动分享）；
- **路上内容是加密的**——你远程查看、操作的对话与文件都是密文，中转服务读不到内容；
- **可以在电脑上再加一道锁**——设一个只属于你的主机访问密码（可选，随时可开关）：任何其他人，包括服务方，都过不去。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh`（MIT 协议，开源）
