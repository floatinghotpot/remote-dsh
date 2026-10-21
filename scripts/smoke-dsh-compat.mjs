#!/usr/bin/env node
/**
 * smoke-dsh-compat.mjs — dsh 版本兼容真机冒烟（无 API key，纯 Node）。
 *
 * 用法：node scripts/smoke-dsh-compat.mjs [--dsh <path>]
 * 输出每个断言 S1–S7 的通过/失败；任一失败退出码非 0。
 * 覆盖 remote-dsh × dsh 的传输契约面（非 dsh 业务功能），断言清单见
 * doc/fix/20260907-dsh-0.1.2-rc1-auth/discussion.md §6。
 *
 * 依赖：gateway 已 build（dist/）；ws 升级用 node:http 手动握手（零第三方依赖）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  spawnDsh,
  findDsh,
  exchangeDshSessionCookie,
  detectDshVersion,
  patchLoopbackJs,
} from "../packages/gateway/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 参数解析 ----
let dshPath = process.argv.includes("--dsh") ? process.argv[process.argv.indexOf("--dsh") + 1] : undefined;
dshPath = dshPath ?? findDsh();
if (dshPath === null || dshPath === undefined) {
  console.error("SMOKE FAIL: cannot find dsh in PATH");
  process.exit(1);
}

const failures = [];
const check = (id, cond, detail) => {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(id);
};

/** 手动发 HTTP upgrade 请求；upgrade 事件 = 101，response 事件 = 被拒（如 401）。 */
function wsUpgradeStatus(port, path, cookieHeader) {
  return new Promise((resolveStatus) => {
    const headers = {
      host: `127.0.0.1:${port}`,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    };
    if (cookieHeader) headers.cookie = cookieHeader;
    const req = httpRequest({ host: "127.0.0.1", port, path, headers });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolveStatus(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolveStatus(res.statusCode);
    });
    req.on("error", () => resolveStatus(0));
    req.end();
  });
}

async function fetchStatus(port, path, cookieHeader, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  const version = await detectDshVersion(dshPath);
  console.log(`dsh version: ${version ?? "(unknown)"}`);
  console.log(`dsh path: ${dshPath}`);

  // S1 spawn + S2 就绪行解析
  let dsh;
  try {
    dsh = await spawnDsh(dshPath);
    check("S1", true, "spawn dsh web --port 0 --no-open");
    check("S2", true, `port=${dsh.port} token=${dsh.authToken === undefined ? "absent(0.1.1)" : "present(0.1.2+)"}`);
  } catch (e) {
    check("S1", false, e.message);
    process.exit(1);
  }

  // S3 认证：有 token → 换发 + 带 cookie GET / 200；无 token → 直接 GET / 200
  let cookie = null;
  if (dsh.authToken !== undefined) {
    cookie = await exchangeDshSessionCookie(dsh.port, dsh.authToken);
    check("S3a", cookie !== null, "exchange cookie");
  }
  const rootRes = await fetchStatus(dsh.port, "/", cookie);
  check("S3", rootRes.status === 200, `GET / => ${rootRes.status}`);
  check("S3-401-free", !rootRes.text.includes("authentication required"), "no 401 body");

  // S4 /api 门：带 cookie 应过认证（404/400/200 均可，唯独不是 401）
  const api = await fetchStatus(dsh.port, "/api/workspace.list", cookie, "POST");
  check("S4", api.status !== 401, `POST /api/workspace.list => ${api.status}`);

  // S5 WS upgrade：带 cookie 应 101；无 cookie 应非 101（对照组证明认证生效）。
  // 端点按版本行为探测：0.1.2+ 用 /api/remote.mux，0.1.1 用 /api/events.mux
  const wsPath = dsh.authToken !== undefined ? "/api/remote.mux" : "/api/events.mux";
  const wsOk = await wsUpgradeStatus(dsh.port, wsPath, cookie);
  check("S5", wsOk === 101, `WS upgrade ${wsPath} (cookie) => ${wsOk}`);
  if (dsh.authToken !== undefined) {
    const wsNoCookie = await wsUpgradeStatus(dsh.port, wsPath, null);
    check("S5-ctrl", wsNoCookie !== 101, `WS upgrade ${wsPath} (no cookie) => ${wsNoCookie}（应非 101）`);
  }

  // S6 静态资源可达（index 引用的 manifest）
  const manifest = await fetchStatus(dsh.port, "/manifest.webmanifest", cookie);
  check("S6", manifest.status === 200, `GET /manifest.webmanifest => ${manifest.status}`);

  // S7 patch 目标命中：对 dsh 安装树的 client-connection client.js 执行 patchLoopbackJs
  try {
    const clientJs = locateClientJs(dshPath);
    const body = await readFile(clientJs);
    const patched = patchLoopbackJs(body);
    check("S7", patched !== null, `patchLoopbackJs(${clientJs}) 命中`);
  } catch (e) {
    console.log(`SKIP S7 — 无法定位 dsh client-connection client.js（${e.message}）；由单测 loopback-compat.test.ts 兜底`);
  }

  await dsh.stop();
  if (failures.length > 0) {
    console.error(`SMOKE FAIL: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("SMOKE PASS");
}

/** 定位 dsh 安装树里的 client-connection/lib/client.js（支持 npm 全局 + pnpm 布局）。 */
function locateClientJs(dshPath) {
  const binDir = dirname(dshPath);

  // 1) npm 全局布局精确路径：/usr/local/bin/dsh -> ../lib/node_modules/@deepseek-ai/dsh/...
  const npmClient = join(
    binDir, "..", "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules",
    "@deepseek-ai", "dsh-client-connection", "lib", "client.js",
  );
  if (existsSync(npmClient)) return npmClient;

  // 2) pnpm 布局：从 node_modules 根 find（<root>/node_modules/.bin/dsh -> .. = <root>/node_modules）
  const candidates = [join(binDir, ".."), join(binDir, "..", "node_modules")];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    const find = spawnSync("find", [root, "-path", "*dsh-client-connection/lib/client.js"], { encoding: "utf8" });
    const first = find.status === 0 ? (find.stdout ?? "").trim().split("\n")[0] : "";
    if (first !== "") return first;
  }

  throw new Error("not found under npm global or pnpm layout");
}

main().catch((e) => {
  console.error("SMOKE FAIL:", e.message);
  process.exit(1);
});
