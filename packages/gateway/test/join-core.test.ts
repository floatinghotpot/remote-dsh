import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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

test("startJoin：connecting → connected → stop → stopped，锁获取/释放", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-join-core-")), "join.lock");

  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 }, // 不实际转发，仅验状态机
    role: "plugin",
    lockPath,
    hooks: { onState: (s) => states.push(s) },
  });

  await waitFor(() => states.includes("connected"));
  assert.deepEqual(states, ["connecting", "connected"]);

  const held = readJoinLock(lockPath);
  assert.equal(held?.role, "plugin");
  assert.equal(held?.pid, process.pid);

  await handle.stop();
  assert.equal(states.at(-1), "stopped");
  assert.equal(readJoinLock(lockPath), null);

  wss.close();
});

test("startJoin：他人活锁 → 同步抛错", async () => {
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-join-core-")), "join.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 1, role: "cli" }));

  assert.throws(() => {
    startJoin({
      hubUrl: "http://127.0.0.1:1",
      token: "t".repeat(43),
      insecure: false,
      target: { host: "127.0.0.1", port: 1 },
      role: "plugin",
      lockPath,
    });
  }, /lock held by cli/);
});
