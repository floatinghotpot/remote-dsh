# 出差在外也能访问家里的 DSH：VPN 连回局域网，配对码照用

[English](../en/01-02-vpn-lan.md) | **中文**

> 2026-08-23 · remote-dsh 0.4.1
> 场景系列：局域网访问 —— ① 直连 · **⑧ VPN 回连（本文）**

---

## 场景

你出差/旅行在外，但家里（或办公室）已经有一条 **VPN** —— WireGuard、OpenVPN、公司 VPN 都行。

VPN 连上后，你的设备**就像在局域网里一样**（拿到一个内网 IP、能访问内网资源）。这时访问家里那台 DSH 智能体，**完全复用局域网玩法**：`rdsh serve` + 配对码，一条命令都不用改。

不用搭公网 hub、不用暴露任何端口——**VPN 管链路，rdsh 管认证**。

## 前提

| 项 | 说明 |
|---|---|
| 家里/办公室 | 一台跑 DSH 的主机（Windows/Mac/Linux），已装 `remote-dsh` |
| VPN | WireGuard / OpenVPN / 公司 VPN，能从外网连入 |
| 在外设备 | 笔记本/手机，装了 VPN 客户端 |

## 三步

### ① 家里主机上启动 rdsh（和平时一样）

```bash
# 家里那台跑 DSH 的主机上
rdsh serve
# 默认绑定 0.0.0.0:8443 —— VPN 网段也能访问
```

### ② 在外设备连 VPN

连上后确认拿到内网 IP：

```bash
# WireGuard 示例
sudo wg-quick up wg0
ip addr show wg0        # 看到 10.x.x.x 等 VPN 网段 IP
```

**能 ping 通家里主机**（或 VPN 分配的虚拟 IP）就说明链路通了。

### ③ 浏览器访问 + 配对码

```bash
# 在外设备浏览器打开（家里主机的局域网 IP 或 VPN 虚拟 IP）
http://<家里主机IP>:8443
# 输入家里主机终端显示的配对码 → 进入 DSH
```

配对码只在**家里主机终端**显示——这是物理信任锚点，VPN 隧道里传输也不怕。

## 和公网 hub 方案怎么选

| 方案 | 适用 | 说明 |
|---|---|---|
| **VPN 回连（本文）** | 已有 VPN 的公司/家庭网络 | 复用现有设施，零额外部署；`rdsh serve` 配对码照用 |
| [公网 hub（rdsh join）](../zh/03-01-hub-public.md) | 没有 VPN | 出站隧道，无需任何网络配置，一个网址管所有机器 |

## 注意事项

- **防火墙**：家里主机放行 8443（或换端口）；VPN 服务端/路由器别挡 VPN 网段互访
- **延迟**：VPN 链路质量决定体验；实时事件流（WebSocket）在几百 ms 内都很顺
- **安全性**：rdsh 配对码 + HttpOnly 会话 Cookie 是认证层；VPN 加密链路是传输层——双层都别关
- **实测程度**：`rdsh serve` 局域网访问能力已由 M1 验收；VPN 客户端连通是通用网络操作，具体以你的 VPN 配置为准

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
