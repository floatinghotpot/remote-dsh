/**
 * 43b：Hub 端到端启动在 PostgreSQL（无 SQLite）。跳过条件：PG 不可达。
 * 用 createPgStore 作为 store、无 HubDb，起 startHubServer 并访问公开端点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migratePg } from "../src/pg.ts";
import { createPgStore } from "../src/pg-store/index.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { UserRow } from "../src/db.ts";

const DSN = process.env.RDSH_TEST_PG_DSN ?? "postgres://rdsh:rdsh_dev_password@127.0.0.1:5432/rdsh_boot";

test("Hub boots on PostgreSQL (no SQLite)", async (t) => {
  const pool = createPgPool(DSN, { max: 3, min: 0 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    t.skip("PostgreSQL unreachable");
    return;
  }
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migratePg(pool);
    const store = createPgStore(pool);
    const cache = new Map<number, UserRow>();
    for (const u of await store.listUsers()) cache.set(u.id, u);
    const auth = new HubAuth(store, (id) => cache.get(id) ?? null, new Jwt(Buffer.from("test-key-0123456789abcdef")));
    const server = await startHubServer({
      host: "127.0.0.1",
      port: 0,
      store,
      auth,
      tunnels: new TunnelRegistry(),
      events: new EventHub(),
      portalDir: "/nonexistent-portal",
    });

    const res = await fetch(`http://127.0.0.1:${server.actualPort}/api/capabilities`);
    assert.equal(res.status, 200, "public endpoint serves on PG");

    await new Promise<void>((r) => server.server.close(() => r()));
    await pool.end();
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
});
