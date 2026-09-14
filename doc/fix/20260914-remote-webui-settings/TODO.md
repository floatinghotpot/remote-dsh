# TODO：远程 Web UI 的设置与 API key（未完成项）

> 机械提取自 [verification.md](verification.md) §5。AC1–AC4 已达成，剩余为**发布部署**与范围外事项。

## 发布与部署（必做，否则线上不变）

- [ ] `rdsh-hub` 新版本（因素① shim 门面）+ 部署到线上 hub
- [ ] `rdsh-gateway` + `remote-dsh` 新版本（因素②③：编码感知补丁 / LAN 补丁 / 缓存头）
- [ ] 发布后复核：远程设置页可用、API key 可保存；`[patch] miss` 日志不应出现在真实 JS bundle 上

## 文档（可选加强）

- [ ] LAN 博客（`doc/blog/zh/01-01-lan-access.md`）补一句"LAN 会话视同 loopback"的信任声明与开关

## 范围外（另行立项）

- [ ] **fetch 包装的流式/二进制放行**：`dsh-client-file-upload`、`dsh-client-ui-sidebar-documentpreview` 使用 `getReader()`/`response.body`，E2EE 下预计仍会坏
- [ ] 给 `join-loopback-patch.test.ts` 增加 **conditional request**（`If-None-Match`）用例，覆盖"补丁后的缓存语义"
