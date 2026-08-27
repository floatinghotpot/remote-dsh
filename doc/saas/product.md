# remote-dsh

remote-dsh 让您把 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 变成「任何地方浏览器即用」的 AI 智能体——免部署、免公网、免装客户端。

## 它解决什么
- **免部署**：无需自己搭 hub、无需公网 IP，注册即用；
- **免装客户端**：纯浏览器访问，电脑 / 手机 / 微信内打开即可；
- **一个账号管多台机器**：自有机器或云主机统一接入、共享、审计。

## 核心能力
- 远程访问：局域网 / 云服务器 / 公网 hub 三种模式；
- 账号体系：邮箱 / 手机号注册、2FA、审计、共享授权；
- 安全：TLS + 认证网关 + 会话签名，协议冻结（gateway 永不需改动）。

## 开源与托管
- **自托管**（开源免费，MIT）：`npm i -g remote-dsh` 即可自建；
- **托管 SaaS**（本服务）：注册 / 试用 / 订阅，免运维。

## 快速开始
1. 注册账号（3 天试用，1 台主机）；
2. 在自有机器上执行 `rdsh host join <hub>` 接入；
3. 浏览器登录 → 进入主机 → 操作 DSH。

## 更多
- 开源仓库与文档：[github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
