# 70 V1 压测 harness

对应 70 容量需求 V1 与 66 讨论 §7（V1–V8）。

**目的**：把 66 discussion 里的「推算」换成「实测」——产出每一项的**上限**与**拐点**，
回填单机容量表，作为「是否启动 71（多实例）」的输入（D1）。

## 运行前提

- Node ≥ 22（原生 `fetch` / `WebSocket`，零第三方依赖）
- 被测 hub 已启动（`bench-http` / `bench-ws` 需要 base URL）
- `bench-cache` / `bench-n2` 为纯本地（不需要 hub）

## V1–V8 对照

| # | 测什么 | 脚本 / 方法 | 产出 |
|---|---|---|---|
| V1 | 单连接开销（空闲长连接 RSS/CPU） | `bench-ws.mjs`（`/api/events` 或 `/tunnel`） | 每连接 KB、每连接 CPU% |
| V2 | `/api/events` 订阅上限 | `bench-ws.mjs --path /api/events` | N 连接时 RSS/CPU 曲线、拐点 |
| V3 | 用户缓存刷新成本 | `bench-cache.mjs`（本地 DB 播种 N 用户） | `listUsersSince` 耗时 vs N |
| V4 | 关键端点 QPS 天花板 | `bench-http.mjs`（`/api/hosts` 等） | QPS / P50 / P99 vs 并发 |
| V5 | 重连风暴 | `bench-ws.mjs --churn`（周期断开重连） | 重连成功率、CPU 尖峰 |
| V6 | 用量写入放大 | `packages/hub/test/` 既有 usage 用例 + 生产 `usage` 指标 | flush 行数/耗时 |
| V7 | N2 心跳 10 万 host | `bench-n2.mjs`（payload 体积） | 全量 vs 增量 payload 字节 |
| V8 | relay 单节点连接上限 | 在 relay 机器上跑 `bench-ws.mjs`（对 relay 域名） | 连接上限、RSS |

## 决策口径

- **上限**：达到某个阈值（如 CPU 80%、RSS 80%）时的 N；
- **拐点**：耗时/CPU 从线性转为超线性的那个 N（容量规划取拐点的 70% 作为安全水位）；
- 每项跑 3 次取中位数，记录环境（Node 版本、机器规格、是否 loopback）。

## 示例

```bash
# V4：对本地 hub 打 /api/hosts（需登录态 token，见 --token）
node bench-http.mjs --url http://127.0.0.1:8443 --path /api/hosts --token "$TOKEN" --concurrency 50 --duration 30

# V2：20000 条 /api/events 长连接
node bench-ws.mjs --url ws://127.0.0.1:8443 --path /api/events --cookie "rdsh_session=$SESSION" --count 20000

# V3：本地播种 10 万用户并测增量刷新
cd ../../packages/hub && node ../../e2e/loadtest/bench-cache.mjs --users 100000

# V7：算出 10 万 host 的全量/增量 payload 体积
node bench-n2.mjs --hosts 100000
```

> 说明：`bench-cache` 使用 `packages/hub/src/db.ts`（SQLite），需在 `packages/hub` 目录下运行。
