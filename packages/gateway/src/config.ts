/**
 * config.ts — host 配置加载/默认/校验/迁移。持久配置唯一来源（~/.rdsh/host.json，3 模式）。
 *
 * 模式：`mode = "lan" | "cloud" | "join"`（lan/cloud = 独立服务；join = 出站隧道）。
 * 优先级：CLI 参数 > config 文件 > 默认值。
 * 路径：`--config <path>` > `$RDSH_CONFIG` > 默认 `~/.rdsh/host.json`。
 * 迁移：默认路径下 host.json 不存在但旧 `~/.rdsh/config.json` 存在时，按 tls/auth.mode 推断 mode 并写回 host.json（原文件保留）。
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthMode = "pair" | "password" | "none";
export type HostMode = "lan" | "cloud" | "join";

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
  /** 运行模式：lan/cloud = 独立服务；join = 出站隧道 */
  mode: HostMode;
  host: string;
  port: number;
  sessionTtlSeconds: number;
  tls?: TlsConfig;
  behindProxy: boolean;
  allowFrom: string[];
  auth: AuthConfig;
  dshPath?: string;
  /** join 模式字段 */
  hub?: string;
  name?: string;
  insecure?: boolean;
  /** DSH UI 兼容开关（跟随 E2EE；trustE2EEAsLoopback 默认 true） */
  dshUiCompat?: DshUiCompat;
}

/** DSH UI 兼容：把经隧道访问的前端 isLoopback 判定视为 loopback，使 Models/设置持久化可用。 */
export interface DshUiCompat {
  /** E2EE 激活（或宿主启用）时 patch JS；false = 保持 DSH 原样（共享 host/敏感场景） */
  trustE2EEAsLoopback?: boolean;
}

export const DEFAULT_HOST_CONFIG_PATH = join(homedir(), ".rdsh", "host.json");
/** 旧版 serve 配置（迁移源，保留不删）。 */
const LEGACY_CONFIG_PATH = join(homedir(), ".rdsh", "config.json");

const DEFAULT_AUTH: AuthConfig = { mode: "pair", version: 1, users: [] };

const DEFAULTS: RdshConfig = {
  mode: "lan",
  host: "0.0.0.0",
  port: 8443,
  sessionTtlSeconds: 12 * 3600,
  behindProxy: false,
  allowFrom: [],
  auth: DEFAULT_AUTH,
  dshUiCompat: { trustE2EEAsLoopback: true },
};

/** 解析配置文件路径（--config > $RDSH_CONFIG > 默认 host.json）。 */
export function resolveConfigPath(cliPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  return cliPath ?? env.RDSH_CONFIG ?? DEFAULT_HOST_CONFIG_PATH;
}

/** 原子写回配置（tmp + rename，0600）。 */
export async function saveConfig(path: string, config: RdshConfig): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** 加载并校验配置；默认路径下文件不存在时尝试迁移旧 config.json，否则返回默认值。 */
export async function loadConfig(path: string): Promise<RdshConfig> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`failed to read config ${path}: ${(err as Error).message}`);
    }
    // ENOENT：默认路径下迁移旧 config.json → host.json（幂等：写回含 mode 的规范化配置）
    if (path === DEFAULT_HOST_CONFIG_PATH) {
      const legacy = await readLegacyConfig();
      if (legacy !== null) {
        await writeFile(path, `${JSON.stringify(normalizeConfig(legacy, LEGACY_CONFIG_PATH), null, 2)}\n`, { mode: 0o600 });
        raw = legacy;
      }
    }
  }
  return normalizeConfig(raw, path);
}

/** 读取旧 ~/.rdsh/config.json（不存在 → null；坏 JSON → 抛错）。 */
async function readLegacyConfig(): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(LEGACY_CONFIG_PATH, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`failed to read legacy config ${LEGACY_CONFIG_PATH}: ${(err as Error).message}`);
  }
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

  // ---- mode（三态；缺省按 tls/auth.mode 推断，兼容旧 config.json）----
  if (cfg.mode !== undefined) {
    if (cfg.mode !== "lan" && cfg.mode !== "cloud" && cfg.mode !== "join") {
      throw new Error(`${source}: "mode" must be lan|cloud|join`);
    }
    out.mode = cfg.mode;
  } else {
    const tls = cfg.tls;
    const authMode = (cfg.auth as Record<string, unknown> | undefined)?.mode;
    out.mode = tls !== undefined || authMode === "password" ? "cloud" : "lan";
  }

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
  // ---- join 字段 ----
  if (cfg.hub !== undefined) {
    assertString(cfg.hub, "hub", source);
    out.hub = cfg.hub;
  }
  if (cfg.name !== undefined) {
    assertString(cfg.name, "name", source);
    out.name = cfg.name;
  }
  if (cfg.insecure !== undefined) {
    if (typeof cfg.insecure !== "boolean") throw new Error(`${source}: "insecure" must be boolean`);
    out.insecure = cfg.insecure;
  }
  if (cfg.dshPath !== undefined) {
    assertString(cfg.dshPath, "dshPath", source);
    out.dshPath = cfg.dshPath;
  }
  // ---- dshUiCompat（缺省 trustE2EEAsLoopback: true）----
  if (cfg.dshUiCompat !== undefined) {
    if (typeof cfg.dshUiCompat !== "object" || cfg.dshUiCompat === null) {
      throw new Error(`${source}: "dshUiCompat" must be an object`);
    }
    const compat = cfg.dshUiCompat as Record<string, unknown>;
    if (compat.trustE2EEAsLoopback !== undefined) {
      if (typeof compat.trustE2EEAsLoopback !== "boolean") {
        throw new Error(`${source}: "dshUiCompat.trustE2EEAsLoopback" must be boolean`);
      }
      out.dshUiCompat = { trustE2EEAsLoopback: compat.trustE2EEAsLoopback };
    }
  }
  return out;
}

function assertString(v: unknown, field: string, source: string): asserts v is string {
  if (typeof v !== "string") throw new Error(`${source}: "${field}" must be a string`);
}
