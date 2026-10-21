/**
 * 42-hub-write-path P0 压测辅助（accumulator/DB 路径）。
 *
 * 用法：node --experimental-strip-types scripts/usage-load.ts [hosts] [reportsPerHost]
 * 说明：这是「内存累加 + 批量 flush」的离线基线，不含 HTTP/鉴权；
 *       生产压测请对真实 Hub 走 /api/host/usage/report。
 */
import { HubDb } from "../src/db.ts";
import { UsageAccumulator, localDate } from "../src/relay-usage.ts";

const hosts = Number(process.argv[2] ?? 10_000);
const reportsPerHost = Number(process.argv[3] ?? 1);

const db = new HubDb(":memory:");
const user = db.createUser("load", "hash");
const acc = new UsageAccumulator(db);
const today = localDate();
const day = {
  date: today,
  relaySeconds: 0,
  relayBytesUp: 1024,
  relayBytesDown: 2048,
  directBytesUp: 0,
  directBytesDown: 0,
  cloudAsrSeconds: 0,
  localAsrSeconds: 0,
  cloudTtsChars: 0,
  localTtsChars: 0,
  sessions: 1,
};

const started = performance.now();
for (let r = 0; r < reportsPerHost; r += 1) {
  for (let i = 0; i < hosts; i += 1) {
    acc.reportHostUsage(user.id, `h${i}`, "inst-load", day);
  }
}
const fillMs = performance.now() - started;

const flushStarted = performance.now();
acc.flush();
const flushMs = performance.now() - flushStarted;
const stats = acc.stats();
const rows = db.listUsageDaily(user.id, today, today);

console.log(JSON.stringify({
  hosts,
  reports: hosts * reportsPerHost,
  fillMs: Number(fillMs.toFixed(1)),
  flushMs: Number(flushMs.toFixed(1)),
  flushRows: stats.lastFlushRows,
  batches: Math.ceil(stats.lastFlushRows / 500),
  rowsInDb: rows.length,
  relayBytesUp: rows[0]?.relayBytesUp ?? 0,
}, null, 2));
db.close();
