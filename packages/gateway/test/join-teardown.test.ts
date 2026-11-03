/**
 * 收尾完整性：`startJoin` 的 `stop()` 必须清掉所有「会把事件循环拉住的」句柄
 * （心跳 interval、退避重连 timer、隧道 WS socket）。这是桌面端 10s 优雅窗口的前置条件：
 * 任何一个 ref'd 句柄残留，宿主就退不出、升级就会被拒。
 *
 * 用 `process.getActiveResourcesInfo()`（只列 ref'd 的活跃资源，unref 的定时器不计入）
 * 做 before/after 对比，断言 stop() 后回到基线。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { encodeFrame, FRAME_TYPE, jsonPayload } from "rdsh-tunnel";
import { startJoin, UsageReporter } from "../src/join.ts";
import type { JoinState } from "../src/join.ts";

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 起一个假的 hub WS 服务；onMessage 决定它如何回应。 */
async function fakeHub(
  onMessage: (socket: { send: (b: Buffer) => void }) => ((data: Buffer) => void) | undefined,
): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  wss.on("connection", (ws) => {
    const handler = onMessage({ send: (b) => ws.send(b) });
    if (handler !== undefined) ws.on("message", (data) => handler(Buffer.from(data as ArrayBuffer)));
  });
  return {
    port,
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

interface ResourceCounts {
  timeout: number;
  tcpSocket: number;
  tcpServer: number;
}

function countResources(): ResourceCounts {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1;
  return {
    timeout: counts["Timeout"] ?? 0,
    tcpSocket: counts["TCPSocketWrap"] ?? 0,
    tcpServer: counts["TCPServerWrap"] ?? 0,
  };
}

/** 用本地假 hub + 临时锁路径起 join 隧道；不传 reporter（自建 ownsReporter）。 */
function startJoinAgainst(hubPort: number, lockPath: string, onState: (s: JoinState) => void) {
  return startJoin({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 }, // 不实际转发，仅验生命周期
    role: "plugin",
    lockPath,
    heartbeatMs: 100,
    pongTimeoutMs: 250,
    hooks: { onState },
  });
}

test("connected 态 stop() 后无残留 ref'd 句柄（心跳 interval + WS socket 归零）", async () => {
  const hub = await fakeHub(({ send }) => () => send(encodeFrame(FRAME_TYPE.PONG, 0, jsonPayload({ ts: Date.now() }))));
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-teardown-connected-")), "join.lock");
  const states: JoinState[] = [];
  const base = countResources(); // startJoin 前的干净基线
  const handle = startJoinAgainst(hub.port, lockPath, (s) => states.push(s));
  try {
    await waitFor(() => states.includes("connected"));
    await sleep(300); // 跨几个心跳周期稳定
    await handle.stop({ flushTimeoutMs: 200 });
    await sleep(200); // 等 WS socket 异步关闭走完
    const after = countResources();
    assert.equal(after.timeout, base.timeout, "心跳 interval 已清除");
    assert.equal(after.tcpSocket, base.tcpSocket, "隧道 WS socket 已关闭");
    assert.equal(after.tcpServer, base.tcpServer, "无新增监听口");
  } finally {
    await handle.stop({ flushTimeoutMs: 200 });
    await hub.close();
  }
});

test("reconnecting 态 stop() 后无残留重连 timer（P1-2 回归）", async () => {
  // 接受连接但永不回应 → 心跳死线触发 terminate → 进入退避重连（1s 重连 timer 被武装）
  const hub = await fakeHub(() => undefined);
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-teardown-reconnect-")), "join.lock");
  const states: JoinState[] = [];
  const base = countResources(); // startJoin 前的干净基线
  const handle = startJoinAgainst(hub.port, lockPath, (s) => states.push(s));
  try {
    await waitFor(() => states.includes("reconnecting"));
    // 此刻退避重连 timer 已武装（ref'd）。stop() 必须清掉它，否则把进程再拉最多 1s（生产 60s）。
    await handle.stop({ flushTimeoutMs: 200 });
    await sleep(200);
    const after = countResources();
    assert.equal(after.timeout, base.timeout, "退避重连 timer 已取消");
  } finally {
    await handle.stop({ flushTimeoutMs: 200 });
    await hub.close();
  }
});

/** 黑洞 HTTP 服务：接受 TCP 连接但永不响应，用于模拟 hub 慢/不可达。 */
async function blackholeHttpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(() => { /* 黑洞：不回应 */ });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

test("在途周期性 flush 不击穿短超时（P1-1 回归）", async () => {
  const hub = await blackholeHttpServer();
  try {
    const reporter = new UsageReporter({ hubUrl: `http://127.0.0.1:${hub.port}`, token: "t".repeat(43), insecure: false });
    reporter.meter.addDirectUp(123); // hasUsage=true → flush 会真实发出 hubRequest
    const socketsBefore = countResources().tcpSocket; // 此刻（flush 前）的基线
    const inFlight = reporter.flush(); // 默认 10s，黑洞 hub 下挂起
    await sleep(50); // 让在途请求真正发出、socket 进入黑洞
    const t0 = Date.now();
    await reporter.flush(200); // 短超时：应中止在途并 ~200ms 内收尾，而不是被 10s 在途链吞掉
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `短超时被在途 flush 击穿，耗时 ${elapsed}ms`);
    await inFlight.catch(() => undefined);
    // flush 的 socket（agent:false 无池化）在超时/中止后应关闭，回到发起前水平；
    // 用 <= 容忍本文件其它测例遗留、且正在异步关闭的 socket。
    await waitFor(() => countResources().tcpSocket <= socketsBefore, 3000);
  } finally {
    await hub.close();
  }
});
