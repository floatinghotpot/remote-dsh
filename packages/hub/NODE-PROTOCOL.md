# rdsh 节点协议（relay ↔ hub）

> **状态**: v1（2026-11-17，N2 增量化）。跨语言契约 —— rdsh-relay（Go）与 rdsh-hub
> （TS）之间的**唯一**节点上行协议。任何变更必须先更新本文档再改实现，并补 conformance
> 用例（`e2e/fixtures/`）。

## 传输

- 载体：HTTP POST + JSON；TLS 由反代终止
- 方向：**节点出站**连 hub；节点不监听入站控制面
- 鉴权：`Authorization: Bearer <nodeToken>`（token 由 N1 签发，仅存 SHA-256 摘要）

## 端点总表

| 端点 | 语义 | 频率 |
|---|---|---|
| `POST /api/nodes/register` | N1 注册/入网 | 首次 + 重启 |
| `POST /api/nodes/heartbeat` | N2 心跳 + 在线 host 上报 | 30s |
| `POST /api/nodes/hosts` | N4 单主机上下线 | 事件触发 |
| `POST /api/nodes/sync` | N5 拉取本节点主机/归属/公钥 | 30s |
| `POST /api/nodes/leave` | 解除分配 + 删除节点 | 退役 |
| `POST /api/nodes/assign` | 验证 assign 令牌 | 连接建立时 |

---

## N1 — 注册（`POST /api/nodes/register`）

**请求**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `advertiseUrl` | string | ✅ | 节点对客 URL（`https://...`） |
| `name` | string | | 展示名 |

**鉴权二选一**：`joinToken`（新节点自助入网，默认 disabled）或既有 `nodeToken`（重注册）。

**响应**：`{ nodeId, nodeToken }`（首次）或 `{ nodeId, nodeToken: "" }`（重注册，token 不变）。

---

## N2 — 心跳（`POST /api/nodes/heartbeat`）

心跳即存活证明；同时上报本节点**在线主机集合**与负载。

### 请求字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | number | **单调递增序号**（节点进程内从 1 开始，重启归零）。缺省 = 旧节点，按 `full` 处理 |
| `full` | boolean | `true` = 以 `hosts` 全量替换；缺省 `false` |
| `added` | string[] | 增量：本次新上线的 hostId |
| `removed` | string[] | 增量：本次掉线的 hostId |
| `hosts` | string[] | **兼容字段**：本节点全部在线 hostId（旧节点只用它；新节点仅在 `full` 时携带） |
| `connections` | number | 当前连接数（指标） |
| `activeStreams` | number | 活跃流数（指标） |
| `bytesIn` / `bytesOut` | number | 累计流量（指标） |

### 语义

- **`seq` 缺省**（旧节点）或 **`full: true`** → 以 `hosts` 为准**全量替换** presence；hub 记录 `lastSeq`。
- **`seq === lastSeq + 1`** → 应用 `added` / `removed` 增量。
- **`seq !== lastSeq + 1`**（gap / 重复 / 节点重启归零）→ **不应用增量**，响应 `{"needFull": true}`，要求下一次发 `full`。
- 增量 `added` 的每个 hostId 由 hub 逐个校验归属（`host.nodeId === node.id` 或 `NULL` 时补写归属），防伪造/串节点。

### 响应

| 情况 | 响应 |
|---|---|
| 正常 | `200 {}` |
| 需要全量 | `200 {"needFull": true}` |
| 请求体超 4 MiB | **`413 PAYLOAD_TOO_LARGE`**（附日志 + 指标，**不再静默**） |
| 非 JSON | `400 BAD_REQUEST` |
| 节点 token 无效 | `401 UNAUTHORIZED` |

> **4 MiB 上限**：全量心跳携带全部 hostId，单节点在线 host 超约 10.7 万即触顶。
> 增量心跳的 payload 与在线 host 数**无关**（O(变化量)），稳态 < 1 KB。

---

## N4 — 单主机登记（`POST /api/nodes/hosts`）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `hostId` | string | ✅ | 主机 id |
| `online` | boolean | ✅ | 上线 / 下线 |

**语义**：幂等；`online=true` 且 host 尚未归属时补写 `node_id`；串节点（`host.nodeId` 为他人）→ `409 CONFLICT`。

---

## N5 — 数据同步（`POST /api/nodes/sync`）

拉取本节点全部主机的归属、用户 `ver`、公钥、draining 迁移票据、欠费拦截集合。

**响应**：

| 字段 | 说明 |
|---|---|
| `hosts[]` | `{ hostId, ownerId, online, userVers, migrateTo? }` |
| `hostCookiePubKey` | host cookie 验签公钥（hex） |
| `draining` | 本节点是否处于退役迁移 |
| `blockedUserIds` | 欠费越下限、需拦截的用户 |

---

## leave — 退役（`POST /api/nodes/leave`）

解除本节点全部 host 的 `node_id` 归属 + 删除节点记录。

---

## assign — 验证分配令牌（`POST /api/nodes/assign`）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `assign` | string | ✅ | hub 签发的 60s 一次性令牌 |

**响应**：`{ hostId }`；令牌伪造/过期/非本节点 → `403 FORBIDDEN`。

---

## 兼容性

- **旧节点（无 `seq`）**：hub 按 `full` 处理，行为与 v1 一致；
- **新节点连旧 hub**：旧 hub 忽略未知字段 `seq/full/added/removed`（不读），仍按 `hosts` 全量处理——**向后兼容**；
- `hosts` 字段**不得移除**（兼容期保留）。

## conformance

`remote-dsh/e2e/fixtures/` 下 `node-heartbeat-*.json`：一次 full + 两次增量 + 一次 gap。
