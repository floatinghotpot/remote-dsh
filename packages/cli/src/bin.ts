#!/usr/bin/env node
/**
 * rdsh CLI 入口（手写参数解析，零依赖）。
 *
 *   rdsh host setup lan|cloud
 *   rdsh host join <hub-url> [--token <t>] [--name <n>] [--dsh <p>] [--insecure]
 *   rdsh host serve | service install|status|uninstall | leave | user ...
 *   rdsh hub serve|user|host|service ... [--config <path>]
 *   rdsh --version | --help
 */
import { createInterface } from "node:readline";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  serve,
  join,
  registerJoin,
  findDsh,
  selfRevoke,
  readPersistedToken,
  clearPersistedToken,
  UserManager,
  resolveConfigPath,
  loadConfig,
  saveConfig,
  installService,
  uninstallService,
  serviceStatus,
  HOST_SERVICE_NAME,
  JOIN_SERVICE_NAME,
  HUB_SERVICE_NAME,
} from "rdsh-gateway";
import type { JoinOptions } from "rdsh-gateway";
import {
  loadHubConfig,
  resolveHubConfigPath,
  HubDb,
  hashPassword,
  serveHub,
} from "rdsh-hub";
import type { HubServeOptions } from "rdsh-hub";
import { VERSION } from "./index.js";

const HELP = `rdsh — secure remote access for DeepSeek Harness

Usage:
  rdsh host setup lan|cloud   Configure this machine (LAN / cloud HTTPS gateway)
  rdsh host join <hub-url>    Connect this machine to a hub (outbound tunnel)
  rdsh host serve             Run the configured mode in the foreground
  rdsh host service ...       Run as a systemd/launchd service
  rdsh host leave             Unregister this machine from the hub
  rdsh host user ...          Manage gateway users (LAN/cloud password auth)
  rdsh hub serve              Start the hub server (cloud, multi-host)
  rdsh hub user add|passwd|rm|ls|unlock|reset-2fa|ban|unban
  rdsh hub audit ls           Audit log (login/2FA/sharing/email events)
  rdsh hub host ls|revoke     List / revoke hosts (revoke drops the tunnel instantly)
  rdsh hub service ...        Run hub as a systemd/launchd service

Global:
  --config <path>             Host config (default ~/.rdsh/host.json; also $RDSH_CONFIG)
                              For hub commands: hub config (default ~/.rdsh/hub.json; also $RDSH_HUB_CONFIG)
  --version, -v               Print version
  --help, -h                  Print this help
`;

/** 子命令级用法（`rdsh <cmd> --help`）。 */
const SUB_HELP: Record<string, string> = {
  host: `Usage: rdsh host <subcommand>

Configure and run this machine (the DSH host).

Subcommands:
  setup lan              Configure a LAN gateway (pair auth, plain http)
  setup cloud            Configure a cloud HTTPS gateway (password + TLS + allowFrom)
  join <hub-url>         Connect to a hub (interactive token paste; --token for scripts)
  serve                  Run the configured mode in the foreground
  service install|status|uninstall   Run as a systemd/launchd service
  leave                  Unregister this machine from the hub
  user add|passwd|ls|rm  Manage gateway users

Options (setup lan):   --port <n> [--pair-code <code>]
Options (setup cloud):  --tls-cert <path> --tls-key <path> [--port <n>] [--allow-from <cidr,...>]
Options (join):         --token <t> --name <n> --dsh <path> --insecure
`,
  hub: `Usage: rdsh hub <subcommand> [options]

Run the hub server or manage it.

Subcommands:
  serve                 Start the hub server (TLS required)
  user add|passwd|rm|ls|unlock|reset-2fa|ban|unban   Manage users (admin creates accounts; unlock / reset-2fa / ban / unban)
  audit ls [--user <n>] [--event <e>] [--since 24h|7d]   Query the audit log
  host ls|revoke        List / revoke hosts (revoke drops the tunnel instantly)
  service install|status|uninstall   Run hub as a systemd/launchd service

Options (serve):
  --config <path>       Hub config (default ~/.rdsh/hub.json; also $RDSH_HUB_CONFIG)
  --port <n>            Listen port (overrides hub config; default 8443)
  --host <ip>           Bind address (overrides hub config; default 0.0.0.0)
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`rdsh ${VERSION}`);
    return;
  }

  // 全局解析：先剥 --config <path>（允许出现在任何位置），剩余为子命令参数
  const cli = parseGlobal(argv);
  const command = cli.flags[0];
  if (command === undefined) {
    console.error("rdsh: missing command. Run 'rdsh --help'.");
    process.exitCode = 1;
    return;
  }
  const rest = cli.flags.slice(1);
  try {
    if (hasHelp(rest)) {
      console.log(SUB_HELP[command] ?? HELP);
      return;
    }
    switch (command) {
      case "host": {
        await handleHost(rest, cli.configPath);
        return;
      }
      case "hub": {
        await handleHub(rest, cli.configPath);
        return;
      }
      default:
        console.error(`rdsh: unknown command '${command}'. Run 'rdsh --help'.`);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`rdsh: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/** 提取全局 --config <path>（或 $RDSH_CONFIG），返回剩余参数。 */
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

function parsePort(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port '${v}'`);
  return n;
}

/** 服务 unit 的子进程 PATH：node 目录（nvm/自装）+ 系统路径，保证 spawn dsh 时 shebang 能解析 node。 */
function nodePathEnv(): string {
  return `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
}

async function handleHost(args: string[], configPath?: string): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || hasHelp(rest)) {
    console.log(SUB_HELP["host"] ?? HELP);
    return;
  }
  switch (sub) {
    case "setup":
      await handleHostSetup(rest, configPath);
      return;
    case "join":
      await handleHostJoin(rest, configPath);
      return;
    case "serve":
      await handleHostServe(rest, configPath);
      return;
    case "service":
      await handleHostService(rest, configPath);
      return;
    case "leave":
      await handleHostLeave(rest, configPath);
      return;
    case "user":
      await handleHostUser(rest, configPath);
      return;
    default:
      throw new Error("usage: rdsh host setup|join|serve|service|leave|user");
  }
}

/** `rdsh host setup lan|cloud`：写 host.json（mode + 预设字段），配置完退出。 */
async function handleHostSetup(args: string[], configPath?: string): Promise<void> {
  const which = args[0];
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);

  if (which === "lan") {
    let port = config.port;
    let pairCode = config.auth.pairCode;
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--port") port = parsePort(args[++i]);
      else if (flag === "--pair-code") pairCode = args[++i];
      else throw new Error(`unknown option '${flag}'`);
    }
    config.mode = "lan";
    config.port = port;
    config.tls = undefined;
    config.behindProxy = false;
    config.allowFrom = [];
    config.auth.mode = "pair";
    config.auth.pairCode = pairCode;
    config.dshPath = config.dshPath ?? findDsh() ?? undefined;
    await saveConfig(target, config);
    console.log(`rdsh: host 配置为 LAN 网关（pair，端口 ${port}）→ ${target}`);
    console.log("rdsh: 运行 `rdsh host serve` 前台启动，或 `rdsh host service install` 常驻。");
    return;
  }

  if (which === "cloud") {
    let port = config.port;
    let cert: string | undefined;
    let key: string | undefined;
    let allowFrom: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--port") port = parsePort(args[++i]);
      else if (flag === "--tls-cert") cert = args[++i];
      else if (flag === "--tls-key") key = args[++i];
      else if (flag === "--allow-from") allowFrom = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      else throw new Error(`unknown option '${flag}'`);
    }
    if (cert === undefined || key === undefined) {
      throw new Error("usage: rdsh host setup cloud --tls-cert <path> --tls-key <path> [--port <n>] [--allow-from <cidr,...>]");
    }
    config.mode = "cloud";
    config.port = port;
    config.tls = { cert, key };
    config.behindProxy = false;
    config.allowFrom = allowFrom;
    config.auth.mode = "password";
    config.dshPath = config.dshPath ?? findDsh() ?? undefined;
    await saveConfig(target, config);
    console.log(`rdsh: host 配置为云 HTTPS 网关（password，端口 ${port}）→ ${target}`);
    console.log("rdsh: 用 `rdsh host user add <name>` 建用户，再 `rdsh host serve` / `rdsh host service install`。");
    return;
  }

  throw new Error("usage: rdsh host setup lan|cloud");
}

/** `rdsh host join <hub>`：注册（join token）→ 写 host.json + session，配置完退出。 */
async function handleHostJoin(args: string[], configPath?: string): Promise<void> {
  const hubUrl = args[0];
  if (hubUrl === undefined || !/^https?:\/\//.test(hubUrl)) {
    throw new Error("usage: rdsh host join <hub-url> [--token <t>] [--name <n>] [--dsh <p>] [--insecure]");
  }
  const opts: JoinOptions = { hubUrl };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = (name: string): string => {
      i += 1;
      if (i >= args.length) throw new Error(`missing value for ${name}`);
      return args[i] ?? "";
    };
    if (flag === "--token") opts.token = value(flag);
    else if (flag === "--name") opts.name = value(flag);
    else if (flag === "--dsh") opts.dshPath = value(flag);
    else if (flag === "--insecure") opts.insecure = true;
    else if (flag === "--reset") opts.reset = true;
    else throw new Error(`unknown option '${flag}'`);
  }
  if (opts.token === undefined && readPersistedToken(hubUrl) === null) {
    // 无 --token 且无持久化 session：TTY 交互粘贴 token；非 TTY 报错不 hang
    if (process.stdin.isTTY) {
      const pasted = (await promptLine("Paste your join token (hub portal → Add host): ")).trim();
      if (pasted === "") throw new Error("需要 join token（hub portal → 添加主机 生成）");
      opts.token = pasted;
    } else {
      throw new Error("无持久化 session 且未提供 --token；交互式运行粘贴 token");
    }
  }

  const outcome = await registerJoin(opts);
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);
  config.mode = "join";
  config.hub = hubUrl;
  config.name = outcome.name;
  config.insecure = outcome.insecure;
  config.dshPath = opts.dshPath ?? findDsh() ?? config.dshPath;
  await saveConfig(target, config);
  console.log(`rdsh: host 已接入 ${hubUrl}（${config.name}）—— session 已保存`);
  console.log("rdsh: 运行 `rdsh host serve` 前台启动，或 `rdsh host service install` 常驻。");
}

/** `rdsh host serve`：前台常驻，读 host.json 按 mode 分发（join→隧道，lan/cloud→网关）。 */
async function handleHostServe(_args: string[], configPath?: string): Promise<void> {
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);
  if (config.mode === "join") {
    if (config.hub === undefined) throw new Error("host.json 缺 hub（join 模式）；先 `rdsh host join <hub>`");
    await join({ hubUrl: config.hub, name: config.name, insecure: config.insecure, dshPath: config.dshPath, dshUiCompat: config.dshUiCompat, gateway: config.gateway });
    return;
  }
  await serve({ configPath: target });
}

/** `rdsh host service install|status|uninstall`：读 host.json mode 装对应服务（unit 不含 token）。 */
async function handleHostService(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const target = resolveConfigPath(configPath);
  switch (action) {
    case "install": {
      await maybeRegisterForServiceInstall(args, target);
      const config = await loadConfig(target);
      const name = config.mode === "join" ? JOIN_SERVICE_NAME : HOST_SERVICE_NAME;
      // host 服务会 spawn dsh（shebang `#!/usr/bin/env node`），nvm/自装 node 下需补 node 目录到 PATH（防 127）
      console.log(await installService({ name, args: ["host", "serve"], configPath: target, pathEnv: nodePathEnv() }));
      console.log(`rdsh: host service installed (${name}) —— 开机自启 + 崩溃重启。`);
      return;
    }
    case "status": {
      const config = await loadConfig(target);
      const name = config.mode === "join" ? JOIN_SERVICE_NAME : HOST_SERVICE_NAME;
      console.log(`rdsh host service (${name}): ${await serviceStatus(name)}`);
      return;
    }
    case "uninstall": {
      const config = await loadConfig(target);
      const name = config.mode === "join" ? JOIN_SERVICE_NAME : HOST_SERVICE_NAME;
      console.log(await uninstallService(name));
      return;
    }
    default:
      throw new Error("usage: rdsh host service install|status|uninstall");
  }
}

/** 一行接入：`host service install <hub-url> --token <t> [--name <n>]` → 注册 + 写 host.json（再装服务）。 */
async function maybeRegisterForServiceInstall(args: string[], target: string): Promise<void> {
  const maybeHub = args[1];
  if (maybeHub === undefined || !/^https?:\/\//.test(maybeHub)) return; // 无 <hub>，走读 host.json 路径
  const joinOpts: JoinOptions = { hubUrl: maybeHub };
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--token") joinOpts.token = args[++i];
    else if (flag === "--name") joinOpts.name = args[++i];
    else if (flag === "--dsh") joinOpts.dshPath = args[++i];
    else if (flag === "--insecure") joinOpts.insecure = true;
    else throw new Error(`unknown option '${flag}'`);
  }
  const outcome = await registerJoin(joinOpts);
  const cfg = await loadConfig(target);
  cfg.mode = "join";
  cfg.hub = maybeHub;
  cfg.name = outcome.name;
  cfg.insecure = outcome.insecure;
  cfg.dshPath = joinOpts.dshPath ?? findDsh() ?? cfg.dshPath;
  await saveConfig(target, cfg);
}

/** `rdsh host leave`：self-revoke + 清 session + 删 host.json → 未配置。 */
async function handleHostLeave(_args: string[], configPath?: string): Promise<void> {
  const target = resolveConfigPath(configPath);
  const config = await loadConfig(target);
  if (config.mode !== "join" || config.hub === undefined) {
    throw new Error("当前不是 join 模式（或缺 hub），无需 leave");
  }
  const token = readPersistedToken(config.hub);
  if (token === null) {
    console.log("rdsh: 本地无 session 文件，仅清理配置");
  } else {
    await selfRevoke(config.hub, token, config.insecure === true);
    console.log("rdsh: 已在 hub 自吊销本机");
  }
  clearPersistedToken(config.hub);
  await rm(target, { force: true });
  console.log(`rdsh: host 已注销（清理 ${target}）—— 回到未配置状态`);
}

/** `rdsh host user add|passwd|ls|rm`：本机网关用户（写 host.json auth.users）。 */
async function handleHostUser(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const um = new UserManager(resolveConfigPath(configPath));
  switch (action) {
    case "add": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh host user add <name>");
      const password = await promptPassword(`password for ${name}: `);
      const again = await promptPassword("confirm: ");
      if (password !== again) throw new Error("passwords do not match");
      await um.add(name, password);
      console.log(`rdsh: user '${name}' added`);
      return;
    }
    case "passwd": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh host user passwd <name>");
      const password = await promptPassword(`new password for ${name}: `);
      const again = await promptPassword("confirm: ");
      if (password !== again) throw new Error("passwords do not match");
      const ok = await um.passwd(name, password);
      if (!ok) throw new Error(`user '${name}' not found`);
      console.log(`rdsh: password updated for '${name}' (all existing sessions revoked)`);
      return;
    }
    case "ls": {
      const users = await um.list();
      console.log(users.length > 0 ? users.join("\n") : "(no users)");
      return;
    }
    case "rm": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh host user rm <name>");
      const ok = await um.remove(name);
      if (!ok) throw new Error(`user '${name}' not found`);
      console.log(`rdsh: user '${name}' removed`);
      return;
    }
    default:
      throw new Error("usage: rdsh host user add|passwd|ls|rm");
  }
}

/** 打开 hub 数据库（读 hub config 定位 dbPath）。 */
async function openHubDb(configPath?: string): Promise<HubDb> {
  const hubConfigPath = resolveHubConfigPath(configPath);
  const config = await loadHubConfig(hubConfigPath);
  return new HubDb(config.dbPath);
}

/** `rdsh hub audit ls [--user <name>] [--event <e>] [--since 24h|7d]`。 */
async function handleHubAudit(args: string[], configPath?: string): Promise<void> {
  const db = await openHubDb(configPath);
  try {
    // 兼容 `audit ls` 与 `audit`（ls 为可选位置参数）
    const opts = args[0] === "ls" ? args.slice(1) : args;
    const filter: { userId?: number; event?: string; since?: number } = {};
    for (let i = 0; i < opts.length; i++) {
      const flag = opts[i];
      if (flag === "--user") {
        const name = opts[++i];
        if (name === undefined) throw new Error("missing value for --user");
        const u = db.getUserByName(name);
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
    const events = db.listAudit(filter);
    if (events.length === 0) {
      console.log("(no events)");
      return;
    }
    for (const e of events) {
      const user = e.userId !== null ? db.getUserById(e.userId) : null;
      console.log(`${new Date(e.createdAt).toISOString()}  ${user?.name ?? "-"}  ${e.event}  ip=${e.ip}  ${e.detailJson}`);
    }
  } finally {
    db.close();
  }
}

async function handleHub(args: string[], configPath?: string): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || hasHelp(rest)) {
    console.log(SUB_HELP["hub"] ?? HELP);
    return;
  }
  switch (sub) {
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
    case "service": {
      const action = rest[0];
      const hubConfigPath = resolveHubConfigPath(configPath);
      switch (action) {
        case "install":
          console.log(await installService({ name: HUB_SERVICE_NAME, args: ["hub", "serve"], configPath: hubConfigPath }));
          console.log(`rdsh: hub service installed (${HUB_SERVICE_NAME}) —— 开机自启 + 崩溃重启。`);
          return;
        case "status":
          console.log(`rdsh hub service (${HUB_SERVICE_NAME}): ${await serviceStatus(HUB_SERVICE_NAME)}`);
          return;
        case "uninstall":
          console.log(await uninstallService(HUB_SERVICE_NAME));
          return;
        default:
          throw new Error("usage: rdsh hub service install|status|uninstall");
      }
    }
    default:
      throw new Error("usage: rdsh hub serve|user|host|audit|service");
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

/** 交互输入密码两次（一致校验）；不匹配重试（最多 3 次），仍失败抛错。 */
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
  const db = await openHubDb(configPath);
  try {
    switch (action) {
      case "add": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user add <name> [--role <user|readonly|operator|admin>]");
        const roleIdx = args.indexOf("--role");
        const role = roleIdx >= 0 && args[roleIdx + 1] !== undefined ? args[roleIdx + 1]! : "user";
        if (!["user", "readonly", "operator", "admin"].includes(role)) throw new Error(`invalid role '${role}' (user|readonly|operator|admin)`);
        const hubConfigPath = resolveHubConfigPath(configPath);
        if (db.getUserByName(name) !== null) throw new Error(`user '${name}' already exists`);
        // 建号即设初始密码（安全修复 F1：不再提供 --no-password 公开首密码激活路径，防账号抢占）
        const user = db.createUser(name, await hashPassword(await promptPasswordTwice(`password for ${name}: `)));
        if (role !== "user") db.setRole(user.id, role);
        console.log(`rdsh: user '${name}' created (role: ${role})`);
        return;
      }
      case "passwd": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user passwd <name>");
        const user = db.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        const password = await promptPasswordTwice(`new password for ${name}: `);
        db.setPassword(user.id, await hashPassword(password));
        console.log(`rdsh: password reset for '${name}' (all their sessions revoked)`);
        return;
      }
      case "ls": {
        const users = db.listUsers();
        console.log(users.length > 0 ? users.map((u) => `${u.name}\t${u.role}`).join("\n") : "(no users)");
        return;
      }
      case "rm": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user rm <name>");
        const user = db.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        db.removeUser(user.id);
        console.log(`rdsh: user '${name}' removed (their hosts removed)`);
        return;
      }
      case "unlock": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user unlock <name>");
        const user = db.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        db.unlockAccount(user.id);
        console.log(`rdsh: user '${name}' unlocked`);
        return;
      }
      case "reset-2fa": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user reset-2fa <name>");
        const user = db.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        db.clearTotpSecret(user.id);
        db.bumpVersion(user.id);
        console.log(`rdsh: 2FA reset for '${name}' (their sessions revoked)`);
        return;
      }
      case "ban": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user ban <name>");
        const user = db.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        db.setAccountStatus(user.id, "banned");
        console.log(`rdsh: user '${name}' banned (login + host access blocked)`);
        return;
      }
      case "unban": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user unban <name>");
        const user = db.getUserByName(name);
        if (user === null) throw new Error(`user '${name}' not found`);
        db.setAccountStatus(user.id, "active");
        console.log(`rdsh: user '${name}' unbanned (plan restored)`);
        return;
      }
      default:
        throw new Error("usage: rdsh hub user add|passwd|ls|rm|unlock|reset-2fa|ban|unban");
    }
  } finally {
    db.close();
  }
}

async function handleHubHost(args: string[], configPath?: string): Promise<void> {
  const action = args[0];
  const db = await openHubDb(configPath);
  try {
    switch (action) {
      case "ls": {
        const hosts = db.listAllHosts();
        if (hosts.length === 0) {
          console.log("(no hosts)");
        } else {
          for (const h of hosts) {
            const owner = db.getUserById(h.ownerId);
            console.log(`${h.id}  ${h.name}  owner=${owner?.name ?? h.ownerId}  created=${h.createdAt}`);
          }
        }
        return;
      }
      case "revoke": {
        const hostId = args[1];
        if (hostId === undefined) throw new Error("usage: rdsh hub host revoke <hostId>");
        const host = db.getHostById(hostId);
        if (host === null) throw new Error(`host '${hostId}' not found`);
        db.removeHost(hostId);
        console.log(`rdsh: host '${hostId}' revoked — its tunnel will drop and reconnects are rejected`);
        return;
      }
      default:
        throw new Error("usage: rdsh hub host ls|revoke <hostId>");
    }
  } finally {
    db.close();
  }
}

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

/** 读取一行（echo，用于粘贴 token 等非敏感输入）。 */
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

// 管理命令（host setup/join/leave/service/user 完成后）显式退出：
// 常驻命令（host serve / hub serve）不 resolve，靠信号退出。
void main().then(() => process.exit(process.exitCode ?? 0));
