# TODO（WebView hub 登录态不持久）

> 提取自 [solution.md](./solution.md) §8「非目标」与 [verification.md](./verification.md) §4 的未完成/后置项。

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| T1 | garsync 真机 >1h + 杀 App 重启验证 | ⏭️ | 机制已在浏览器验证；App（iOS WKWebView）侧 >1h 与杀进程重启待真机复测（solution §7-1/2） |
| T2 | `/portal/login` 已登录跳转真机点选 | ⏭️ | 代码 + 逻辑已核对，待真机复测（solution §7-4） |
| T3 | portal `api.refresh` 死代码清理 | ⏭️ | `api.refresh(refreshToken)` 已无调用（`silentRefresh` 自建 fetch）；body 回退使其仍可用，属可选清理（solution §8） |
| T4 | 续期 cookie 加 `Secure` | ⏭️ | 现与 session cookie 一致不加（兼容自托管 http）；若 hub 恒为 HTTPS 可后续统一加（solution §8） |
