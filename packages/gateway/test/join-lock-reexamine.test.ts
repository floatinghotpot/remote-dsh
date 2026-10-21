import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { startJoin } from "../src/join.ts";
import type { JoinState } from "../src/join.ts";
import { readJoinLock } from "../src/lock.ts";

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("startJoin：重连前复查锁 —— 锁被外部删除（force-unlock）→ superseded，不再重连", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-join-lock-")), "join.lock");

  let serverWs: import("ws").WebSocket | undefined;
  wss.on("connection", (ws) => {
    serverWs = ws;
  });

  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 },
    role: "plugin",
    lockPath,
    hooks: { onState: (s) => states.push(s) },
  });

  await waitFor(() => states.includes("connected"));
  assert.ok(readJoinLock(lockPath) !== null, "连接后应持锁");

  // 模拟 force-unlock：外部删除锁文件（此时本进程还"以为"自己持锁，锁盘上已消失）
  rmSync(lockPath, { force: true });

  // 模拟 hub 把旧连接踢掉（force-unlock 后可见实例抢锁连上，hub terminate 本实例）
  assert.ok(serverWs !== undefined, "应已接受连接");
  serverWs.terminate();

  // 重连前复查锁：锁已不在 → superseded，不再重连
  await waitFor(() => states.includes("superseded"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(states.at(-1), "superseded");
  assert.ok(
    !states.slice(states.indexOf("superseded") + 1).includes("connected"),
    "superseded 之后不得再 connected（否则仍在反击）",
  );

  await handle.stop();
  wss.close();
});

test("startJoin：持锁期间正常断线 → 仍重连（锁复查不误伤）", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-join-lock-")), "join.lock");

  let first: import("ws").WebSocket | undefined;
  wss.on("connection", (ws) => {
    if (first === undefined) first = ws;
  });

  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 },
    role: "plugin",
    lockPath,
    hooks: { onState: (s) => states.push(s) },
  });

  await waitFor(() => states.includes("connected"));
  // 锁仍在己手：正常断线 → 重连（reconnecting → connected）
  assert.ok(first !== undefined);
  first.terminate();

  await waitFor(() => states.includes("reconnecting"));
  await waitFor(() => states.filter((s) => s === "connected").length >= 2, 5000);
  assert.equal(states.at(-1), "connected");

  await handle.stop();
  wss.close();
});
