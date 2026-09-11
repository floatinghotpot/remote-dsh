/**
 * 心跳超时判定：gateway 侧（PROTOCOL.md「心跳与重连」）。
 *
 * 协议要求**双方对称**维护：发出 PING 后 10s（测试注入毫秒级）内未收到对端任何帧
 * → 判定连接已死并主动断开 → 触发既有退避重连。
 * 历史缺陷：两侧都只应答、都不判定（见 doc/fix/20260911-heartbeat-pong-timeout/）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { encodeFrame, FRAME_TYPE, jsonPayload } from "rdsh-tunnel";
import { startJoin } from "../src/join.ts";
import type { JoinState } from "../src/join.ts";

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 起一个假的 hub WS 服务；onConnection 决定它如何回应（不回 / 回 PONG）。 */
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

test("心跳：对端不应答 → 死线超时后重连（reconnecting）", async () => {
  const hub = await fakeHub(() => undefined); // 接受连接但永不回应
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-hb-timeout-")), "join.lock");
  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${hub.port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 }, // 不实际转发，仅验状态机
    role: "plugin",
    lockPath,
    // 毫秒级注入：超时 250ms ≫ 心跳 100ms，留出 CI 调度余量（生产为 30s/10s）
    heartbeatMs: 100,
    pongTimeoutMs: 250,
    hooks: { onState: (s) => states.push(s) },
  });
  try {
    await waitFor(() => states.includes("reconnecting"));
    assert.deepEqual(states.slice(0, 3), ["connecting", "connected", "reconnecting"]);
  } finally {
    await handle.stop();
    await hub.close();
  }
});

test("心跳：对端恢复后重连并保持在线（死线判定不误杀 + 自动恢复）", async () => {
  // 首次连接静默（模拟对端已死）；第二次起正常应答（模拟对端恢复）
  let connections = 0;
  const hub = await fakeHub(({ send }) => {
    connections += 1;
    if (connections === 1) return undefined;
    return () => send(encodeFrame(FRAME_TYPE.PONG, 0, jsonPayload({ ts: Date.now() })));
  });
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-hb-recover-")), "join.lock");
  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${hub.port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 },
    role: "plugin",
    lockPath,
    heartbeatMs: 100,
    pongTimeoutMs: 250,
    hooks: { onState: (s) => states.push(s) },
  });
  try {
    // 判死 → 退避重连（1s）→ 重新建链并恢复在线
    await waitFor(() => states.filter((s) => s === "connected").length >= 2, 8000);
    await new Promise((r) => setTimeout(r, 600)); // 恢复后再跨多个心跳周期，确认不再被误判
    assert.deepEqual(states, ["connecting", "connected", "reconnecting", "connecting", "connected"]);
  } finally {
    await handle.stop();
    await hub.close();
  }
});

test("心跳：对端回 PONG → 不误判（保持 connected）", async () => {
  // 每次收到任何帧都回一个合法 PONG（模拟合规 hub）
  const hub = await fakeHub(({ send }) => () => {
    send(encodeFrame(FRAME_TYPE.PONG, 0, jsonPayload({ ts: Date.now() })));
  });
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-hb-alive-")), "join.lock");
  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${hub.port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 },
    role: "plugin",
    lockPath,
    heartbeatMs: 100,
    pongTimeoutMs: 250,
    hooks: { onState: (s) => states.push(s) },
  });
  try {
    await waitFor(() => states.includes("connected"));
    // 跨越多个心跳周期（>= 6 × 100ms）：若死线未正确撤销，这里会出现 reconnecting
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(states, ["connecting", "connected"]);
  } finally {
    await handle.stop();
    await hub.close();
  }
});
