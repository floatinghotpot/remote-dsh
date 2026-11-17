#!/usr/bin/env node
/**
 * V1 / V2 / V5 — WebSocket 连接压测（70 V1 压测 harness）。
 *
 * 打开 N 条长连接，采样 RSS；`--churn` 时全部断开再重连（V5 重连风暴）。
 * 用到 Node ≥ 22 原生 `WebSocket`（零第三方依赖）。
 *
 * Usage:
 *   node bench-ws.mjs --url ws://127.0.0.1:8443 --path /api/events --cookie "rdsh_session=..." --count 10000
 *   node bench-ws.mjs --url ws://127.0.0.1:8443 --path /api/events --cookie "..." --count 10000 --churn
 */
const args = parseArgs(process.argv.slice(2));
const base = (args.url ?? "ws://127.0.0.1:8443").replace(/\/+$/, "");
const path = args.path ?? "/api/events";
const cookie = args.cookie ?? "";
const count = Number(args.count ?? 1000);
const churn = args.churn === "true";
const sampleMs = Number(args.sample ?? 5000);

const target = base + path;
const sockets = [];
const rssBefore = process.memoryUsage().rss;

function connect() {
  const ws = new WebSocket(target, cookie ? { headers: { cookie } } : undefined);
  ws.onmessage = () => {};
  ws.onerror = () => {};
  sockets.push(ws);
}

for (let i = 0; i < count; i += 500) {
  const batch = Math.min(500, count - i);
  for (let j = 0; j < batch; j++) connect();
  await new Promise((r) => setTimeout(r, 50));
}

const sample = (label) => {
  const m = process.memoryUsage();
  console.log(JSON.stringify({
    label,
    connections: sockets.length,
    rssMB: Number((m.rss / 1024 / 1024).toFixed(1)),
    heapUsedMB: Number((m.heapUsed / 1024 / 1024).toFixed(1)),
    rssDeltaKBPerConn: sockets.length === 0 ? 0 : Number(((m.rss - rssBefore) / 1024 / sockets.length).toFixed(1)),
  }));
};

sample("after-connect");
await new Promise((r) => setTimeout(r, sampleMs));
sample("steady");

if (churn) {
  for (const ws of sockets) ws.close();
  sockets.length = 0;
  await new Promise((r) => setTimeout(r, 1000));
  const t0 = performance.now();
  for (let i = 0; i < count; i += 500) {
    const batch = Math.min(500, count - i);
    for (let j = 0; j < batch; j++) connect();
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(JSON.stringify({ label: "churn", reconnected: sockets.length, reconnectMs: Number((performance.now() - t0).toFixed(0)) }));
  sample("after-churn");
}

for (const ws of sockets) ws.close();
process.exit(0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    out[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}
