# 验证：远程 Web UI 设置 / API key（verification）

> **日期**: 2026-09-14 ｜ **对应**: [solution.md](solution.md) ｜ **状态**: **✅ 三个因素全部修复；AC1/AC2 已由用户在浏览器实测通过**

---

## 1. AC 对照（全部达成）

| AC | 状态 | 证据 |
|---|---|---|
| **AC1 远程设置页可打开** | ✅ **浏览器实测通过**（2026-09-14，用户确认） | 本地 hub（`http://e2e.localhost:8799`，**非 loopback** + 安全上下文）+ 隔离 HOME 的 host；硬刷新后设置 → Models 正常 |
| **AC2 能输入并保存 API key** | ✅ **浏览器实测通过** | 同上（provider 目录加载、key 可输入保存） |
| **AC3 LAN 可打开设置并输入 key** | ✅ 集成级（默认 on） | `proxy-js-patch.test.ts`：on → identity/gzip/br 均被替换；off → 原样透传 |
| **AC4 E2EE 语义不变、不改 DSH 源码** | ✅ | 仅改浏览器侧门面 + 网关补丁/编码；协议/握手/派生/Aead 零改动 |

## 2. 改动与验证清单

| 因素 | 改动 | 验证 |
|---|---|---|
| ① hub | `packages/hub/src/e2ee-shim.ts`（门面补全 +64/−8） | `e2ee-shim-ws.test.ts` 3 例（含真实 X25519+HKDF+AES-GCM 往返）+ **反证**（回退旧版 ⇒ `TypeError: ws.addEventListener is not a function`） |
| ② host | `join.ts`：**编码感知补丁**（解压 → patch → 按原编码重压）、**OPEN 帧后移到补丁之后**（`content-length` 才准）、**缓存头改为 `max-age=300`**、**未命中留痕日志** | `join-loopback-patch.test.ts`：identity/gzip/deflate/br 全部命中且 `content-length` 正确；未知编码（zstd）**字节级原样透传**；非 JS 不动 |
| ③ LAN | `proxy.ts`（`jsPatch` + 同样的编码感知）、`server.ts`（两个 LAN 分支接线 + ctx 开关）、`serve.ts`（透传配置）、`config.ts`（`trustPairedAsLoopback`，默认 true） | `proxy-js-patch.test.ts` 2 例（含 gzip/br；严格模式原样透传） |
| 文档 | `doc/overview/usage.md` §8.5：两个 loopback 开关 + 修正 `EnvironmentFile` 误导说法（API key 不要放环境） | — |

## 3. 关键证据（这次事故的两个"隐形杀手"）

1. **gzip 导致补丁静默失效**：同一真实 combo URL（11 MB，含 `dsh-client-connection`）——
   - 修复前：`accept-encoding: gzip` → **含原始判定（未补丁 ✗）**；`identity` → 已补丁 ✓
   - 修复后：**两者都"已补丁 ✓"**（插桩：`hit … 4334275B → 3916783B, gzip`，即解压 11 MB → 补丁 → 重压 3.9 MB）
2. **缓存头把"旧的未补丁 bundle"钉死**：上游响应为 `cache-control: public, max-age=31536000, immutable`，而 `rev=` URL 由**上游内容**决定 ⇒ 补丁更新后浏览器仍用旧体（这正是"代码修好但用户端不生效"的原因）；修复后补丁命中时改为 `public, max-age=300`（实测确认）。

## 4. 质量门

`pnpm build` exit 0（0 TS error）；`pnpm test` 全绿：**gateway 116 / hub 99 / tunnel 12 / web-remote 16 / agent-mesh 1**，0 fail。

## 5. 尚未完成（见 [TODO.md](TODO.md)）

1. **发布与部署**：`rdsh-hub`（因素①）+ `rdsh-gateway`/`remote-dsh`（因素②③）；生产 hub 不部署则线上不变。
2. **范围外（登记）**：`fetch` 包装的流式/二进制放行（`getReader()`/`response.body` 使用方在 E2EE 下预计仍会坏）。
