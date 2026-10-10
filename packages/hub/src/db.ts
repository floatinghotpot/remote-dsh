/**
 * db.ts — hub 持久化（node:sqlite，零外部依赖）。
 *
 * 表：users / hosts / refresh_tokens / join_tokens。
 * 安全基线（req R10）：密码 scrypt 哈希、host token / refresh token 只存 SHA-256 摘要。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface UserRow {
  id: number;
  name: string;
  passwordHash: string;
  /** 改密/吊销时 +1：JWT 内嵌 ver，校验时对比 → 即时失效 */
  ver: number;
  createdAt: string;
  /** 1 = 首次登录须设密码（--no-password 建号）；设密后清 0 */
  mustChange: number;
  /** 绑定邮箱（未绑定为 null；唯一） */
  email: string | null;
  /** 1 = 邮箱已验证 */
  emailVerified: number;
  /** TOTP secret（base32）；null = 未开启 2FA */
  totpSecret: string | null;
  /** 连续登录失败次数（账户维度锁定） */
  failedAttempts: number;
  /** 锁定截止时间戳（ms）；null = 未锁定 */
  lockedUntil: number | null;
  /** 绑定手机号（未绑定为 null；唯一，+86 E.164） */
  phone: string | null;
  /** 1 = 手机号已验证 */
  phoneVerified: number;
  /** 账号状态：pending | active | banned | deleted */
  accountStatus: string;
  /** 角色：user | readonly | operator | admin（管理面 RBAC） */
  role: string;
  /** 计费状态：NULL（不受限）| trial | subscribed | grace | free */
  planStatus: string | null;
  /** 当前计费状态到期时间戳（ms）；NULL 不适用 */
  planExpiresAt: number | null;
  /** 试用开始时间戳（ms） */
  trialStartedAt: number | null;
  /** 降级到免费档的时间戳（ms）；重新订阅时清空 */
  freeSinceAt: number | null;
  /** 最近一次成功登录时间戳（ms，feature 16；null = 从未登录） */
  lastLoginAt: number | null;
  /** 微信 openid（**网站应用** AppID 下唯一；null = 未绑定） */
  wxwebOpenid: string | null;
  /** 微信 openid（**移动应用** AppID 下唯一；null = 未绑定） */
  wxappOpenid: string | null;
  /** 微信 unionid（开放平台账号内跨 AppID 共享 = 账号身份；null = 未返回/未绑定） */
  wechatUnionid: string | null;
  /** 微信昵称（仅展示） */
  wechatNickname: string | null;
  /** 微信头像 URL（仅展示） */
  wechatAvatar: string | null;
  /** Apple 用户标识（sub；App 内唯一；null = 未绑定） */
  appleSub: string | null;
  /** Apple 邮箱（仅首次授权返回；私有中继邮箱合法） */
  appleEmail: string | null;
  /** Apple 姓名（仅首次授权返回，展示用） */
  appleFullName: string | null;
}

export interface HostRow {
  id: string;
  ownerId: number;
  name: string;
  tokenHash: string;
  e2eePublicKey: string | null;
  createdAt: string;
}

export interface RefreshRow {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: number;
  revoked: number;
  createdAt: number;
}

export interface JoinTokenRow {
  id: string;
  label: string | null;
  ownerId: number;
  tokenHash: string;
  expiresAt: number;
  revoked: number;
  createdAt: string;
}

export interface BindSessionRow {
  id: string;
  consumeTokenHash: string;
  e2eePublicKey: string | null;
  name: string | null;
  ownerId: number | null;
  status: "pending" | "approved" | "consumed";
  createdAt: string;
  expiresAt: number;
}

export interface HostShareRow {
  hostId: string;
  userId: number;
  role: string;
  createdAt: string;
}

export interface AuditEventRow {
  id: number;
  userId: number | null;
  event: string;
  detailJson: string;
  ip: string;
  /** 来源：user（自助）| admin（管理操作） */
  source: string;
  /** admin 操作者 id；用户自助为 null */
  actorUserId: number | null;
  createdAt: number;
}

export interface EmailCodeRow {
  id: number;
  userId: number;
  email: string;
  purpose: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export interface SmsCodeRow {
  id: number;
  userId: number;
  phone: string;
  purpose: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export interface SubscriptionRow {
  id: number;
  userId: number;
  planId: string;
  /** active | canceled | expired */
  status: string;
  startedAt: number;
  expiresAt: number;
  createdAt: number;
  /** 支付来源渠道（apple / google / wechatpay），旧数据为 null */
  channel: string | null;
  /** 平台订阅实体 ID（unicpay subscriptionId），用于 webhook 幂等；旧数据为 null */
  subscriptionId: string | null;
  /** 是否自动续订 */
  willRenew: boolean;
}

export interface OrderRow {
  id: string;
  userId: number;
  planId: string;
  amountCny: number;
  /** created | paid | closed | refunded */
  status: string;
  channel: string | null;
  outId: string | null;
  createdAt: number;
  paidAt: number | null;
}

export interface PaymentRow {
  id: string;
  orderId: string;
  userId: number;
  channel: string;
  channelOrderId: string;
  amountCny: number;
  paidAt: number;
  raw: string;
}

export interface UsageDayRow {
  id: number;
  userId: number;
  /** 'YYYY-MM-DD'（区域时区日界，客户端上报） */
  date: string;
  relaySeconds: number;
  relayBytesUp: number;
  relayBytesDown: number;
  directBytesUp: number;
  directBytesDown: number;
  cloudAsrSeconds: number;
  localAsrSeconds: number;
  sessions: number;
  updatedAt: number;
}

export class HubDb {
  readonly db: DatabaseSync;
  /** 数据库文件路径（:memory: 测试用） */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        ver INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 0,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        phone TEXT,
        phone_verified INTEGER NOT NULL DEFAULT 0,
        account_status TEXT NOT NULL DEFAULT 'active',
        role TEXT NOT NULL DEFAULT 'user',
        plan_status TEXT,
        plan_expires_at INTEGER,
        trial_started_at INTEGER,
        free_since_at INTEGER,
        wxweb_openid TEXT,
        wxapp_openid TEXT,
        wechat_unionid TEXT,
        wechat_nickname TEXT,
        wechat_avatar TEXT,
        last_login_at INTEGER,
        apple_sub TEXT,
        apple_email TEXT,
        apple_full_name TEXT
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        e2ee_public_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS join_tokens (
        id TEXT PRIMARY KEY,
        label TEXT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bind_sessions (
        id TEXT PRIMARY KEY,
        consume_token_hash TEXT UNIQUE NOT NULL,
        e2ee_public_key TEXT,
        name TEXT,
        owner_id INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_share (
        host_id TEXT NOT NULL REFERENCES hosts(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        PRIMARY KEY (host_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        event TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        ip TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'user',
        actor_user_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_codes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sms_codes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        purpose TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        channel TEXT,
        subscription_id TEXT,
        will_renew INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan_id TEXT NOT NULL,
        amount_cny REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        channel TEXT,
        out_id TEXT,
        created_at INTEGER NOT NULL,
        paid_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        channel TEXT NOT NULL,
        channel_order_id TEXT NOT NULL,
        amount_cny REAL NOT NULL,
        paid_at INTEGER NOT NULL,
        raw TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS apple_tokens (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        refresh_token TEXT,
        access_token TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        host_id TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL,
        instance_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        relay_seconds INTEGER NOT NULL DEFAULT 0,
        relay_bytes_up INTEGER NOT NULL DEFAULT 0,
        relay_bytes_down INTEGER NOT NULL DEFAULT 0,
        direct_bytes_up INTEGER NOT NULL DEFAULT 0,
        direct_bytes_down INTEGER NOT NULL DEFAULT 0,
        cloud_asr_seconds INTEGER NOT NULL DEFAULT 0,
        local_asr_seconds INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, host_id, date, instance_id)
      );
    `);
    // 迁移守卫：既有库补列（SQLite ALTER ADD COLUMN 不支持 UNIQUE，邮箱唯一用独立索引）
    const userCols = new Set(
      (this.db.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    const addCols: Array<[string, string]> = [
      ["email", "email TEXT"],
      ["email_verified", "email_verified INTEGER NOT NULL DEFAULT 0"],
      ["totp_secret", "totp_secret TEXT"],
      ["failed_attempts", "failed_attempts INTEGER NOT NULL DEFAULT 0"],
      ["locked_until", "locked_until INTEGER"],
      ["phone", "phone TEXT"],
      ["phone_verified", "phone_verified INTEGER NOT NULL DEFAULT 0"],
      ["account_status", "account_status TEXT NOT NULL DEFAULT 'active'"],
      ["role", "role TEXT NOT NULL DEFAULT 'user'"],
      ["plan_status", "plan_status TEXT"],
      ["plan_expires_at", "plan_expires_at INTEGER"],
      ["trial_started_at", "trial_started_at INTEGER"],
      ["free_since_at", "free_since_at INTEGER"],
      ["wxweb_openid", "wxweb_openid TEXT"],
      ["wxapp_openid", "wxapp_openid TEXT"],
      ["wechat_unionid", "wechat_unionid TEXT"],
      ["wechat_nickname", "wechat_nickname TEXT"],
      ["wechat_avatar", "wechat_avatar TEXT"],
      ["last_login_at", "last_login_at INTEGER"],
      ["apple_sub", "apple_sub TEXT"],
      ["apple_email", "apple_email TEXT"],
      ["apple_full_name", "apple_full_name TEXT"],
    ];
    for (const [name, ddl] of addCols) {
      if (!userCols.has(name)) this.db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone);`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wxweb_openid ON users(wxweb_openid);`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wxapp_openid ON users(wxapp_openid);`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat_unionid ON users(wechat_unionid);`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub ON users(apple_sub);`);
    const hostCols = new Set(
      (this.db.prepare("PRAGMA table_info(hosts)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (!hostCols.has("e2ee_public_key")) this.db.exec(`ALTER TABLE hosts ADD COLUMN e2ee_public_key TEXT`);
    const auditCols = new Set(
      (this.db.prepare("PRAGMA table_info(audit_events)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (!auditCols.has("source")) this.db.exec(`ALTER TABLE audit_events ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`);
    if (!auditCols.has("actor_user_id")) this.db.exec(`ALTER TABLE audit_events ADD COLUMN actor_user_id INTEGER`);
    // 121 订阅支付接入 unicpay：subscriptions 补渠道/平台订阅 ID/自动续订三列
    const subCols = new Set(
      (this.db.prepare("PRAGMA table_info(subscriptions)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (!subCols.has("channel")) this.db.exec(`ALTER TABLE subscriptions ADD COLUMN channel TEXT`);
    if (!subCols.has("subscription_id")) this.db.exec(`ALTER TABLE subscriptions ADD COLUMN subscription_id TEXT`);
    if (!subCols.has("will_renew")) this.db.exec(`ALTER TABLE subscriptions ADD COLUMN will_renew INTEGER NOT NULL DEFAULT 0`);
  }


  // ---- 行映射（SQL snake_case → TS camelCase 接口） ----

  private mapUser(row: Record<string, unknown>): UserRow {
    return {
      id: Number(row.id),
      name: String(row.name),
      passwordHash: String(row.password_hash),
      ver: Number(row.ver),
      createdAt: String(row.created_at),
      mustChange: Number(row.must_change ?? 0),
      email: row.email === null || row.email === undefined ? null : String(row.email),
      emailVerified: Number(row.email_verified ?? 0),
      totpSecret: row.totp_secret === null || row.totp_secret === undefined ? null : String(row.totp_secret),
      failedAttempts: Number(row.failed_attempts ?? 0),
      lockedUntil: row.locked_until === null || row.locked_until === undefined ? null : Number(row.locked_until),
      phone: row.phone === null || row.phone === undefined ? null : String(row.phone),
      phoneVerified: Number(row.phone_verified ?? 0),
      accountStatus: String(row.account_status ?? "active"),
      role: String(row.role ?? "user"),
      planStatus: row.plan_status === null || row.plan_status === undefined ? null : String(row.plan_status),
      planExpiresAt: row.plan_expires_at === null || row.plan_expires_at === undefined ? null : Number(row.plan_expires_at),
      trialStartedAt: row.trial_started_at === null || row.trial_started_at === undefined ? null : Number(row.trial_started_at),
      freeSinceAt: row.free_since_at === null || row.free_since_at === undefined ? null : Number(row.free_since_at),
      lastLoginAt: row.last_login_at === null || row.last_login_at === undefined ? null : Number(row.last_login_at),
      wxwebOpenid: row.wxweb_openid === null || row.wxweb_openid === undefined ? null : String(row.wxweb_openid),
      wxappOpenid: row.wxapp_openid === null || row.wxapp_openid === undefined ? null : String(row.wxapp_openid),
      wechatUnionid: row.wechat_unionid === null || row.wechat_unionid === undefined ? null : String(row.wechat_unionid),
      wechatNickname: row.wechat_nickname === null || row.wechat_nickname === undefined ? null : String(row.wechat_nickname),
      wechatAvatar: row.wechat_avatar === null || row.wechat_avatar === undefined ? null : String(row.wechat_avatar),
      appleSub: row.apple_sub === null || row.apple_sub === undefined ? null : String(row.apple_sub),
      appleEmail: row.apple_email === null || row.apple_email === undefined ? null : String(row.apple_email),
      appleFullName: row.apple_full_name === null || row.apple_full_name === undefined ? null : String(row.apple_full_name),
    };
  }

  private mapHost(row: Record<string, unknown>): HostRow {
    return {
      id: String(row.id),
      ownerId: Number(row.owner_id),
      name: String(row.name),
      tokenHash: String(row.token_hash),
      e2eePublicKey: row.e2ee_public_key === null || row.e2ee_public_key === undefined ? null : String(row.e2ee_public_key),
      createdAt: String(row.created_at),
    };
  }

  private mapRefresh(row: Record<string, unknown>): RefreshRow {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      tokenHash: String(row.token_hash),
      expiresAt: Number(row.expires_at),
      revoked: Number(row.revoked),
      createdAt: Number(row.created_at),
    };
  }

  private mapJoinToken(row: Record<string, unknown>): JoinTokenRow {
    return {
      id: String(row.id),
      label: row.label === null || row.label === undefined ? null : String(row.label),
      ownerId: Number(row.owner_id),
      tokenHash: String(row.token_hash),
      expiresAt: Number(row.expires_at),
      revoked: Number(row.revoked),
      createdAt: String(row.created_at),
    };
  }

  private mapBindSession(row: Record<string, unknown>): BindSessionRow {
    return {
      id: String(row.id),
      consumeTokenHash: String(row.consume_token_hash),
      e2eePublicKey: row.e2ee_public_key === null || row.e2ee_public_key === undefined ? null : String(row.e2ee_public_key),
      name: row.name === null || row.name === undefined ? null : String(row.name),
      ownerId: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id),
      status: String(row.status) as BindSessionRow["status"],
      createdAt: String(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  private mapHostShare(row: Record<string, unknown>): HostShareRow {
    return {
      hostId: String(row.host_id),
      userId: Number(row.user_id),
      role: String(row.role),
      createdAt: String(row.created_at),
    };
  }

  private mapAudit(row: Record<string, unknown>): AuditEventRow {
    return {
      id: Number(row.id),
      userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
      event: String(row.event),
      detailJson: String(row.detail_json ?? "{}"),
      ip: String(row.ip ?? ""),
      source: String(row.source ?? "user"),
      actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : Number(row.actor_user_id),
      createdAt: Number(row.created_at),
    };
  }

  private mapEmailCode(row: Record<string, unknown>): EmailCodeRow {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      email: String(row.email),
      purpose: String(row.purpose),
      codeHash: String(row.code_hash),
      expiresAt: Number(row.expires_at),
      attempts: Number(row.attempts ?? 0),
      createdAt: Number(row.created_at),
    };
  }

  private mapSmsCode(row: Record<string, unknown>): SmsCodeRow {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      phone: String(row.phone),
      purpose: String(row.purpose),
      codeHash: String(row.code_hash),
      expiresAt: Number(row.expires_at),
      attempts: Number(row.attempts ?? 0),
      createdAt: Number(row.created_at),
    };
  }

  private mapSubscription(row: Record<string, unknown>): SubscriptionRow {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      planId: String(row.plan_id),
      status: String(row.status),
      startedAt: Number(row.started_at),
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
      channel: row.channel === null || row.channel === undefined ? null : String(row.channel),
      subscriptionId: row.subscription_id === null || row.subscription_id === undefined ? null : String(row.subscription_id),
      willRenew: Number(row.will_renew ?? 0) === 1,
    };
  }

  private mapOrder(row: Record<string, unknown>): OrderRow {
    return {
      id: String(row.id),
      userId: Number(row.user_id),
      planId: String(row.plan_id),
      amountCny: Number(row.amount_cny),
      status: String(row.status),
      channel: row.channel === null || row.channel === undefined ? null : String(row.channel),
      outId: row.out_id === null || row.out_id === undefined ? null : String(row.out_id),
      createdAt: Number(row.created_at),
      paidAt: row.paid_at === null || row.paid_at === undefined ? null : Number(row.paid_at),
    };
  }

  private mapPayment(row: Record<string, unknown>): PaymentRow {
    return {
      id: String(row.id),
      orderId: String(row.order_id),
      userId: Number(row.user_id),
      channel: String(row.channel),
      channelOrderId: String(row.channel_order_id),
      amountCny: Number(row.amount_cny),
      paidAt: Number(row.paid_at),
      raw: String(row.raw ?? "{}"),
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- users ----

  createUser(name: string, passwordHash: string, now = new Date().toISOString(), mustChange = false): UserRow {
    const info = this.db
      .prepare("INSERT INTO users (name, password_hash, created_at, must_change) VALUES (?, ?, ?, ?)")
      .run(name, passwordHash, now, mustChange ? 1 : 0);
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return this.mapUser(row as unknown as Record<string, unknown>);
  }

  /** 微信登录自动建号：active + 不可用密码（禁密码登录）+ 微信身份字段。 */
  createWechatUser(name: string, openid: string, unionid: string | null, nickname: string | null, avatar: string | null, now = new Date().toISOString()): UserRow {
    const info = this.db
      .prepare(
        "INSERT INTO users (name, password_hash, created_at, must_change, account_status, wxweb_openid, wechat_unionid, wechat_nickname, wechat_avatar) VALUES (?, '!wechat', ?, 0, 'active', ?, ?, ?, ?)",
      )
      .run(name, now, openid, unionid, nickname, avatar);
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return this.mapUser(row as unknown as Record<string, unknown>);
  }

  /** 绑定微信身份到指定账号（openid/unionid 落库；重绑则覆盖昵称/头像）。 */
  bindWechat(id: number, openid: string, unionid: string | null, nickname: string | null, avatar: string | null): void {
    this.db
      .prepare("UPDATE users SET wxweb_openid = ?, wechat_unionid = ?, wechat_nickname = ?, wechat_avatar = ? WHERE id = ?")
      .run(openid, unionid, nickname, avatar, id);
  }

  /** 微信 App（移动应用）登录自动建号：与门户建号同构，但 openid 存 wxapp_openid。 */
  createWechatAppUser(name: string, appOpenid: string, unionid: string | null, nickname: string | null, avatar: string | null, now = new Date().toISOString()): UserRow {
    const info = this.db
      .prepare(
        "INSERT INTO users (name, password_hash, created_at, must_change, account_status, wxapp_openid, wechat_unionid, wechat_nickname, wechat_avatar) VALUES (?, '!wechat', ?, 0, 'active', ?, ?, ?, ?)",
      )
      .run(name, now, appOpenid, unionid, nickname, avatar);
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return this.mapUser(row as unknown as Record<string, unknown>);
  }

  /** 绑定微信 App（移动应用）身份到指定账号（openid 存 wxapp_openid；unionid 共享）。 */
  bindWechatApp(id: number, appOpenid: string, unionid: string | null, nickname: string | null, avatar: string | null): void {
    this.db
      .prepare("UPDATE users SET wxapp_openid = ?, wechat_unionid = ?, wechat_nickname = ?, wechat_avatar = ? WHERE id = ?")
      .run(appOpenid, unionid, nickname, avatar, id);
  }

  getUserByName(name: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE name = ?").get(name);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  getUserById(id: number): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  listUsers(): UserRow[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as Array<Record<string, unknown>>).map((r) => this.mapUser(r));
  }

  /** 全库用户总数（含 pending；注册总量上限用）。 */
  countUsers(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c);
  }

  /** 自指定时间点（ms）以来创建的用户数（created_at 为 ISO 字符串，字典序 = 时间序）。 */
  countUsersCreatedSince(sinceMs: number): number {
    const iso = new Date(sinceMs).toISOString();
    return Number((this.db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= ?").get(iso) as { c: number }).c);
  }

  /** 管理台用户分页 + 模糊搜索（name/email/phone）；返回 { rows, total }。 */
  listUsersPage(opts: { q?: string; limit?: number; offset?: number }): { rows: UserRow[]; total: number } {
    const q = opts.q !== undefined && opts.q !== "" ? opts.q : null;
    const where = q !== null ? "WHERE name LIKE ? OR email LIKE ? OR phone LIKE ?" : "";
    const like = q !== null ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...like) as { c: number }).c);
    const limit = opts.limit !== undefined ? opts.limit : 50;
    const offset = opts.offset !== undefined ? opts.offset : 0;
    const rows = (this.db.prepare(`SELECT * FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...like, limit, offset) as unknown as Array<Record<string, unknown>>).map((r) => this.mapUser(r));
    return { rows, total };
  }

  removeUser(id: number): void {
    this.db.exec("BEGIN");
    try {
      // 按 FK 依赖顺序删子表 → 父表（users 最后）
      this.db.prepare("DELETE FROM email_codes WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM audit_events WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM host_share WHERE user_id = ?").run(id); // member 侧
      this.db.prepare("DELETE FROM host_share WHERE host_id IN (SELECT id FROM hosts WHERE owner_id = ?)").run(id); // 其 host 的共享
      this.db.prepare("DELETE FROM join_tokens WHERE owner_id = ?").run(id);
      this.db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM hosts WHERE owner_id = ?").run(id);
      this.db.prepare("DELETE FROM payments WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM orders WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM apple_tokens WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM sms_codes WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  setPassword(id: number, passwordHash: string): void {
    // 改密 → ver + 1（全部旧 JWT 立即失效）+ 清除首次设密标记
    this.db.prepare("UPDATE users SET password_hash = ?, ver = ver + 1, must_change = 0 WHERE id = ?").run(passwordHash, id);
  }

  bumpVersion(id: number): void {
    this.db.prepare("UPDATE users SET ver = ver + 1 WHERE id = ?").run(id);
  }

  // ---- hosts ----

  createHost(id: string, ownerId: number, name: string, tokenHash: string, e2eePublicKey?: string, now = new Date().toISOString()): HostRow {
    this.db.prepare("INSERT INTO hosts (id, owner_id, name, token_hash, e2ee_public_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      ownerId,
      name,
      tokenHash,
      e2eePublicKey ?? null,
      now,
    );
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
    return this.mapHost(row as unknown as Record<string, unknown>);
  }

  getHostById(id: string): HostRow | null {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
    return row === undefined ? null : this.mapHost(row as unknown as Record<string, unknown>);
  }

  findHostByTokenHash(tokenHash: string): HostRow | null {
    const row = this.db.prepare("SELECT * FROM hosts WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapHost(row as unknown as Record<string, unknown>);
  }

  listHostsByOwner(ownerId: number): HostRow[] {
    return (this.db.prepare("SELECT * FROM hosts WHERE owner_id = ? ORDER BY created_at").all(ownerId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
  }

  /** 管理员视图：全部 host（rdsh hub host ls）。 */
  listAllHosts(): HostRow[] {
    return (this.db.prepare("SELECT * FROM hosts ORDER BY created_at").all() as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
  }

  /** 管理员视图：每个 owner 的主机数（GROUP BY owner_id，索引聚合，O(N)）。 */
  countHostsByOwner(): Array<{ ownerId: number; count: number }> {
    return this.db.prepare("SELECT owner_id AS ownerId, COUNT(*) AS count FROM hosts GROUP BY owner_id").all() as unknown as Array<{ ownerId: number; count: number }>;
  }

  /** 管理台主机分页 + 模糊搜索（主机名/归属用户名），JOIN 出 ownerName；返回 { rows, total }。 */
  listHostsPage(opts: { q?: string; limit?: number; offset?: number }): { rows: Array<HostRow & { ownerName: string }>; total: number } {
    const q = opts.q !== undefined && opts.q !== "" ? opts.q : null;
    const where = q !== null ? "WHERE h.name LIKE ? OR u.name LIKE ?" : "";
    const like = q !== null ? [`%${q}%`, `%${q}%`] : [];
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM hosts h LEFT JOIN users u ON h.owner_id = u.id ${where}`).get(...like) as { c: number }).c);
    const limit = opts.limit !== undefined ? opts.limit : 50;
    const offset = opts.offset !== undefined ? opts.offset : 0;
    const rows = (this.db.prepare(`SELECT h.*, u.name AS owner_name FROM hosts h LEFT JOIN users u ON h.owner_id = u.id ${where} ORDER BY h.created_at LIMIT ? OFFSET ?`).all(...like, limit, offset) as unknown as Array<Record<string, unknown>>)
      .map((r) => ({ ...this.mapHost(r), ownerName: r.owner_name === null || r.owner_name === undefined ? String(r.owner_id) : String(r.owner_name) }));
    return { rows, total };
  }

  renameHost(id: string, name: string): boolean {
    const info = this.db.prepare("UPDATE hosts SET name = ? WHERE id = ?").run(name, id);
    return info.changes > 0;
  }

  removeHost(id: string): boolean {
    this.db.prepare("DELETE FROM host_share WHERE host_id = ?").run(id); // 清共享残留（FK）
    const info = this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
    return info.changes > 0;
  }

  // ---- refresh tokens ----

  createRefreshToken(userId: number, tokenHash: string, expiresAt: number, now = Date.now()): RefreshRow {
    this.db.prepare("INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
      userId,
      tokenHash,
      expiresAt,
      now,
    );
    const row = this.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash);
    return this.mapRefresh(row as unknown as Record<string, unknown>);
  }

  findRefreshByHash(tokenHash: string): RefreshRow | null {
    const row = this.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapRefresh(row as unknown as Record<string, unknown>);
  }

  revokeRefresh(id: number): void {
    this.db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?").run(id);
  }

  revokeAllRefreshForUser(userId: number): void {
    this.db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?").run(userId);
  }

  /** 清理过期 refresh token。 */
  pruneExpiredRefresh(now = Date.now()): void {
    this.db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked = 1").run(now);
  }

  // ---- join tokens（用户级注册凭证，05-join-easy）----

  createJoinToken(id: string, label: string | null, ownerId: number, tokenHash: string, expiresAt: number, now = new Date().toISOString()): JoinTokenRow {
    this.db
      .prepare("INSERT INTO join_tokens (id, label, owner_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, label, ownerId, tokenHash, expiresAt, now);
    const row = this.db.prepare("SELECT * FROM join_tokens WHERE id = ?").get(id);
    return this.mapJoinToken(row as unknown as Record<string, unknown>);
  }

  listJoinTokens(ownerId: number): JoinTokenRow[] {
    return (this.db.prepare("SELECT * FROM join_tokens WHERE owner_id = ? ORDER BY created_at").all(ownerId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapJoinToken(r));
  }

  getJoinTokenById(id: string): JoinTokenRow | null {
    const row = this.db.prepare("SELECT * FROM join_tokens WHERE id = ?").get(id);
    return row === undefined ? null : this.mapJoinToken(row as unknown as Record<string, unknown>);
  }

  getJoinTokenByHash(tokenHash: string): JoinTokenRow | null {
    const row = this.db.prepare("SELECT * FROM join_tokens WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapJoinToken(row as unknown as Record<string, unknown>);
  }

  revokeJoinToken(id: string): boolean {
    const info = this.db.prepare("UPDATE join_tokens SET revoked = 1 WHERE id = ?").run(id);
    return info.changes > 0;
  }

  createBindSession(id: string, consumeTokenHash: string, e2eePublicKey: string | null, name: string | null, expiresAt: number, now = new Date().toISOString()): BindSessionRow {
    this.db
      .prepare("INSERT INTO bind_sessions (id, consume_token_hash, e2ee_public_key, name, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, consumeTokenHash, e2eePublicKey, name, now, expiresAt);
    return this.getBindSession(id) as BindSessionRow;
  }

  getBindSession(id: string): BindSessionRow | null {
    const row = this.db.prepare("SELECT * FROM bind_sessions WHERE id = ?").get(id);
    return row === undefined ? null : this.mapBindSession(row as unknown as Record<string, unknown>);
  }

  getBindSessionByConsumeTokenHash(hash: string): BindSessionRow | null {
    const row = this.db.prepare("SELECT * FROM bind_sessions WHERE consume_token_hash = ?").get(hash);
    return row === undefined ? null : this.mapBindSession(row as unknown as Record<string, unknown>);
  }

  approveBindSession(id: string, ownerId: number): boolean {
    return this.db.prepare("UPDATE bind_sessions SET owner_id = ?, status = 'approved' WHERE id = ? AND status = 'pending'").run(ownerId, id).changes > 0;
  }

  consumeBindSession(id: string): boolean {
    return this.db.prepare("UPDATE bind_sessions SET status = 'consumed' WHERE id = ? AND status = 'approved'").run(id).changes > 0;
  }

  pruneExpiredBindSessions(now = Date.now()): void {
    this.db.prepare("DELETE FROM bind_sessions WHERE expires_at < ?").run(now);
  }

  pruneExpiredJoinTokens(now = Date.now()): void {
    this.db.prepare("DELETE FROM join_tokens WHERE expires_at < ?").run(now);
  }

  // ---- users：邮箱 / 2FA / 锁定 ----

  /** 绑定/换绑邮箱（email_verified 清零，需重新验证）。 */
  setEmail(id: number, email: string): void {
    this.db.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?").run(email, id);
  }

  setEmailVerified(id: number): void {
    this.db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(id);
  }

  /** 解绑邮箱（清 email + verified）。 */
  clearEmail(id: number): void {
    this.db.prepare("UPDATE users SET email = NULL, email_verified = 0 WHERE id = ?").run(id);
  }

  /** 解绑微信（清网站应用 openid + 移动应用 openid + unionid + 昵称头像）。 */
  clearWechat(id: number): void {
    this.db
      .prepare("UPDATE users SET wxweb_openid = NULL, wxapp_openid = NULL, wechat_unionid = NULL, wechat_nickname = NULL, wechat_avatar = NULL WHERE id = ?")
      .run(id);
  }

  /** 解绑 Apple（清 sub/email/姓名 + 删令牌）。 */
  clearApple(id: number): void {
    this.db.prepare("UPDATE users SET apple_sub = NULL, apple_email = NULL, apple_full_name = NULL WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM apple_tokens WHERE user_id = ?").run(id);
  }

  setTotpSecret(id: number, secret: string): void {
    this.db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, id);
  }

  clearTotpSecret(id: number): void {
    this.db.prepare("UPDATE users SET totp_secret = NULL WHERE id = ?").run(id);
  }

  getUserByEmail(email: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  getUserByWxwebOpenid(openid: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE wxweb_openid = ?").get(openid);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  getUserByWxappOpenid(appOpenid: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE wxapp_openid = ?").get(appOpenid);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  getUserByWechatUnionid(unionid: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE wechat_unionid = ?").get(unionid);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  getUserByAppleSub(sub: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE apple_sub = ?").get(sub);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  /** Apple 登录自动建号：active + 不可用密码（禁密码登录）+ apple 身份字段。 */
  createAppleUser(name: string, sub: string, email: string | null, fullName: string | null, now = new Date().toISOString()): UserRow {
    const info = this.db
      .prepare(
        "INSERT INTO users (name, password_hash, created_at, must_change, account_status, apple_sub, apple_email, apple_full_name) VALUES (?, '!apple', ?, 0, 'active', ?, ?, ?)",
      )
      .run(name, now, sub, email, fullName);
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return this.mapUser(row as unknown as Record<string, unknown>);
  }

  /** 绑定/补记 Apple 身份（首次的 email/fullName）。 */
  bindApple(id: number, sub: string, email: string | null, fullName: string | null): void {
    this.db
      .prepare("UPDATE users SET apple_sub = ?, apple_email = ?, apple_full_name = ? WHERE id = ?")
      .run(sub, email, fullName, id);
  }

  /** 存 Apple 令牌（**已加密**密文；加密在调用方，DB 不感知明文）。 */
  storeAppleTokens(userId: number, refreshTokenEnc: string | null, accessTokenEnc: string | null, nowMs = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO apple_tokens (user_id, refresh_token, access_token, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token, updated_at = excluded.updated_at",
      )
      .run(userId, refreshTokenEnc, accessTokenEnc, nowMs);
  }

  getAppleTokens(userId: number): { refreshTokenEnc: string | null; accessTokenEnc: string | null; updatedAt: number } | null {
    const row = this.db.prepare("SELECT * FROM apple_tokens WHERE user_id = ?").get(userId) as
      | { refresh_token: string | null; access_token: string | null; updated_at: number }
      | undefined;
    if (row === undefined) return null;
    return {
      refreshTokenEnc: row.refresh_token === null || row.refresh_token === undefined ? null : String(row.refresh_token),
      accessTokenEnc: row.access_token === null || row.access_token === undefined ? null : String(row.access_token),
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  deleteAppleTokens(userId: number): void {
    this.db.prepare("DELETE FROM apple_tokens WHERE user_id = ?").run(userId);
  }

  /** 登录失败计数 +1，返回新值。 */
  incrementFailedAttempts(id: number): number {
    this.db.prepare("UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?").run(id);
    return this.getUserById(id)?.failedAttempts ?? 0;
  }

  /** 触发锁定：设 locked_until 并清失败计数（解锁后重新计数）。 */
  lockAccount(id: number, lockedUntil: number): void {
    this.db.prepare("UPDATE users SET locked_until = ?, failed_attempts = 0 WHERE id = ?").run(lockedUntil, id);
  }

  /** 登录成功：清失败计数。 */
  clearFailedAttempts(id: number): void {
    this.db.prepare("UPDATE users SET failed_attempts = 0 WHERE id = ?").run(id);
  }

  /** 记录最近一次成功登录时间（feature 16；登录成功各通道调用）。 */
  touchLastLogin(id: number, now = Date.now()): void {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, id);
  }

  /** admin 解锁：清失败计数 + 清锁定。 */
  unlockAccount(id: number): void {
    this.db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(id);
  }

  // ---- host 共享（owner/member）----

  shareHost(hostId: string, userId: number, role: string, now = new Date().toISOString()): void {
    this.db.prepare("INSERT OR REPLACE INTO host_share (host_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(hostId, userId, role, now);
  }

  revokeShare(hostId: string, userId: number): boolean {
    const info = this.db.prepare("DELETE FROM host_share WHERE host_id = ? AND user_id = ?").run(hostId, userId);
    return info.changes > 0;
  }

  getShare(hostId: string, userId: number): HostShareRow | null {
    const row = this.db.prepare("SELECT * FROM host_share WHERE host_id = ? AND user_id = ?").get(hostId, userId);
    return row === undefined ? null : this.mapHostShare(row as unknown as Record<string, unknown>);
  }

  /** host 的共享成员列表（join users 取 name）。 */
  listShares(hostId: string): Array<{ userId: number; name: string; role: string; createdAt: string }> {
    return (this.db
      .prepare("SELECT s.user_id, s.role, s.created_at, u.name FROM host_share s JOIN users u ON u.id = s.user_id WHERE s.host_id = ? ORDER BY s.created_at")
      .all(hostId) as unknown as Array<Record<string, unknown>>).map((r) => ({
      userId: Number(r.user_id),
      name: String(r.name),
      role: String(r.role),
      createdAt: String(r.created_at),
    }));
  }

  /** 用户可见的全部 host（owner ∪ 被共享 member）。 */
  listHostsForUser(userId: number): HostRow[] {
    return (this.db
      .prepare(
        "SELECT DISTINCT h.* FROM hosts h LEFT JOIN host_share s ON s.host_id = h.id WHERE h.owner_id = ? OR s.user_id = ? ORDER BY h.created_at",
      )
      .all(userId, userId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
  }

  isHostOwner(hostId: string, userId: number): boolean {
    const host = this.getHostById(hostId);
    return host !== null && host.ownerId === userId;
  }

  // ---- 用量统计（11-usage-analytics）----

  /** 幂等 UPSERT 一天的用量（端侧上报的当天累计值，重复上报结果一致）。 */
  /** 幂等 UPSERT 一天用量：同一 `(user_id, host_id, date, instance_id)` 内按字段 `MAX` 合并；
   *  跨实例（重启 = 新 instanceId）由查询侧 `SUM` 聚合。 */
  upsertUsageDaily(
    userId: number,
    day: {
      date: string;
      relaySeconds: number;
      relayBytesUp: number;
      relayBytesDown: number;
      directBytesUp: number;
      directBytesDown: number;
      cloudAsrSeconds: number;
      localAsrSeconds: number;
      sessions: number;
    },
    meta: { hostId?: string; instanceId?: string; source?: string } = {},
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (user_id, host_id, date, instance_id, source, relay_seconds, relay_bytes_up, relay_bytes_down, direct_bytes_up, direct_bytes_down, cloud_asr_seconds, local_asr_seconds, sessions, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, host_id, date, instance_id) DO UPDATE SET
           relay_seconds = MAX(relay_seconds, excluded.relay_seconds),
           relay_bytes_up = MAX(relay_bytes_up, excluded.relay_bytes_up),
           relay_bytes_down = MAX(relay_bytes_down, excluded.relay_bytes_down),
           direct_bytes_up = MAX(direct_bytes_up, excluded.direct_bytes_up),
           direct_bytes_down = MAX(direct_bytes_down, excluded.direct_bytes_down),
           cloud_asr_seconds = MAX(cloud_asr_seconds, excluded.cloud_asr_seconds),
           local_asr_seconds = MAX(local_asr_seconds, excluded.local_asr_seconds),
           sessions = MAX(sessions, excluded.sessions),
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        meta.hostId ?? "",
        day.date,
        meta.instanceId ?? "",
        meta.source ?? "",
        day.relaySeconds,
        day.relayBytesUp,
        day.relayBytesDown,
        day.directBytesUp,
        day.directBytesDown,
        day.cloudAsrSeconds,
        day.localAsrSeconds,
        day.sessions,
        now,
      );
  }

  /** 某用户 [from, to]（含）区间的日序列（跨 host/instance 求和），按 date 升序。 */
  listUsageDaily(userId: number, from: string, to: string): UsageDayRow[] {
    return (this.db
      .prepare(
        `SELECT date,
                SUM(relay_seconds) AS relay_seconds,
                SUM(relay_bytes_up) AS relay_bytes_up,
                SUM(relay_bytes_down) AS relay_bytes_down,
                SUM(direct_bytes_up) AS direct_bytes_up,
                SUM(direct_bytes_down) AS direct_bytes_down,
                SUM(cloud_asr_seconds) AS cloud_asr_seconds,
                SUM(local_asr_seconds) AS local_asr_seconds,
                SUM(sessions) AS sessions
         FROM usage_daily WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date`,
      )
      .all(userId, from, to) as unknown as Array<Record<string, unknown>>).map((r) => this.mapUsageDay(r));
  }

  /** 某主机 [from, to]（含）区间的日序列（跨访问者/实例求和），按 date 升序 —— owner 视图。 */
  listUsageDailyByHost(hostId: string, from: string, to: string): UsageDayRow[] {
    return (this.db
      .prepare(
        `SELECT date,
                SUM(relay_seconds) AS relay_seconds,
                SUM(relay_bytes_up) AS relay_bytes_up,
                SUM(relay_bytes_down) AS relay_bytes_down,
                SUM(direct_bytes_up) AS direct_bytes_up,
                SUM(direct_bytes_down) AS direct_bytes_down,
                SUM(cloud_asr_seconds) AS cloud_asr_seconds,
                SUM(local_asr_seconds) AS local_asr_seconds,
                SUM(sessions) AS sessions
         FROM usage_daily WHERE host_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date`,
      )
      .all(hostId, from, to) as unknown as Array<Record<string, unknown>>).map((r) => this.mapUsageDay(r));
  }

  /** 清理早于 [date] 的按天用量（R12：保留 90 天）。 */
  deleteUsageOlderThan(date: string): void {
    this.db.prepare("DELETE FROM usage_daily WHERE date < ?").run(date);
  }

  private mapUsageDay(r: Record<string, unknown>): UsageDayRow {
    return {
      id: Number(r.id ?? 0),
      userId: Number(r.user_id ?? 0),
      date: String(r.date),
      relaySeconds: Number(r.relay_seconds ?? 0),
      relayBytesUp: Number(r.relay_bytes_up ?? 0),
      relayBytesDown: Number(r.relay_bytes_down ?? 0),
      directBytesUp: Number(r.direct_bytes_up ?? 0),
      directBytesDown: Number(r.direct_bytes_down ?? 0),
      cloudAsrSeconds: Number(r.cloud_asr_seconds ?? 0),
      localAsrSeconds: Number(r.local_asr_seconds ?? 0),
      sessions: Number(r.sessions ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    };
  }

  // ---- 审计 ----

  recordAudit(userId: number | null, event: string, detail: unknown, ip: string, now = Date.now(), opts?: { source?: string; actorUserId?: number | null }): void {
    this.db.prepare("INSERT INTO audit_events (user_id, event, detail_json, ip, created_at, source, actor_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      userId,
      event,
      JSON.stringify(detail ?? {}),
      ip,
      now,
      opts?.source ?? "user",
      opts?.actorUserId ?? null,
    );
  }

  listAudit(filter: { userId?: number; event?: string; since?: number; source?: string } = {}): AuditEventRow[] {
    const clauses: string[] = [];
    const params: Array<number | string> = [];
    if (filter.userId !== undefined) {
      clauses.push("user_id = ?");
      params.push(filter.userId);
    }
    if (filter.event !== undefined) {
      clauses.push("event = ?");
      params.push(filter.event);
    }
    if (filter.since !== undefined) {
      clauses.push("created_at >= ?");
      params.push(filter.since);
    }
    if (filter.source !== undefined) {
      clauses.push("source = ?");
      params.push(filter.source);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM audit_events${where} ORDER BY id DESC LIMIT 1000`).all(...params) as unknown as Array<
      Record<string, unknown>
    >).map((r) => this.mapAudit(r));
  }

  pruneAudit(beforeMs: number): void {
    this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(beforeMs);
  }

  /** 在线一致快照：VACUUM INTO 导出当前库到目标文件（运行中安全，不中断服务）。 */
  backupTo(targetPath: string): void {
    const escaped = targetPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  // ---- 邮件验证码 / 重置码 ----

  createEmailCode(userId: number, email: string, purpose: string, codeHash: string, expiresAt: number, now = Date.now()): EmailCodeRow {
    // 同 email+purpose 只留最新一条
    this.db.prepare("DELETE FROM email_codes WHERE email = ? AND purpose = ?").run(email, purpose);
    this.db
      .prepare("INSERT INTO email_codes (user_id, email, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, email, purpose, codeHash, expiresAt, now);
    const row = this.db.prepare("SELECT * FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1").get(email, purpose);
    return this.mapEmailCode(row as unknown as Record<string, unknown>);
  }

  getEmailCodeByEmail(email: string, purpose: string): EmailCodeRow | null {
    const row = this.db.prepare("SELECT * FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1").get(email, purpose);
    return row === undefined ? null : this.mapEmailCode(row as unknown as Record<string, unknown>);
  }

  incrementCodeAttempts(id: number): void {
    this.db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  deleteEmailCodes(email: string): void {
    this.db.prepare("DELETE FROM email_codes WHERE email = ?").run(email);
  }

  // ---- 手机号 / 账号状态 / 计费状态（08-saas）----

  getUserByPhone(phone: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  setPhone(id: number, phone: string): void {
    this.db.prepare("UPDATE users SET phone = ?, phone_verified = 0 WHERE id = ?").run(phone, id);
  }

  setPhoneVerified(id: number): void {
    this.db.prepare("UPDATE users SET phone_verified = 1 WHERE id = ?").run(id);
  }

  clearPhone(id: number): void {
    this.db.prepare("UPDATE users SET phone = NULL, phone_verified = 0 WHERE id = ?").run(id);
  }

  setAccountStatus(id: number, status: string): void {
    this.db.prepare("UPDATE users SET account_status = ? WHERE id = ?").run(status, id);
  }

  /** 设置角色（user | readonly | operator | admin）。 */
  setRole(id: number, role: string): void {
    this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  }

  /** 进入试用：plan_status=trial + 起止时间。 */
  startTrial(id: number, nowMs: number, expiresAtMs: number): void {
    this.db.prepare("UPDATE users SET plan_status = 'trial', trial_started_at = ?, plan_expires_at = ? WHERE id = ?").run(nowMs, expiresAtMs, id);
  }

  /** 设置计费状态（subscribed/grace/free/NULL）+ 到期时间；非 free 时清 free_since_at。 */
  setPlan(id: number, status: string | null, expiresAtMs: number | null): void {
    this.db.prepare("UPDATE users SET plan_status = ?, plan_expires_at = ?, free_since_at = NULL WHERE id = ?").run(status, expiresAtMs, id);
  }

  /** 标记降级到免费档的时间（30 天 host 数据保留起点）。 */
  setFreeSince(id: number, ts: number): void {
    this.db.prepare("UPDATE users SET free_since_at = ? WHERE id = ?").run(ts, id);
  }

  /** 删除 free 且超保留期的用户 host（含共享残留）；返回删除 host 数。 */
  purgeExpiredFreeHosts(now: number, retentionMs: number): number {
    const rows = this.db
      .prepare("SELECT id FROM users WHERE plan_status = 'free' AND free_since_at IS NOT NULL AND free_since_at < ?")
      .all(now - retentionMs) as unknown as Array<{ id: number }>;
    let count = 0;
    for (const r of rows) {
      this.db.prepare("DELETE FROM host_share WHERE host_id IN (SELECT id FROM hosts WHERE owner_id = ?)").run(r.id);
      const info = this.db.prepare("DELETE FROM hosts WHERE owner_id = ?").run(r.id);
      count += Number(info.changes);
    }
    return count;
  }

  // ---- 短信验证码（镜像 email_codes）----

  createSmsCode(userId: number, phone: string, purpose: string, codeHash: string, expiresAt: number, now = Date.now()): SmsCodeRow {
    this.db.prepare("DELETE FROM sms_codes WHERE phone = ? AND purpose = ?").run(phone, purpose);
    this.db
      .prepare("INSERT INTO sms_codes (user_id, phone, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, phone, purpose, codeHash, expiresAt, now);
    const row = this.db.prepare("SELECT * FROM sms_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1").get(phone, purpose);
    return this.mapSmsCode(row as unknown as Record<string, unknown>);
  }

  getSmsCodeByPhone(phone: string, purpose: string): SmsCodeRow | null {
    const row = this.db.prepare("SELECT * FROM sms_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1").get(phone, purpose);
    return row === undefined ? null : this.mapSmsCode(row as unknown as Record<string, unknown>);
  }

  incrementSmsCodeAttempts(id: number): void {
    this.db.prepare("UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  deleteSmsCodes(phone: string): void {
    this.db.prepare("DELETE FROM sms_codes WHERE phone = ?").run(phone);
  }

  // ---- 订阅 / 订单 / 支付（S2）----

  createSubscription(
    userId: number,
    planId: string,
    startedAt: number,
    expiresAt: number,
    now = Date.now(),
    opts?: { channel?: string | null; subscriptionId?: string | null; willRenew?: boolean },
  ): SubscriptionRow {
    const info = this.db
      .prepare("INSERT INTO subscriptions (user_id, plan_id, status, started_at, expires_at, created_at, channel, subscription_id, will_renew) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)")
      .run(userId, planId, startedAt, expiresAt, now, opts?.channel ?? null, opts?.subscriptionId ?? null, opts?.willRenew ? 1 : 0);
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(Number(info.lastInsertRowid));
    return this.mapSubscription(row as unknown as Record<string, unknown>);
  }

  getActiveSubscription(userId: number): SubscriptionRow | null {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(userId);
    return row === undefined ? null : this.mapSubscription(row as unknown as Record<string, unknown>);
  }

  setSubscriptionStatus(id: number, status: string): void {
    this.db.prepare("UPDATE subscriptions SET status = ? WHERE id = ?").run(status, id);
  }

  /** 按平台订阅实体 ID（unicpay subscriptionId）查订阅，用于 webhook 幂等去重。 */
  getSubscriptionBySubscriptionId(subscriptionId: string): SubscriptionRow | null {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE subscription_id = ? LIMIT 1").get(subscriptionId);
    return row === undefined ? null : this.mapSubscription(row as unknown as Record<string, unknown>);
  }

  /** 按 subscriptionId 更新订阅状态（生命周期事件同实体，续订/宽限/到期/换档复用同一行）。 */
  updateSubscriptionBySubscriptionId(subscriptionId: string, planId: string, status: string, expiresAt: number, willRenew: boolean): void {
    this.db.prepare("UPDATE subscriptions SET plan_id = ?, status = ?, expires_at = ?, will_renew = ? WHERE subscription_id = ?").run(planId, status, expiresAt, willRenew ? 1 : 0, subscriptionId);
  }

  createOrder(id: string, userId: number, planId: string, amountCny: number, now = Date.now()): OrderRow {
    this.db.prepare("INSERT INTO orders (id, user_id, plan_id, amount_cny, status, created_at) VALUES (?, ?, ?, ?, 'created', ?)").run(id, userId, planId, amountCny, now);
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    return this.mapOrder(row as unknown as Record<string, unknown>);
  }

  getOrder(id: string): OrderRow | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
    return row === undefined ? null : this.mapOrder(row as unknown as Record<string, unknown>);
  }

  markOrderPaid(id: string, channel: string, outId: string | null, paidAt = Date.now()): void {
    this.db.prepare("UPDATE orders SET status = 'paid', channel = ?, out_id = ?, paid_at = ? WHERE id = ?").run(channel, outId, paidAt, id);
  }

  closeOrder(id: string): void {
    this.db.prepare("UPDATE orders SET status = 'closed' WHERE id = ?").run(id);
  }

  /** 记录人工退款：订单置 refunded（不接渠道退款 API，见 req R7）。 */
  markOrderRefunded(id: string): void {
    this.db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(id);
  }

  /** 全部订单（admin 账单运营，按创建时间倒序）。 */
  listOrders(): OrderRow[] {
    const rows = this.db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOrder(r));
  }

  /** 某用户的订单（详情页，按时间倒序）。 */
  listOrdersByUser(userId: number): OrderRow[] {
    const rows = this.db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(userId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOrder(r));
  }

  /** 某用户的支付流水（详情页）。 */
  listPaymentsByUser(userId: number): PaymentRow[] {
    const rows = this.db.prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY paid_at DESC").all(userId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPayment(r));
  }

  /** 某用户的订阅历史（详情页）。 */
  listSubscriptionsByUser(userId: number): SubscriptionRow[] {
    const rows = this.db.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC").all(userId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSubscription(r));
  }

  /** 全部支付流水（admin 账单运营，按支付时间倒序）。 */
  listPayments(): PaymentRow[] {
    const rows = this.db.prepare("SELECT * FROM payments ORDER BY paid_at DESC LIMIT 1000").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapPayment(r));
  }

  createPayment(id: string, orderId: string, userId: number, channel: string, channelOrderId: string, amountCny: number, paidAt: number, raw: string): PaymentRow {
    this.db
      .prepare("INSERT INTO payments (id, order_id, user_id, channel, channel_order_id, amount_cny, paid_at, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, orderId, userId, channel, channelOrderId, amountCny, paidAt, raw);
    const row = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    return this.mapPayment(row as unknown as Record<string, unknown>);
  }

  /** 按渠道单号查入账（支付回调幂等）。 */
  getPaymentByChannelOrderId(channel: string, channelOrderId: string): PaymentRow | null {
    const row = this.db.prepare("SELECT * FROM payments WHERE channel = ? AND channel_order_id = ?").get(channel, channelOrderId);
    return row === undefined ? null : this.mapPayment(row as unknown as Record<string, unknown>);
  }

  // ---- 账号删除（R7：墓碑化，保留 orders/payments 账务 + audit 留痕）----

  deleteAccount(id: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM sms_codes WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM email_codes WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM host_share WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM host_share WHERE host_id IN (SELECT id FROM hosts WHERE owner_id = ?)").run(id);
      this.db.prepare("DELETE FROM join_tokens WHERE owner_id = ?").run(id);
      this.db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM hosts WHERE owner_id = ?").run(id);
      this.db.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(id);
      this.db.prepare("DELETE FROM apple_tokens WHERE user_id = ?").run(id);
      // 墓碑：抹除个人数据 + 释放 name（可重注册）；orders/payments/audit 保留（账务与留痕）
      this.db
        .prepare(
          "UPDATE users SET name = ?, password_hash = '!deleted', email = NULL, phone = NULL, email_verified = 0, phone_verified = 0, totp_secret = NULL, account_status = 'deleted', plan_status = NULL, plan_expires_at = NULL, trial_started_at = NULL, wxapp_openid = NULL, apple_sub = NULL, apple_email = NULL, apple_full_name = NULL WHERE id = ?",
        )
        .run(`deleted-${id}`, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
