/**
 * pg-store/index.ts — 43b-2：组装各领域模块为完整 `HubStore`（PostgreSQL 实现）。
 */
import type { Pool } from "pg";
import { withTransaction } from "../pg.ts";
import type { HubStore } from "../store.ts";
import { users } from "./users.ts";
import { hosts } from "./hosts.ts";
import { tokens } from "./tokens.ts";
import { codes } from "./codes.ts";
import { billing } from "./billing.ts";
import { credits } from "./credits.ts";
import { usage } from "./usage.ts";
import { nodes } from "./nodes.ts";

/** 由连接池构造 PostgreSQL 版 `HubStore`（供 `startHubServer` 在 `db.driver=postgres` 时使用）。 */
export function createPgStore(pool: Pool): HubStore {
  return {
    ...users(pool),
    ...hosts(pool),
    ...tokens(pool),
    ...codes(pool),
    ...billing(pool),
    ...credits(pool),
    ...usage(pool),
    ...nodes(pool),
    withTransaction: (fn) => withTransaction(pool, async (client) => fn(client)),
    close: async () => {
      await pool.end();
    },
    // backupTo 是 SQLite 的 VACUUM INTO；PostgreSQL 走 pg_dump（43c 迁移工具 / 托管备份）。
    backupTo: async (_targetPath: string) => {
      throw new Error("backupTo is SQLite-only; use pg_dump for PostgreSQL");
    },
  } as HubStore;
}
