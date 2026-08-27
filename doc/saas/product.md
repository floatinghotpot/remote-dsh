# remote-dsh

remote-dsh 让您把 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 变成「任何地方浏览器即用」的 AI 智能体——免部署、免公网、免装客户端。

## 为什么选择 remote-dsh
- **浏览器即用**：免部署、免公网 IP、免装客户端，开浏览器就能指挥智能体；
- **双通道接入**：DSH 插件（`dsh-web-remote`）一键接入，或 CLI（`remote-dsh`）灵活自控；
- **开源可信**：MIT 开源、协议冻结（gateway 永不需改动），可自托管、可被集成。

## 使用场景

### ① 快速上手（免部署 · 托管 hub）
- **适合**：大多数用户，想最快用上，不想碰服务器、公网或部署。
- **需要**：一个 hub 账号 + DSH 插件 `dsh-web-remote`。
- **效果**：无需公网 IP，任何地方（电脑 / 手机 / 微信内浏览器）登录即用。

### ② 专业直连（自带机器 · 免 hub）
- **局域网**：机器与你在同一网络，`rdsh serve` 配对后按 IP 直连。
- **云服务器**：有公网 IP / 域名的云主机，`rdsh serve` + TLS 密码认证，按 IP / 域名直连。
- **适合**：想保留完全控制、不经过任何第三方 hub 的技术用户。

### ③ 企业自建（自托管 hub · 完全自控）
- **自托管 hub**：在自有机器上 `rdsh hub serve`，多用户 / 审计 / 共享。
- **云上自部署 hub**：把 hub 部署在自己的云主机上，供团队按账号接入。
- **适合**：团队 / 企业，要统一账号、审计、数据自持。

## 快速开始（托管 hub）
1. 注册账号（3 天试用，1 台主机）；
2. 在 DSH 中执行 `dsh plugin add dsh-web-remote`，于「远程访问」面板粘贴 hub 地址 + join token 接入；
3. 浏览器登录 → 进入主机 → 操作 DSH。

## 更多
- 开源仓库与文档：[github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
