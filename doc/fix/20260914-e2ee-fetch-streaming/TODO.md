# TODO：E2EE 大文件上传（未完成项）

> 机械提取自 [verification.md](./verification.md) §1/§4。已达成：AC1（传输层）/AC6/AC7/AC8/AC9/AC10。

## 待做（本记录剩余）

- [ ] **AC2 响应二进制保真**：`response` 不再一律 `TextDecoder`（预览走 `getReader()`/`response.body` ⇒ 二进制会变形）——`packages/hub/src/e2ee-shim.ts` fetch 包装
- [ ] **AC3 流式响应**：首块在 CLOSE 之前可见（当前到 CLOSE 才 resolve）；`ReadableStream` 返回
- [ ] **AC4 请求体类型**：Blob / FormData / ReadableStream；不支持的类型**明确报错**（不得静默发错）
- [ ] 扩展 F7 沙箱：二进制字节一致、首块早于 CLOSE、Blob/FormData 体、不支持类型报错
- [ ] 用户端 18 MiB 文件**端到端**复测（`/tmp/big18.png`，17,895,423 B）

## 需产品决策（超出本记录范围）

- [ ] **F13：后台上传走 Blob Worker**（原生 XHR/fetch）⇒ **不经 E2EE，明文到 hub**。选项：① 接受（登记为已知限制）；② 改 DSH 侧让上传走页面 fetch；③ shim 同时包 Worker 构造（`Worker` 目前未被包装）——需评估
- [ ] **F14**：上传路径 502 文案 `UPSTREAM_UNREACHABLE: dsh not reachable` 掩盖真实 401/400（`packages/gateway/src/join.ts:591` 把"上游提前中断"当不可达）⇒ 定位并给出真实错误码
- [ ] **AC5**：dev/HMR 的 `EventSource` 通道不走 E2EE（低危，登记）

## 发布

- [ ] `rdsh-hub` 新版本（shim 分片/自愈 + 中继护栏）：**不发版则线上仍然既传不了大文件、又会被大帧打死**
- [ ] 发布后复核：>16 MiB 上传成功、通道失效有明确报错、hub 不被单帧打死
