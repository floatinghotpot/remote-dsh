/**
 * serve.ts — `rdsh hub serve` 编排：config → DB → JWT 密钥 → TLS → 服务器 → 生命周期。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { loadHubConfig, resolveHubConfigPath } from "./config.ts";
import { HubDb } from "./db.ts";
import { Jwt } from "./jwt.ts";
import { HubAuth } from "./auth.ts";
import { TunnelRegistry } from "./tunnel.ts";
import { EventHub } from "./events.ts";
import { startHubServer, loadHubTls } from "./server.ts";
import { defaultPortalDir } from "./portal.ts";

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
  const db = new HubDb(config.dbPath);
  // 审计保留清理：启动清一次 + 每天清（R6 默认 90 天，可配置）
  const auditRetentionMs = (config.security?.auditRetentionDays ?? 90) * 24 * 3600 * 1000;
  const pruneAudit = (): void => db.pruneAudit(Date.now() - auditRetentionMs);
  pruneAudit();
  setInterval(pruneAudit, 24 * 3600 * 1000).unref();
  const jwt = new Jwt(await loadJwtKey(config.jwtKeyPath));
  const auth = new HubAuth(db, jwt, config.security);
  const tunnels = new TunnelRegistry();
  const events = new EventHub();

  const portalDir = defaultPortalDir();
  const { server, actualPort } = await startHubServer({
    host,
    port,
    tls,
    behindProxy: config.behindProxy,
    db,
    auth,
    tunnels,
    events,
    portalDir,
    email: config.email,
    captcha: config.captcha,
    security: config.security,
    sms: config.sms,
    registration: config.registration,
    billing: config.billing,
    beian: config.beian,
    site: config.site,
  });

  const scheme = tls ? "https" : "http";
  const regMode = config.registration === "open" ? "registration open" : "registration closed (admin creates users)";
  console.log(`rdsh hub serve: hub on ${scheme}://${host === "0.0.0.0" ? "0.0.0.0" : host}:${actualPort}`);
  console.log(`rdsh hub serve: db: ${config.dbPath}`);
  console.log(`rdsh hub serve: portal: ${portalDir}`);
  console.log(`rdsh hub serve: users managed via 'rdsh hub user add|rm|ls' — ${regMode}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nrdsh: received ${signal}, shutting down...`);
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  // 常驻：进程靠信号退出（shutdown 里 process.exit）；防止函数返回后
  // CLI 的 main().then(exit) 误退出服务进程
  await new Promise<void>(() => {});
}
