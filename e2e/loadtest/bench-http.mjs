#!/usr/bin/env node
/**
 * V4 — HTTP QPS / latency benchmark（70 V1 压测 harness）。
 *
 * Usage:
 *   node bench-http.mjs --url http://127.0.0.1:8443 --path /api/hosts --token "$TOKEN" --concurrency 50 --duration 30
 */
const args = parseArgs(process.argv.slice(2));
const base = (args.url ?? "http://127.0.0.1:8443").replace(/\/+$/, "");
const path = args.path ?? "/api/hosts";
const token = args.token ?? "";
const concurrency = Number(args.concurrency ?? 20);
const durationMs = Number(args.duration ?? 10) * 1000;
const target = base + path;

const lat = [];
let ok = 0;
let fail = 0;
const endAt = Date.now() + durationMs;

async function worker() {
  while (Date.now() < endAt) {
    const t0 = performance.now();
    try {
      const res = await fetch(target, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      await res.arrayBuffer();
      if (res.status >= 200 && res.status < 400) ok += 1;
      else fail += 1;
    } catch {
      fail += 1;
    }
    lat.push(performance.now() - t0);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
console.log(JSON.stringify({
  target,
  concurrency,
  durationMs,
  requests: lat.length,
  ok,
  fail,
  qps: Number((lat.length / (durationMs / 1000)).toFixed(1)),
  p50Ms: Number(pct(0.5).toFixed(1)),
  p99Ms: Number(pct(0.99).toFixed(1)),
  maxMs: Number((lat[lat.length - 1] ?? 0).toFixed(1)),
}, null, 2));

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
