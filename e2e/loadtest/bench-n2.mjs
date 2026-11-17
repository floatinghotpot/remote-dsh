#!/usr/bin/env node
/**
 * V7 — N2 心跳 payload 体积（70 V1 压测 harness）。
 *
 * 纯计算：给定在线 host 数，算全量（hosts[]）与增量（added/removed）的 JSON 体积，
 * 验证 4 MiB 上限对应的 host 拐点（约 10.7 万）。
 *
 * Usage:
 *   node bench-n2.mjs --hosts 100000
 */
const n = Number(parseArgs(process.argv.slice(2)).hosts ?? 100000);
// 生产 hostId 是 UUID（36 字符）；用同长度近似，避免短 id 低估体积（约 10.7 万 → 4 MiB）。
const ids = Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
const metric = { connections: 12000, activeStreams: 40, bytesIn: 123456789, bytesOut: 987654321 };
const full = JSON.stringify({ seq: 1, full: true, hosts: ids, ...metric });
const delta = JSON.stringify({ seq: 2, added: ids.slice(0, 8), removed: [], ...metric });
const fullBytes = Buffer.byteLength(full);
const LIMIT = 4 * 1024 * 1024;
console.log(JSON.stringify({
  hosts: n,
  fullBytes,
  fullMiB: Number((fullBytes / 1024 / 1024).toFixed(2)),
  deltaBytes: Buffer.byteLength(delta),
  over4MiB: fullBytes > LIMIT,
  approxMaxHostsUnder4MiB: Math.floor((n * LIMIT) / fullBytes),
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
