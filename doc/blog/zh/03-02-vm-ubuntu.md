# 虚拟机里的 DSH 智能体也能远程访问：不用改网络，一条 rdsh join 搞定

[English](../en/03-02-vm-ubuntu.md) | **中文**

> 2026-08-23 · remote-dsh 0.4.1
> 场景系列：① 局域网遥控 → ②/③/④ 云服务器部署 → ⑤ 公网 hub → **⑥ 虚拟机（本文）** → ⑦ 嵌入式 Linux

---

## 场景

你的 DSH 智能体跑在**虚拟机里**——VMware Workstation / Fusion、VirtualBox、Parallels、Hyper-V 里的一个 Ubuntu，而不是裸机。

虚拟机默认是 **NAT 网络**：VM 躲在宿主机后面，**没有自己的公网 IP**，局域网设备也找不到它。改桥接模式又要折腾虚拟化软件和路由器配置。

**最省事的路：不改网络，让 VM 出站连 hub**——`rdsh join` 一条命令，从任何地方访问这台 VM 里的 DSH。

## 方式 A（推荐）：NAT 网络不动 → `rdsh join`（hub 出站隧道）

虚拟机里执行（网络配置零改动）：

```bash
npm install -g remote-dsh
rdsh join https://hub.example.com
```

终端打印 6 位配对码 → 浏览器登录 hub → 输码绑定 → 从任何地方访问这台 VM 里的 DSH。

- VM 只**出站**连接 hub，宿主机、公司网络不用开任何端口
- NAT / 桥接 / 仅主机模式**全都能用**——不用管网络模式
- hub 搭建见 [⑤ 没有公网 IP 也能远程操控](../zh/03-01-hub-public.md)

## 方式 B（备选）：桥接模式 → `rdsh serve`（局域网直连）

如果你只想在局域网内用，且 VM 已配成**桥接**（和宿主机同网段、有自己的局域网 IP）：

```bash
npm install -g remote-dsh
rdsh serve
# 另一台设备访问 http://<VM的IP>:8443，输配对码
```

适用：同 WiFi 的快速直连；缺点是要先把 VM 网络改成桥接（NAT 默认用不了）。

## 多台 VM 一起管

一台宿主机开多个 VM、每台一个 DSH？每台各跑一个 `rdsh join`，门户列表就是多台机器：

```
hub 门户
 ├─ ● dev-ubuntu-vm1   （VMware 里的 Ubuntu，NAT 出站）
 ├─ ● build-vm2        （VirtualBox，NAT 出站）
 └─ ● raspberry-pi     （树莓派，见 ⑦ 篇）
```

## 注意事项

- **VM 快照/挂起**：挂起时隧道断开，恢复后 `rdsh join` 自动重连——不用管
- **资源**：DSH 智能体需要 CPU/内存，给 VM 分 2G+ 内存更稳
- **时间同步**：VM 时钟漂移影响 JWT 会话有效期，建议开时间同步（VMware Tools / guest additions）
- **实测程度**：`rdsh join` 公网隧道能力已由 M3 验收（真实 dsh + hub）；VM 网络场景按已验证组件组合，具体虚拟化软件步骤以官方文档为准

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
