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
import type { UnicPayConfig } from "./billing/unicpay.ts";
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
  /** 人民币元 / 周期 */
  priceCny: number;
  /** 美元 / 周期（可选；缺省时客户端按人民币展示） */
  priceUsd?: number;
  /** 周期月数（如 1 = 月付；到期按日历月顺延） */
  intervalMonths: number;
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
  /** unicpay 平台（feature 121 订阅/内购接入）；缺省 → 不使用 unicpay */
  unicpay?: UnicPayConfig;
}

/** 计费默认值（config.billing 未提供时消费方取此）。 */
export const BILLING_DEFAULTS = { trialDays: 3, trialHosts: 1, graceDays: 3, retentionDays: 30 } as const;

/** 备案信息（portal 页脚展示；国内经营性网站合规必需，全部可选）。 */
/** 端到端加密策略（hub 侧）。mode: off 禁用 / optional 按 host 能力协商 / required 强制。 */
export interface E2eeConfig {
  mode: "off" | "optional" | "required";
}

/** 每日 SQLite 快照备份（VACUUM INTO 在线一致快照）。 */
export interface BackupConfig {
  /** 备份目录（缺省 <hub.json 同目录>/backups） */
  dir?: string;
  /** 保留天数（缺省 7） */
  keepDays?: number;
}

/** 站点信息（品牌名 + 法务/客服外链；备案/版权等内容已迁静态落地页）。 */
export interface SiteConfig {
  /** 产品品牌名（登录页眉标；缺省 portal 回退 "RDSH.CN"） */
  brand?: string;
  /** 用户协议 URL；配置后指向静态站 /<lang>/terms/ */
  termsUrl?: string;
  /** 隐私政策 URL；配置后指向静态站 /<lang>/privacy/ */
  privacyUrl?: string;
  /** 微信客服（企业微信客服）跳转 URL；配置后门户账户页显示「微信客服」入口 */
  customerServiceUrl?: string;
}

/** 微信登录配置（网站应用 AppID，独立于支付；仅登录）。 */
export interface WechatLoginConfig {
  /** 微信开放平台网站应用 AppID */
  appid: string;
  /** 网站应用 AppSecret（仅服务端） */
  appSecret: string;
  /** 登录回调完整 URL（须在开放平台「授权回调域」内） */
  redirectUri: string;
}

/** 微信登录配置（移动应用 AppID，仅 App SDK 登录；独立于网站应用与支付）。 */
export interface WechatAppLoginConfig {
  /** 微信开放平台移动应用 AppID */
  appid: string;
  /** 移动应用 AppSecret（仅服务端） */
  appSecret: string;
}

/** 苹果登录（Sign in with Apple，仅 iOS App）。凭据一律走配置，密钥不入库。 */
export interface AppleLoginConfig {
  /** Apple Developer 的 Team ID */
  teamId: string;
  /** 「Sign in with Apple」私钥的 Key ID */
  keyId: string;
  /** Client ID（原生 iOS = bundleId，如 com.unicgames.rdshapp） */
  clientId: string;
  /** 「Sign in with Apple」私钥（.p8，PKCS#8 PEM）文件路径；内容不入库 */
  privateKeyPath: string;
  /** 令牌加密密钥（64 位 hex = 32 字节，AES-256-GCM） */
  tokenEncKey: string;
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
  /** 注册每日上限（滚动 24h 计数；缺省不限） */
  registrationDailyLimit?: number;
  /** 注册总量上限（全库用户数硬顶；缺省不限） */
  registrationMaxUsers?: number;
  /** 计费/套餐配置；缺省 → 无套餐（订阅功能禁用） */
  billing?: BillingConfig;
  /** 端到端加密策略；缺省 → optional（按 host 能力协商） */
  e2ee?: E2eeConfig;
  /** 每日快照备份；缺省 → 启用（<hub.json 同目录>/backups，保留 7 天） */
  backup?: BackupConfig;
  /** 站点信息（portal 页脚导航） */
  site?: SiteConfig;
  /** 微信登录（网站应用 AppID；缺省 → 微信登录禁用） */
  wechatLogin?: WechatLoginConfig;
  /** 微信 App 登录（移动应用 AppID；缺省 → App 微信登录禁用） */
  wechatAppLogin?: WechatAppLoginConfig;
  /** 允许回跳的 App scheme 白名单（不含 `://`，如 `["rdshapp"]`；缺省 → 空，服务端回跳安全失败） */
  appSchemes?: string[];
  /** 苹果登录（Sign in with Apple；缺省 → 苹果登录禁用） */
  appleLogin?: AppleLoginConfig;
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
  if (cfg.registrationDailyLimit !== undefined) {
    if (!Number.isInteger(cfg.registrationDailyLimit) || (cfg.registrationDailyLimit as number) < 1) throw new Error(`${source}: "registrationDailyLimit" must be a positive integer`);
    out.registrationDailyLimit = cfg.registrationDailyLimit as number;
  }
  if (cfg.registrationMaxUsers !== undefined) {
    if (!Number.isInteger(cfg.registrationMaxUsers) || (cfg.registrationMaxUsers as number) < 1) throw new Error(`${source}: "registrationMaxUsers" must be a positive integer`);
    out.registrationMaxUsers = cfg.registrationMaxUsers as number;
  }
  if (cfg.billing !== undefined) out.billing = normalizeBilling(cfg.billing, source);
  if (cfg.e2ee !== undefined) out.e2ee = normalizeE2ee(cfg.e2ee, source);
  if (cfg.backup !== undefined) out.backup = normalizeBackup(cfg.backup, source);
  if (cfg.site !== undefined) out.site = normalizeSite(cfg.site, source);
  if (cfg.wechatLogin !== undefined) out.wechatLogin = normalizeWechatLogin(cfg.wechatLogin, source);
  if (cfg.wechatAppLogin !== undefined) out.wechatAppLogin = normalizeWechatAppLogin(cfg.wechatAppLogin, source);
  if (cfg.appSchemes !== undefined) out.appSchemes = normalizeAppSchemes(cfg.appSchemes, source);
  if (cfg.appleLogin !== undefined) out.appleLogin = normalizeAppleLogin(cfg.appleLogin, source);
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
      if (plan.priceUsd !== undefined && (typeof plan.priceUsd !== "number" || plan.priceUsd < 0)) throw new Error(`${source}: "billing.plans[].priceUsd" must be a non-negative number`);
      if ("intervalDays" in plan) throw new Error(`${source}: "billing.plans[].intervalDays" was removed — rename it to "intervalMonths" and set the month count (e.g. intervalDays: 30 → intervalMonths: 1)`);
      if (!Number.isInteger(plan.intervalMonths) || (plan.intervalMonths as number) < 1) throw new Error(`${source}: "billing.plans[].intervalMonths" must be a positive integer`);
      plans.push({ id: plan.id, name: plan.name, hosts: plan.hosts as number, priceCny: plan.priceCny, priceUsd: typeof plan.priceUsd === "number" ? plan.priceUsd : undefined, intervalMonths: plan.intervalMonths as number });
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
      for (const key of ["mchid", "appid", "certSerialNo", "privateKey", "apiV3Key", "platformCert", "platformCertSerialNo", "notifyUrl"] as const) {
        if (typeof w[key] !== "string" || w[key] === "") throw new Error(`${source}: "billing.payment.wechatpay.${key}" must be a non-empty string`);
      }
      if (w.appSecret !== undefined && (typeof w.appSecret !== "string" || w.appSecret === "")) throw new Error(`${source}: "billing.payment.wechatpay.appSecret" must be a non-empty string`);
    }
    out.payment = b.payment as PaymentConfig;
  }
  if (b.unicpay !== undefined) {
    const u = b.unicpay as Record<string, unknown>;
    for (const key of ["appId", "baseUrl", "authSecret", "webhookSecret"] as const) {
      if (typeof u[key] !== "string" || u[key] === "") throw new Error(`${source}: "billing.unicpay.${key}" must be a non-empty string`);
    }
    out.unicpay = b.unicpay as UnicPayConfig;
  }
  return out;
}

function normalizeE2ee(raw: unknown, source: string): E2eeConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "e2ee" must be an object`);
  const e = raw as Record<string, unknown>;
  if (e.mode !== "off" && e.mode !== "optional" && e.mode !== "required") {
    throw new Error(`${source}: "e2ee.mode" must be off|optional|required`);
  }
  return { mode: e.mode };
}

function normalizeBackup(raw: unknown, source: string): BackupConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "backup" must be an object`);
  const b = raw as Record<string, unknown>;
  const out: BackupConfig = {};
  if (b.dir !== undefined) {
    if (typeof b.dir !== "string" || b.dir === "") throw new Error(`${source}: "backup.dir" must be a non-empty string`);
    out.dir = b.dir;
  }
  if (b.keepDays !== undefined) {
    if (typeof b.keepDays !== "number" || !Number.isInteger(b.keepDays) || b.keepDays < 1) throw new Error(`${source}: "backup.keepDays" must be a positive integer`);
    out.keepDays = b.keepDays;
  }
  return out;
}

function normalizeSite(raw: unknown, source: string): SiteConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "site" must be an object`);
  const s = raw as Record<string, unknown>;
  const out: SiteConfig = {};
  for (const key of ["brand", "termsUrl", "privacyUrl", "customerServiceUrl"] as const) {
    if (s[key] !== undefined) {
      if (typeof s[key] !== "string") throw new Error(`${source}: "site.${key}" must be a string`);
      out[key] = s[key] as string;
    }
  }
  return out;
}

function normalizeWechatLogin(raw: unknown, source: string): WechatLoginConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "wechatLogin" must be an object`);
  const w = raw as Record<string, unknown>;
  for (const key of ["appid", "appSecret", "redirectUri"] as const) {
    if (typeof w[key] !== "string" || w[key] === "") throw new Error(`${source}: "wechatLogin.${key}" must be a non-empty string`);
  }
  try {
    const u = new URL(w.redirectUri as string);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
  } catch {
    throw new Error(`${source}: "wechatLogin.redirectUri" must be a valid absolute URL`);
  }
  return { appid: w.appid as string, appSecret: w.appSecret as string, redirectUri: w.redirectUri as string };
}

function normalizeWechatAppLogin(raw: unknown, source: string): WechatAppLoginConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "wechatAppLogin" must be an object`);
  const a = raw as Record<string, unknown>;
  for (const key of ["appid", "appSecret"] as const) {
    if (typeof a[key] !== "string" || a[key] === "") throw new Error(`${source}: "wechatAppLogin.${key}" must be a non-empty string`);
  }
  return { appid: a.appid as string, appSecret: a.appSecret as string };
}

function normalizeAppSchemes(raw: unknown, source: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${source}: "appSchemes" must be an array`);
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || s === "") throw new Error(`${source}: "appSchemes[]" must be a non-empty string`);
    const clean = s.replace(/:\/\/.*$/, "").trim();
    if (!/^[a-z][a-z0-9+.-]*$/i.test(clean)) throw new Error(`${source}: "appSchemes[]" has invalid scheme: ${s}`);
    out.push(clean);
  }
  return out;
}

function normalizeAppleLogin(raw: unknown, source: string): AppleLoginConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "appleLogin" must be an object`);
  const a = raw as Record<string, unknown>;
  for (const key of ["teamId", "keyId", "clientId", "privateKeyPath"] as const) {
    if (typeof a[key] !== "string" || a[key] === "") throw new Error(`${source}: "appleLogin.${key}" must be a non-empty string`);
  }
  if (typeof a.tokenEncKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(a.tokenEncKey)) {
    throw new Error(`${source}: "appleLogin.tokenEncKey" must be a 64-char hex string (32 bytes)`);
  }
  return {
    teamId: a.teamId as string,
    keyId: a.keyId as string,
    clientId: a.clientId as string,
    privateKeyPath: a.privateKeyPath as string,
    tokenEncKey: a.tokenEncKey as string,
  };
}
