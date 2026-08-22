#!/usr/bin/env node
/**
 * rdsh CLI 入口（手写参数解析，零依赖）。
 *
 *   rdsh serve [--config <path>] [--reset] [--port <n>] ...
 *   rdsh user add|passwd <name> | ls | rm <name>   [--config <path>]
 *   rdsh service install|uninstall|status          [--config <path>]
 *   rdsh --version | --help
 */
import { createInterface } from "node:readline";
import {
  serve,
  UserManager,
  resolveConfigPath,
  installService,
  uninstallService,
  serviceStatus,
} from "rdsh-gateway";
import type { ServeOptions } from "rdsh-gateway";
import { VERSION } from "./index.js";

const HELP = `rdsh — secure remote access for DeepSeek Harness

Usage:
  rdsh serve [options]      Start the gateway (LAN auth or cloud HTTPS service)
  rdsh user add <name>      Add a user (interactive password)
  rdsh user passwd <name>   Change a user's password (revokes all sessions)
  rdsh user ls              List users
  rdsh user rm <name>       Remove a user
  rdsh service install      Install as a systemd/launchd service (auto-start)
  rdsh service status       Show service status
  rdsh service uninstall    Stop and remove the service

Global:
  --config <path>           Config file (default ~/.rdsh/config.json; also $RDSH_CONFIG)
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

Config (persistent): host, port, sessionTtlSeconds, tls{cert,key}, behindProxy,
  allowFrom[], auth{mode: pair|password|none, pairCode, users[]}, dshPath.
`;

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
    switch (command) {
      case "serve": {
        const opts = parseServeArgs(rest, cli.configPath);
        await serve(opts);
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

/** 隐藏式密码输入（TTY raw 模式；非 TTY 时共享行队列读管道）。 */
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
