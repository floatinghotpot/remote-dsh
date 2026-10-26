/**
 * pg.ts — 43-hub-postgres 43b：PostgreSQL 连接池 / 迁移 / 事务基础设施。
 *
 * 43b-1：`createPgPool`（显式池参数 + GUC 超时）、`migratePg`（schema_migrations + 编号 SQL）、
 * `withTransaction`（client 级事务，替代 SQLite 的 `db.exec("BEGIN")`）。
 * `PgStore`（153 个方法的 SQL 端口）在 43b-2 落地，复用本模块的连接与事务。
 */
import { Pool, type PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const txStore = new AsyncLocalStorage<PoolClient>();

/** 迁移串行化锁 key（session 级 advisory lock，覆盖整个迁移循环）。 */
const MIGRATION_LOCK_KEY = "rdsh_migrate_pg";
/** 连接池 lock_timeout（毫秒）；迁移时临时放宽、结束后恢复，避免 SET 泄漏到被复用的连接。 */
const POOL_LOCK_TIMEOUT_MS = 2000;

/**
 * 事务感知的查询句柄：在 withTransaction 内返回当前 client，否则返回 pool。
 * 领域模块统一用 txDb(pool) 而不是裸 pool，事务内的方法调用就自动落在同一连接上。
 */
export function txDb(pool: Pool): Pool | PoolClient {
  return txStore.getStore() ?? pool;
}

export interface PgPoolOptions {
  /** 连接池上限（实例数 × pool.max 须低于 PG max_connections）。 */
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** API 语句超时（毫秒）；迁移/批处理走 withTransaction 时另行放宽。 */
  statementTimeoutMs?: number;
}

/** 显式配置连接池（43 req §6）：不做任何隐式默认。 */
export function createPgPool(connectionString: string, opts: PgPoolOptions = {}): Pool {
  const statementTimeout = opts.statementTimeoutMs ?? 5_000;
  return new Pool({
    connectionString,
    max: opts.max ?? 10,
    min: opts.min ?? 2,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    application_name: "rdsh-hub",
    // GUC 超时通过连接 options 下发（statement_timeout / idle_in_transaction / lock_timeout）。
    options: `-c statement_timeout=${statementTimeout} -c idle_in_transaction_session_timeout=10000 -c lock_timeout=${POOL_LOCK_TIMEOUT_MS}`,
  });
}

async function migrationsDir(): Promise<string> {
  // dist/ 与 migrations/ 相邻（见 package.json files）；npm 打包后仍可解析。
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "pg");
}

/**
 * 按序应用编号 SQL migrations；每文件一个事务 + schema_migrations 记录。
 * 并发安全（session 级 advisory lock 串行化多入口/多进程）+ 可审计（source/pid 落 schema_migrations）。
 */
export async function migratePg(pool: Pool, source = "unknown"): Promise<string[]> {
  const lock = await pool.connect();
  let savedStatementTimeout = "";
  try {
    // 迁移属长时操作：阻塞取锁与 0002/0013 的大表 ALTER 都可能超过池默认超时，
    // 故同时放宽 statement_timeout / lock_timeout（否则并发等待或长 DDL 会被「canceling statement due to timeout」掐断）。
    savedStatementTimeout = (await lock.query("SHOW statement_timeout")).rows[0].statement_timeout;
    await lock.query("SET statement_timeout = 0");
    await lock.query("SET lock_timeout = 0");
    await lock.query(`SELECT pg_advisory_lock(hashtext($1)::bigint)`, [MIGRATION_LOCK_KEY]);
    try {
      await lock.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at bigint NOT NULL)`);
      await lock.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS source text`);
      await lock.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS pid integer`);
      const dir = await migrationsDir();
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      const applied: string[] = [];
      for (const f of files) {
        const done = await lock.query("SELECT 1 FROM schema_migrations WHERE version = $1", [f]);
        if ((done.rowCount ?? 0) > 0) continue;
        const sql = readFileSync(join(dir, f), "utf8");
        try {
          await lock.query("BEGIN");
          await lock.query(sql);
          await lock.query(
            "INSERT INTO schema_migrations (version, applied_at, source, pid) VALUES ($1, $2, $3, $4)",
            [f, Date.now(), source, process.pid],
          );
          await lock.query("COMMIT");
          applied.push(f);
        } catch (err) {
          await lock.query("ROLLBACK");
          throw err;
        }
      }
      if (applied.length > 0) {
        console.log(`[hub] migrations applied: ${applied.join(", ")} (source=${source}, pid=${process.pid})`);
      }
      return applied;
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    // 对称恢复池的 GUC 超时，避免 SET 泄漏到被复用的连接。
    if (savedStatementTimeout) {
      await lock.query("SET statement_timeout = $1", [savedStatementTimeout]).catch(() => {});
    }
    await lock.query(`SET lock_timeout = ${POOL_LOCK_TIMEOUT_MS}`).catch(() => {});
    lock.release();
  }
}

/** client 级事务；异常回滚并重抛（替代 SQLite `db.exec("BEGIN/COMMIT/ROLLBACK")`）。 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const outer = txStore.getStore();
  if (outer !== undefined) {
    // 嵌套事务 → SAVEPOINT（与 SQLite 的 SAVEPOINT 可嵌套语义对齐；见 db.ts appendCreditLedger）。
    await outer.query("SAVEPOINT rdsh_sp");
    try {
      const result = await fn(outer);
      await outer.query("RELEASE SAVEPOINT rdsh_sp");
      return result;
    } catch (err) {
      await outer.query("ROLLBACK TO SAVEPOINT rdsh_sp");
      await outer.query("RELEASE SAVEPOINT rdsh_sp");
      throw err;
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await txStore.run(client, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
