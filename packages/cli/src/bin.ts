#!/usr/bin/env node
/**
 * rdsh CLI 入口（手写参数解析，零依赖）。
 *
 *   rdsh serve [--config <path>] [--reset] [--port <n>] ...
 *   rdsh join <hub-url> [--token <t>] [--dsh <path>]
 *   rdsh hub serve|user|host|service ... [--config <path>]
 *   rdsh user add|passwd <name> | ls | rm <name>   [--config <path>]
 *   rdsh service install|uninstall|status          [--config <path>]
 *   rdsh --version | --help
 */
import { createInterface } from "node:readline";
import {
  serve,
  join,
  UserManager,
  resolveConfigPath,
  installService,
  uninstallService,
  serviceStatus,
} from "rdsh-gateway";
import type { ServeOptions, JoinOptions } from "rdsh-gateway";
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
  rdsh serve [options]      Start the gateway (LAN auth or cloud HTTPS service)
  rdsh join <hub-url>       Connect to a hub via outbound tunnel (no ports open)
  rdsh hub serve            Start the hub server (cloud, multi-host)
  rdsh hub user add <name>  Create a hub user (interactive password; --no-password for first-login setup)
  rdsh hub user passwd <n>  Reset a user's password (admin)
  rdsh hub user rm|ls
  rdsh hub host ls|revoke   List / revoke hosts (revoke = tunnel drops instantly)
  rdsh hub service ...      Install hub as a systemd/launchd service
  rdsh user add|passwd|ls|rm    Gateway users (LAN/cloud HTTPS service)
  rdsh service install|status|uninstall

Global:
  --config <path>           Gateway config (default ~/.rdsh/config.json; also $RDSH_CONFIG)
                            For hub commands: hub config (default ~/.rdsh/hub.json; also $RDSH_HUB_CONFIG)
  --version, -v             Print version
  --help, -h                Print this help

Options (serve):
  --port <n>                Listen port (overrides config; default 8443)
  --host <ip>               Bind address (overrides config; default 0.0.0.0)
  --pair-code <code>        Preset pairing code (overrides config)
  --session-ttl <sec>       Session cookie lifetime (overrides config; default 43200)
  --dsh <path>              dsh executable path (overrides config)
  --reset                   Rotate session keys (all devices must re-auth)
  --no-code                 Disable auth (trusted network ONLY!)

Options (join):
  --token <t>               Use an existing host token (skip pairing-code flow)
  --dsh <path>              dsh executable path

Options (hub serve):
  --port <n>                Listen port (overrides hub config; default 8443)
  --host <ip>               Bind address (overrides hub config; default 0.0.0.0)

Config (persistent): host, port, sessionTtlSeconds, tls{cert,key}, behindProxy,
  allowFrom[], auth{mode: pair|password|none, pairCode, users[]}, dshPath.
Hub config (~/.rdsh/hub.json): host, port, tls{cert,key}, dbPath, jwtKeyPath.
`;

/** 子命令级用法（`rdsh <cmd> --help`）。 */
const SUB_HELP: Record<string, string> = {
  serve: `Usage: rdsh serve [options]

Start the gateway (LAN auth or cloud HTTPS service).

Options:
  --config <path>       Config file (default ~/.rdsh/config.json; also $RDSH_CONFIG)
  --port <n>            Listen port (overrides config; default 8443)
  --host <ip>           Bind address (overrides config; default 0.0.0.0)
  --pair-code <code>    Preset pairing code (overrides config)
  --session-ttl <sec>   Session cookie lifetime (overrides config; default 43200)
  --dsh <path>          dsh executable path (overrides config)
  --reset               Rotate session keys (all devices must re-auth)
  --no-code             Disable auth (trusted network ONLY!)
`,
  join: `Usage: rdsh join <hub-url> [options]

Connect to a hub via an outbound tunnel (no ports open on this machine).

Options:
  --token <t>           Use an existing host token (skip the pair-code flow)
  --dsh <path>          dsh executable path
  --insecure            Skip TLS certificate verification (self-signed hub)
`,
  hub: `Usage: rdsh hub <subcommand> [options]

Run the hub server or manage it.

Subcommands:
  serve                 Start the hub server (TLS required)
  user add|passwd|rm|ls Manage users (registration closed; admin creates accounts)
  host ls|revoke        List / revoke hosts (revoke drops the tunnel instantly)
  service install|status|uninstall   Run hub as a systemd/launchd service

Options (serve):
  --config <path>       Hub config (default ~/.rdsh/hub.json; also $RDSH_HUB_CONFIG)
  --port <n>            Listen port (overrides hub config; default 8443)
  --host <ip>           Bind address (overrides hub config; default 0.0.0.0)
`,
  user: `Usage: rdsh user <action> [name]

Manage gateway users (LAN / cloud HTTPS service).

Actions:
  add <name>            Add a user (interactive password)
  passwd <name>         Change a user's password (revokes all their sessions)
  ls                    List users
  rm <name>             Remove a user

Options:
  --config <path>       Config file (default ~/.rdsh/config.json; also $RDSH_CONFIG)
`,
  service: `Usage: rdsh service <action>

Manage the gateway as a systemd/launchd service.

Actions:
  install               Install and start (auto-start on boot, restart on crash)
  status                Show service status
  uninstall             Stop and remove the service

Options:
  --config <path>       Config file (default ~/.rdsh/config.json; also $RDSH_CONFIG)
`,
};

/** 参数里是否有 --help / -h。 */
function hasHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

interface CliOptions {
  configPath: string;
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
      case "serve": {
        const opts = parseServeArgs(rest, cli.configPath);
        await serve(opts);
        return;
      }
      case "join": {
        const opts = parseJoinArgs(rest);
        await join(opts);
        return;
      }
      case "hub": {
        await handleHub(rest, cli.configPath);
        return;
      }
      case "user": {
        await handleUser(rest, cli.configPath);
        return;
      }
      case "service": {
        await handleService(rest, cli.configPath);
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
  return { configPath: resolveConfigPath(configPath), flags };
}

interface ServeCliOptions extends ServeOptions {
  reset?: boolean;
  noCode?: boolean;
}

function parseServeArgs(args: string[], configPath: string): ServeCliOptions {
  const opts: ServeCliOptions = { configPath };
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
      case "--pair-code":
        opts.pairCode = value(flag);
        break;
      case "--session-ttl": {
        const v = Number(value(flag));
        if (!Number.isInteger(v) || v <= 0) throw new Error(`invalid --session-ttl '${args[i]}'`);
        opts.sessionTtlSeconds = v;
        break;
      }
      case "--dsh":
        opts.dshPath = value(flag);
        break;
      case "--reset":
        opts.reset = true;
        break;
      case "--no-code":
        opts.noCode = true;
        break;
      default:
        throw new Error(`unknown option '${flag}'`);
    }
  }
  return opts;
}

function parseJoinArgs(args: string[]): JoinOptions {
  const hubUrl = args[0];
  if (hubUrl === undefined || !/^https?:\/\//.test(hubUrl)) {
    throw new Error("usage: rdsh join <hub-url> [--token <t>] [--dsh <path>]");
  }
  const opts: JoinOptions = { hubUrl };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = (name: string): string => {
      i += 1;
      if (i >= args.length) throw new Error(`missing value for ${name}`);
      return args[i] ?? "";
    };
    switch (flag) {
      case "--token":
        opts.token = value(flag);
        break;
      case "--dsh":
        opts.dshPath = value(flag);
        break;
      case "--insecure":
        opts.insecure = true;
        break;
      default:
        throw new Error(`unknown option '${flag}'`);
    }
  }
  return opts;
}

async function handleUser(args: string[], configPath: string): Promise<void> {
  const action = args[0];
  const um = new UserManager(configPath);
  switch (action) {
    case "add": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh user add <name>");
      const password = await promptPassword(`password for ${name}: `);
      const again = await promptPassword("confirm: ");
      if (password !== again) throw new Error("passwords do not match");
      await um.add(name, password);
      console.log(`rdsh: user '${name}' added (config: ${configPath})`);
      return;
    }
    case "passwd": {
      const name = args[1];
      if (name === undefined) throw new Error("usage: rdsh user passwd <name>");
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
      if (name === undefined) throw new Error("usage: rdsh user rm <name>");
      const ok = await um.remove(name);
      if (!ok) throw new Error(`user '${name}' not found`);
      console.log(`rdsh: user '${name}' removed`);
      return;
    }
    default:
      throw new Error("usage: rdsh user add|passwd|ls|rm");
  }
}

async function handleService(args: string[], configPath: string): Promise<void> {
  const action = args[0];
  switch (action) {
    case "install":
      console.log(await installService(configPath));
      console.log("rdsh: service installed — it starts on boot and restarts on crash.");
      return;
    case "status":
      console.log(`rdsh service: ${await serviceStatus()}`);
      return;
    case "uninstall":
      console.log(await uninstallService());
      return;
    default:
      throw new Error("usage: rdsh service install|status|uninstall");
  }
}

/** 打开 hub 数据库（读 hub config 定位 dbPath）。 */
async function openHubDb(configPath: string): Promise<HubDb> {
  const hubConfigPath = resolveHubConfigPath(configPath);
  const config = await loadHubConfig(hubConfigPath);
  return new HubDb(config.dbPath);
}

async function handleHub(args: string[], configPath: string): Promise<void> {
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
    case "service": {
      const action = rest[0];
      const hubConfigPath = resolveHubConfigPath(configPath);
      switch (action) {
        case "install":
          console.log(await installService(hubConfigPath, ["hub", "serve"]));
          console.log("rdsh: hub service installed — starts on boot and restarts on crash.");
          return;
        case "status":
          console.log(`rdsh hub service: ${await serviceStatus()}`);
          return;
        case "uninstall":
          console.log(await uninstallService());
          return;
        default:
          throw new Error("usage: rdsh hub service install|status|uninstall");
      }
    }
    default:
      throw new Error("usage: rdsh hub serve|user|host|service");
  }
}

function parseHubServeArgs(args: string[], configPath: string): HubServeOptions {
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

async function handleHubUser(args: string[], configPath: string): Promise<void> {
  const action = args[0];
  const db = await openHubDb(configPath);
  try {
    switch (action) {
      case "add": {
        const name = args[1];
        if (name === undefined) throw new Error("usage: rdsh hub user add <name> [--no-password]");
        const noPassword = args.includes("--no-password");
        const hubConfigPath = resolveHubConfigPath(configPath);
        if (db.getUserByName(name) !== null) throw new Error(`user '${name}' already exists`);
        if (noPassword) {
          // 首次登录自设密码（must_change=1，密码占位不可用）
          db.createUser(name, "scrypt:disabled", new Date().toISOString(), true);
          console.log(`rdsh: user '${name}' created — they must set a password on first sign-in (${hubConfigPath})`);
        } else {
          const password = await promptPasswordTwice(`password for ${name}: `);
          db.createUser(name, await hashPassword(password));
          console.log(`rdsh: user '${name}' created (hub db: ${db.path})`);
        }
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
        console.log(users.length > 0 ? users.map((u) => u.name).join("\n") : "(no users)");
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
      default:
        throw new Error("usage: rdsh hub user add|passwd|ls|rm");
    }
  } finally {
    db.close();   // 抛错路径也必须关闭 SQLite 句柄（否则进程挂住）
  }
}

async function handleHubHost(args: string[], configPath: string): Promise<void> {
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
  // 注意：不能每次调用新建 readline —— 第二个 interface 会读不到剩余行。
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

void main();
