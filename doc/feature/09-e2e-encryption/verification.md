# 09-e2e-encryption — 验证（verification.md）

> **日期**: 2026-08-29
> **状态**: 主线验证通过（真实环境）
> **依据**: [req.md](req.md) R1–R8 + [plan.md](plan.md)

## 1. 结论

E2EE 数据面加密主线实现完成并在真实环境验证通过：hub 对 `/h/` DSH 流量只中继密文、读不到内容；portal 保持明文；老 host 明文降级兼容。**主线可交付**；唯一剩余项为 G1（host 侧开关，defer → TODO），非阻塞。

## 2. RTTM 复核（req → 实现 → 调用）

| 需求 | 状态 | 实现证据 | 调用 / 备注 |
|---|---|---|---|
| R1 raw stream 协议 | ✅ | `PROTOCOL.md`（`kind:"raw"` + `flags` bit0）+ `tunnel/src/frame.ts` RequestOpen 加 raw | `e2ee-frame-interop.test.ts` 帧字节互操作；Go conformance 非问题（Go 未实现未排期） |
| R2 内层 Noise NK | ✅ | `gateway/src/e2ee.ts`（Node）+ `portal/src/e2ee.ts`（WebCrypto）线级兼容 | `e2ee.test.ts` + `e2ee-interop.test.ts`（Node↔WebCrypto）；密钥每连接轮换 |
| R3 透明拦截（DSH 零改动） | ✅ | hub 注入 `E2EE_SHIM_HTML` 包装 `fetch`/`WebSocket`（无 SW）；DSH 前端零改动 | 真实环境连接正常；SSE 未拦——DSH 用 WS 不用 SSE（discussion §9），属设计偏离非缺口 |
| R4 密钥与 pinning（TOFU） | ✅ | `e2ee-key-store.ts`（host 持久化）+ join 上送 `e2eePublicKey` + portal pin localStorage | 真实环境：re-join 注册指纹、盾牌图标、首次信任 PIN 固定 |
| R5 配置开关 | ⚠️ | hub `e2ee.mode` 三档 ✅；**host `e2ee: true\|false` 开关未实现** | → G1（defer） |
| R6 数据面边界 | ✅ | `/h/` E2EE、`/portal/` 明文 | 生产 `/portal/` 明文（curl 实证）；`/h/` 密文（浏览器实测） |
| R7 返回条 | ✅ | 返回条由 hub 注入明文 HTML 壳（`relay.ts` `BACK_BAR_HTML`） | data-plane-only 下 hub 仍可读 HTML 壳 → 无需迁移到 gateway，R7 前提不成立 |
| R8 兼容性 | ✅ | 老 gateway 注册无 `e2eePublicKey` → NULL → 明文；新 gateway + 老 hub 忽略字段 → 明文 | 真实环境：老 host + 新 hub 明文工作 ✅ |

## 3. 差距清单

### G1 — host 侧 `e2ee: true|false` 开关未实现（R5）
- **严重度**: 中（req 明确列出 + 交互矩阵引用）
- **处置**: **defer**（用户决定，见 [TODO.md](TODO.md)）
- **现象**: gateway 无条件生成密钥对、无条件处理 raw 流；host 无法主动关闭 E2EE
- **影响**: hub `optional` 模式下新 host 恒 E2EE（浏览器已信任时）；host 无法为调试/合规关闭
- **建议**: hub `e2ee.mode` 已是全局控制点，host 级开关为边际价值；defer 到需要时再补（`host.json` 加 `e2ee: false` → join 不上送指纹、raw OPEN 拒绝）

## 4. 生产前 watch-list（不阻塞交付）

- **Noise 直实现交叉审计**: 无第三方库、自行实现（solution §7 watch-list）；Node↔WebCrypto 互操作测试已过，生产前建议对照 Noise 规范 / 成熟实现核对
- **指纹变更告警（TOFU）**: 代码已实现并被调用；真实环境未实测「换钥 → 告警」流程
- **`e2ee.mode` off/required 两档**: 未实测（不改生产配置）；`optional` 档已实测通过
