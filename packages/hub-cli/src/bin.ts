#!/usr/bin/env node
/**
 * rdsh-hub CLI 入口（手写参数解析，零新增依赖）。
 *
 *   rdsh-hub setup              Configure this hub (db backend + TLS) and write hub.json
 *   rdsh-hub serve              Start the hub server (cloud, multi-host)
 *   rdsh-hub user add|passwd|rm|ls|unlock|reset-2fa|ban|unban
 *   rdsh-hub audit ls [--user <n>] [--event <e>] [--since 24h|7d]
 *   rdsh-hub host ls|revoke
 *   rdsh-hub db migrate|verify|check
 *   rdsh-hub service install|status|start|stop|restart|uninstall
 *   rdsh-hub --version | --help
 *
 * 说明：由 `remote-dsh` 拆出（feature 47）；`setup`/`db` 与 backend-aware
 * 管理命令见 feature 48。服务单元工具复用 `rdsh-gateway` 的 installService。
 */
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadHubConfig,
  resolveHubConfigPath,
  HubDb,
  hashPassword,
  serveHub,
  createPgPool,
  migratePg,
  createPgStore,
  createSqliteStore,
  migrateSqliteToPg,
  verify,
} from "rdsh-hub";
import type { HubServeOptions, HubStore } from "rdsh-hub";
import {
  installService,
  uninstallService,
  serviceStatus,
  startService,
  stopService,
  restartService,
  HUB_SERVICE_NAME,
} from "rdsh-gateway";
import { VERSION } from "./index.js";

const HELP = `rdsh-hub — run and manage the rdsh hub server

Usage:
  rdsh-hub setup              Configure this hub (db backend + TLS) and write hub.json
  rdsh-hub serve              Start the hub server (cloud, multi-host)
  rdsh-hub user add|passwd|rm|ls|unlock|reset-2fa|ban|unban   Manage users (admin creates accounts)
  rdsh-hub audit ls           Audit log (login/2FA/sharing/email events)
  rdsh-hub host ls|revoke     List / revoke hosts (revoke drops the tunnel instantly)
  rdsh-hub db migrate|verify|check   Database: migrate SQLite->PG, verify, health check
  rdsh-hub service ...        Run hub as a systemd/launchd service

Global:
  --config <path>             Hub config (default ~/.rdsh/hub.json; also $RDSH_HUB_CONFIG)
  --version, -v               Print version
  --help, -h                  Print this help
`;

/** 子命令级用法（`rdsh-hub <cmd> --help`）。 */
const SUB_HELP: Record<string, string> = {
  serve: `Usage: rdsh-hub serve [options]

Start the hub server (cloud, multi-host).

Options:
  --config <path>   Hub config (default ~/.rdsh/hub.json; also $RDSH_HUB_CONFIG)
  --port <n>        Listen port (overrides hub config; default 8443)
  --host <ip>       Bind address (overrides hub config; default 0.0.0.0)
`,
  user: `Usage: rdsh-hub user <action>

Manage users (admin creates accounts; unlock / reset-2fa / ban / unban).

Actions:
  add <name> [--role <user|readonly|operator|admin>]   Create a user (admin)
  passwd <name>                                          Reset a user's password
  rm <name>                                              Remove a user (their hosts removed)
  ls                                                     List users
  unlock <name>                                          Unlock a locked account
  reset-2fa <name>                                       Reset a user's 2FA (sessions revoked)
  ban <name>                                             Ban a user
  unban <name>                                           Unban a user
`,
  audit: `Usage: rdsh-hub audit ls [--user <name>] [--event <e>] [--since 24h|7d]

Query the audit log.
`,
  host: `Usage: rdsh-hub host ls|revoke

List / revoke hosts (revoke drops the tunnel instantly).

Actions:
  ls                    List all hosts
  revoke <hostId>       Revoke a host (tunnel drops, reconnects rejected)
`,
  service: `Usage: rdsh-hub service install|status|start|stop|restart|uninstall

Run hub as a systemd/launchd service.
`,
  setup: `Usage: rdsh-hub setup [options]

Configure this hub and write hub.json.

Options:
  --db sqlite|postgres   Database backend (default sqlite)
  --dsn <...>            PostgreSQL DSN (required for --db postgres)
  --tls-cert <p>         TLS certificate path (with --tls-key)
  --tls-key <p>          TLS key path (with --tls-cert)
  --behind-proxy         Run behind a TLS-terminating reverse proxy
  --force                Overwrite an existing hub.json
`,
  db: `Usage: rdsh-hub db <action>

Database administration.

Actions:
  migrate --source <hub.db> [--dsn <...>] [--backup-dir <dir>] [--dry-run]
      One-step SQLite->PostgreSQL migration (preflight + backup + copy + verify).
  verify --source <hub.db> [--dsn <...>]
      Re-verify a migrated database (row counts + ledger + FK + sample).
  check
      Print the current db backend, connectivity and migration status.
`,
};

/** 参数里是否有 --help / -h。 */
function hasHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

interface CliOptions {
  configPath?: string;
  flags: string[];
}

/** 与 packages/cli/src/bin.ts 的 parseGlobal 保持同步。 */
function parseGlobal(argv: string[]): CliOptions {
  const flags: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      i += 1;
      configPath = argv[i];
      if (configPath === undefined) throw new Error("missing value for --config");
    } else {
      flags.push(argv[i]!);
    }
  }
  return { configPath, flags };
}

/** 打开 hub 数据访问层（backend-aware：sqlite→SqliteStore，postgres→PgStore）。 */
async function openHubStore(configPath?: string): Promise<HubStore> {
  const hubConfigPath = resolveHubConfigPath(configPath);
  const config = await loadHubConfig(hubConfigPath);
  const driver = config.db?.driver ?? "sqlite";
  if (driver === "postgres") {
    const pool = createPgPool(config.db?.dsn ?? "");
    try {
      await migratePg(pool); // 幂等：未 serve 时也能保证 schema 就绪
    } catch (err) {
      await pool.end();
      throw err;
    }
    return createPgStore(pool);
  }
  return createSqliteStore(new HubDb(config.dbPath));
}

/** `rdsh-hub audit ls [--user <name>] [--event <e>] [--since 24h|7d]`。 */
async function handleHubAudit(args: string[], configPath?: string): Promise<void> {
  const store = await openHubStore(configPath);
  try {
    // 兼容 `audit ls` 与 `audit`（ls 为可选位置参数）
    const opts = args[0] === "ls" ? args.slice(1) : args;
    const filter: { userId?: number; event?: string; since?: number } = {};
    for (let i = 0; i < opts.length; i++) {
      const flag = opts[i];
      if (flag === "--user") {
        const name = opts[++i];
        if (name === undefined) throw new Error("missing value for --user");
        const u = await store.getUserByName(name);
        if (u === null) throw new Error(`user '${name}' not found`);
        filter.userId = u.id;
      } else if (flag === "--event") {
        filter.event = opts[++i];
        if (filter.event === undefined) throw new Error("missing value for --event");
      } else if (flag === "--since") {
        const v = opts[++i];
        if (v === undefined) throw new Error("missing value for --since");
        const m = /^(\d+)([hd])$/.exec(v);
        if (m === null) throw new Error(`invalid --since '${v}' (use like 24h or 7d)`);
        filter.since = Date.now() - Number(m[1]) * (m[2] === "h" ? 3_600_000 : 86_400_000);
      } else {
        throw new Error(`unknown option '${flag}'`);
      }
    }
    const events = await store.listAudit(filter);
    if (events.length === 0) {
      console.log("(no events)");
      return;
    }
    for (const e of events) {
      const user = e.userId !== null ? await store.getUserById(e.userId) : null;
      console.log(`${new Date(e.createdAt).toISOString()}  ${user?.name ?? "-"}  ${e.event}  ip=${e.ip}  ${e.detailJson}`);
    }
  } finally {
    await store.close();
  }
}

async function handleHub(args: string[], configPath?: string): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "setup": {
      await handleSetup(rest, configPath);
      return;
    }
    case "serve": {
      const opts = parseHubServeArgs(rest, configPath);
      await serveHub(opts);
      return;
    }
    case "user": {
      await handleHubUser(rest, configPath);
      return;
    }
    case "host": {
      await handleHubHost(rest, configPath);
      return;
    }
    case "audit": {
      await handleHubAudit(rest, configPath);
      return;
    }
    case "db": {
      await handleDb(rest, configPath);
      return;
    }
    case "service": {
      const action = rest[0];
      const hubConfigPath = resolveHubConfigPath(configPath);
      switch (action) {
        case "install":
          console.log(await installService({ name: HUB_SERVICE_NAME, args: ["serve"], configPath: hubConfigPath }));
          console.log(`rdsh-hub: hub service installed (${HUB_SERVICE_NAME}) —— 开机自启 + 崩溃重启。`);
          return;
        case "status":
          console.log(`rdsh-hub service (${HUB_SERVICE_NAME}): ${await serviceStatus(HUB_SERVICE_NAME)}`);
          return;
        case "start":
          console.log(await startService(HUB_SERVICE_NAME));
          return;
        case "stop":
          console.log(await stopService(HUB_SERVICE_NAME));
          return;
        case "restart":
          console.log(await restartService(HUB_SERVICE_NAME));
          return;
        case "uninstall":
          console.log(await uninstallService(HUB_SERVICE_NAME));
          return;
        default:
          throw new Error("usage: rdsh-hub service install|status|start|stop|restart|uninstall");
      }
    }
    default:
      throw new Error("usage: rdsh-hub setup|serve|user|host|audit|db|service");
  }
}

function parseHubServeArgs(args: string[], configPath?: string): HubServeOptions {
  const opts: HubServeOptions = { configPath };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = (name: string): string => {
      i += 1;
      if (i >= args.length) throw new Error(`missing value for ${name}`);
      return args[i] ?? "";
    };
    switch (flag) {
      case "--port": {
        const v = Number(value(flag));
        if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error(`invalid --port '${args[i]}'`);
        opts.port = v;
        break;
      }
      case "--host":
        opts.host = value(flag);
        break;
      default:
        throw new Error(`unknown option '${flag}'`);
    }
  }
  return opts;
}

/** 交互输入密码两次（一致校验）；不匹配重试（最多 3 次），仍失败抛错。
 * 与 packages/cli/src/bin.ts 保持同步。 */
async function promptPasswordTwice(firstPrompt: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const password = await promptPassword(firstPrompt);
    const again = await promptPassword("confirm: ");
    if (password === again) {
      if (password.length < 8) throw new Error("password must be at least 8 characters");
      return password;
    }
    console.error(`passwords do not match (attempt ${attempt}/3), try again`);
  }
  throw new Error("passwords do not match after 3 attempts");
}

async function handleHubUser(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const store = await openHubStore(configPath);
  try {
    switch (action) {
      case "add": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh-hub user add <name> [--role <user|readonly|operator|admin>]");
        const roleIdx = args.indexOf("--role");
        const role = roleIdx >= 0 && args[roleIdx + 1] !== undefined ? args[roleIdx + 1]! : "user";
        if (!["user", "readonly", "operator", "admin"].includes(role)) throw new Error(`invalid role '${role}' (user|readonly|operator|admin)`);
        if (await store.getUserByName(name) !== null) throw new Error(`user '${name}' already exists`);
        // 建号即设初始密码（安全修复 F1：不再提供 --no-password 公开首密码激活路径，防账号抢占）
        const user = await store.createUser(name, await hashPassword(await promptPasswordTwice(`password for ${name}: `)));
        if (role !== "user") await store.setRole(user.id, role);
        console.log(`rdsh-hub: user '${name}' created (role: ${role})`);
        return;
      }
      case "passwd": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh-hub user passwd <name>");
        const user = await store.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        const password = await promptPasswordTwice(`new password for ${name}: `);
        await store.setPassword(user.id, await hashPassword(password));
        console.log(`rdsh-hub: password reset for '${name}' (all their sessions revoked)`);
        return;
      }
      case "ls": {
        const users = await store.listUsers();
        console.log(users.length > 0 ? users.map((u) => `${u.name}\t${u.role}`).join("\n") : "(no users)");
        return;
      }
      case "rm": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh-hub user rm <name>");
        const user = await store.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        await store.removeUser(user.id);
        console.log(`rdsh-hub: user '${name}' removed (their hosts removed)`);
        return;
      }
      case "unlock": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh-hub user unlock <name>");
        const user = await store.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        await store.unlockAccount(user.id);
        console.log(`rdsh-hub: user '${name}' unlocked`);
        return;
      }
      case "reset-2fa": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh-hub user reset-2fa <name>");
        const user = await store.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        await store.clearTotpSecret(user.id);
        await store.bumpVersion(user.id);
        console.log(`rdsh-hub: 2FA reset for '${name}' (their sessions revoked)`);
        return;
      }
      case "ban": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh-hub user ban <name>");
        const user = await store.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        await store.setAccountStatus(user.id, "banned");
        console.log(`rdsh-hub: user '${name}' banned (login + host access blocked)`);
        return;
      }
      case "unban": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh-hub user unban <name>");
        const user = await store.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        await store.setAccountStatus(user.id, "active");
        console.log(`rdsh-hub: user '${name}' unbanned (plan restored)`);
        return;
      }
      default:
        throw new Error("usage: rdsh-hub user add|passwd|ls|rm|unlock|reset-2fa|ban|unban");
    }
  } finally {
    await store.close();
  }
}

async function handleHubHost(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const store = await openHubStore(configPath);
  try {
    switch (action) {
      case "ls": {
        const hosts = await store.listAllHosts();
        if (hosts.length === 0) {
          console.log("(no hosts)");
        } else {
          for (const h of hosts) {
            const owner = await store.getUserById(h.ownerId);
            console.log(`${h.id}  ${h.name}  owner=${owner?.name ?? h.ownerId}  created=${h.createdAt}`);
          }
        }
        return;
      }
      case "revoke": {
        const hostId = args[1];
        if (hostId === undefined) throw new Error("usage: rdsh-hub host revoke <hostId>");
        const host = await store.getHostById(hostId);
        if (host === null) throw new Error(`host '${hostId}' not found`);
        await store.removeHost(hostId);
        console.log(`rdsh-hub: host '${hostId}' revoked — its tunnel will drop and reconnects are rejected`);
        return;
      }
      default:
        throw new Error("usage: rdsh-hub host ls|revoke <hostId>");
    }
  } finally {
    await store.close();
  }
}

/** 解析 `--flag <value>`（区分于位置参数）。 */
function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 原子写文件：先写临时文件再 rename，避免半成品。 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

/** 读取一行（echo）。用于 DSN——注意 DSN 含密码，会回显在终端。与 packages/cli/src/bin.ts 保持同步。 */
function promptLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** `rdsh-hub setup`：选库 + 校验 + 建表 + 写 hub.json（原子）。 */
async function handleSetup(args: string[], configPath?: string): Promise<void> {
  let backend = arg(args, "--db");
  if (backend === undefined && process.stdin.isTTY) {
    const ans = (await promptLine("数据库后端？sqlite（默认）/ postgres：")).trim().toLowerCase();
    backend = ans === "" || ans === "sqlite" || ans === "1" ? "sqlite" : ans === "postgres" || ans === "2" ? "postgres" : (() => { throw new Error(`无效选择 '${ans}'`); })();
  }
  backend ??= "sqlite";
  if (backend !== "sqlite" && backend !== "postgres") {
    throw new Error("usage: rdsh-hub setup [--db sqlite|postgres] [--dsn <...>] [--tls-cert <p> --tls-key <p> | --behind-proxy] [--force]");
  }
  let dsn = arg(args, "--dsn");
  const tlsCert = arg(args, "--tls-cert");
  const tlsKey = arg(args, "--tls-key");
  const behindProxy = args.includes("--behind-proxy");
  const force = args.includes("--force");
  const hubConfigPath = resolveHubConfigPath(configPath);

  if (existsSync(hubConfigPath) && !force) {
    throw new Error(`${hubConfigPath} already exists; pass --force to overwrite`);
  }
  const tls = tlsCert !== undefined || tlsKey !== undefined;
  if (tls && (tlsCert === undefined || tlsKey === undefined)) {
    throw new Error("--tls-cert and --tls-key must be provided together");
  }
  if (!tls && !behindProxy) {
    throw new Error("TLS required: pass --tls-cert/--tls-key or --behind-proxy");
  }

  if (backend === "postgres") {
    if (dsn === undefined) {
      if (!process.stdin.isTTY) throw new Error("postgres requires --dsn <...> (non-interactive)");
      dsn = (await promptLine("PostgreSQL DSN (postgres://user:pass@host:5432/db): ")).trim();
      if (dsn === "") throw new Error("DSN is required for postgres");
    }
    const pool = createPgPool(dsn, { connectionTimeoutMillis: 8000 });
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      await pool.end();
      throw new Error(`postgres unreachable: ${(err as Error).message}\n  create it first, e.g.: CREATE ROLE rdsh LOGIN PASSWORD '...'; CREATE DATABASE rdsh OWNER rdsh;`);
    }
    try {
      await migratePg(pool);
    } finally {
      await pool.end();
    }
  }

  const config: Record<string, unknown> = {};
  if (backend === "postgres") config.db = { driver: "postgres", dsn };
  if (behindProxy) config.behindProxy = true;
  if (tls) config.tls = { cert: tlsCert, key: tlsKey };

  await writeFileAtomic(hubConfigPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`rdsh-hub: hub config written → ${hubConfigPath}`);
  console.log(`rdsh-hub: db backend = ${backend}${backend === "postgres" ? "（schema 已建）" : "（默认 ~/.rdsh/hub.db，serve 时自动建库）"}`);
}

/** `rdsh-hub db migrate|verify|check`。 */
async function handleDb(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const rest = args.slice(1);
  const hubConfigPath = resolveHubConfigPath(configPath);
  const config = await loadHubConfig(hubConfigPath);

  switch (action) {
    case "migrate": {
      const source = arg(rest, "--source");
      if (source === undefined) throw new Error("usage: rdsh-hub db migrate --source <hub.db> [--dsn <...>] [--backup-dir <dir>] [--dry-run]");
      const dsn = arg(rest, "--dsn") ?? config.db?.dsn;
      if (dsn === undefined) throw new Error("missing DSN: set db.dsn in hub.json or pass --dsn <...>");
      const backupDir = arg(rest, "--backup-dir") ?? "./backups";
      const dryRun = rest.includes("--dry-run");
      const report = await migrateSqliteToPg({ source, dsn, backupDir, dryRun });
      console.log(JSON.stringify(report, null, 2));
      console.log("");
      console.log("cutover（切换步骤）：");
      console.log("  1) 停 Hub（维护/停写）。");
      console.log("  2) 把 hub.json 的 db.driver 设为 postgres + db.dsn=<PG DSN>。");
      console.log("  3) 启动 Hub，冒烟（登录 / 主机列表 / 用量 / 账本）。");
      console.log("");
      console.log("rollback（回滚步骤）：");
      console.log("  1) 停 Hub。");
      console.log("  2) 恢复 SQLite：cp <backup 快照> <hub.db>（快照路径见 report.backup.snapshot）。");
      console.log("  3) 把 hub.json 的 db.driver 改回 sqlite（或移除 db.dsn）。");
      console.log("  4) 启动 Hub，验证数据回到迁移前。");
      return;
    }
    case "verify": {
      const source = arg(rest, "--source");
      if (source === undefined) throw new Error("usage: rdsh-hub db verify --source <hub.db> [--dsn <...>]");
      const dsn = arg(rest, "--dsn") ?? config.db?.dsn;
      if (dsn === undefined) throw new Error("missing DSN: set db.dsn in hub.json or pass --dsn <...>");
      const ver = await verify(source, dsn);
      console.log(JSON.stringify(ver, null, 2));
      if (ver.ok !== true) process.exitCode = 1;
      return;
    }
    case "check": {
      const driver = config.db?.driver ?? "sqlite";
      if (driver === "sqlite") {
        console.log("db backend: sqlite");
        console.log(`db path   : ${config.dbPath}${existsSync(config.dbPath) ? " (exists)" : " (not created yet — created on serve)"}`);
      } else {
        const pool = createPgPool(config.db?.dsn ?? "", { connectionTimeoutMillis: 8000 });
        try {
          await pool.query("SELECT 1");
        } catch (err) {
          console.log("db backend: postgres");
          console.log(`connect   : FAILED — ${(err as Error).message}`);
          process.exitCode = 1;
          await pool.end();
          return;
        }
        console.log("db backend: postgres");
        console.log("connect   : ok");
        let applied = "unknown";
        try {
          applied = String((await pool.query("SELECT COUNT(*) AS c FROM schema_migrations")).rows[0]?.c ?? "?");
        } catch {
          applied = "0（schema_migrations 不存在，尚未迁移）";
        }
        console.log(`migrations: ${applied}`);
        await pool.end();
      }
      return;
    }
    default:
      throw new Error("usage: rdsh-hub db migrate|verify|check");
  }
}

/** 隐藏输入（TTY raw mode；非 TTY 走管道逐行）。与 packages/cli/src/bin.ts 保持同步。 */
function promptPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    return new Promise<string>((resolve) => {
      let input = "";
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 13 || byte === 10) {
            stdin.removeListener("data", onData);
            if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
            process.stdout.write("\n");
            resolve(input);
            return;
          }
          if (byte === 127 || byte === 8) {
            input = input.slice(0, -1);
            continue;
          }
          input += String.fromCharCode(byte);
        }
      };
      stdin.on("data", onData);
    });
  }
  // 非 TTY（管道/重定向）：一次性读完 stdin（EOF），逐行消费。
  process.stdout.write(prompt);
  return nextPipeLine();
}

let pipeLines: string[] | null = null;

function nextPipeLine(): Promise<string> {
  if (pipeLines !== null) {
    return Promise.resolve(pipeLines.shift() ?? "");
  }
  pipeLines = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return new Promise<string>((resolve) => {
    rl.on("line", (l) => pipeLines!.push(l));
    rl.on("close", () => resolve(pipeLines!.shift() ?? ""));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`rdsh-hub ${VERSION}`);
    return;
  }
  // 全局解析：先剥 --config <path>（允许出现在任何位置），剩余为子命令参数
  const cli = parseGlobal(argv);
  const command = cli.flags[0];
  const rest = cli.flags.slice(1);
  if (command === undefined) {
    console.error("rdsh-hub: missing command. Run 'rdsh-hub --help'.");
    process.exitCode = 1;
    return;
  }
  try {
    if (hasHelp(rest)) {
      console.log(SUB_HELP[command] ?? HELP);
      return;
    }
    await handleHub([command, ...rest], cli.configPath);
  } catch (err) {
    console.error(`rdsh-hub: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// 常驻命令（serve）不 resolve，靠信号退出；管理命令完成后显式退出。
void main().then(() => process.exit(process.exitCode ?? 0));
