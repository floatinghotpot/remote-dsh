# 09-e2e-encryption — TODO

> 自动提取自 [plan.md](plan.md) 的 `⏭️` / `❌` 项。
> 非空 = 特性未完全收口。人工审阅后决定：关闭 / 延期 / 放弃。

| # | 项 | 来源 | 严重度 | 处置 |
|---|---|---|---|---|
| G1 | host 侧 `e2ee: true\|false` 开关未实现（R5） | plan T2 / verification G1 | 中 | **defer**（hub `e2ee.mode` 已全局控制；host 开关为边际价值，需要时再补 `host.json` `e2ee: false`） |
