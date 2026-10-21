import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type Duplex } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJoin } from "../src/join.ts";
import type { JoinState } from "../src/join.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function raw401(_req: IncomingMessage, socket: Duplex, code?: string): void {
  const header = code !== undefined ? `x-rdsh-error: ${code}\r\n` : "";
  socket.write(`HTTP/1.1 401 Unauthorized\r\n${header}Connection: close\r\n\r\n`);
  socket.destroy();
}

function raw307(_req: IncomingMessage, socket: Duplex, relayPort: number): void {
  socket.write(`HTTP/1.1 307 Temporary Redirect\r\nLocation: ws://127.0.0.1:${relayPort}/tunnel?assign=x\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

const target = { host: "127.0.0.1", port: 1 };
const lockDir = () => mkdtempSync(join(tmpdir(), "rdsh-reject-"));
const hubUrl = (port: number) => `http://127.0.0.1:${port}`;

test("relay 401（带 ASSIGN_INVALID code）：不判 rejected，持续退避重试", async () => {
  // relay：对任何连接回 401 + ASSIGN_INVALID（分配层失败，机器可读）
  const relay = createServer();
  relay.on("upgrade", (req, socket) => raw401(req, socket, "ASSIGN_INVALID"));
  const relayPort = await listen(relay);

  // hub：每次连接都 307 到 relay；relay 每次都 401 → 网关应持续重试、永不判 rejected
  const hub = createServer();
  hub.on("upgrade", (req, socket) => raw307(req, socket, relayPort));
  const hubPort = await listen(hub);

  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: hubUrl(hubPort),
    token: "t".repeat(43),
    insecure: false,
    target,
    role: "plugin",
    lockPath: join(lockDir(), "join.lock"),
    hooks: { onState: (s) => states.push(s) },
  });

  try {
    await waitFor(() => states.filter((s) => s === "reconnecting").length >= 2);
    assert.ok(!states.includes("rejected"), `relay 401 不应判 rejected，实际 states=${JSON.stringify(states)}`);
    assert.ok(states.filter((s) => s === "reconnecting").length >= 2, "应持续退避重试");
  } finally {
    await handle.stop();
    hub.close();
    relay.close();
  }
});

test("relay 401（无 code）：按瞬时处理，仍持续重试、不判 rejected", async () => {
  const relay = createServer();
  relay.on("upgrade", (req, socket) => raw401(req, socket));
  const relayPort = await listen(relay);

  const hub = createServer();
  hub.on("upgrade", (req, socket) => raw307(req, socket, relayPort));
  const hubPort = await listen(hub);

  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: hubUrl(hubPort),
    token: "t".repeat(43),
    insecure: false,
    target,
    role: "plugin",
    lockPath: join(lockDir(), "join.lock"),
    hooks: { onState: (s) => states.push(s) },
  });

  try {
    await waitFor(() => states.filter((s) => s === "reconnecting").length >= 2);
    assert.ok(!states.includes("rejected"), `无 code 的 relay 401 也不应判 rejected，states=${JSON.stringify(states)}`);
  } finally {
    await handle.stop();
    hub.close();
    relay.close();
  }
});

test("hub 401（带 HOST_TOKEN_REVOKED code）：权威拒绝 → 判 rejected 并停", async () => {
  const hub = createServer();
  hub.on("upgrade", (req, socket) => raw401(req, socket, "HOST_TOKEN_REVOKED"));
  const hubPort = await listen(hub);

  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: hubUrl(hubPort),
    token: "t".repeat(43),
    insecure: false,
    target,
    role: "plugin",
    lockPath: join(lockDir(), "join.lock"),
    hooks: { onState: (s) => states.push(s) },
  });

  try {
    await waitFor(() => states.includes("rejected"));
    assert.ok(states.includes("rejected"), `hub 401 应判 rejected，实际 states=${JSON.stringify(states)}`);
  } finally {
    await handle.stop();
    hub.close();
  }
});

test("hub 401（无 code，如反代/WAF 瞬态 401）：按瞬时处理，退避重试而非永久 rejected", async () => {
  const hub = createServer();
  hub.on("upgrade", (req, socket) => raw401(req, socket)); // 裸 401，无 x-rdsh-error
  const hubPort = await listen(hub);

  const states: JoinState[] = [];
  const handle = startJoin({
    hubUrl: hubUrl(hubPort),
    token: "t".repeat(43),
    insecure: false,
    target,
    role: "plugin",
    lockPath: join(lockDir(), "join.lock"),
    hooks: { onState: (s) => states.push(s) },
  });

  try {
    await waitFor(() => states.filter((s) => s === "reconnecting").length >= 2);
    assert.ok(!states.includes("rejected"), `裸 hub 401 不应判 rejected，实际 states=${JSON.stringify(states)}`);
    assert.ok(states.filter((s) => s === "reconnecting").length >= 2, "应持续退避重试");
  } finally {
    await handle.stop();
    hub.close();
  }
});
