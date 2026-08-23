/**
 * config.ts — hub 配置加载（~/.rdsh/hub.json）。
 *
 * 路径优先级：`--config <path>` > `$RDSH_HUB_CONFIG` > 默认 `~/.rdsh/hub.json`。
 * 字段：host/port/tls{cert,key}/dbPath/jwtKeyPath；非法字段明确报错。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HubConfig {
  host: string;
  port: number;
  /** TLS 证书路径；缺失 → 拒绝启动（公网 hub 必须 TLS） */
  tls?: { cert: string; key: string };
  /** SQLite 数据库路径 */
  dbPath: string;
  /** JWT 签名密钥路径（自动生成，0600） */
  jwtKeyPath: string;
  /** 反代终止 TLS（apache2/nginx）：hub 监听 http，限流按 X-Forwarded-For（仅回环信任） */
  behindProxy: boolean;
}

export const DEFAULT_HUB_CONFIG_PATH = join(homedir(), ".rdsh", "hub.json");

const DEFAULTS = {
  host: "0.0.0.0",
  port: 8443,
  dbPath: join(homedir(), ".rdsh", "hub.db"),
  jwtKeyPath: join(homedir(), ".rdsh", "hub-jwt.key"),
  behindProxy: false,
};

/** 解析配置文件路径（--config > $RDSH_HUB_CONFIG > 默认）。 */
export function resolveHubConfigPath(cliPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  return cliPath ?? env.RDSH_HUB_CONFIG ?? DEFAULT_HUB_CONFIG_PATH;
}

/** 加载并校验 hub 配置；文件不存在时返回默认值。 */
export async function loadHubConfig(path: string): Promise<HubConfig> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`failed to read hub config ${path}: ${(err as Error).message}`);
    }
  }
  return normalizeHubConfig(raw, path);
}

/** 校验并规范化任意输入（测试复用）。 */
export function normalizeHubConfig(raw: unknown, source = "config"): HubConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;
  const out: HubConfig = { ...DEFAULTS };

  if (cfg.host !== undefined) {
    if (typeof cfg.host !== "string") throw new Error(`${source}: "host" must be a string`);
    out.host = cfg.host;
  }
  if (cfg.port !== undefined) {
    if (!Number.isInteger(cfg.port) || (cfg.port as number) < 0 || (cfg.port as number) > 65535) {
      throw new Error(`${source}: invalid "port" ${JSON.stringify(cfg.port)}`);
    }
    out.port = cfg.port as number;
  }
  if (cfg.tls !== undefined) {
    if (typeof cfg.tls !== "object" || cfg.tls === null) throw new Error(`${source}: "tls" must be an object`);
    const tls = cfg.tls as Record<string, unknown>;
    if (typeof tls.cert !== "string" || typeof tls.key !== "string") {
      throw new Error(`${source}: "tls.cert" and "tls.key" must be strings`);
    }
    out.tls = { cert: tls.cert, key: tls.key };
  }
  if (cfg.dbPath !== undefined) {
    if (typeof cfg.dbPath !== "string") throw new Error(`${source}: "dbPath" must be a string`);
    out.dbPath = cfg.dbPath;
  }
  if (cfg.jwtKeyPath !== undefined) {
    if (typeof cfg.jwtKeyPath !== "string") throw new Error(`${source}: "jwtKeyPath" must be a string`);
    out.jwtKeyPath = cfg.jwtKeyPath;
  }
  if (cfg.behindProxy !== undefined) {
    if (typeof cfg.behindProxy !== "boolean") throw new Error(`${source}: "behindProxy" must be boolean`);
    out.behindProxy = cfg.behindProxy;
  }
  return out;
}
