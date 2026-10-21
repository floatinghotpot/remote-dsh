/**
 * migrate.ts — SQLite→PostgreSQL 数据迁移（48-hub-admin，并入 `rdsh-hub` lib）。
 *
 * 由 43c 的独立工具 `tools/migrate-sqlite-to-pg/` 迁入，随 `rdsh-hub-cli` 的
 * `rdsh-hub db migrate|verify` 使用。`migrateSqliteToPg` 先跑 `migratePg` 幂等建表，
 * 再做数据搬运（空库可直接迁移）。
 *
 * 安全约定：只读源库（仅 SELECT + VACUUM INTO 到新文件）；不打印 DSN 密码。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createPgPool, migratePg } from "./pg.ts";

// ---- 表清单（依赖序：父表在前）与列映射 ----
const TABLES = [
  "users", "hosts", "refresh_tokens", "join_tokens", "bind_sessions", "host_share",
  "audit_events", "email_codes", "sms_codes", "subscriptions", "orders", "payments",
  "credits_ledger", "meta", "apple_tokens", "usage_daily", "nodes", "node_metrics",
  "relay_join_tokens", "relay_join_events",
] as const;

/** PG 侧去掉了代理 id 的表（自然主键代替）。 */
const SKIP_ID = new Set(["usage_daily"]);

export type MigrateReport = Record<string, unknown>;

function sqliteColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((c) => !(SKIP_ID.has(table) && c === "id"));
}

function openSqlite(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`source SQLite not found: ${path}`);
  return new DatabaseSync(path, { readOnly: true }); // 只读源库（VACUUM INTO 亦支持只读）
}

function redactDsn(dsn: string): string {
  return dsn.replace(/(\/\/[^:]+:)[^@]*@/, "$1***@");
}

// ---- preflight（只读核对：源库行数 + 账本校验值 + PG 可达性）----
export async function preflight(source: string, dsn: string): Promise<MigrateReport> {
  const db = openSqlite(source);
  const counts: Record<string, number> = {};
  for (const t of TABLES) counts[t] = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  const ledger = db.prepare(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(delta),0) AS sum_delta, COALESCE(SUM(CASE WHEN bucket='purchased' THEN delta END),0) AS purchased FROM credits_ledger`,
  ).get() as Record<string, number>;
  const usersCredits = db.prepare(
    `SELECT COALESCE(SUM(purchased_credits),0) AS purchased, COALESCE(SUM(bonus_carried),0) AS carried, COALESCE(SUM(bonus_current),0) AS current FROM users`,
  ).get() as Record<string, number>;
  const pool = createPgPool(dsn, { max: 1 });
  let pgVersion = "";
  let pgTables: string[] = [];
  try {
    const v = (await pool.query("SELECT version() AS v")).rows[0] as { v: string };
    pgVersion = v.v;
    const ts = (await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    )).rows as Array<{ table_name: string }>;
    pgTables = ts.map((r) => r.table_name);
  } finally {
    await pool.end();
  }
  return { source, dsn: redactDsn(dsn), counts, ledger, usersCredits, pgVersion, pgTables };
}

// ---- backup（VACUUM INTO 到新文件，不改源库）----
export function backup(source: string, backupDir: string): MigrateReport {
  const db = openSqlite(source);
  mkdirSync(backupDir, { recursive: true });
  const target = join(backupDir, `${basename(source)}.${Date.now()}.bak`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  return { snapshot: target, bytes: existsSync(target) ? statSync(target).size : -1 };
}

// ---- copy（目标表 DELETE 后全量拷贝，单事务，幂等）----
export async function copy(source: string, dsn: string, dryRun = false): Promise<MigrateReport> {
  const db = openSqlite(source);
  const pool = createPgPool(dsn, { max: 3 });
  const copied: Record<string, number> = {};
  try {
    if (dryRun) {
      for (const t of TABLES) {
        copied[t] = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
      }
      return { dryRun: true, plan: copied };
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const t of [...TABLES].reverse()) await client.query(`DELETE FROM ${t}`);
      for (const t of TABLES) {
        const cols = sqliteColumns(db, t);
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${t}`).all() as unknown as Array<Record<string, unknown>>;
        for (const row of rows) {
          const values = cols.map((c) => row[c]);
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
          await client.query(`INSERT INTO ${t} (${colList}) VALUES (${placeholders})`, values);
        }
        copied[t] = rows.length;
      }
      // 重置 identity 序列：显式 id 插入不推进序列，否则迁移后新插入会与已迁 id 冲突
      for (const t of TABLES) {
        if (!sqliteColumns(db, t).includes("id")) continue; // 无 id 列的表跳过（junction/无代理 id）
        const seq = (await client.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [t])).rows[0]?.s as string | null;
        if (seq === null || seq === undefined) continue;
        await client.query(`SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return { copied };
  } finally {
    db.close();
    await pool.end();
  }
}

// ---- verify（行数 + 账本校验和 + FK 孤儿 + 抽样）----
export async function verify(source: string, dsn: string): Promise<MigrateReport> {
  const db = openSqlite(source);
  const pool = createPgPool(dsn, { max: 1 });
  const mismatches: string[] = [];
  try {
    for (const t of TABLES) {
      const s = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
      const p = Number((await pool.query(`SELECT COUNT(*) AS c FROM ${t}`)).rows[0]!.c);
      if (s !== p) mismatches.push(`${t}: sqlite=${s} pg=${p}`);
    }
    const ledgerSql = `SELECT COUNT(*) AS rows, COALESCE(SUM(delta),0) AS sum_delta, COALESCE(SUM(CASE WHEN bucket='purchased' THEN delta END),0) AS purchased`;
    const sLedger = db.prepare(ledgerSql + " FROM credits_ledger").get() as Record<string, number>;
    const pLedger = (await pool.query(ledgerSql + " FROM credits_ledger")).rows[0] as Record<string, number>;
    for (const k of ["rows", "sum_delta", "purchased"]) {
      if (Number(sLedger[k]) !== Number(pLedger[k])) mismatches.push(`credits_ledger.${k}: sqlite=${sLedger[k]} pg=${pLedger[k]}`);
    }
    const fks: Array<[string, string, string, string]> = [
      ["hosts", "owner_id", "users", "id"],
      ["orders", "user_id", "users", "id"],
      ["payments", "order_id", "orders", "id"],
      ["payments", "user_id", "users", "id"],
      ["credits_ledger", "user_id", "users", "id"],
      ["subscriptions", "user_id", "users", "id"],
      ["host_share", "host_id", "hosts", "id"],
      ["host_share", "user_id", "users", "id"],
      ["refresh_tokens", "user_id", "users", "id"],
    ];
    for (const [t, col, pt, pcol] of fks) {
      const orphans = Number((await pool.query(`SELECT COUNT(*) AS c FROM ${t} c LEFT JOIN ${pt} p ON c.${col} = p.${pcol} WHERE p.${pcol} IS NULL`)).rows[0].c);
      if (orphans > 0) mismatches.push(`${t}.${col} orphans=${orphans}`);
    }
    const sSample = db.prepare("SELECT name, account_status FROM users ORDER BY id LIMIT 10").all();
    const pSample = (await pool.query("SELECT name, account_status FROM users ORDER BY id LIMIT 10")).rows;
    if (JSON.stringify(sSample) !== JSON.stringify(pSample)) mismatches.push("users sample mismatch");
    return { ok: mismatches.length === 0, mismatches, tableCounts: Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await pool.query(`SELECT COUNT(*) AS c FROM ${t}`)).rows[0]!.c)]))) };
  } finally {
    db.close();
    await pool.end();
  }
}

export interface MigrateOptions {
  /** SQLite 源文件（只读）。 */
  source: string;
  /** PostgreSQL DSN（目标）。 */
  dsn: string;
  /** 备份目录（VACUUM INTO 产物）。 */
  backupDir?: string;
  /** 只打印计划，不写 PG、不备份。 */
  dryRun?: boolean;
}

/** 一步迁移：migratePg（建表）→ preflight → backup → copy → verify；verify 不一致时抛错。 */
export async function migrateSqliteToPg(opts: MigrateOptions): Promise<MigrateReport> {
  const { source, dsn, backupDir = "./backups", dryRun = false } = opts;
  if (!dryRun) {
    // 目标 schema 幂等就绪，空库也能直接迁移（dry-run 不写 PG）
    const pool = createPgPool(dsn, { max: 1 });
    try {
      await migratePg(pool);
    } finally {
      await pool.end();
    }
  }
  const pre = await preflight(source, dsn);
  if (dryRun) {
    const cop = await copy(source, dsn, true);
    return { preflight: pre, backup: undefined, copied: (cop.plan as Record<string, number>) ?? {}, verify: undefined };
  }
  const bak = backup(source, backupDir);
  const cop = await copy(source, dsn, false);
  const ver = await verify(source, dsn);
  if (ver.ok !== true) {
    throw new Error(`migration verify failed: ${JSON.stringify(ver.mismatches ?? [])}`);
  }
  return { preflight: pre, backup: bak, copied: (cop.copied as Record<string, number>) ?? {}, verify: ver };
}
