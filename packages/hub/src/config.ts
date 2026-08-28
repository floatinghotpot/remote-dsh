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
import type { SmsConfig } from "./sms/types.ts";
import type { PaymentConfig } from "./billing/types.ts";
import type { AliyunCaptchaConfig } from "./captcha/aliyun.ts";

export interface CaptchaConfig {
  provider: "arithmetic" | "none" | "aliyun";
  /** provider=aliyun 时的验签配置（场景 ID 等） */
  aliyun?: AliyunCaptchaConfig;
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

/** 套餐规格（host 数 × 时长；价格 config 可配）。 */
export interface PlanSpec {
  id: string;
  name: string;
  /** host 数配额 */
  hosts: number;
  /** 人民币元 / intervalDays 天 */
  priceCny: number;
  /** 周期天数（如 30 = 月付） */
  intervalDays: number;
}

export interface BillingConfig {
  plans: PlanSpec[];
  /** 试用天数（默认 3） */
  trialDays?: number;
  /** 试用 host 配额（默认 1） */
  trialHosts?: number;
  /** 宽限天数（默认 3） */
  graceDays?: number;
  /** 降级后离线 host 数据保留天数（默认 30） */
  retentionDays?: number;
  /** 支付通道；缺省 → mock（立即成功） */
  payment?: PaymentConfig;
}

/** 计费默认值（config.billing 未提供时消费方取此）。 */
export const BILLING_DEFAULTS = { trialDays: 3, trialHosts: 1, graceDays: 3, retentionDays: 30 } as const;

/** 备案信息（portal 页脚展示；国内经营性网站合规必需，全部可选）。 */
export interface BeianConfig {
  /** ICP 备案号，如 "蜀ICP备XXXXXXXX号" */
  icp?: string;
  /** ICP 备案查询链接，默认 https://beian.miit.gov.cn */
  icpUrl?: string;
  /** 公安备案号，如 "川公网安备 XXXXXXXXXXXX号" */
  gongan?: string;
  /** 公安备案查询链接，默认 https://beian.mps.gov.cn */
  gonganUrl?: string;
}

/** 站点信息（portal 页脚导航：公司名/官网 + 产品介绍页）。 */
export interface SiteConfig {
  /** 公司名（页脚展示；无 url 时纯文本） */
  name?: string;
  /** 公司官网 URL */
  url?: string;
  /** 产品介绍页 URL */
  productUrl?: string;
  /** 用户协议 URL；配置后覆盖内置 /portal/terms */
  termsUrl?: string;
  /** 隐私政策 URL；配置后覆盖内置 /portal/privacy */
  privacyUrl?: string;
  /** 页脚信息行（地址/版权/许可等，按序渲染；href 可选外链）。 */
  footer?: Array<{ text: string; href?: string }>;
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
  /** 短信提供方；缺省 → 短信功能禁用（手机号通道不可用） */
  sms?: SmsConfig;
  /** 开放注册开关；缺省 → closed（自托管默认关闭，防 bot） */
  registration?: "open" | "closed";
  /** 计费/套餐配置；缺省 → 无套餐（订阅功能禁用） */
  billing?: BillingConfig;
  /** 备案信息（portal 页脚展示） */
  beian?: BeianConfig;
  /** 站点信息（portal 页脚导航） */
  site?: SiteConfig;
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
  if (cfg.sms !== undefined) out.sms = normalizeSms(cfg.sms, source);
  if (cfg.registration !== undefined) out.registration = normalizeRegistration(cfg.registration, source);
  if (cfg.billing !== undefined) out.billing = normalizeBilling(cfg.billing, source);
  if (cfg.beian !== undefined) out.beian = normalizeBeian(cfg.beian, source);
  if (cfg.site !== undefined) out.site = normalizeSite(cfg.site, source);
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
  if (e.provider === "smtp" && e.smtp === undefined) {
    throw new Error(`${source}: "email.smtp" is required when provider=smtp`);
  }
  if (e.provider === "aliyun" && e.aliyun === undefined) {
    throw new Error(`${source}: "email.aliyun" is required when provider=aliyun`);
  }
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
  if (c.provider !== "arithmetic" && c.provider !== "none" && c.provider !== "aliyun") throw new Error(`${source}: "captcha.provider" must be arithmetic|none|aliyun`);
  const out: CaptchaConfig = { provider: c.provider };
  if (c.provider === "aliyun") {
    const a = c.aliyun as Record<string, unknown> | undefined;
    if (
      a === undefined ||
      typeof a.accessKeyId !== "string" ||
      typeof a.accessKeySecret !== "string" ||
      typeof a.sceneId !== "string" ||
      typeof a.prefix !== "string"
    ) {
      throw new Error(`${source}: "captcha.aliyun" needs accessKeyId/accessKeySecret/sceneId/prefix`);
    }
    out.aliyun = { accessKeyId: a.accessKeyId, accessKeySecret: a.accessKeySecret, sceneId: a.sceneId, prefix: a.prefix };
    if (a.endpoint !== undefined) {
      if (typeof a.endpoint !== "string") throw new Error(`${source}: "captcha.aliyun.endpoint" must be a string`);
      out.aliyun.endpoint = a.endpoint;
    }
  }
  return out;
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

function normalizeSms(raw: unknown, source: string): SmsConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "sms" must be an object`);
  const s = raw as Record<string, unknown>;
  if (s.provider !== "aliyun" && s.provider !== "log") throw new Error(`${source}: "sms.provider" must be aliyun|log`);
  const out: SmsConfig = { provider: s.provider };
  if (s.provider === "aliyun") {
    const a = s.aliyun as Record<string, unknown> | undefined;
    if (
      a === undefined ||
      typeof a.accessKeyId !== "string" ||
      typeof a.accessKeySecret !== "string" ||
      typeof a.signName !== "string" ||
      typeof a.templateCode !== "string"
    ) {
      throw new Error(`${source}: "sms.aliyun" needs accessKeyId/accessKeySecret/signName/templateCode`);
    }
    out.aliyun = { accessKeyId: a.accessKeyId, accessKeySecret: a.accessKeySecret, signName: a.signName, templateCode: a.templateCode };
    if (a.endpoint !== undefined) {
      if (typeof a.endpoint !== "string") throw new Error(`${source}: "sms.aliyun.endpoint" must be a string`);
      out.aliyun.endpoint = a.endpoint;
    }
  }
  return out;
}

function normalizeRegistration(raw: unknown, source: string): "open" | "closed" {
  if (raw !== "open" && raw !== "closed") throw new Error(`${source}: "registration" must be open|closed`);
  return raw;
}

function normalizeBilling(raw: unknown, source: string): BillingConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "billing" must be an object`);
  const b = raw as Record<string, unknown>;
  const plans: PlanSpec[] = [];
  if (b.plans !== undefined) {
    if (!Array.isArray(b.plans)) throw new Error(`${source}: "billing.plans" must be an array`);
    for (const p of b.plans) {
      const plan = p as Record<string, unknown>;
      if (typeof plan.id !== "string" || plan.id.length === 0) throw new Error(`${source}: "billing.plans[].id" must be a non-empty string`);
      if (typeof plan.name !== "string" || plan.name.length === 0) throw new Error(`${source}: "billing.plans[].name" must be a non-empty string`);
      if (!Number.isInteger(plan.hosts) || (plan.hosts as number) < 1) throw new Error(`${source}: "billing.plans[].hosts" must be a positive integer`);
      if (typeof plan.priceCny !== "number" || plan.priceCny < 0) throw new Error(`${source}: "billing.plans[].priceCny" must be a non-negative number`);
      if (!Number.isInteger(plan.intervalDays) || (plan.intervalDays as number) < 1) throw new Error(`${source}: "billing.plans[].intervalDays" must be a positive integer`);
      plans.push({ id: plan.id, name: plan.name, hosts: plan.hosts as number, priceCny: plan.priceCny, intervalDays: plan.intervalDays as number });
    }
  }
  const out: BillingConfig = { plans };
  for (const key of ["trialDays", "trialHosts", "graceDays", "retentionDays"] as const) {
    if (b[key] !== undefined) {
      if (!Number.isInteger(b[key]) || (b[key] as number) < 0) throw new Error(`${source}: "billing.${key}" must be a non-negative integer`);
      (out as unknown as Record<string, unknown>)[key] = b[key] as number;
    }
  }
  if (b.payment !== undefined) {
    const p = b.payment as Record<string, unknown>;
    if (p.provider !== "mock" && p.provider !== "wechatpay" && p.provider !== "cmb") throw new Error(`${source}: "billing.payment.provider" must be mock|wechatpay|cmb`);
    if (p.provider === "wechatpay") {
      if (p.wechatpay === undefined) throw new Error(`${source}: "billing.payment.wechatpay" is required when provider=wechatpay`);
      const w = p.wechatpay as Record<string, unknown>;
      for (const key of ["mchid", "appid", "certSerialNo", "privateKey", "apiV3Key", "notifyUrl"] as const) {
        if (typeof w[key] !== "string" || w[key] === "") throw new Error(`${source}: "billing.payment.wechatpay.${key}" must be a non-empty string`);
      }
      if (w.appSecret !== undefined && (typeof w.appSecret !== "string" || w.appSecret === "")) throw new Error(`${source}: "billing.payment.wechatpay.appSecret" must be a non-empty string`);
    }
    out.payment = b.payment as PaymentConfig;
  }
  return out;
}

function normalizeBeian(raw: unknown, source: string): BeianConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "beian" must be an object`);
  const b = raw as Record<string, unknown>;
  const out: BeianConfig = {};
  for (const key of ["icp", "icpUrl", "gongan", "gonganUrl"] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== "string") throw new Error(`${source}: "beian.${key}" must be a string`);
      out[key] = b[key] as string;
    }
  }
  return out;
}

function normalizeSite(raw: unknown, source: string): SiteConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "site" must be an object`);
  const s = raw as Record<string, unknown>;
  const out: SiteConfig = {};
  for (const key of ["name", "url", "productUrl", "termsUrl", "privacyUrl"] as const) {
    if (s[key] !== undefined) {
      if (typeof s[key] !== "string") throw new Error(`${source}: "site.${key}" must be a string`);
      out[key] = s[key] as string;
    }
  }
  if (s.footer !== undefined) {
    if (!Array.isArray(s.footer)) throw new Error(`${source}: "site.footer" must be an array`);
    out.footer = (s.footer as unknown[]).map((item, i) => {
      if (typeof item !== "object" || item === null) throw new Error(`${source}: site.footer[${i}] must be an object`);
      const f = item as Record<string, unknown>;
      if (typeof f.text !== "string" || f.text.length === 0) throw new Error(`${source}: site.footer[${i}].text must be a non-empty string`);
      const row: { text: string; href?: string } = { text: f.text };
      if (f.href !== undefined) {
        if (typeof f.href !== "string") throw new Error(`${source}: site.footer[${i}].href must be a string`);
        row.href = f.href;
      }
      return row;
    });
  }
  return out;
}
