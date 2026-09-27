import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateIpv4, lanCandidates, startDirect } from "../src/direct.ts";
import { createDirectTicketManager } from "../src/direct-ticket.ts";

function closeServer(server: ReturnType<typeof createServer>): void {
  server.closeAllConnections?.();
  server.close();
}

test("isPrivateIpv4：RFC1918/link-local 为 true，公网/非法为 false", () => {
  assert.equal(isPrivateIpv4("10.0.0.1"), true);
  assert.equal(isPrivateIpv4("172.16.0.1"), true);
  assert.equal(isPrivateIpv4("172.31.255.255"), true);
  assert.equal(isPrivateIpv4("192.168.1.5"), true);
  assert.equal(isPrivateIpv4("169.254.10.10"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateIpv4("1.2.3.4"), false);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("172.15.0.1"), false);
  assert.equal(isPrivateIpv4("999.1.1.1"), false);
  assert.equal(isPrivateIpv4("not-an-ip"), false);
});

test("lanCandidates：返回项均为私网 IPv4 + 给定端口", () => {
  const out = lanCandidates(8442);
  for (const c of out) {
    assert.equal(isPrivateIpv4(c.host), true, `${c.host} 应为私网地址`);
    assert.equal(c.port, 8442);
  }
});

test("startDirect：设口令时 = ticket + 口令门禁（?ticket= → 发 cookie，单次；无票 → challenge）", async () => {
  // mock 上游（dsh）
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("dsh-ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));

  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-direct-"));
  const tm = createDirectTicketManager("direct-secret-abcdefghijklmnopqrstuvwxyz");
  const direct = await startDirect({
    dshPort: (upstream.address() as AddressInfo).port,
    secret: "direct-secret-abcdefghijklmnopqrstuvwxyz",
    accessCode: "abcd1234",
    consumeTicket: (t) => tm.consume(t),
    keyDir,
    host: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${direct.actualPort}`;
  try {
    // 无 cookie → challenge 页（有口令）
    const anon = await fetch(`${base}/`);
    assert.equal(anon.status, 200);
    assert.ok((await anon.text()).includes('type="password"'));

    // 一次性直连票 → 302 + rdsh_gate cookie
    const ticket = tm.mint();
    const withTicket = await fetch(`${base}/?ticket=${ticket}`, { redirect: "manual" });
    assert.equal(withTicket.status, 302);
    assert.equal(withTicket.headers.get("location"), "/");
    const cookie = withTicket.headers.get("set-cookie")!;
    assert.ok(cookie.includes("rdsh_gate="));
    const gate = cookie.split(";")[0]!;

    // 用门禁 cookie 访问 → 转发到 dsh
    const ok = await fetch(`${base}/api/whatever`, { headers: { cookie: gate } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "dsh-ok");

    // 票已消费：重放 → 回 challenge（不再 302）
    const replay = await fetch(`${base}/?ticket=${ticket}`, { redirect: "manual" });
    assert.equal(replay.status, 200);
    assert.ok((await replay.text()).includes('type="password"'));
  } finally {
    await direct.stop();
    closeServer(upstream);
  }
});

test("startDirect：不设口令时 = 纯 ticket 门禁（无票 → 403，不弹口令页）", async () => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("dsh-ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));

  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-direct-"));
  const tm = createDirectTicketManager("direct-secret-abcdefghijklmnopqrstuvwxyz");
  const direct = await startDirect({
    dshPort: (upstream.address() as AddressInfo).port,
    secret: "direct-secret-abcdefghijklmnopqrstuvwxyz",
    accessCode: null, // 无口令
    consumeTicket: (t) => tm.consume(t),
    keyDir,
    host: "127.0.0.1",
    port: 0,
  });
  const base = `http://127.0.0.1:${direct.actualPort}`;
  try {
    // 无票 → 403（纯 ticket 门禁，无口令页），提示两种启动方式各自的设口令方法
    const anon = await fetch(`${base}/`);
    assert.equal(anon.status, 403);
    const anonHtml = await anon.text();
    assert.ok(anonHtml.includes("gate set"), "应提示 CLI 设口令命令");
    assert.ok(anonHtml.includes("Remote Access"), "应提示插件面板设口令");

    // 有票 → 302 + cookie → 转发
    const ticket = tm.mint();
    const withTicket = await fetch(`${base}/?ticket=${ticket}`, { redirect: "manual" });
    assert.equal(withTicket.status, 302);
    const gate = withTicket.headers.get("set-cookie")!.split(";")[0]!;
    const ok = await fetch(`${base}/api/whatever`, { headers: { cookie: gate } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "dsh-ok");
  } finally {
    await direct.stop();
    closeServer(upstream);
  }
});
