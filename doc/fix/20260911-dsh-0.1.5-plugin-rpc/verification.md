# dsh 0.1.5-rc.2：dsh-web-remote 插件树加载失败（verification）

> **日期**: 2026-09-11
> **对象**: `dsh-web-remote@0.5.1`（工作区构建产物）
> **结论**: **通过** —— 0.1.5-rc.2 与 0.1.2-rc.1 双版本实测正常启动且 RPC 可用；构建零 issue；协议单测 16/16

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| dsh 0.1.5-rc.2 | 全局 `/usr/local/lib/node_modules/@deepseek-ai/dsh`（npm `next` 通道） |
| dsh 0.1.2-rc.1 | 本地隔离安装 `/tmp/dsh-012`（`npm install @deepseek-ai/dsh@0.1.2-rc.1`） |
| 隔离 HOME | `DSH_HOME=/tmp/dsh-compat`（0.1.5）/ `/tmp/dsh-012-home`（0.1.2）——不触碰真实 `~/.dsh` |
| 被测产物 | `packages/web-remote/dist/`（`index.js` + `rpc-route.js`）覆盖到 profile 的 `node_modules/dsh-web-remote/dist/` |

## 2. 静态验证

| # | 项 | 结果 |
|---|---|---|
| V1 | `pnpm build`（tsc strict，全 workspace） | ✅ 零 error / 零 info |
| V2 | `pnpm test` | ✅ gateway 109 / hub 91 / **web-remote 16** / cli 0 —— 全 0 fail |
| V3 | `packages/web-remote/client.js` 未改动 | ✅ `git diff --name-only` 无该文件 |
| V4 | 协议逻辑单测（`test/rpc-route.test.ts`，`node:test`） | ✅ 16/16：围栏 401/403、404、415（含 charset）、413、400（非 JSON）、envelope 非法 → 200 `gateway/bad-request`、`method` 与 path 不一致、500 handler 抛错、200 正常/业务错误/envelope 回显/多段 endpoint |

改动面：`packages/web-remote/src/index.ts`、新增 `packages/web-remote/src/rpc-route.ts`、新增 `packages/web-remote/test/rpc-route.test.ts`、`packages/web-remote/package.json`（版本 + test 脚本）、`doc/**`。

## 3. dsh 0.1.5-rc.2 端到端

前置：`dsh plugin --profile compat add dsh-web-remote@0.5.0`（取依赖）→ 用本次构建覆盖 `dist/`。

| # | 用例 | 命令要点 | 实测结果 |
|---|---|---|---|
| V5 | `dsh web` 能启动 | `dsh --profile compat --no-open --port 0` | ✅ `dsh web: http://127.0.0.1:54022/?token=…`，日志无 `plugin tree failed` |
| V6 | 未认证调用被拒 | 直接 POST `/remote-access/state`（无 cookie） | ✅ HTTP 401 |
| V7 | 认证后业务调用 | 先用 `?token=` 换 cookie（index → 303 + `dsh-auth` cookie），再 POST | ✅ `{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"status":"connected","hub":"https://rdsh.cn","name":"iMacPro",…}}}` HTTP 200 |
| V8 | 非法 envelope | body `{"nope":1}` | ✅ HTTP 200 + `{rpcId:"invalid-request", result:{ok:false, error:{code:"gateway/bad-request", message:"invalid client-request message"}}}`（与官方桥一致） |
| V9 | `method` 与 path 不一致 | method `connect` 打到 `/remote-access/state` | ✅ HTTP 200 + `message:"method \"connect\" does not match endpoint \"state\""` |
| V10 | 错误 content-type | `content-type: text/plain` | ✅ HTTP 415 |
| V11 | 无 endpoint 的路径 | POST `/remote-access` | ✅ HTTP 404 |
| V12 | 超限请求体 | `content-length: 70000`（上限 64 KiB） | ✅ HTTP 413 |

## 4. dsh 0.1.2-rc.1 交叉版本端到端

前置：`DSH_HOME=/tmp/dsh-012-home /tmp/dsh-012/node_modules/.bin/dsh plugin --profile web add dsh-web-remote@0.5.0` → 覆盖同一份构建产物。

| # | 用例 | 实测结果 |
|---|---|---|
| V13 | `dsh web` 能启动 | ✅ `dsh web: http://127.0.0.1:53539/?token=…`（无 pending / 无 `plugin tree failed`） |
| V14 | 未认证调用 | ✅ HTTP 401 |
| V15 | 认证后 `state` | ✅ HTTP 200 + `{"result":{"ok":true,"value":{"status":"connecting","hub":"https://rdsh.cn","name":"iMacPro",…}}}` |

> 说明：第一次 0.1.2 测试失败是**测试脚手架的错**——`--from-default-profile web` 在建自定义 profile 时未生效，导致 profile 只有 `dsh-base`（无 web-app ⇒ 无 `webServer`/`connection` 服务，插件停在 `pending`）。改用 shipped `web` profile 后通过。此为验证过程记录，非产品缺陷。

## 5. 安全围栏

| # | 项 | 结果 |
|---|---|---|
| V16 | 复用官方 `connection.requestRejection`（Host/Origin fence + 浏览器会话） | ✅ 未认证 401（V6/V14） |
| V17 | 原先失效的 `{ authority: "loopback" }` 第三参已删除；未因此放宽任何检查 | ✅ 围栏来源与 DSH 自有路由完全一致 |
| V18 | 请求体上限（64 KiB）与 413 行为 | ✅ 代码路径同官方 `/api` 桥（`content-length` 预检 + 累计上限 + 连接关闭） |

## 6. 插件浏览器半 + 真实 profile 验证（2026-09-11 追加）

前置：`pnpm pack`（自动把 `rdsh-gateway: workspace:*` 转为 `0.8.1`）→ `dsh plugin --profile web add /tmp/dsh-web-remote-0.5.1.tgz` 装入**真实 `~/.dsh/profiles/web`**，另起独立端口实例验证（不重启用户当前会话）。

| # | 用例 | 实测证据 | 结果 |
|---|---|---|---|
| P1 | 装入真实 profile | `bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-web-remote]` | ✅ |
| P2 | 宿主半启动 | 日志无 `plugin tree failed` | ✅ |
| P3 | 宿主半 RPC + 自动接入 | `POST /remote-access/state` → `{ok:true, value:{status:"connected", hub:"https://rdsh.cn", name:"iMacPro", …}}` | ✅ |
| P4 | 浏览器半注册进 boot 图 | 首页含 `{"id":"dsh-web-remote","url":"/plugins/??dsh-web-remote/client.js&rev=…","inject":[…]}` | ✅ |
| P5 | 浏览器半 bundle 下发 | `GET /plugins/??dsh-web-remote/client.js&rev=…` → **200 / 19,273 B**，含 `__ModuleLoader__.load`、`settings.remote-access`、`远程访问` | ✅ |
| P6 | 客户端服务依赖 | 面板 inject 的 `connection` / `slots` / `locale` 在 0.1.5 均存在（`slots` 由 `dsh-client-ui-renderer` 提供，同 0.1.2） | ✅ |
| P7 | `dsh.client.inject` 中的 `@deepseek-ai/dsh-client-runtime` / `dsh-client-ui-slots` | 两包在 **0.1.2 也不存在**；客户端加载器对未知注入名「查不到即跳过」（0.1.2 与 0.1.5 该段逻辑逐字节相同）⇒ 仅排序提示，非破坏点，无需改 | ✅ |
| P8 | 用户人工确认（UI） | 设置页出现「远程访问」项并可用；**经 hub 从远端成功访问本机 DSH** | ✅ |

> 结论：插件**宿主半 + 浏览器半**在 dsh `0.1.5-rc.2` 上均验证通过。安装方式为本地 tarball（0.5.1 未发布 npm）：profile 依赖记为 `file:/tmp/dsh-web-remote-0.5.1.tgz`，发布后建议改用 `dsh plugin --profile web add dsh-web-remote@0.5.1`。

## 7. 网关链路验证（2026-09-11 追加）

用户追加要求：`rdsh host` 会 spawn dsh 并与其通信，需同步核验 0.1.5 是否破坏该链路。

| # | 用例（真实 `dsh@0.1.5-rc.2` + 隔离配置 `--config`，`mode=lan`） | 结果 |
|---|---|---|
| G1 | spawn `dsh web --port 0 --no-open` + 就绪行解析 | ✅ `rdsh serve: dsh web on 127.0.0.1:54478` |
| G2 | 0.1.2+ launch token 解析 + cookie 换发 | ✅ 无「会话 cookie 换发失败」警告 |
| G3/G4 | Host/Origin 重写 + `/api` 转发 | ✅ `settings/describe` → 200 真实数据；`session/list` → 200 + DSH 业务错误 |
| G5 | HTML 注入（polyfill + gzip 剥离） | ✅ 200 text/html，注入命中 |
| G6 | WS `/api/remote.mux` 升级桥接 | ✅ OPEN（101） |
| G7 | join 侧 `patchLoopbackJs` 命中真实 0.1.5 bundle | ✅ 命中 1 处，patch 后残留 0 |
| G8 | 扩展 `DSH_COMPAT_MAX` 到 `0.1.5-rc.2` 后重跑 G2/G4/G5/G6 | ✅ 全部通过，版本警告消失 |

完整证据与 WS 路径说明见 [doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md](../../review/20260911-dsh-0.1.5-rc.2-plugin-compat.md) §5。

| # | 用例（真实 `dsh@0.1.5-rc.2` + join 模式 → 生产 hub） | 结果 |
|---|---|---|
| G9 | 完整隧道端到端：`rdsh host serve`（join，hub `https://rdsh.cn`，主机 `iMacPro`）→ **用户从远端设备经 hub 访问本机 DSH** | ✅ 成功（人工实测，2026-09-11）；日志无版本警告、无 cookie 换发失败；测后已停止，`join.lock` 释放 |

## 8. 遗留与影响记录

| 项 | 说明 |
|---|---|
| 测试副作用 | 插件按设计在启动时 `autoConnect`，实测期间曾用真实 `~/.rdsh/host.json` 接入 `rdsh.cn` hub；测试进程已终止，`~/.rdsh/join.lock` 为 stale（pid 已死，`gateway/src/lock.ts` 自愈，无需手工清理） |
| 未覆盖 | 无（网关与 hub 隧道链路均已完成实测：G1–G9） |
| 未发布 | 0.5.1 未发布 npm（用户确认范围） |
