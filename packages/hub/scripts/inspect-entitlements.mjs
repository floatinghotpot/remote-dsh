#!/usr/bin/env node
/**
 * inspect-entitlements.mjs —— 只读巡检（feature 23 R8）。
 *
 * 列出授权/配额相关的矛盾状态，只报告、不写库：
 *   ① subscribed/grace 但无 active 订阅  → 配额会被 hostQuota() 算成 0 台
 *   ② plan=null 但设了到期时间            → sweepBilling 到期会硬降 free 并踢掉全部主机隧道
 *   ③ 永久无限账号清单（plan=null 且无到期）→ 供人工复核（无界增长）
 *
 * 用法：node packages/hub/scripts/inspect-entitlements.mjs [--config <hub.json>]
 * 缺省读取 ~/.rdsh/hub.json。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const argIdx = process.argv.indexOf("--config");
const configPath = argIdx >= 0 && process.argv[argIdx + 1] !== undefined ? process.argv[argIdx + 1] : resolve(homedir(), ".rdsh", "hub.json");

const config = JSON.parse(readFileSync(configPath, "utf8"));
const dbPath = resolve(dirname(configPath), config.dbPath ?? "hub.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

const iso = (ms) => (ms === null ? null : new Date(Number(ms)).toISOString());
const fmt = (u) => `${u.id}\t${u.name}\t${u.email ?? ""}\t${u.phone ?? ""}`;

const orphans = []; // ① subscribed/grace 无 active 订阅
const bombs = []; // ② null + 到期
const unlimited = []; // ③ 永久无限清单

for (const u of db.prepare("SELECT id, name, email, phone, plan_status, plan_expires_at, account_status FROM users ORDER BY id").all()) {
  if (u.plan_status === "subscribed" || u.plan_status === "grace") {
    const sub = db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(u.id);
    if (sub === undefined) orphans.push({ ...u, planStatus: u.plan_status });
  } else if (u.plan_status === null && u.plan_expires_at !== null) {
    bombs.push({ ...u, expires: iso(u.plan_expires_at) });
  } else if (u.plan_status === null && u.plan_expires_at === null) {
    unlimited.push(u);
  }
}

console.log("=== ① subscribed/grace 但无 active 订阅（配额 = 0 台） ===");
console.log(orphans.length === 0 ? "  (无)" : orphans.map((u) => `  ${fmt(u)}\tplan=${u.planStatus}`).join("\n"));
console.log();
console.log("=== ② plan=null 但设了到期时间（到期硬降 free + 踢隧道） ===");
console.log(bombs.length === 0 ? "  (无)" : bombs.map((u) => `  ${fmt(u)}\texpires=${u.expires}`).join("\n"));
console.log();
console.log("=== ③ 永久无限账号清单（plan=null 且无到期，供人工复核） ===");
console.log(unlimited.length === 0 ? "  (无)" : unlimited.map((u) => `  ${fmt(u)}`).join("\n"));
console.log();
console.log(`summary: ①${orphans.length} ②${bombs.length} ③${unlimited.length}`);
db.close();
