/**
 * usage-report.test.ts — 用量计量/上报已上提到 `startJoin`（CLI 与插件共用同一份）。
 *
 * 回归背景（doc/fix/20261016-plugin-usage-reporting）：计量与上报原先只写在 CLI `join()`，
 * 插件只调 `startJoin` ⇒ 插件的直连流量**从未被计量上报**（账号页「直连流量」恒 0）。
 *
 * 本文件锁两件事：
 * 1. `startJoin` 自带 meter，直连字节在 `stop()` 时被上报（不再只有 CLI 会报）；
 * 2. 调用方传入的 meter 被**沿用**且**跨 handle 复用**——插件重连会新建 handle，
 *    但直连口比隧道活得久，meter 不能跟着换（否则重连后又恒 0）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createRawServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { startJoin, UsageReporter, hubRequest } from "../src/join.ts";
import type { JoinState } from "../src/join.ts";

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 假 hub = 一个能同时处理 HTTP（用量上报）与 WS upgrade（隧道）的服务器。 */
async function startFakeHub(): Promise<{
  hubUrl: string;
  reports: Array<Record<string, unknown>>;
  close: () => void;
}> {
  const reports: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/host/usage/report") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch {
          /* 忽略非 JSON */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    hubUrl: `http://127.0.0.1:${port}`,
    reports,
    close: () => {
      wss.close();
      server.close();
    },
  };
}

async function freshLockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "rdsh-usage-report-")), "join.lock");
}

const TOKEN = "t".repeat(43);

test("用量上报：startJoin 自带 meter，stop() 时把直连字节上报（CLI/插件共用）", async () => {
  const hub = await startFakeHub();
  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: hub.hubUrl,
    token: TOKEN,
    insecure: false,
    target: { host: "127.0.0.1", port: 1 }, // 不实际转发，仅验用量链路
    role: "plugin",
    lockPath: await freshLockPath(),
    hooks: { onState: (s) => states.push(s) },
  });

  await waitFor(() => states.includes("connected"));

  // 插件形态正是靠这个 meter 计量直连字节（原先这条路径连 meter 都没有）。
  handle.meter.addDirectUp(1234);
  handle.meter.addDirectDown(5678);

  await handle.stop();
  await waitFor(() => hub.reports.length > 0);

  assert.equal(hub.reports.length, 1, "stop() 应触发一次最终 flush");
  const r = hub.reports[0]!;
  assert.equal(r.directBytesUp, 1234);
  assert.equal(r.directBytesDown, 5678);
  assert.equal(r.relayBytesUp, 0, "设备端只报直连：中转计量归 Relay（否则双计）");
  assert.equal(r.relayBytesDown, 0);
  assert.equal(r.token, TOKEN);
  assert.equal(typeof r.instanceId, "string");
  assert.match(String(r.date), /^\d{4}-\d{2}-\d{2}$/);

  hub.close();
});

test("用量上报：并发 flush 串行化，不崩溃、不丢最终累计", async () => {
  const hub = await startFakeHub();
  const reporter = new UsageReporter({ hubUrl: hub.hubUrl, token: TOKEN, insecure: false });
  reporter.meter.addDirectUp(42);
  // 并发触发多轮 flush（模拟 60s 定时与 stop() 的最终 flush 撞车）——必须都能 resolve、不崩。
  await Promise.all([reporter.flush(), reporter.flush(), reporter.flush()]);
  await waitFor(() => hub.reports.length > 0);
  assert.ok(hub.reports.length >= 1);
  assert.equal(hub.reports.at(-1)!.directBytesUp, 42, "最终上报应含累计");
  hub.close();
});

test("用量上报：调用方传入的 reporter 被沿用，且跨 handle 复用（插件重连不换 meter）", async () => {
  const hub = await startFakeHub();
  // 插件把 reporter 建在**进程级**（不随隧道 handle 走），两个 handle 共用同一个 meter。
  const reporter = new UsageReporter({ hubUrl: hub.hubUrl, token: TOKEN, insecure: false });
  const meter = reporter.meter;
  const base = {
    hubUrl: hub.hubUrl,
    token: TOKEN,
    insecure: false,
    target: { host: "127.0.0.1", port: 1 },
    role: "plugin" as const,
    reporter,
  };

  const states1: JoinState[] = [];
  const h1 = startJoin({ ...base, lockPath: await freshLockPath(), hooks: { onState: (s) => states1.push(s) } });
  await waitFor(() => states1.includes("connected"));
  assert.equal(h1.meter, meter, "startJoin 必须沿用调用方传入 reporter 的 meter");
  meter.addDirectUp(100);
  await h1.stop();
  await waitFor(() => hub.reports.length > 0);
  assert.equal(hub.reports.at(-1)!.directBytesUp, 100);

  // 「断开 → 再接入」：新 handle、**同一个 meter** —— 旧实现这里会把直连流量记进已停实例的 meter。
  const states2: JoinState[] = [];
  const h2 = startJoin({ ...base, lockPath: await freshLockPath(), hooks: { onState: (s) => states2.push(s) } });
  await waitFor(() => states2.includes("connected"));
  assert.equal(h2.meter, meter);
  meter.addDirectUp(7);
  await h2.stop();
  await waitFor(() => hub.reports.length >= 2);
  assert.equal(hub.reports.at(-1)!.directBytesUp, 107, "累计值应继续上报（100 + 7）");

  hub.close();
});

test("UsageReporter 独立于隧道也能上报（隧道断开时直连流量仍会上报）", async () => {
  const hub = await startFakeHub();
  // 插件进程级 reporter 不依赖任何 startJoin：隧道断开、只有直连口在服务时，它照常 flush。
  const reporter = new UsageReporter({ hubUrl: hub.hubUrl, token: TOKEN, insecure: false });
  reporter.meter.addDirectUp(42);
  await reporter.flush();
  await waitFor(() => hub.reports.length > 0);
  assert.equal(hub.reports[0]!.directBytesUp, 42);
  hub.close();
});

test("hubRequest 超时兜底：黑洞 hub 在超时内 reject（不挂半开连接）", async () => {
  // 接受连接但永不响应，模拟 hub 黑洞。
  const server = createRawServer(() => {
    /* 吞掉连接，不回包 */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const t0 = Date.now();
  await assert.rejects(
    () => hubRequest(`http://127.0.0.1:${port}`, "/x", { method: "GET", insecure: false }, 200),
    /timed out/,
  );
  assert.ok(Date.now() - t0 < 3000, `应在 ~200ms 超时 reject，实际 ${Date.now() - t0}ms`);
  server.close();
});

test("hubRequest 超时兜底：响应头已到但 body 挂起，也会在超时内 reject", async () => {
  // 发了响应头但永不发 body / end —— 覆盖「res 不发 error 只发 aborted/close」的路径。
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const t0 = Date.now();
  await assert.rejects(
    () => hubRequest(`http://127.0.0.1:${port}`, "/x", { method: "GET", insecure: false }, 200),
    /timed out/,
  );
  assert.ok(Date.now() - t0 < 3000, `应在 ~200ms 超时 reject，实际 ${Date.now() - t0}ms`);
  server.closeAllConnections?.();
  server.close();
});

test("UsageReporter.setTarget 换 hub 时清零 meter（避免跨 hub 错账）", async () => {
  const hubA = await startFakeHub();
  const hubB = await startFakeHub();
  const reporter = new UsageReporter({ hubUrl: hubA.hubUrl, token: TOKEN, insecure: false });
  reporter.meter.addDirectUp(50);

  // 同 hub 重连（setTarget 相同 hubUrl）→ 不清零，累计保留。
  reporter.setTarget(hubA.hubUrl, TOKEN, false);
  assert.equal(reporter.meter.snapshot().directBytesUp, 50);

  // 换到不同 hub → 清零，避免旧 hub 的累计误报到新 hub。
  reporter.setTarget(hubB.hubUrl, TOKEN, false);
  assert.equal(reporter.meter.snapshot().directBytesUp, 0, "换 hub 应清零");

  hubA.close();
  hubB.close();
});
