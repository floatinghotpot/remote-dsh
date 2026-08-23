# Bug 报告：`rdsh join` 重启后必须重新配对，且 hub 侧累积不可复用的离线 host 条目

> **日期**: 2026-08-24
> **严重度**: P2（功能缺口/体验缺陷，非安全漏洞；阻塞"gateway 常驻服务"的运维预期）
> **影响组件**: rdsh-gateway（`packages/gateway/src/join.ts`）、rdsh-hub 数据面（`packages/hub/src/api.ts`）
> **发现环境**: 阿里云 ECS（Ubuntu 26.04，容器），rdsh 0.4.8（本地构建），hub 经 apache2 443 反代（behindProxy），gateway 与 hub 同机（`rdsh join http://127.0.0.1:8443`）
> **来源**: 生产部署测试发现（2026-08-24，重启 join 后需重新输配对码）

---

## 1. 现象（症状）

- 每次重启 `rdsh join`（进程重启/崩溃恢复/机器重启后重新运行），都会**打印新的配对码**，必须在 portal 重新输码绑定，隧道才恢复；
- 每次重新绑定后，hub.db `hosts` 表**新增一条** host 记录，旧的 host 条目永远停留在"离线"状态，**不自动清理**，随时间无限累积；
- 浏览器端无感知（登录会话独立），但旧 host 的 `rdsh_host` cookie 指向的旧 hostId 已无隧道（HOST_OFFLINE），需手动回到列表选新 host。

## 2. 复现步骤

1. `rdsh join <hub-url>`（无 `--token`）→ 打印配对码 → portal 绑定 → 隧道建立，hub.db 出现 host 条目 A；
2. 重启该进程（Ctrl+C / `pkill` / 服务重启），再次运行 `rdsh join <hub-url>`；
3. 观察：打印**新配对码**，portal 再次绑定 → hub.db 新增 host 条目 B；
4. 观察：条目 A 仍存在（离线），永不消失；`rdsh hub host ls` 可见两条。

## 3. 根因（代码事实）

**join 侧：host token 不持久化，进程死亡即丢失。**

- `packages/gateway/src/join.ts:106`：`const token = opts.token ?? (await bind(...))` —— token 只在本次进程生命周期内使用；
- `packages/gateway/src/join.ts:37-58`（`bind()`）：`POST /api/hosts/pending` → 打印配对码 → 轮询 `GET /api/hosts/pending/:id` → 返回 token；**全程无落盘**（grep 确认 join.ts 无任何文件写入）；
- `packages/gateway/src/join.ts:305`：token 仅用于 WSS 隧道 URL `?token=`。

**hub 侧：每次绑定都新建 host，旧条目无自动清理。**

- `packages/hub/src/api.ts:334-338`（`handleBind`）：`hostId = randomUUID()`、`hostToken = randomToken()`、`db.createHost(...)` —— **无条件新建**，不识别/复用/清理旧条目；
- `packages/hub/src/api.ts:391-403`（`handleRevokeHost`）：只有 owner 显式吊销（`db.removeHost`）才删除 —— 旧条目只能人工清理。

**设计意图核对**：M3 需求 R3（"断线自动重连，指数退避"）只覆盖**隧道层断线**（进程存活期间），不覆盖**进程重启**；R4 的 `--token` 直填路径存在但 token 无法从正常流程获得（`rdsh hub host ls` 不输出明文 token，绑定响应中的 token 仅 join 进程内可见且不打印）→ 实际无法用于重启恢复。属需求覆盖缺口 + 实现缺陷。

## 4. 影响

| 项 | 影响 |
|---|---|
| 运维体验 | gateway 无法做到"重启即恢复"，违背常驻服务预期（systemd/launchd 崩溃重启后需人工介入） |
| 数据面 | `hosts` 表死条目无限累积（每次重启 +1），portal 列表被离线条目污染 |
| 安全 | **无安全漏洞**：token 只存 SHA-256 摘要是正确设计；修复时必须保持"明文 token 仅存在于 gateway 本地 0600 文件"，不回传 hub |

## 5. 修复方案（候选 + 推荐）

### 方案 A（推荐）：join 持久化 host token 并复用

- `join.ts`：绑定成功后将 token 写入 `~/.rdsh/join-<hub-host>.token`（`node:fs`，权限 0600，文件名按 hub URL hash 或主机名区分）；
- 启动流程改为：`opts.token ?? readPersistedToken(hub) ?? await bind(...)`；
- **复用失败回退**：用持久化 token 建隧道若被 hub 拒绝（401/404，如已吊销/服务端重置），则**删除旧 token 文件**并自动进入配对码流程（无需人工干预）；
- 保持安全边界：明文 token 只落 gateway 本地（0600），hub 侧依旧只存 SHA-256 摘要；
- 配套：`--reset` 或新 flag 清除持久化 token（可并入现有 `--reset` 语义或文档说明删除文件）。

### 方案 B（辅助，可选）：hub 侧旧条目提示

- `handleBind` 时若检测到该 owner 存在同网关的离线旧条目，返回提示信息（不自动删，避免误删——旧条目可能属于另一台机器上的同名网关）；清理仍由 owner 通过 `rdsh hub host revoke` / portal 手动完成。
- 或将"自动清理旧条目"作为独立小需求评估（需定义"同网关"识别规则，如 token 摘要无法回溯，只能按 owner+名称前缀，误删风险高——**建议不做自动删**）。

### 方案 C（不做）：仅文档缓解

- usage.md 说明"重启需重新配对"并给出清理命令 —— 只能缓解，不解决，不推荐单独采用。

## 6. 验收标准

1. 正常绑定后 kill join，立即重启：**不打印配对码**，直接用持久化 token 恢复隧道（hub 侧 host 在线）；
2. 在 portal 吊销该 host 后重启 join：**自动回退**到配对码流程（打印新码），无报错退出；
3. token 文件权限 0600；`~/.rdsh` 下文件名可识别（如 `join-*.token`）；hub.db 依旧无明文 token（grep 断言）；
4. 单测：token 读写/权限/失效回退路径；join e2e（如 `spike/e2e-m3.sh` 扩展）覆盖"重启复用"场景；
5. 回归：M1/M2/M3 测试全绿（`pnpm test`）。

## 7. 参考

- 相关代码：`packages/gateway/src/join.ts`（bind/join/token 使用）、`packages/hub/src/api.ts`（handleBind/handleRevokeHost）、`packages/hub/src/db.ts`（hosts 表）
- 关联文档：`doc/feature/03-hub/req.md`（R3 重连 / R4 绑定）、`doc/overview/roadmap.md`（"顺手项：--token e2e 补测"）
- 已知相邻缺口（非本 bug）：join 被 SIGKILL 时 dsh 孤儿（M3 verification.md §5，P3）
