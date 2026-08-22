#!/usr/bin/env node
/**
 * rdsh CLI 入口（手写参数解析，零依赖）。
 *
 *   rdsh serve [--port <n>] [--host <ip>] [--pair-code <code>]
 *              [--session-ttl <sec>] [--dsh <path>] [--reset]
 *   rdsh --version | --help
 */
import { serve } from "rdsh-gateway";
import type { ServeOptions } from "rdsh-gateway";
import { VERSION } from "./index.js";

const HELP = `rdsh — secure remote access for DeepSeek Harness

Usage:
  rdsh serve [options]   Start the LAN auth gateway in front of dsh web

Options (serve):
  --port <n>             Listen port (default 8443; 0 = OS-assigned)
  --host <ip>            Bind address (default 0.0.0.0)
  --pair-code <code>     Preset pairing code (default: random, shown on start)
  --session-ttl <sec>    Session cookie lifetime in seconds (default 43200)
  --dsh <path>           Path to the dsh executable (default: from PATH)
  --reset                Reset session keys (all devices must pair again)
  --no-code              SKIP pairing auth — any device on the network gets
                         full DSH access. ONLY for fully trusted LANs!

Global:
  --version, -v          Print version
  --help, -h             Print this help
`;

interface ServeCliOptions {
  host: string;
  port: number;
  pairCode?: string;
  sessionTtlSeconds: number;
  dshPath?: string;
  reset?: boolean;
  noCode?: boolean;
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
  const command = argv[0];
  if (command === "serve") {
    try {
      const opts = parseServeArgs(argv.slice(1));
      await serve(opts as ServeOptions);
    } catch (err) {
      console.error(`rdsh: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    return;
  }
  console.error(`rdsh: unknown command '${command}'. Run 'rdsh --help'.`);
  process.exitCode = 1;
}

function parseServeArgs(args: string[]): ServeCliOptions {
  const opts: ServeCliOptions = { host: "0.0.0.0", port: 8443, sessionTtlSeconds: 12 * 3600 };
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

void main();
