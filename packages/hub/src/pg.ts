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
    options: `-c statement_timeout=${statementTimeout} -c idle_in_transaction_session_timeout=10000 -c lock_timeout=2000`,
  });
}

async function migrationsDir(): Promise<string> {
  // dist/ 与 migrations/ 相邻（见 package.json files）；npm 打包后仍可解析。
  return join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "pg");
}

/** 按序应用编号 SQL migrations；每文件一个事务 + schema_migrations 记录（幂等）。 */
export async function migratePg(pool: Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at bigint NOT NULL)`);
  const dir = await migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [f]);
    if ((done.rowCount ?? 0) > 0) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [f, Date.now()]);
      await client.query("COMMIT");
      applied.push(f);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
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
