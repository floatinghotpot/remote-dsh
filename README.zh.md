# remote-dsh

让 DeepSeek Harness 随时随地可用。

![rdsh logo](media/rdsh256.png)

**remote-dsh** 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之上构建一层安全远程访问：
本机照常 `dsh web`，之后用任意设备 —— 同局域网的笔记本/手机，以及（配合 hub）公网任意位置 —— 都能操作这台机器上的 DSH。

## 状态

MVP 进行中：局域网网关（`rdsh serve`）是第一个里程碑。
需求管线见 [doc/feature/01-remote-access](doc/feature/)，完整产品提案见 [doc/marketing/proposal.md](doc/marketing/proposal.md)。

## 快速开始（MVP）

```bash
npm install -g remote-dsh   # 与 dsh 一起安装；命令是 rdsh
rdsh serve                 # 启动局域网认证网关（自动拉起 dsh web）
```

同网络下另一台笔记本浏览器打开 `http://<你的IP>:<端口>`，输入终端显示的配对码即可使用。

## 组件

| 组件 | 名称 | 职责 |
|---|---|---|
| CLI | `rdsh` | `rdsh serve`（局域网）/ `rdsh join <hub>`（公网）/ `rdsh hub ...` |
| 服务器 | rdsh-hub | 控制面（认证、host 注册、路由）+ 数据面（隧道汇聚转发） |
| 开发机侧 | rdsh-gateway | 局域网认证网关 / 公网出站隧道端点；spawn `dsh web` |
| 隧道协议 | rdsh-tunnel | 线协议：帧复用、心跳、背压 |
| 门户 | rdsh-portal | 网页登录 + host 列表（Vite + React） |
| 手机 App | rdsh-app | Flutter（Android/iOS） |
| 微信小程序 | rdsh-weapp | 轻量客户端 |

## 架构

```
客户端（浏览器 / App / 小程序）
        │  HTTPS/WSS —— 层1：hub 对外 API
        ▼
    rdsh-hub  ◄──── WSS 隧道 —— 层2：rdsh-tunnel ──── rdsh-gateway ──► dsh web (127.0.0.1)
```

两个协议层：**层 1**（hub 对外 API，JSON over HTTPS + WSS 事件）是客户端实现的唯一契约；
**层 2**（rdsh-tunnel）只在 hub 与 gateway 之间运行，客户端从不实现。

## 开发

- Node.js ≥ 22（见 `.nvmrc`）、pnpm ≥ 9
- TypeScript monorepo（`packages/*`）、Flutter App（`apps/app`）、微信小程序（`apps/weapp`）、未来 Go hub（`go/`）
- 贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，内部文档见 `doc/`

## 维护者

- [Liming Xie](https://github.com/floatinghotpot) — liming.xie@gmail.com

## 许可证

MIT —— 见 [LICENSE](LICENSE)。品牌资产（logo、名称）不在 MIT 授权范围内 —— 见 [NOTICE](NOTICE)。
