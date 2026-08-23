# 从任何地方远程访问嵌入式 Linux（树莓派）上的 DSH 智能体：一条 rdsh join 接入（构想，未实测）

[English](../en/03-03-embed-linux.md) | **中文**

> 2026-08-23 · remote-dsh 0.4.1
> 场景系列：① 局域网遥控 → ②/③/④ 云服务器部署 → ⑤ 公网 hub → ⑥ 虚拟机 → **⑦ 嵌入式 Linux（本文）**

> ⚠ **本文是构想，未在真实树莓派/嵌入式板卡上实测**（2026-08-23 标注）。步骤基于 rdsh 已验证能力（M3 hub 隧道）与通用 Linux 经验；dsh 对 ARM 的支持以官方发布为准。

---

## 场景

想用一块**树莓派**（或类似的 ARM 嵌入式 Linux 板子）常驻跑 DSH 智能体——低功耗、24 小时在线，当家里的"小服务器"。

树莓派通常：**WiFi/有线联网、没有公网 IP、无显示器（headless）**。它和 [⑤ 没有公网 IP 也能远程操控](../zh/03-01-hub-public.md) 的场景完全一致——**rdsh join 出站隧道**是最合适的接入方式。

## 构想步骤

### ① 树莓派上装 Node.js ≥ 22（ARM64）

```bash
# Raspberry Pi OS（64 位）示例；nodejs.org 提供 arm64 官方包
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

- 老派（32 位系统 / armv7）：Node 官方对 armv7 的支持有限，需确认对应版本
- 检查架构：`uname -m`（aarch64 = ARM64）

### ② 装 dsh + remote-dsh

```bash
npm install -g remote-dsh
# dsh 按 DeepSeek Harness 官方方式安装；ARM 支持以官方发布为准
dsh --version
```

### ③ 接入 hub（一条命令）

```bash
rdsh join https://hub.example.com
# 打印配对码 → 浏览器登录 hub 输码绑定 → 从任何地方访问树莓派上的 DSH
```

headless 无显示器也没关系：绑定完就在 hub 门户里，重启后 `rdsh join` 自动重连（建议用 `rdsh service install` 常驻——但 hub 的服务化模板按当前架构生成，树莓派场景以实测为准）。

### ④ 常驻与自启

```bash
# 构想：systemd 用户级服务（开机自启 + 崩溃重启）
rdsh service install   # 生成 systemd/launchd unit（以实测为准）
```

## 资源考量（构想）

| 板子 | 可行性（构想） | 备注 |
|---|---|---|
| 树莓派 4B/5（4G+ 内存） | 可行 | 跑 DSH 需要 CPU/内存，4G 版本更稳 |
| 树莓派 3B+ / 零 2W | 存疑 | 内存 1G，LLM 调用/工作流可能吃力 |
| 其他 ARM 板（Rockchip/Allwinner 等） | 视系统而定 | 需 64 位系统 + Node 22 支持 |

## 为什么用 hub（而不是直连）

树莓派在家庭网络里（NAT 后面、WiFi 无公网 IP），`rdsh serve` 只能局域网用；要公网访问，**出站隧道是唯一不需要公网 IP/端口映射的方式**——和 ⑤ 篇同一个架构。

## 未实测项（诚实清单）

- dsh 在 ARM64 树莓派 OS 上的安装与运行（以官方发布为准）
- 低配板（1G 内存）上 DSH 的实际可用性
- `rdsh service install` 在树莓派 systemd 上的表现（模板按桌面 Linux 设计）

如果你有树莓派实测过，欢迎反馈结果，我们会更新本文。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
