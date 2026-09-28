import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/server.ts";

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

/** 以 accessCode 门禁启动测试网关。 */
async function startGateGateway(accessCode: string) {
  const upstream = await startUpstream();
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-gw-"));
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    sessionTtlSeconds: 3600,
    dshPort: upstream.port,
    keyDir,
    accessCode,
  });
  const base = `http://127.0.0.1:${gw.actualPort}`;
  return { gw, upstream, base, keyDir };
}

/** 提交 accessCode 门禁口令（form-urlencoded，与 challenge 页一致）。 */
function postGate(base: string, code: string) {
  return fetch(`${base}/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": "zh" },
    body: `gate_code=${encodeURIComponent(code)}`,
    redirect: "manual",
  });
}

test("accessCode 门禁：无 cookie 访问 → challenge 页（不触达 dsh）", async () => {
  const t = await startGateGateway("abcd1234");
  try {
    const res = await fetch(`${t.base}/`, { headers: { "accept-language": "zh" } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("访问密码"), "应返回访问密码 challenge 页");
    assert.ok(html.includes('type="password"'));
  } finally {
    closeServer(t.gw.server);
    closeServer(t.upstream.server);
  }
});

test("accessCode 门禁：错误口令 → challenge 错误态；正确口令 → 303 + rdsh_gate cookie", async () => {
  const t = await startGateGateway("abcd1234");
  try {
    const bad = await postGate(t.base, "wrong");
    assert.equal(bad.status, 200);
    assert.ok((await bad.text()).includes("访问密码错误"));

    const ok = await postGate(t.base, "abcd1234");
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), "/");
    const cookie = ok.headers.get("set-cookie");
    assert.ok(cookie?.includes("rdsh_gate="), "应下发 rdsh_gate cookie");
    assert.ok(cookie?.includes("HttpOnly"));
    assert.ok(cookie?.includes("SameSite=Lax"));
  } finally {
    closeServer(t.gw.server);
    closeServer(t.upstream.server);
  }
});

test("accessCode 门禁：有效 cookie → 转发 dsh；无效 cookie → 回 challenge（非 307）", async () => {
  const t = await startGateGateway("abcd1234");
  try {
    const ok = await postGate(t.base, "abcd1234");
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;

    const res = await fetch(`${t.base}/api/whatever`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "dsh-ok");

    const invalid = await fetch(`${t.base}/api/whatever`, { headers: { cookie: "rdsh_gate=broken.sig" }, redirect: "manual" });
    assert.equal(invalid.status, 200);
    assert.ok((await invalid.text()).includes("type=\"password\""));
  } finally {
    closeServer(t.gw.server);
    closeServer(t.upstream.server);
  }
});

test("accessCode 门禁：连续错误 → 锁定（locked 态，即使口令正确）", async () => {
  const t = await startGateGateway("abcd1234");
  try {
    for (let i = 0; i < 10; i++) await postGate(t.base, "wrong");
    const locked = await postGate(t.base, "abcd1234");
    assert.equal(locked.status, 200);
    assert.ok((await locked.text()).includes("尝试次数过多"));
  } finally {
    closeServer(t.gw.server);
    closeServer(t.upstream.server);
  }
});

test("accessCode 门禁下也必须打 loopback 补丁（jsPatch 接线回归）", async () => {
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith("/js/")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end("var loop = isLoopbackHostname(pageLocation.hostname);");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("dsh-ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-gw-"));
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    sessionTtlSeconds: 3600,
    dshPort: (upstream.address() as AddressInfo).port,
    keyDir,
    accessCode: "abcd1234",
  });
  const base = `http://127.0.0.1:${gw.actualPort}`;
  try {
    const ok = await postGate(base, "abcd1234");
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    const js = await (await fetch(`${base}/js/plain.js`, { headers: { cookie } })).text();
    assert.ok(js.includes("var loop = true;"), "门禁会话下 JS 补丁必须生效");
    assert.ok(!js.includes("isLoopbackHostname"), "不应残留原始判定");
  } finally {
    closeServer(gw.server);
    closeServer(upstream);
  }
});

test("noCode=true（无 accessCode、authMode none）→ 无会话直接转发 + WS 放行", async () => {
  const upstream = await startUpstream();
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-gw-nocode-"));
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    sessionTtlSeconds: 3600,
    dshPort: upstream.port,
    keyDir,
    noCode: true,
  });
  const base = `http://127.0.0.1:${gw.actualPort}`;
  try {
    const res = await fetch(`${base}/api/session.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "dsh-ok");

    const { WebSocket } = await import("ws");
    const opened = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.actualPort}/api/events.mux`);
      const timer = setTimeout(() => reject(new Error("timeout")), 3000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    assert.equal(opened, true);
  } finally {
    closeServer(gw.server);
    closeServer(upstream.server);
  }
});

test("dshAuthCookieHeader 透传到上游转发请求（auth none）", async () => {
  const seen = { cookie: "" as string };
  const upstream = createServer((req, res) => {
    seen.cookie = req.headers.cookie ?? "";
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-gw-"));
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    sessionTtlSeconds: 3600,
    dshPort: (upstream.address() as AddressInfo).port,
    keyDir,
    noCode: true,
    dshAuthCookieHeader: "dsh-auth-x=v1.y.z",
  });
  try {
    await fetch(`http://127.0.0.1:${gw.actualPort}/api/test`);
    assert.equal(seen.cookie, "dsh-auth-x=v1.y.z");
  } finally {
    closeServer(gw.server);
    closeServer(upstream);
  }
});
