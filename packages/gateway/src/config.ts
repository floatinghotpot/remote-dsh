/**
 * config.ts — 配置加载/默认/校验。持久配置唯一来源（~/.rdsh/config.json）。
 *
 * 优先级：CLI 参数 > config 文件 > 默认值。
 * 路径：`--config <path>` > `$RDSH_CONFIG` > 默认 `~/.rdsh/config.json`。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthMode = "pair" | "password" | "none";

export interface TlsConfig {
  cert: string;
  key: string;
}

export interface AuthUser {
  name: string;
  passwordHash: string;
}

export interface AuthConfig {
  mode: AuthMode;
  pairCode?: string;
  /** 改密时 +1，用于使旧会话失效 */
  version: number;
  users: AuthUser[];
}

export interface RdshConfig {
  host: string;
  port: number;
  sessionTtlSeconds: number;
  tls?: TlsConfig;
  behindProxy: boolean;
  allowFrom: string[];
  auth: AuthConfig;
  dshPath?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".rdsh", "config.json");

const DEFAULT_AUTH: AuthConfig = { mode: "pair", version: 1, users: [] };

const DEFAULTS: RdshConfig = {
  host: "0.0.0.0",
  port: 8443,
  sessionTtlSeconds: 12 * 3600,
  behindProxy: false,
  allowFrom: [],
  auth: DEFAULT_AUTH,
};

/** 解析配置文件路径（--config > $RDSH_CONFIG > 默认）。 */
export function resolveConfigPath(cliPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  return cliPath ?? env.RDSH_CONFIG ?? DEFAULT_CONFIG_PATH;
}

/** 加载并校验配置；文件不存在时返回默认值。 */
export async function loadConfig(path: string): Promise<RdshConfig> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`failed to read config ${path}: ${(err as Error).message}`);
    }
    // ENOENT → 默认配置
  }
  return normalizeConfig(raw, path);
}

/** 校验并规范化任意输入（测试/CLI 覆盖复用）。 */
export function normalizeConfig(raw: unknown, source = "config"): RdshConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;
  const out: RdshConfig = {
    ...DEFAULTS,
    auth: { ...DEFAULT_AUTH, users: [] },
  };

  if (cfg.host !== undefined) {
    assertString(cfg.host, "host", source);
    out.host = cfg.host;
  }
  if (cfg.port !== undefined) {
    if (!Number.isInteger(cfg.port) || (cfg.port as number) < 0 || (cfg.port as number) > 65535) {
      throw new Error(`${source}: invalid "port" ${JSON.stringify(cfg.port)}`);
    }
    out.port = cfg.port as number;
  }
  if (cfg.sessionTtlSeconds !== undefined) {
    if (!Number.isInteger(cfg.sessionTtlSeconds) || (cfg.sessionTtlSeconds as number) <= 0) {
      throw new Error(`${source}: invalid "sessionTtlSeconds" ${JSON.stringify(cfg.sessionTtlSeconds)}`);
    }
    out.sessionTtlSeconds = cfg.sessionTtlSeconds as number;
  }
  if (cfg.tls !== undefined) {
    if (typeof cfg.tls !== "object" || cfg.tls === null) throw new Error(`${source}: "tls" must be an object`);
    const tls = cfg.tls as Record<string, unknown>;
    assertString(tls.cert, "tls.cert", source);
    assertString(tls.key, "tls.key", source);
    out.tls = { cert: tls.cert, key: tls.key };
  }
  if (cfg.behindProxy !== undefined) {
    if (typeof cfg.behindProxy !== "boolean") throw new Error(`${source}: "behindProxy" must be boolean`);
    out.behindProxy = cfg.behindProxy;
  }
  if (cfg.allowFrom !== undefined) {
    if (!Array.isArray(cfg.allowFrom) || cfg.allowFrom.some((x) => typeof x !== "string")) {
      throw new Error(`${source}: "allowFrom" must be an array of CIDR strings`);
    }
    out.allowFrom = cfg.allowFrom as string[];
  }
  if (cfg.auth !== undefined) {
    if (typeof cfg.auth !== "object" || cfg.auth === null) throw new Error(`${source}: "auth" must be an object`);
    const auth = cfg.auth as Record<string, unknown>;
    if (auth.mode !== undefined) {
      if (auth.mode !== "pair" && auth.mode !== "password" && auth.mode !== "none") {
        throw new Error(`${source}: "auth.mode" must be pair|password|none`);
      }
      out.auth.mode = auth.mode;
    }
    if (auth.pairCode !== undefined) {
      assertString(auth.pairCode, "auth.pairCode", source);
      out.auth.pairCode = auth.pairCode;
    }
    if (auth.version !== undefined) {
      if (!Number.isInteger(auth.version) || (auth.version as number) < 1) {
        throw new Error(`${source}: "auth.version" must be a positive integer`);
      }
      out.auth.version = auth.version as number;
    }
    if (auth.users !== undefined) {
      if (!Array.isArray(auth.users)) throw new Error(`${source}: "auth.users" must be an array`);
      out.auth.users = (auth.users as unknown[]).map((u, i) => {
        if (typeof u !== "object" || u === null) throw new Error(`${source}: auth.users[${i}] must be an object`);
        const user = u as Record<string, unknown>;
        assertString(user.name, `auth.users[${i}].name`, source);
        assertString(user.passwordHash, `auth.users[${i}].passwordHash`, source);
        return { name: user.name, passwordHash: user.passwordHash };
      });
    }
  }
  if (cfg.dshPath !== undefined) {
    assertString(cfg.dshPath, "dshPath", source);
    out.dshPath = cfg.dshPath;
  }
  return out;
}

function assertString(v: unknown, field: string, source: string): asserts v is string {
  if (typeof v !== "string") throw new Error(`${source}: "${field}" must be a string`);
}
