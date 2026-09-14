/**
 * 无 host 上下文时 `GET /manifest.webmanifest` 必须返回**合法 manifest**，不能回 portal HTML。
 *
 * 2026-09-14 实测：浏览器取 manifest 不带 cookie（规范 credentials omit）⇒ hub 判不出 host ⇒
 * 落到 portal 兜底返回 HTML ⇒ Chrome 报 `Manifest: Line 1, column 1, Syntax error`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";

test("无 host cookie 取 manifest：返回合法 JSON manifest（不得回 portal HTML）", async () => {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.actualPort}/manifest.webmanifest`, {
      headers: { accept: "*/*", connection: "close" }, // 浏览器取 manifest 不带 cookie
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/manifest\+json/);
    const body = (await res.json()) as { name?: string; start_url?: string };
    assert.equal(typeof body.name, "string", "manifest 必须能被 JSON.parse（HTML 会在这里失败）");
    assert.equal(body.start_url, "/");
  } finally {
    server.server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    db.close();
  }
});

test("导航请求仍回落 portal SPA（不因 manifest 分支而破坏深链）", async () => {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
  });
  try {
    // portalDir 不存在 ⇒ servePortal 未处理 ⇒ 404 JSON；关键是**不是** manifest 分支的 200
    const res = await fetch(`http://127.0.0.1:${server.actualPort}/login`, {
      headers: { accept: "text/html,application/xhtml+xml", connection: "close" },
    });
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    server.server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    db.close();
  }
});
