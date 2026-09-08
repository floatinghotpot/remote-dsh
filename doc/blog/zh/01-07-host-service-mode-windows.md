# 后台服务 · Windows：现状与可用路线

> 2026-09-08 · rdsh.cn 云服务
> rdsh.cn 上手系列：③ 接入方式三：后台服务 —— **Windows 篇（本文：当前为受限现状 + 可用路线）**（Linux / macOS 另有分篇）

---

## 现状（先说清楚）

Windows 上的"一键安装为后台服务"**目前尚未提供**——remote-dsh 的服务化支持覆盖 Linux（systemd）和 macOS（launchd），在 Windows 上**请勿直接执行** `rdsh host service install`（会失败）。

不过你现在仍有两个可用的路子，任选其一：

### 路线一：WSL2 里按 Linux 篇操作（推荐）

如果你需要在 Windows 电脑上常驻运行：

1. 安装 **WSL2 + Ubuntu**（建议使用支持 systemd 的较新 WSL 版本，具体启用方式见微软官方文档）；
2. 在 Ubuntu 里装 `dsh`，然后**完全按本系列《后台服务接入 · Linux》篇**操作（一条 `service install` 命令装好）。

> 好处：与 Linux 篇同一套已验证流程，开机随 WSL 启动自动连上 rdsh.cn。

### 路线二：Windows 原生——暂时前台跑

如果只是临时用用：

- 登录后打开终端执行 `rdsh host serve`，即可远程访问（关掉窗口连接即断）；
- 想"登录即自启"，可以用 Windows 自带的**任务计划程序**在登录时启动它——这是通用的系统级做法，属于临时方案，不是 remote-dsh 的官方后台服务。

## 为什么现在还没有 Windows 一键服务

Windows 没有 systemd / launchd 这类用户级服务模型，需要单独实现（如任务计划/服务封装），属于平台适配工作——**正在跟进中**。本文会随版本更新，正式支持发布后我们会补充完整的 Windows 教程。

> 有强烈需求？欢迎到项目 GitHub 反馈，帮助决定优先级。

## 电脑接进来之后，它安全吗？

- **它是"只认你"，不是"开了门"**——接入后只有你的账号能进入它；别人看不到，也进不去（除非你主动分享）；
- **路上内容是加密的**——你远程查看、操作的对话与文件都是密文，中转服务读不到内容；
- **可以在电脑上再加一道锁**——设一个只属于你的主机访问密码（可选，随时可开关）：任何其他人，包括服务方，都过不去。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh`（MIT 协议，开源）
