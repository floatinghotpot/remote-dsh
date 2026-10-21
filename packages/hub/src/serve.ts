/**
 * serve.ts — `rdsh-hub serve` 编排：config → DB → JWT 密钥 → TLS → 服务器 → 生命周期。
 *
 * 43b：支持两种后端——sqlite（默认，HubDb）与 postgres（pg 连接池 + createPgStore）。
 * 定时任务全部走异步 store；SQLite 专属的 VACUUM 备份仅在 sqlite 后端启用。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { loadHubConfig, resolveHubConfigPath } from "./config.ts";
import { HubDb } from "./db.ts";
import type { UserRow } from "./db.ts";
import { Jwt } from "./jwt.ts";
import { HubAuth } from "./auth.ts";
import { TunnelRegistry } from "./tunnel.ts";
import { EventHub } from "./events.ts";
import { startHubServer, loadHubTls } from "./server.ts";
import { createSqliteStore, type HubStore } from "./store.ts";
import { createPgPool, migratePg } from "./pg.ts";
import { createPgStore } from "./pg-store/index.ts";
import { defaultPortalDir } from "./portal.ts";
import { backupNow, pruneBackups } from "./backup.ts";
import { loadHostCookieSigner } from "./hostcookie.ts";

/**
 * Q9：用户缓存同步失效——包装用户写方法，写后回读最新 UserRow 写回缓存。
 * verifyAccess 只依赖 ver + accountStatus，故改密/封禁/解锁/删除即时生效。
 */
function wrapUserMutations(store: HubStore, cache: Map<number, UserRow>): HubStore {
  const MUTATE: Array<keyof HubStore> = [
    "setPassword", "bumpVersion", "setAccountStatus", "deleteAccount", "removeUser",
    "setTotpSecret", "clearTotpSecret", "setRole", "lockAccount", "unlockAccount",
    "setEmail", "setPhone", "bindWechat", "bindWechatApp", "bindApple",
    "clearWechat", "clearEmail", "clearPhone", "clearApple", "setPlan", "setFreeSince",
    "setEmailVerified", "setPhoneVerified",
  ];
  const wrapped = { ...store } as HubStore;
  for (const m of MUTATE) {
    const orig = (store as unknown as Record<string, unknown>)[m];
    if (typeof orig !== "function") continue;
    (wrapped as unknown as Record<string, unknown>)[m] = async (...args: unknown[]) => {
      const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(store, args);
      const id = args[0];
      if (typeof id === "number") {
        const fresh = await store.getUserById(id);
        if (fresh !== null) cache.set(id, fresh);
        else cache.delete(id);
      }
      return result;
    };
  }
  return wrapped;
}

export interface HubServeOptions {
  configPath?: string;
  host?: string;
  port?: number;
}

/** 读取或生成 JWT 签名密钥（0600，自动创建）。 */
export async function loadJwtKey(path: string): Promise<Buffer> {
  try {
    return Buffer.from(await readFile(path, "utf8"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(dirname(path), { recursive: true });
    const key = randomBytes(32);
    await writeFile(path, key.toString("base64url"), { mode: 0o600 });
    return key;
  }
}

/** 启动 hub 服务器。进程常驻：SIGINT/SIGTERM 优雅退出。 */
export async function serveHub(opts: HubServeOptions): Promise<void> {
  const configPath = resolveHubConfigPath(opts.configPath);
  const config = await loadHubConfig(configPath);
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;

  // behindProxy：反代终止 TLS，hub 监听 http（无需证书）
  const tls = config.behindProxy ? undefined : await loadHubTls(config.tls);

  // ---- 后端选择：sqlite（默认） / postgres ----
  const driver = config.db?.driver ?? "sqlite";
  let db: HubDb | undefined;
  let store: HubStore;
  let cache: Map<number, UserRow> | undefined;
  let lookupUser: (id: number) => UserRow | null;
  let dbLabel: string;
  let dbSize: (() => Promise<number>) | undefined;
  if (driver === "postgres") {
    const pool = createPgPool(config.db?.dsn ?? "");
    await migratePg(pool);
    dbSize = async () => Number((await pool.query("SELECT pg_database_size(current_database()) AS s")).rows[0]!.s);
    // Q9：用户缓存（预加载 + 5s 刷新 + 写路径同步失效）。
    cache = new Map<number, UserRow>();
    const cacheRef = cache;
    store = wrapUserMutations(createPgStore(pool), cacheRef);
    const reload = async (): Promise<void> => {
      for (const u of await store.listUsers()) cacheRef.set(u.id, u);
    };
    await reload();
    setInterval(() => void reload(), 5000).unref();
    lookupUser = (id) => cacheRef.get(id) ?? null;
    dbLabel = config.db?.dsn?.replace(/(\/\/[^:]+:)[^@]*@/, "$1***@") ?? "";
  } else {
    db = new HubDb(config.dbPath);
    store = createSqliteStore(db);
    lookupUser = (id) => db!.getUserById(id);
    dbLabel = config.dbPath;
  }

  // ---- 定时任务（异步 store）----
  const auditRetentionMs = (config.security?.auditRetentionDays ?? 90) * 24 * 3600 * 1000;
  const pruneAudit = async (): Promise<void> => { await store.pruneAudit(Date.now() - auditRetentionMs); };
  void pruneAudit();
  setInterval(() => void pruneAudit(), 24 * 3600 * 1000).unref();
  const markNodesOffline = async (): Promise<void> => { await store.markNodesOffline(Date.now() - 90_000); };
  setInterval(() => void markNodesOffline(), 30_000).unref();
  const pruneBindSessions = async (): Promise<void> => { await store.pruneExpiredBindSessions(); };
  void pruneBindSessions();
  setInterval(() => void pruneBindSessions(), 10 * 60 * 1000).unref();
  const pruneJoinTokens = async (): Promise<void> => { await store.pruneExpiredJoinTokens(); };
  void pruneJoinTokens();
  setInterval(() => void pruneJoinTokens(), 24 * 3600 * 1000).unref();

  // 每日快照备份（SQLite 专属 VACUUM INTO；postgres 走托管 pg_dump / 43c）
  const backupDir = config.backup?.dir ?? join(dirname(config.dbPath), "backups");
  const backupKeepDays = config.backup?.keepDays ?? 7;
  if (db !== undefined) {
    const runBackup = (): void => {
      try {
        backupNow(db!, backupDir);
        pruneBackups(backupDir, backupKeepDays);
      } catch (err) {
        console.error(`[hub] backup failed:`, err instanceof Error ? err.message : err);
      }
    };
    setInterval(runBackup, 24 * 3600 * 1000).unref();
  }

  const jwt = new Jwt(await loadJwtKey(config.jwtKeyPath));
  const hostCookieSigner = loadHostCookieSigner(join(dirname(config.jwtKeyPath), "hub-hostcookie.key"));
  config.hostCookiePubKey = hostCookieSigner.publicKeyHex;
  const auth = new HubAuth(store, lookupUser, jwt, config.security, hostCookieSigner, driver === "postgres" ? (u) => cache?.set(u.id, u) : undefined);
  const tunnels = new TunnelRegistry();
  const events = new EventHub();

  const portalDir = defaultPortalDir();
  const { server, actualPort } = await startHubServer({
    host,
    port,
    tls,
    behindProxy: config.behindProxy,
    db,
    store,
    dbSize,
    auth,
    tunnels,
    events,
    portalDir,
    email: config.email,
    captcha: config.captcha,
    security: config.security,
    sms: config.sms,
    registration: config.registration,
    registrationDailyLimit: config.registrationDailyLimit,
    registrationMaxUsers: config.registrationMaxUsers,
    billing: config.billing,
    site: config.site,
    wechatLogin: config.wechatLogin,
    wechatAppLogin: config.wechatAppLogin,
    appSchemes: config.appSchemes,
    appleLogin: config.appleLogin,
    e2ee: config.e2ee,
    backup: { dir: backupDir, keepDays: backupKeepDays },
    relayNodeToken: config.relayNodeToken,
    hostCookiePubKey: config.hostCookiePubKey,
    hostCookieDomain: config.hostCookieDomain,
    defaultRelayUrl: config.defaultRelayUrl,
    hostCookieSigner,
  });

  const scheme = tls ? "https" : "http";
  const regMode = config.registration === "open" ? "registration open" : "registration closed (admin creates users)";
  console.log(`rdsh-hub serve: hub on ${scheme}://${host === "0.0.0.0" ? "0.0.0.0" : host}:${actualPort}`);
  console.log(`rdsh-hub serve: db: ${dbLabel}`);
  console.log(`rdsh-hub serve: portal: ${portalDir}`);
  console.log(`rdsh-hub serve: users managed via 'rdsh-hub user add|rm|ls' — ${regMode}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nrdsh: received ${signal}, shutting down...`);
    server.close();
    db?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  // 常驻：进程靠信号退出（shutdown 里 process.exit）；防止函数返回后
  // CLI 的 main().then(exit) 误退出服务进程
  await new Promise<void>(() => {});
}
