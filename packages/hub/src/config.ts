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
import type { WechatOauthConfig } from "./billing/wechat-oauth.ts";
import type { CreditProduct } from "./credits.ts";
import { readFileSync } from "node:fs";
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
  /**
   * 档位：1 = 标准版 / 2 = 专业版 / 3 = 旗舰版（可扩展）。
   *
   * 缺省 `undefined` 时客户端按**最低付费档**处理（与 App 的 `vip_tier ?? 1` 一致）。
   * 客户端据此显示身份与档位对比表 —— 契约见 `API.md` §13。
   */
  vipTier?: number;
  /**
   * 每月赠点数（点数，非微单位；0 = 不赠）。
   * 数值待成本模型回填，缺省 0（本期不发赠点，仅保留结转逻辑）。
   */
  bonusCredits?: number;
}

export interface BillingConfig {
  plans: PlanSpec[];
  /**
   * **点数/订阅商品清单文件**（单一真相）—— hub 启动时读它取点数档位。
   *
   * 就是 App 的 `private/rdsh-app/assets/iap_products.json`（App 展示、商店导出、
   * hub 记账三方共用一份），部署时 scp 到服务器并在配置里写绝对路径。
   * 读的是 `products.consumable[]`（字段 `id` / `package.credits` / `priceCNY` / `priceUSD`）。
   */
  productsFile?: string;
  /**
   * 点数充值档位（解析结果：来自 `productsFile`，或配置内联兜底）。
   *
   * 缺省为空数组 ⇒ **不卖点数**（`/api/credits/recharge` 与入账都会拒绝未知 goodsId）。
   */
  credits: CreditProduct[];
  /** 试用天数（默认 3） */
  trialDays?: number;
  /** 试用 host 配额（默认 1） */
  trialHosts?: number;
  /** 宽限天数（默认 3） */
  graceDays?: number;
  /** 降级后离线 host 数据保留天数（默认 30） */
  retentionDays?: number;
  /** 公众号 OAuth（jsapi 支付换 openid 用）；缺省 → jsapi 不可用 */
  wechatOauth?: WechatOauthConfig;
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
  /** 产品品牌名（中英文），登录页眉标 + 邮件模板 {brand} 占位符；未配置/缺项时由渲染层兜底 zh=鲸语通 en=WhaleLink */
  brand?: { zh?: string; en?: string };
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
  /** 数据库：driver=sqlite（默认，用 dbPath）或 postgres（用 dsn）。缺省 → sqlite */
  db?: { driver?: "sqlite" | "postgres"; dsn?: string };
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
  /** 转发点（relay node）上报用量的共享令牌；缺省 → 端点禁用（404） */
  relayNodeToken?: string;
  /** host cookie 的 Ed25519 公钥（hex，64 字符）；节点经 N5 同步持公钥验签（R17）。缺省 → 节点目录功能禁用 */
  hostCookiePubKey?: string;
  /** host cookie 的 Domain（区域根域，如 .rdsh.cn）；缺省 → host-only（节点子域收不到） */
  hostCookieDomain?: string;
  /** 默认 relay（hub 内置转发点）的对客 URL（如 https://relay.rdsh.cn）；配置后 host 列表与进入 302 强制走该 URL，避免与站点根路径混用。缺省 → 空（回退 hub 根路径） */
  defaultRelayUrl?: string;
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
  if (cfg.db !== undefined) {
    const db = cfg.db as { driver?: string; dsn?: string };
    if (typeof db !== "object" || db === null) throw new Error(`${source}: "db" must be an object`);
    const driver = db.driver ?? "sqlite";
    if (driver !== "sqlite" && driver !== "postgres") throw new Error(`${source}: "db.driver" must be "sqlite" or "postgres"`);
    if (driver === "postgres" && (typeof db.dsn !== "string" || db.dsn === "")) throw new Error(`${source}: "db.dsn" is required when db.driver=postgres`);
    out.db = { driver, dsn: driver === "postgres" ? db.dsn : undefined };
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
  if (cfg.relayNodeToken !== undefined) {
    if (typeof cfg.relayNodeToken !== "string" || cfg.relayNodeToken.length < 16) throw new Error(`${source}: "relayNodeToken" must be a string of >= 16 chars`);
    out.relayNodeToken = cfg.relayNodeToken;
  }
  if (cfg.hostCookiePubKey !== undefined) {
    if (typeof cfg.hostCookiePubKey !== "string" || !/^[0-9a-f]{64}$/i.test(cfg.hostCookiePubKey)) throw new Error(`${source}: "hostCookiePubKey" must be a 64-char hex Ed25519 public key`);
    out.hostCookiePubKey = cfg.hostCookiePubKey;
  }
  if (cfg.hostCookieDomain !== undefined) {
    if (typeof cfg.hostCookieDomain !== "string") throw new Error(`${source}: "hostCookieDomain" must be a string`);
    out.hostCookieDomain = cfg.hostCookieDomain;
  }
  if (cfg.defaultRelayUrl !== undefined) {
    if (typeof cfg.defaultRelayUrl !== "string") throw new Error(`${source}: "defaultRelayUrl" must be a string`);
    out.defaultRelayUrl = cfg.defaultRelayUrl;
  }
  if (cfg.backup !== undefined) out.backup = normalizeBackup(cfg.backup, source);
  if (cfg.site !== undefined) out.site = normalizeSite(cfg.site, source);
  if (cfg.wechatLogin !== undefined) out.wechatLogin = normalizeWechatLogin(cfg.wechatLogin, source);
  if (cfg.wechatAppLogin !== undefined) out.wechatAppLogin = normalizeWechatAppLogin(cfg.wechatAppLogin, source);
  if (cfg.appSchemes !== undefined) out.appSchemes = normalizeAppSchemes(cfg.appSchemes, source);
  if (cfg.appleLogin !== undefined) out.appleLogin = normalizeAppleLogin(cfg.appleLogin, source);
  out.security = normalizeSecurity(cfg.security, source);
  return out;
}

function normalizeLangPair(raw: unknown, label: string): { zh: string; en: string } {
  if (typeof raw !== "object" || raw === null) throw new Error(`${label} must be an object { zh, en }`);
  const p = raw as Record<string, unknown>;
  if (typeof p.zh !== "string" || typeof p.en !== "string") throw new Error(`${label} needs zh/en strings`);
  return { zh: p.zh, en: p.en };
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
  if (e.codeTemplates !== undefined) {
    const ct = e.codeTemplates as Record<string, unknown>;
    if (typeof ct !== "object" || ct === null) throw new Error(`${source}: "email.codeTemplates" must be an object`);
    const templates: NonNullable<EmailConfig["codeTemplates"]> = {};
    for (const purpose of ["verify", "reset"] as const) {
      const raw = ct[purpose];
      if (raw === undefined) continue;
      if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "email.codeTemplates.${purpose}" must be an object`);
      const t = raw as Record<string, unknown>;
      templates[purpose] = {
        subject: normalizeLangPair(t.subject, `${source}: "email.codeTemplates.${purpose}.subject"`),
        text: normalizeLangPair(t.text, `${source}: "email.codeTemplates.${purpose}.text"`),
      };
    }
    if (Object.keys(templates).length > 0) out.codeTemplates = templates;
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

/**
 * 把「id / credits / priceCny / priceUsd」条目解析成档位。
 * 配置文件与商品清单文件共用；两种字段拼写都接受（`priceCny|priceCNY`、`priceUsd|priceUSD`）。
 */
/** 解析配置内联的套餐（`billing.plans[]`，自托管/测试兜底）。规则与商品清单形态保持一致。 */
function parsePlanEntries(raw: unknown, source: string, where: string): PlanSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${source}: "${where}" must be an array`);
  const out: PlanSpec[] = [];
  for (const p of raw) {
      const plan = p as Record<string, unknown>;
      if (typeof plan.id !== "string" || plan.id.length === 0) throw new Error(`${source}: "${where}[].id" must be a non-empty string`);
      if (typeof plan.name !== "string" || plan.name.length === 0) throw new Error(`${source}: "${where}[].name" must be a non-empty string`);
      if (!Number.isInteger(plan.hosts) || (plan.hosts as number) < 1) throw new Error(`${source}: "${where}[].hosts" must be a positive integer`);
      if (typeof plan.priceCny !== "number" || plan.priceCny < 0) throw new Error(`${source}: "${where}[].priceCny" must be a non-negative number`);
      if (plan.priceUsd !== undefined && (typeof plan.priceUsd !== "number" || plan.priceUsd < 0)) throw new Error(`${source}: "${where}[].priceUsd" must be a non-negative number`);
      if ("intervalDays" in plan) throw new Error(`${source}: "${where}[].intervalDays" was removed — rename it to "intervalMonths" and set the month count (e.g. intervalDays: 30 → intervalMonths: 1)`);
      if (!Number.isInteger(plan.intervalMonths) || (plan.intervalMonths as number) < 1) throw new Error(`${source}: "${where}[].intervalMonths" must be a positive integer`);
      if (plan.vipTier !== undefined && (!Number.isInteger(plan.vipTier) || (plan.vipTier as number) < 1)) throw new Error(`${source}: "${where}[].vipTier" must be a positive integer (1=标准版 / 2=专业版 / 3=旗舰版)`);
      // vipTier 只影响展示/对比表（权益与配额由 hosts 决定）→ 容忍缺省：
      // 缺省按声明顺序推导为 1,2,3…（与门户/App 的 `vipTier ?? 1` 兜底姿态一致，向后兼容存量配置）。
      const vipTier = typeof plan.vipTier === "number" ? plan.vipTier : out.length + 1;
      // 档位不可重复：客户端按 vipTier 判定"我是哪一档"，重复会让它无法区分。
      if (out.some((x) => x.vipTier === vipTier)) {
        throw new Error(`${source}: "${where}[].vipTier" must be unique (duplicate ${vipTier})`);
      }
      out.push({ id: plan.id, name: plan.name, hosts: plan.hosts as number, priceCny: plan.priceCny, priceUsd: typeof plan.priceUsd === "number" ? plan.priceUsd : undefined, intervalMonths: plan.intervalMonths as number, vipTier, bonusCredits: typeof plan.bonusCredits === "number" && plan.bonusCredits >= 0 ? plan.bonusCredits : 0 });
  }
  return out;
}

/** 解析商品清单里的订阅条目（`products.subscription[]`）→ hub 套餐。
 *
 * 清单是 App/商店/hub 共用的单一真相，字段映射见 `API.md`：
 * `name` ← `l10nName["zh-CN"]`（**键缺失时回落 `en`**；键存在但为空 ⇒ 启动失败；只用于支付订单主题）、`hosts` ← `package.hosts`、
 * `vip_tier` ← `package.vip_tier`、月赠点 ← `package.credits`、周期 ← `duration {unit, count}`。
 */
function parseSubscriptionEntries(raw: unknown, source: string, where: string): PlanSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${source}: "${where}" must be an array`);
  const out: PlanSpec[] = [];
  for (const s of raw) {
    const g = s as Record<string, unknown>;
    if (typeof g.id !== "string" || g.id.length === 0) throw new Error(`${source}: "${where}[].id" must be a non-empty string`);
    const l10nName = g.l10nName as Record<string, unknown> | undefined;
    // `??` 只在「zh-CN 键缺失」时回落 en；键存在但为空串 ⇒ 不回落，按 fail-fast 报错（空名称不该有）。
    const name = l10nName === undefined || l10nName === null ? "" : String(l10nName["zh-CN"] ?? l10nName.en ?? "").trim();
    if (name === "") throw new Error(`${source}: "${where}[].l10nName" must carry a non-empty "zh-CN" (or "en") name — the hub needs it for the payment subject`);
    const pkg = g.package as Record<string, unknown> | undefined;
    if (typeof pkg !== "object" || pkg === null) throw new Error(`${source}: "${where}[].package" must be an object`);
    const hosts = pkg.hosts;
    if (!Number.isInteger(hosts) || (hosts as number) < 1) throw new Error(`${source}: "${where}[].package.hosts" must be a positive integer`);
    const priceCny = g.priceCNY ?? g.priceCny;
    if (typeof priceCny !== "number" || priceCny < 0) throw new Error(`${source}: "${where}[].priceCNY" must be a non-negative number`);
    const priceUsd = g.priceUSD ?? g.priceUsd;
    if (priceUsd !== undefined && (typeof priceUsd !== "number" || priceUsd < 0)) throw new Error(`${source}: "${where}[].priceUSD" must be a non-negative number`);
    const duration = g.duration as Record<string, unknown> | undefined;
    const unit = duration?.unit;
    const count = duration?.count;
    if (!Number.isInteger(count) || (count as number) < 1) throw new Error(`${source}: "${where}[].duration.count" must be a positive integer`);
    // hub 按日历月顺延到期日，只接受 month/year（day/week 语义不成立 → 吵，不猜）。
    let intervalMonths: number;
    if (unit === "month") intervalMonths = count as number;
    else if (unit === "year") intervalMonths = (count as number) * 12;
    else throw new Error(`${source}: "${where}[].duration.unit" must be month|year for a hub plan (got ${JSON.stringify(unit)})`);
    const vipTierRaw = pkg.vip_tier;
    if (vipTierRaw !== undefined && (!Number.isInteger(vipTierRaw) || (vipTierRaw as number) < 1)) throw new Error(`${source}: "${where}[].package.vip_tier" must be a positive integer (1=标准版 / 2=专业版 / 3=旗舰版)`);
    const vipTier = typeof vipTierRaw === "number" ? vipTierRaw : out.length + 1;
    if (out.some((x) => x.vipTier === vipTier)) throw new Error(`${source}: "${where}[].package.vip_tier" must be unique (duplicate ${vipTier})`);
    const bonusRaw = pkg.credits;
    if (bonusRaw !== undefined && (!Number.isInteger(bonusRaw) || (bonusRaw as number) < 0)) throw new Error(`${source}: "${where}[].package.credits" must be a non-negative integer`);
    if (out.some((x) => x.id === g.id)) throw new Error(`${source}: "${where}[].id" must be unique (duplicate ${g.id})`);
    out.push({ id: g.id, name, hosts: hosts as number, priceCny, priceUsd: typeof priceUsd === "number" ? priceUsd : undefined, intervalMonths, vipTier, bonusCredits: typeof bonusRaw === "number" ? bonusRaw : 0 });
  }
  return out;
}

function parseCreditEntries(raw: unknown, source: string, where: string): CreditProduct[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${source}: "${where}" must be an array`);
  const out: CreditProduct[] = [];
  for (const c of raw) {
    const g = c as Record<string, unknown>;
    if (typeof g.id !== "string" || g.id.length === 0) throw new Error(`${source}: "${where}[].id" must be a non-empty string`);
    // 2026-10-14：数量收进 `package`（与 App / 商店导出共用同一份清单结构）。
    const pkg = g.package as Record<string, unknown> | undefined;
    if (typeof pkg !== "object" || pkg === null) throw new Error(`${source}: "${where}[].package" must be an object`);
    const credits = pkg.credits;
    if (!Number.isInteger(credits) || (credits as number) < 1) throw new Error(`${source}: "${where}[].package.credits" must be a positive integer`);
    const priceCny = g.priceCny ?? g.priceCNY;
    if (typeof priceCny !== "number" || priceCny < 0) throw new Error(`${source}: "${where}[].priceCny" must be a non-negative number`);
    const priceUsd = g.priceUsd ?? g.priceUSD;
    if (priceUsd !== undefined && (typeof priceUsd !== "number" || priceUsd < 0)) throw new Error(`${source}: "${where}[].priceUsd" must be a non-negative number`);
    if (out.some((x) => x.id === g.id)) throw new Error(`${source}: "${where}[].id" must be unique (duplicate ${g.id})`);
    out.push({
      id: g.id,
      credits: credits as number,
      priceCny,
      priceUsd: typeof priceUsd === "number" ? priceUsd : undefined,
      ...(g.isPopular === true ? { isPopular: true } : {}),
      ...(g.isBestValue === true ? { isBestValue: true } : {}),
    });
  }
  return out;
}

/**
 * 读商品清单文件（`private/rdsh-app/assets/iap_products.json`）：
 * `products.consumable[]` → 点数档位，`products.subscription[]` → 套餐（plans）。
 *
 * **配置错误要吵**：路径写了但文件读不到 / JSON 坏 / 缺字段 ⇒ 启动失败（而不是静默不卖点数）。
 */
function loadCatalogFromFile(path: string, source: string): { credits: CreditProduct[]; plans: PlanSpec[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`${source}: cannot read "billing.productsFile" (${path}): ${(e as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: "billing.productsFile" is not valid JSON (${path}): ${(e as Error).message}`);
  }
  const products = (doc as { products?: { consumable?: unknown; subscription?: unknown } })?.products;
  if (products === undefined || products.consumable === undefined) {
    throw new Error(`${source}: "billing.productsFile" has no "products.consumable" (${path})`);
  }
  // 段键必须显式存在（可为空数组）—— 段名笔误（如 `subscriptions`）会静默"不卖订阅"，故也 fail-fast。
  if (products.subscription === undefined) {
    throw new Error(`${source}: "billing.productsFile" has no "products.subscription" (${path})`);
  }
  const credits = parseCreditEntries(products.consumable, source, "billing.productsFile: products.consumable");
  const plans = parseSubscriptionEntries(products.subscription, source, "billing.productsFile: products.subscription");
  // 同一个 id 不能既是点数档位又是订阅套餐 —— 否则下单/入账无法区分。
  for (const plan of plans) {
    if (credits.some((c) => c.id === plan.id)) {
      throw new Error(`${source}: "billing.productsFile" uses id ${plan.id} in both products.consumable and products.subscription (${path})`);
    }
  }
  return { credits, plans };
}

function normalizeBilling(raw: unknown, source: string): BillingConfig {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: "billing" must be an object`);
  const b = raw as Record<string, unknown>;
  // 点数档位：**优先读商品清单文件**（App/商店/hub 共用的单一真相），
  // 无文件时退回配置内联（自托管与测试用）。
  let productsFile: string | undefined;
  if (b.productsFile !== undefined) {
    // R3「配置错误要吵」：给了值却非字符串（或空串）→ 抛错，而不是静默当未配置。
    if (typeof b.productsFile !== "string" || b.productsFile.length === 0) {
      throw new Error(`${source}: "billing.productsFile" must be a non-empty string`);
    }
    productsFile = b.productsFile;
  }
  const fromFile = productsFile !== undefined ? loadCatalogFromFile(productsFile, source) : undefined;
  const credits: CreditProduct[] = fromFile !== undefined ? fromFile.credits : parseCreditEntries(b.credits, source, "billing.credits");
  const resolvedPlans: PlanSpec[] = fromFile !== undefined ? fromFile.plans : parsePlanEntries(b.plans, source, "billing.plans");
  const out: BillingConfig = { plans: resolvedPlans, credits, productsFile };
  for (const key of ["trialDays", "trialHosts", "graceDays", "retentionDays"] as const) {
    if (b[key] !== undefined) {
      if (!Number.isInteger(b[key]) || (b[key] as number) < 0) throw new Error(`${source}: "billing.${key}" must be a non-negative integer`);
      (out as unknown as Record<string, unknown>)[key] = b[key] as number;
    }
  }
  if (b.wechatOauth !== undefined) {
    const w = b.wechatOauth as Record<string, unknown>;
    for (const key of ["appid", "appSecret", "baseUrl"] as const) {
      if (typeof w[key] !== "string" || w[key] === "") throw new Error(`${source}: "billing.wechatOauth.${key}" must be a non-empty string`);
    }
    out.wechatOauth = b.wechatOauth as WechatOauthConfig;
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
  if (s.brand !== undefined) {
    if (typeof s.brand !== "object" || s.brand === null) throw new Error(`${source}: "site.brand" must be an object { zh?, en? }`);
    const b = s.brand as Record<string, unknown>;
    if (b.zh !== undefined && typeof b.zh !== "string") throw new Error(`${source}: "site.brand.zh" must be a string`);
    if (b.en !== undefined && typeof b.en !== "string") throw new Error(`${source}: "site.brand.en" must be a string`);
    out.brand = { zh: b.zh as string | undefined, en: b.en as string | undefined };
  }
  for (const key of ["termsUrl", "privacyUrl", "customerServiceUrl"] as const) {
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
