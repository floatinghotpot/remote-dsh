import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/server.ts";

/** mock 上游（模拟 dsh web）。 */
/** 强制关闭 http server（含 keep-alive/undici 连接）。 */
function closeServer(server: ReturnType<typeof createServer>): void {
  server.closeAllConnections?.();
  server.close();
}

async function startUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("dsh-ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

async function startTestGateway(pairCode: string, sessionTtlSeconds = 3600) {
  const upstream = await startUpstream();
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-gw-"));
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    pairCode,
    sessionTtlSeconds,
    dshPort: upstream.port,
    keyDir,
  });
  const base = `http://127.0.0.1:${gw.actualPort}`;
  return { gw, upstream, base, keyDir };
}

test("GET /pair 返回配对页 HTML", async () => {
  const t = await startTestGateway("123456");
  try {
    const res = await fetch(`${t.base}/pair`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("配对码"));
    assert.ok(html.includes("<form"));
  } finally {
    closeServer(t.gw.server); closeServer(t.upstream.server);
    
  }
});

test("无会话访问任意路径 → 307 /pair（不触达 dsh）", async () => {
  const t = await startTestGateway("123456");
  try {
    const res = await fetch(`${t.base}/api/sessions`, { redirect: "manual" });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), "/pair");
  } finally {
    closeServer(t.gw.server); closeServer(t.upstream.server);
    
  }
});

test("错误配对码 → 401；正确配对码 → 302 + Set-Cookie", async () => {
  const t = await startTestGateway("123456");
  try {
    const bad = await fetch(`${t.base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
      redirect: "manual",
    });
    assert.equal(bad.status, 401);

    const ok = await fetch(`${t.base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
      redirect: "manual",
    });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/");
    const cookie = ok.headers.get("set-cookie");
    assert.ok(cookie, "应设置会话 Cookie");
    assert.ok(cookie!.includes("HttpOnly"));
    assert.ok(cookie!.includes("SameSite=Lax"));
  } finally {
    closeServer(t.gw.server); closeServer(t.upstream.server);
    
  }
});

test("带有效 Cookie 访问 → 转发到 dsh；Cookie 无效 → 307", async () => {
  const t = await startTestGateway("123456");
  try {
    // 先配对拿 Cookie
    const pair = await fetch(`${t.base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
      redirect: "manual",
    });
    const cookie = pair.headers.get("set-cookie")!.split(";")[0]!;

    const ok = await fetch(`${t.base}/api/whatever`, { headers: { cookie } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "dsh-ok");

    const invalid = await fetch(`${t.base}/api/whatever`, {
      headers: { cookie: "rdsh_session=broken.token" },
      redirect: "manual",
    });
    assert.equal(invalid.status, 307);
  } finally {
    closeServer(t.gw.server); closeServer(t.upstream.server);
    
  }
});

test("连续 5 次错误码 → 429 锁定（即使后续码正确）", async () => {
  const t = await startTestGateway("123456");
  try {
    for (let i = 0; i < 5; i++) {
      await fetch(`${t.base}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      });
    }
    const locked = await fetch(`${t.base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    assert.equal(locked.status, 429);
    const retryAfter = Number(locked.headers.get("retry-after"));
    assert.ok(retryAfter >= 1);
  } finally {
    closeServer(t.gw.server); closeServer(t.upstream.server);
    
  }
});

test("noCode=true 时无会话直接转发（跳过配对）", async () => {
  const upstream = await startUpstream();
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-gw-nocode-"));
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    pairCode: "123456",
    sessionTtlSeconds: 3600,
    dshPort: upstream.port,
    keyDir,
    noCode: true,
  });
  const base = `http://127.0.0.1:${gw.actualPort}`;
  try {
    // 无 Cookie 直接转发（不 307）
    const res = await fetch(`${base}/api/session.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "dsh-ok");
    // WS upgrade 也应放行
    const { WebSocket } = await import("ws");
    const opened = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.actualPort}/api/events.mux`);
      const t = setTimeout(() => reject(new Error("timeout")), 3000);
      ws.on("open", () => { clearTimeout(t); resolve(true); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
    assert.equal(opened, true);
  } finally {
    closeServer(gw.server);
    closeServer(upstream.server);
  }
});

test("reset=true 时旧会话全部失效", async () => {
  const upstream = await startUpstream();
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-gw-reset-"));
  const gw1 = await startGateway({
    host: "127.0.0.1",
    port: 0,
    pairCode: "123456",
    sessionTtlSeconds: 3600,
    dshPort: upstream.port,
    keyDir,
  });
  const base1 = `http://127.0.0.1:${gw1.actualPort}`;
  const pair = await fetch(`${base1}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
    redirect: "manual",
  });
  const cookie = pair.headers.get("set-cookie")!.split(";")[0]!;
  // 同一密钥目录下重启（reset）→ 旧 cookie 失效
  const gw2 = await startGateway({
    host: "127.0.0.1",
    port: 0,
    pairCode: "123456",
    sessionTtlSeconds: 3600,
    dshPort: upstream.port,
    reset: true,
    keyDir,
  });
  const base2 = `http://127.0.0.1:${gw2.actualPort}`;
  const after = await fetch(`${base2}/api/x`, { headers: { cookie }, redirect: "manual" });
  assert.equal(after.status, 307);
  closeServer(gw1.server);
  closeServer(gw2.server);
  closeServer(upstream.server);
});
