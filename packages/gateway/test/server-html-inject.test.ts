import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/server.ts";
import { UserManager } from "../src/auth.ts";

/**
 * 回归测试（feature 22）：lan/cloud 网关的**两个** forwardHttp 调用点都必须注入
 * `window.__rdshWebViewApi`（polyfill + 契约）。此前会话分支漏加适配器，只有
 * authMode=none 分支有——本测试把两类分支都钉住。
 */

const HTML = `<!doctype html><html><head><title>dsh</title></head><body><div id="root"></div></body></html>`;

async function startHtmlUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

function closeServer(server: Server): void {
  server.closeAllConnections?.();
  server.close();
}

test("lan 网关：authMode=none 与 password(登录后) 两分支都注入 __rdshWebViewApi", async () => {
  const upstream = await startHtmlUpstream();
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-html-inject-gw-"));

  // 分支 1：authMode=none（noCode）
  const gwNone = await startGateway({
    host: "127.0.0.1",
    port: 0,
    sessionTtlSeconds: 3600,
    dshPort: upstream.port,
    keyDir: join(keyDir, "none"),
    noCode: true,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${gwNone.actualPort}/`);
    const html = await res.text();
    assert.ok(html.includes("window.__rdshWebViewApi"), "authMode=none 分支应注入契约");
    assert.ok(html.includes("crypto.randomUUID"), "polyfill 也应一并注入");
  } finally {
    gwNone.dispose();
    closeServer(gwNone.server);
  }

  // 分支 2：password + 登录会话
  const dir = await mkdtemp(join(tmpdir(), "rdsh-html-inject-pw-"));
  const cfg = join(dir, "config.json");
  await writeFile(cfg, JSON.stringify({ auth: { mode: "password", version: 1, users: [] } }));
  const um = new UserManager(cfg);
  await um.add("admin", "pw123");
  const gwPw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    sessionTtlSeconds: 3600,
    dshPort: upstream.port,
    keyDir: join(keyDir, "pw"),
    authMode: "password",
    authVersion: 1,
    userManager: um,
    behindProxy: true,
    configPath: cfg,
  });
  try {
    const loginRes = await fetch(`http://127.0.0.1:${gwPw.actualPort}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "admin", password: "pw123" }),
      redirect: "manual",
    });
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "登录应返回会话 cookie");
    const res = await fetch(`http://127.0.0.1:${gwPw.actualPort}/`, { headers: { cookie } });
    const html = await res.text();
    assert.ok(html.includes("window.__rdshWebViewApi"), "password 登录后的会话分支应注入契约");
  } finally {
    gwPw.dispose();
    closeServer(gwPw.server);
    closeServer(upstream.server);
  }
});
