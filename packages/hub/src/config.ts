/**
 * config.ts — hub 配置加载（~/.rdsh/hub.json）。
 *
 * 路径优先级：`--config <path>` > `$RDSH_HUB_CONFIG` > 默认 `~/.rdsh/hub.json`。
 * 字段：host/port/tls{cert,key}/dbPath/jwtKeyPath；非法字段明确报错。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmailConfig } from "./email/types.ts";

export interface CaptchaConfig {
  provider: "arithmetic" | "none";
}

export interface SecurityConfig {
  /** 同收件人每日发信上限（防轰炸，默认 5） */
  emailDailyLimit: number;
  /** 全局每日发信上限（防配额烧钱，默认 200） */
  globalEmailDailyLimit: number;
  /** 账户锁定阈值/时长（默认 10 次/15 分钟） */
  loginLockThreshold: number;
  loginLockMinutes: number;
  /** 审计事件保留天数（默认 90，到期自动清理） */
  auditRetentionDays: number;
}

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
  /** 邮件提供方；缺省 → 邮件功能禁用（邮箱验证/找回密码不可用） */
  email?: EmailConfig;
  /** 验证码；缺省 → arithmetic */
  captcha?: CaptchaConfig;
  /** 安全参数；缺省 → 默认值 */
  security?: SecurityConfig;
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
  if (cfg.email !== undefined) out.email = normalizeEmail(cfg.email, source);
  if (cfg.captcha !== undefined) out.captcha = normalizeCaptcha(cfg.captcha, source);
  out.security = normalizeSecurity(cfg.security, source);
  return out;
}

function normalizeEmail(raw: unknown, source: string): EmailConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "email" must be an object`);
  const e = raw as Record<string, unknown>;
  if (e.provider !== "smtp" && e.provider !== "aliyun" && e.provider !== "log") {
    throw new Error(`${source}: "email.provider" must be smtp|aliyun|log`);
  }
  let from: string;
  if (typeof e.from === "string" && e.from.length > 0) {
    from = e.from;
  } else if (e.provider !== "log") {
    throw new Error(`${source}: "email.from" must be a non-empty string`);
  } else {
    from = "noreply@localhost"; // log 不真发，占位即可
  }
  const out: EmailConfig = { provider: e.provider, from };
  if (e.fromAlias !== undefined) {
    if (typeof e.fromAlias !== "string") throw new Error(`${source}: "email.fromAlias" must be a string`);
    out.fromAlias = e.fromAlias;
  }
  if (e.smtp !== undefined) {
    const s = e.smtp as Record<string, unknown>;
    if (typeof s.host !== "string" || typeof s.user !== "string" || typeof s.password !== "string" || typeof s.port !== "number" || typeof s.secure !== "boolean") {
      throw new Error(`${source}: "email.smtp" needs host/port/secure/user/password`);
    }
    out.smtp = { host: s.host, port: s.port, secure: s.secure, user: s.user, password: s.password };
  }
  if (e.aliyun !== undefined) {
    const a = e.aliyun as Record<string, unknown>;
    if (typeof a.accessKeyId !== "string" || typeof a.accessKeySecret !== "string") {
      throw new Error(`${source}: "email.aliyun" needs accessKeyId/accessKeySecret`);
    }
    out.aliyun = { accessKeyId: a.accessKeyId, accessKeySecret: a.accessKeySecret };
    if (a.endpoint !== undefined) {
      if (typeof a.endpoint !== "string") throw new Error(`${source}: "email.aliyun.endpoint" must be a string`);
      out.aliyun.endpoint = a.endpoint;
    }
  }
  return out;
}

function normalizeCaptcha(raw: unknown, source: string): CaptchaConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "captcha" must be an object`);
  const c = raw as Record<string, unknown>;
  if (c.provider !== "arithmetic" && c.provider !== "none") throw new Error(`${source}: "captcha.provider" must be arithmetic|none`);
  return { provider: c.provider };
}

function normalizeSecurity(raw: unknown, source: string): SecurityConfig {
  const defaults: SecurityConfig = { emailDailyLimit: 5, globalEmailDailyLimit: 200, loginLockThreshold: 10, loginLockMinutes: 15, auditRetentionDays: 90 };
  if (raw === undefined) return defaults;
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "security" must be an object`);
  const s = raw as Record<string, unknown>;
  for (const key of ["emailDailyLimit", "globalEmailDailyLimit", "loginLockThreshold", "loginLockMinutes", "auditRetentionDays"] as const) {
    if (s[key] !== undefined) {
      if (!Number.isInteger(s[key]) || (s[key] as number) < 1) throw new Error(`${source}: "security.${key}" must be a positive integer`);
      defaults[key] = s[key] as number;
    }
  }
  return defaults;
}
