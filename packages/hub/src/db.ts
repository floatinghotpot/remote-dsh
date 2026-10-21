/**
 * db.ts — hub 持久化（node:sqlite，零外部依赖）。
 *
 * 表：users / hosts / refresh_tokens / join_tokens。
 * 安全基线（req R10）：密码 scrypt 哈希、host token / refresh token 只存 SHA-256 摘要。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
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
  nodeId: string | null;
  /** 节点路由的主机在线状态（N4 上报）；hub 路由的用 TunnelRegistry。 */
  online: boolean;
  createdAt: string;
}

export interface NodeRow {
  id: string;
  name: string;
  advertiseUrl: string;
  tokenHash: string;
  region: string;
  status: string;
  enabled: boolean;
  lastIp: string | null;
  capacity: number;
  weight: number;
  lastHeartbeat: number;
  connections: number;
  activeStreams: number;
  bytesIn: number;
  bytesOut: number;
  createdAt: number;
}

export interface RelayJoinTokenRow {
  id: string;
  name: string;
  tokenHash: string;
  tokenPlaintext: string;
  createdBy: number;
  createdAt: number;
  revokedAt: number | null;
}

export interface RelayJoinEventRow {
  id: string;
  tokenId: string;
  nodeId: string;
  srcIp: string | null;
  at: number;
}

export interface NodeBandwidth {
  currentBps: number;
  avg5mBps: number;
  avg1hBps: number;
  avg24hBps: number;
  connections: number;
  activeStreams: number;
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
  /** 34-payment-order-check：平台查单凭据（发起时落库，补发用；不返回客户端）。 */
  ticket: string | null;
  /** 平台支付单号（补发的幂等键，与 webhook 一致：unicpay:<paymentId>）。 */
  paymentId: string | null;
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
  cloudTtsChars: number;
  localTtsChars: number;
  sessions: number;
  updatedAt: number;
}

export interface UsageValues {
  relaySeconds: number;
  relayBytesUp: number;
  relayBytesDown: number;
  directBytesUp: number;
  directBytesDown: number;
  cloudAsrSeconds: number;
  localAsrSeconds: number;
  cloudTtsChars: number;
  localTtsChars: number;
  sessions: number;
}

export interface UsageDayValues extends UsageValues {
  date: string;
}

export interface UsageBatchRow {
  userId: number;
  day: UsageDayValues;
  meta: { hostId?: string; instanceId?: string; source?: string };
}

export interface CreditLedgerRow {
  id: number;
  userId: number;
  delta: number;
  bucket: string;
  reason: string;
  sourceType: string | null;
  sourceId: string | null;
  idempotencyKey: string | null;
  balanceAfter: number | null;
  createdAt: number;
}

export interface CreditBalances {
  purchased: number;
  bonusCarried: number;
  bonusCurrent: number;
  total: number;
}

export type CreditHoldStatus = "held" | "settled" | "released" | "expired";

export interface CreditHoldRow {
  id: string;
  userId: number;
  scopeType: string;
  scopeId: string | null;
  requestId: string;
  amountMicro: number;
  settledMicro: number;
  status: CreditHoldStatus;
  expiresAt: number;
  createdAt: number;
}

export interface CreditHoldReserveResult {
  status: "held" | "existing" | "insufficient";
  hold: CreditHoldRow | null;
  availableMicro: number;
}

export interface CreditHoldSettleResult {
  status: "settled" | "already_settled" | "not_found" | "released" | "insufficient";
  chargedMicro: number;
  balance: CreditBalances;
  hold: CreditHoldRow | null;
}

export interface CreditSpendResult {
  status: "spent" | "already_spent" | "insufficient";
  chargedMicro: number;
  balance: CreditBalances;
}

const USAGE_UPSERT_SQL = `INSERT INTO usage_daily (user_id, host_id, date, instance_id, source, relay_seconds, relay_bytes_up, relay_bytes_down, direct_bytes_up, direct_bytes_down, cloud_asr_seconds, local_asr_seconds, cloud_tts_chars, local_tts_chars, sessions, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, host_id, date, instance_id) DO UPDATE SET
           relay_seconds = MAX(relay_seconds, excluded.relay_seconds),
           relay_bytes_up = MAX(relay_bytes_up, excluded.relay_bytes_up),
           relay_bytes_down = MAX(relay_bytes_down, excluded.relay_bytes_down),
           direct_bytes_up = MAX(direct_bytes_up, excluded.direct_bytes_up),
           direct_bytes_down = MAX(direct_bytes_down, excluded.direct_bytes_down),
           cloud_asr_seconds = MAX(cloud_asr_seconds, excluded.cloud_asr_seconds),
           local_asr_seconds = MAX(local_asr_seconds, excluded.local_asr_seconds),
           cloud_tts_chars = MAX(cloud_tts_chars, excluded.cloud_tts_chars),
           local_tts_chars = MAX(local_tts_chars, excluded.local_tts_chars),
           sessions = MAX(sessions, excluded.sessions),
           updated_at = excluded.updated_at`;

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
        apple_full_name TEXT,
        purchased_credits INTEGER NOT NULL DEFAULT 0,
        bonus_carried INTEGER NOT NULL DEFAULT 0,
        bonus_current INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        e2ee_public_key TEXT,
        node_id TEXT,
        online INTEGER NOT NULL DEFAULT 0,
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
        ticket TEXT,
        payment_id TEXT,
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
      CREATE TABLE IF NOT EXISTS credits_ledger (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        delta INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_type TEXT,
        source_id TEXT,
        idempotency_key TEXT UNIQUE,
        balance_after INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credit_holds (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        request_id TEXT NOT NULL UNIQUE,
        amount_micro INTEGER NOT NULL,
        settled_micro INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credit_holds_user_status ON credit_holds(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_credit_holds_expires ON credit_holds(status, expires_at);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
        cloud_tts_chars INTEGER NOT NULL DEFAULT 0,
        local_tts_chars INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, host_id, date, instance_id)
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        advertise_url TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        region TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'online',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_ip TEXT,
        capacity INTEGER NOT NULL DEFAULT 0,
        weight INTEGER NOT NULL DEFAULT 100,
        last_heartbeat INTEGER NOT NULL DEFAULT 0,
        connections INTEGER NOT NULL DEFAULT 0,
        active_streams INTEGER NOT NULL DEFAULT 0,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_metrics (
        node_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        connections INTEGER NOT NULL DEFAULT 0,
        active_streams INTEGER NOT NULL DEFAULT 0,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (node_id, ts)
      );
      CREATE TABLE IF NOT EXISTS relay_join_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        token_plaintext TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS relay_join_events (
        id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        src_ip TEXT,
        at INTEGER NOT NULL
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
      ["purchased_credits", "purchased_credits INTEGER NOT NULL DEFAULT 0"],
      ["bonus_carried", "bonus_carried INTEGER NOT NULL DEFAULT 0"],
      ["bonus_current", "bonus_current INTEGER NOT NULL DEFAULT 0"],
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
    if (!hostCols.has("node_id")) this.db.exec(`ALTER TABLE hosts ADD COLUMN node_id TEXT`);
    if (!hostCols.has("online")) this.db.exec(`ALTER TABLE hosts ADD COLUMN online INTEGER NOT NULL DEFAULT 0`);
    const nodeCols = new Set(
      (this.db.prepare("PRAGMA table_info(nodes)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    for (const [col, ddl] of [["connections", "connections INTEGER NOT NULL DEFAULT 0"], ["active_streams", "active_streams INTEGER NOT NULL DEFAULT 0"], ["bytes_in", "bytes_in INTEGER NOT NULL DEFAULT 0"], ["bytes_out", "bytes_out INTEGER NOT NULL DEFAULT 0"], ["enabled", "enabled INTEGER NOT NULL DEFAULT 1"], ["last_ip", "last_ip TEXT"]] as Array<[string, string]>) {
      if (!nodeCols.has(col)) this.db.exec(`ALTER TABLE nodes ADD COLUMN ${ddl}`);
    }
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
    // 34-payment-order-check：补发需要持久化平台查单凭据（ticket 查单、payment_id 幂等键）。
    const orderCols = new Set(
      (this.db.prepare("PRAGMA table_info(orders)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (!orderCols.has("ticket")) this.db.exec(`ALTER TABLE orders ADD COLUMN ticket TEXT`);
    if (!orderCols.has("payment_id")) this.db.exec(`ALTER TABLE orders ADD COLUMN payment_id TEXT`);
    // 11-usage-analytics：usage_daily 由旧 schema（无 host_id/instance_id/source + UNIQUE(user_id,date)）
    // 迁移到新 schema。SQLite 无法改 UNIQUE 约束（旧键会拒绝同一 user+day 的第二行，
    // 多主机/多实例场景必现）⇒ 必须重建表。事务内、幂等（列已存在即跳过）。
    const usageCols = new Set(
      (this.db.prepare("PRAGMA table_info(usage_daily)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (usageCols.size > 0 && !usageCols.has("host_id")) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE usage_daily_new (
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
        INSERT INTO usage_daily_new (id, user_id, host_id, date, instance_id, source, relay_seconds, relay_bytes_up, relay_bytes_down, direct_bytes_up, direct_bytes_down, cloud_asr_seconds, local_asr_seconds, sessions, updated_at)
        SELECT id, user_id, '', date, '', '', relay_seconds, relay_bytes_up, relay_bytes_down, direct_bytes_up, direct_bytes_down, cloud_asr_seconds, local_asr_seconds, sessions, updated_at FROM usage_daily;
        DROP TABLE usage_daily;
        ALTER TABLE usage_daily_new RENAME TO usage_daily;
        COMMIT;
      `);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_daily_host ON usage_daily(host_id, date);`);
    // 42 P0：N2 心跳按节点校验在线 host 归属；避免 hosts 全表扫描。
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_hosts_node ON hosts(node_id);`);
    // 32-tts-usage：usage_daily 补朗读字符数列。简单加列（不涉及 UNIQUE 约束），
    // 幂等（列已存在即跳过）；既有行缺省 0。
    const usageCols2 = new Set(
      (this.db.prepare("PRAGMA table_info(usage_daily)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    if (usageCols2.size > 0 && !usageCols2.has("cloud_tts_chars")) {
      this.db.exec(`ALTER TABLE usage_daily ADD COLUMN cloud_tts_chars INTEGER NOT NULL DEFAULT 0`);
    }
    if (usageCols2.size > 0 && !usageCols2.has("local_tts_chars")) {
      this.db.exec(`ALTER TABLE usage_daily ADD COLUMN local_tts_chars INTEGER NOT NULL DEFAULT 0`);
    }
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
      nodeId: row.node_id === null || row.node_id === undefined ? null : String(row.node_id),
      online: Number(row.online ?? 0) === 1,
      createdAt: String(row.created_at),
    };
  }

  private mapNode(row: Record<string, unknown>): NodeRow {
    return {
      id: String(row.id),
      name: String(row.name),
      advertiseUrl: String(row.advertise_url),
      tokenHash: String(row.token_hash),
      region: String(row.region ?? ""),
      status: String(row.status ?? "online"),
      enabled: Number(row.enabled ?? 1) === 1,
      lastIp: row.last_ip === null || row.last_ip === undefined ? null : String(row.last_ip),
      capacity: Number(row.capacity ?? 0),
      weight: Number(row.weight ?? 100),
      lastHeartbeat: Number(row.last_heartbeat ?? 0),
      connections: Number(row.connections ?? 0),
      activeStreams: Number(row.active_streams ?? 0),
      bytesIn: Number(row.bytes_in ?? 0),
      bytesOut: Number(row.bytes_out ?? 0),
      createdAt: Number(row.created_at),
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
      ticket: row.ticket === null || row.ticket === undefined ? null : String(row.ticket),
      paymentId: row.payment_id === null || row.payment_id === undefined ? null : String(row.payment_id),
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

  private mapCreditLedger(row: Record<string, unknown>): CreditLedgerRow {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      delta: Number(row.delta),
      bucket: String(row.bucket),
      reason: String(row.reason),
      sourceType: row.source_type === null || row.source_type === undefined ? null : String(row.source_type),
      sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
      idempotencyKey: row.idempotency_key === null || row.idempotency_key === undefined ? null : String(row.idempotency_key),
      balanceAfter: row.balance_after === null || row.balance_after === undefined ? null : Number(row.balance_after),
      createdAt: Number(row.created_at),
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

  /** 管理台用户分页 + 过滤（模糊搜索 name/email/phone、角色、状态、登录时间范围）；返回 { rows, total }。 */
  listUsersPage(opts: {
    q?: string;
    role?: string;
    status?: string;
    lastLoginFrom?: number;
    lastLoginTo?: number;
    limit?: number;
    offset?: number;
  }): { rows: UserRow[]; total: number } {
    const conds: string[] = [];
    const params: Array<string | number> = [];
    const q = opts.q !== undefined && opts.q !== "" ? opts.q : null;
    if (q !== null) {
      conds.push("(name LIKE ? OR email LIKE ? OR phone LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (opts.role !== undefined && opts.role !== "") {
      conds.push("role = ?");
      params.push(opts.role);
    }
    const now = Date.now();
    if (opts.status === "active") {
      conds.push("account_status = 'active' AND (locked_until IS NULL OR locked_until <= ?)");
      params.push(now);
    } else if (opts.status === "banned") {
      conds.push("account_status = 'banned'");
    } else if (opts.status === "locked") {
      conds.push("locked_until IS NOT NULL AND locked_until > ?");
      params.push(now);
    }
    if (opts.lastLoginFrom !== undefined) {
      conds.push("last_login_at IS NOT NULL AND last_login_at >= ?");
      params.push(opts.lastLoginFrom);
    }
    if (opts.lastLoginTo !== undefined) {
      conds.push("last_login_at IS NOT NULL AND last_login_at <= ?");
      params.push(opts.lastLoginTo);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...params) as { c: number }).c);
    const limit = opts.limit !== undefined ? opts.limit : 50;
    const offset = opts.offset !== undefined ? opts.offset : 0;
    const rows = (this.db.prepare(`SELECT * FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as Array<Record<string, unknown>>).map((r) => this.mapUser(r));
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

  /** 管理员视图：全部 host（rdsh-hub host ls）。 */
  listAllHosts(): HostRow[] {
    return (this.db.prepare("SELECT * FROM hosts ORDER BY created_at").all() as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
  }

  /** 管理员视图：每个 owner 的主机数（GROUP BY owner_id，索引聚合，O(N)）。 */
  countHostsByOwner(): Array<{ ownerId: number; count: number }> {
    return this.db.prepare("SELECT owner_id AS ownerId, COUNT(*) AS count FROM hosts GROUP BY owner_id").all() as unknown as Array<{ ownerId: number; count: number }>;
  }

  /** 管理台主机分页 + 模糊搜索（主机名/归属用户名），JOIN 出 ownerName；返回 { rows, total }。 */
  listHostsPage(opts: {
    q?: string;
    e2ee?: "yes" | "no";
    createdFrom?: number;
    createdTo?: number;
    limit?: number;
    offset?: number;
  }): { rows: Array<HostRow & { ownerName: string }>; total: number } {
    const conds: string[] = [];
    const params: Array<string | number> = [];
    const q = opts.q !== undefined && opts.q !== "" ? opts.q : null;
    if (q !== null) {
      conds.push("(h.name LIKE ? OR u.name LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (opts.e2ee === "yes") conds.push("h.e2ee_public_key IS NOT NULL");
    else if (opts.e2ee === "no") conds.push("h.e2ee_public_key IS NULL");
    if (opts.createdFrom !== undefined) {
      conds.push("h.created_at >= ?");
      params.push(new Date(opts.createdFrom).toISOString());
    }
    if (opts.createdTo !== undefined) {
      conds.push("h.created_at <= ?");
      params.push(new Date(opts.createdTo).toISOString());
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM hosts h LEFT JOIN users u ON h.owner_id = u.id ${where}`).get(...params) as { c: number }).c);
    const limit = opts.limit !== undefined ? opts.limit : 50;
    const offset = opts.offset !== undefined ? opts.offset : 0;
    const rows = (this.db.prepare(`SELECT h.*, u.name AS owner_name FROM hosts h LEFT JOIN users u ON h.owner_id = u.id ${where} ORDER BY h.created_at LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as Array<Record<string, unknown>>)
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

  // ---- relay nodes（30-relay-node）----

  createNode(id: string, name: string, advertiseUrl: string, tokenHash: string, region: string, capacity: number, weight: number, enabled: boolean, lastIp: string | null, now = Date.now()): NodeRow {
    this.db.prepare("INSERT INTO nodes (id, name, advertise_url, token_hash, region, status, enabled, last_ip, capacity, weight, created_at) VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?)").run(
      id,
      name,
      advertiseUrl,
      tokenHash,
      region,
      enabled ? 1 : 0,
      lastIp,
      capacity,
      weight,
      now,
    );
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return this.mapNode(row as unknown as Record<string, unknown>);
  }

  getNodeById(id: string): NodeRow | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row === undefined ? null : this.mapNode(row as unknown as Record<string, unknown>);
  }

  findNodeByTokenHash(tokenHash: string): NodeRow | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapNode(row as unknown as Record<string, unknown>);
  }

  listNodes(): NodeRow[] {
    return (this.db.prepare("SELECT * FROM nodes ORDER BY created_at").all() as unknown as Array<Record<string, unknown>>).map((r) => this.mapNode(r));
  }

  /** 中继节点分页（管理台列表）：返回 { rows, total }。 */
  listNodesPage(limit = 50, offset = 0): { rows: NodeRow[]; total: number } {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c);
    const rows = (this.db.prepare("SELECT * FROM nodes ORDER BY created_at, id LIMIT ? OFFSET ?").all(limit, offset) as unknown as Array<Record<string, unknown>>).map((r) => this.mapNode(r));
    return { rows, total };
  }

  // ---- relay join tokens（41-relay-node-onboarding R3-R5/R22）----

  createRelayJoinToken(id: string, name: string, tokenHash: string, tokenPlaintext: string, createdBy: number, now = Date.now()): RelayJoinTokenRow {
    this.db.prepare("INSERT INTO relay_join_tokens (id, name, token_hash, token_plaintext, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, tokenHash, tokenPlaintext, createdBy, now);
    const row = this.db.prepare("SELECT * FROM relay_join_tokens WHERE id = ?").get(id);
    return this.mapRelayJoinToken(row as unknown as Record<string, unknown>);
  }

  findRelayJoinTokenByHash(tokenHash: string): RelayJoinTokenRow | null {
    const row = this.db.prepare("SELECT * FROM relay_join_tokens WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapRelayJoinToken(row as unknown as Record<string, unknown>);
  }

  getRelayJoinToken(id: string): RelayJoinTokenRow | null {
    const row = this.db.prepare("SELECT * FROM relay_join_tokens WHERE id = ?").get(id);
    return row === undefined ? null : this.mapRelayJoinToken(row as unknown as Record<string, unknown>);
  }

  listRelayJoinTokens(): Array<{ id: string; name: string; createdAt: number; revokedAt: number | null; joinCount: number; tokenTail4: string; tokenPlaintext: string }> {
    return (this.db.prepare("SELECT t.id, t.name, t.created_at, t.revoked_at, t.token_plaintext, substr(t.token_plaintext, -4) AS token_tail4, (SELECT COUNT(*) FROM relay_join_events e WHERE e.token_id = t.id) AS join_count FROM relay_join_tokens t ORDER BY t.created_at").all() as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      createdAt: Number(r.created_at),
      revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
      joinCount: Number(r.join_count ?? 0),
      tokenTail4: String(r.token_tail4 ?? ""),
      tokenPlaintext: String(r.token_plaintext ?? ""),
    }));
  }

  /** 入网令牌改名（只改展示名，不影响已入网的节点）。 */
  renameRelayJoinToken(id: string, name: string): boolean {
    const info = this.db.prepare("UPDATE relay_join_tokens SET name = ? WHERE id = ?").run(name, id);
    return info.changes > 0;
  }

  revokeRelayJoinToken(id: string, now = Date.now()): boolean {
    const info = this.db.prepare("UPDATE relay_join_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    return info.changes > 0;
  }

  recordRelayJoinEvent(id: string, tokenId: string, nodeId: string, srcIp: string | null, now = Date.now()): void {
    this.db.prepare("INSERT INTO relay_join_events (id, token_id, node_id, src_ip, at) VALUES (?, ?, ?, ?, ?)").run(id, tokenId, nodeId, srcIp, now);
  }

  listRelayJoinEvents(tokenId: string): RelayJoinEventRow[] {
    return (this.db.prepare("SELECT * FROM relay_join_events WHERE token_id = ? ORDER BY at DESC").all(tokenId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapRelayJoinEvent(r));
  }

  // ---- node enable/disable + last_ip（R8/R9/R23）----

  setNodeEnabled(id: string, enabled: boolean): boolean {
    const info = this.db.prepare("UPDATE nodes SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return info.changes > 0;
  }

  updateNodeLastIp(id: string, lastIp: string | null): void {
    this.db.prepare("UPDATE nodes SET last_ip = ? WHERE id = ?").run(lastIp, id);
  }

  private mapRelayJoinToken(row: Record<string, unknown>): RelayJoinTokenRow {
    return {
      id: String(row.id),
      name: String(row.name),
      tokenHash: String(row.token_hash),
      tokenPlaintext: String(row.token_plaintext),
      createdBy: Number(row.created_by),
      createdAt: Number(row.created_at),
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    };
  }

  private mapRelayJoinEvent(row: Record<string, unknown>): RelayJoinEventRow {
    return {
      id: String(row.id),
      tokenId: String(row.token_id),
      nodeId: String(row.node_id),
      srcIp: row.src_ip === null || row.src_ip === undefined ? null : String(row.src_ip),
      at: Number(row.at),
    };
  }

  updateNodeHeartbeat(id: string, lastHeartbeat: number): void {
    this.db.prepare("UPDATE nodes SET last_heartbeat = ? WHERE id = ?").run(lastHeartbeat, id);
  }

  updateNodeStatus(id: string, status: string): boolean {
    const info = this.db.prepare("UPDATE nodes SET status = ? WHERE id = ?").run(status, id);
    return info.changes > 0;
  }

  updateNodeName(id: string, name: string): boolean {
    const info = this.db.prepare("UPDATE nodes SET name = ? WHERE id = ?").run(name, id);
    return info.changes > 0;
  }

  /** R33：连续未心跳（last_heartbeat < since）的在线节点 → offline。 */
  markNodesOffline(since: number): void {
    this.db.prepare("UPDATE nodes SET status = 'offline' WHERE status = 'online' AND last_heartbeat > 0 AND last_heartbeat < ?").run(since);
  }

  /**
   * N2 心跳证明节点存活：把被离线扫描误判的节点拉回 online。
   * 只改 offline → online，**不动 `draining`**（迁移中不能被改写，R39）。
   */
  markNodeAlive(id: string): void {
    this.db.prepare("UPDATE nodes SET status = 'online' WHERE id = ? AND status = 'offline'").run(id);
  }

  /** N2：落一次负载采样（最新计数器 + append-only 样本，供带宽口径 R32）。 */
  recordNodeMetric(nodeId: string, m: { connections: number; activeStreams: number; bytesIn: number; bytesOut: number }, now = Date.now()): void {
    this.db.prepare("UPDATE nodes SET connections=?, active_streams=?, bytes_in=?, bytes_out=?, last_heartbeat=? WHERE id=?").run(m.connections, m.activeStreams, m.bytesIn, m.bytesOut, now, nodeId);
    this.db.prepare("INSERT OR REPLACE INTO node_metrics (node_id, ts, connections, active_streams, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?)").run(nodeId, now, m.connections, m.activeStreams, m.bytesIn, m.bytesOut);
  }

  /** R32：节点带宽口径（当前=最近区间速率；平均=5m/1h/24h 滚动窗口，bps）。 */
  nodeBandwidth(nodeId: string, now = Date.now()): NodeBandwidth {
    const total = (r: { bytes_in: number; bytes_out: number } | undefined): number => (r === undefined ? 0 : r.bytes_in + r.bytes_out);
    const latest = this.db.prepare("SELECT bytes_in, bytes_out, connections, active_streams FROM node_metrics WHERE node_id=? ORDER BY ts DESC LIMIT 1").get(nodeId) as { bytes_in: number; bytes_out: number; connections: number; active_streams: number } | undefined;
    const connections = latest?.connections ?? 0;
    const activeStreams = latest?.active_streams ?? 0;
    const rate = (windowMs: number): number => {
      if (latest === undefined) return 0;
      const at = this.db.prepare("SELECT bytes_in, bytes_out FROM node_metrics WHERE node_id=? AND ts <= ? ORDER BY ts DESC LIMIT 1").get(nodeId, now - windowMs) as { bytes_in: number; bytes_out: number } | undefined;
      if (at === undefined) return 0;
      const delta = total(latest) - total(at);
      return delta > 0 ? Math.round((delta / windowMs) * 1000) : 0;
    };
    // 当前速率：最近两样本之间
    let currentBps = 0;
    const lastTwo = this.db.prepare("SELECT ts, bytes_in, bytes_out FROM node_metrics WHERE node_id=? ORDER BY ts DESC LIMIT 2").all(nodeId) as Array<{ ts: number; bytes_in: number; bytes_out: number }>;
    if (lastTwo.length === 2) {
      const [a, b] = lastTwo as [{ ts: number; bytes_in: number; bytes_out: number }, { ts: number; bytes_in: number; bytes_out: number }];
      const dt = a.ts - b.ts;
      if (dt > 0) currentBps = Math.round(((total(a as unknown as { bytes_in: number; bytes_out: number }) - total(b as unknown as { bytes_in: number; bytes_out: number })) / dt) * 1000);
    }
    return { currentBps, avg5mBps: rate(5 * 60 * 1000), avg1hBps: rate(60 * 60 * 1000), avg24hBps: rate(24 * 60 * 60 * 1000), connections, activeStreams };
  }

  removeNode(id: string): boolean {
    const info = this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /** R35/R36：从在线、已启用、且非 draining、且未满载的节点中按优先级/权重选一个。capacity=0 表示不限。 */
  pickNode(): NodeRow | null {
    const row = this.db.prepare(
      "SELECT n.* FROM nodes n WHERE n.status = 'online' AND n.enabled = 1 AND (n.capacity = 0 OR (SELECT COUNT(*) FROM hosts h WHERE h.node_id = n.id) < n.capacity) ORDER BY n.weight DESC, n.created_at ASC LIMIT 1",
    ).get();
    return row === undefined ? null : this.mapNode(row as unknown as Record<string, unknown>);
  }

  /** R5/R40：主机 → 节点 映射（动态分配 / 迁移）。 */
  setHostNode(hostId: string, nodeId: string | null): void {
    this.db.prepare("UPDATE hosts SET node_id = ? WHERE id = ?").run(nodeId, hostId);
  }

  /** 节点路由的主机在线状态（N4 上报）。 */
  setHostOnline(hostId: string, online: boolean): void {
    this.db.prepare("UPDATE hosts SET online = ? WHERE id = ?").run(online ? 1 : 0, hostId);
  }

  listHostsByNode(nodeId: string): HostRow[] {
    return (this.db.prepare("SELECT * FROM hosts WHERE node_id = ? ORDER BY created_at").all(nodeId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
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
      cloudTtsChars: number;
      localTtsChars: number;
      sessions: number;
    },
    meta: { hostId?: string; instanceId?: string; source?: string } = {},
    now = Date.now(),
  ): void {
    this.db.prepare(USAGE_UPSERT_SQL).run(
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
      day.cloudTtsChars,
      day.localTtsChars,
      day.sessions,
      now,
    );
  }

  /** 批量 upsert（每 chunk 一个事务）；供 usage accumulator 的分钟级 flush 使用。 */
  upsertUsageDailyBatch(rows: UsageBatchRow[], chunkSize = 500): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(USAGE_UPSERT_SQL);
    let written = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      // SAVEPOINT（可嵌套）：flush 可能在请求路径的跨日 roll 中触发，外层可能已 BEGIN。
      const sp = `usage_chunk_${i}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        for (const r of chunk) {
          stmt.run(
            r.userId,
            r.meta.hostId ?? "",
            r.day.date,
            r.meta.instanceId ?? "",
            r.meta.source ?? "",
            r.day.relaySeconds,
            r.day.relayBytesUp,
            r.day.relayBytesDown,
            r.day.directBytesUp,
            r.day.directBytesDown,
            r.day.cloudAsrSeconds,
            r.day.localAsrSeconds,
            r.day.cloudTtsChars,
            r.day.localTtsChars,
            r.day.sessions,
            Date.now(),
          );
        }
        this.db.exec(`RELEASE ${sp}`);
      } catch (err) {
        this.db.exec(`ROLLBACK TO ${sp}`);
        this.db.exec(`RELEASE ${sp}`);
        throw err;
      }
      written += chunk.length;
    }
    return written;
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
                SUM(cloud_tts_chars) AS cloud_tts_chars,
                SUM(local_tts_chars) AS local_tts_chars,
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
                SUM(cloud_tts_chars) AS cloud_tts_chars,
                SUM(local_tts_chars) AS local_tts_chars,
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
      cloudTtsChars: Number(r.cloud_tts_chars ?? 0),
      localTtsChars: Number(r.local_tts_chars ?? 0),
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

  /** 审计事件（旧接口：最多 1000 条，供 CSV / 详情页 / 风控等使用）。 */
  listAudit(filter: { userId?: number; event?: string; since?: number; source?: string } = {}): AuditEventRow[] {
    return this.listAuditPage(filter, 1000, 0).rows;
  }

  /** 审计事件分页（管理台列表）：返回 { rows, total }。 */
  listAuditPage(filter: { userId?: number; event?: string; since?: number; source?: string } = {}, limit = 50, offset = 0): { rows: AuditEventRow[]; total: number } {
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
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM audit_events${where}`).get(...params) as { c: number }).c);
    const rows = (this.db.prepare(`SELECT * FROM audit_events${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as Array<
      Record<string, unknown>
    >).map((r) => this.mapAudit(r));
    return { rows, total };
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

  /**
   * 取用户**最近一条**订阅（不按 status 过滤）。
   *
   * 用于配额计算：取消订阅（status=canceled）或进入宽限期（status 尚未翻但计划仍有效）时，
   * plan_status 仍是 subscribed/grace —— 当前周期仍有效，配额应保留。
   * 若用 getActiveSubscription（只看 active），此时会返回 null，配额被误判为 0。
   */
  getLatestSubscription(userId: number): SubscriptionRow | null {
    const row = this.db.prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId);
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

  /** 34-payment-order-check：落库平台查单凭据（发起下单成功后调用一次）。 */
  setOrderUnicpayRefs(id: string, ticket: string, paymentId: string): void {
    this.db.prepare("UPDATE orders SET ticket = ?, payment_id = ? WHERE id = ?").run(ticket, paymentId, id);
  }

  markOrderPaid(id: string, channel: string, outId: string | null, paidAt = Date.now()): void {
    this.db.prepare("UPDATE orders SET status = 'paid', channel = ?, out_id = ?, paid_at = ? WHERE id = ?").run(channel, outId, paidAt, id);
  }

  /** 原子地 created→paid（带条件守卫）：返回是否真的跃迁成功。并发下只有一个调用方会得到 true。 */
  markOrderPaidIfCreated(id: string, channel: string, outId: string | null, paidAt = Date.now()): boolean {
    const info = this.db.prepare("UPDATE orders SET status = 'paid', channel = ?, out_id = ?, paid_at = ? WHERE id = ? AND status = 'created'").run(channel, outId, paidAt, id);
    return Number(info.changes) > 0;
  }

  closeOrder(id: string): void {
    this.db.prepare("UPDATE orders SET status = 'closed' WHERE id = ?").run(id);
  }

  /** 记录人工退款：订单置 refunded（不接渠道退款 API，见 req R7）。 */
  markOrderRefunded(id: string): void {
    this.db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(id);
  }

  /** 管理台订单分页 + 过滤（订单号精确 / 套餐 / 状态）；返回 { rows, total }。 */
  listOrders(opts: { q?: string; planId?: string; status?: string; limit?: number; offset?: number } = {}): { rows: OrderRow[]; total: number } {
    const conds: string[] = [];
    const params: string[] = [];
    if (opts.q !== undefined && opts.q !== "") {
      conds.push("id = ?");
      params.push(opts.q);
    }
    if (opts.planId !== undefined && opts.planId !== "") {
      conds.push("plan_id = ?");
      params.push(opts.planId);
    }
    if (opts.status !== undefined && opts.status !== "") {
      conds.push("status = ?");
      params.push(opts.status);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM orders ${where}`).get(...params) as { c: number }).c);
    const limit = opts.limit !== undefined ? opts.limit : 50;
    const offset = opts.offset !== undefined ? opts.offset : 0;
    const rows = (this.db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as Array<Record<string, unknown>>).map((r) => this.mapOrder(r));
    return { rows, total };
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

  // ---- 点数账本（09-credits-wallet）----

  /** 读用户三桶余额（整数微单位）。 */
  getCreditBalances(userId: number): CreditBalances {
    const row = this.db.prepare("SELECT purchased_credits, bonus_carried, bonus_current FROM users WHERE id = ?").get(userId) as unknown as Record<string, unknown> | undefined;
    const purchased = row === undefined ? 0 : Number(row.purchased_credits);
    const carried = row === undefined ? 0 : Number(row.bonus_carried);
    const current = row === undefined ? 0 : Number(row.bonus_current);
    return { purchased, bonusCarried: carried, bonusCurrent: current, total: purchased + carried + current };
  }

  /** 按幂等键查流水（充值/赠点/退款幂等）。 */
  getCreditLedgerByIdempotencyKey(key: string): CreditLedgerRow | null {
    const row = this.db.prepare("SELECT * FROM credits_ledger WHERE idempotency_key = ?").get(key);
    return row === undefined ? null : this.mapCreditLedger(row as unknown as Record<string, unknown>);
  }

  /**
   * 追加一笔点数流水并原子更新对应桶余额（事务）。
   * 返回 false = 幂等键已存在（重复回调），不重复入账。
   * bucket 仅接受 purchased | bonus_carried | bonus_current（内部契约，由 credits.ts 校验）。
   */
  appendCreditLedger(
    userId: number,
    delta: number,
    bucket: string,
    reason: string,
    opts: { sourceType?: string | null; sourceId?: string | null; idempotencyKey?: string | null; now?: number } = {},
  ): boolean {
    const now = opts.now ?? Date.now();
    if (opts.idempotencyKey != null) {
      if (this.getCreditLedgerByIdempotencyKey(opts.idempotencyKey) !== null) return false;
    }
    // 白名单映射列名，非法 bucket 直接抛错（不静默落到 bonus_current）。
    const BUCKET_COLUMNS: Record<string, string> = {
      purchased: "purchased_credits",
      bonus_carried: "bonus_carried",
      bonus_current: "bonus_current",
    };
    const col = BUCKET_COLUMNS[bucket];
    if (col === undefined) {
      throw new Error(`invalid credit bucket: ${bucket}`);
    }
    // SAVEPOINT 可嵌套：调用方（如 api.ts 的 payment.succeeded）可能已在外层 BEGIN 事务内，
    // 普通 BEGIN 会抛 "cannot start a transaction within a transaction"。
    this.db.exec("SAVEPOINT credits_append");
    try {
      this.db.prepare(`UPDATE users SET ${col} = ${col} + ? WHERE id = ?`).run(delta, userId);
      const balances = this.getCreditBalances(userId);
      const balanceAfter = bucket === "purchased" ? balances.purchased : bucket === "bonus_carried" ? balances.bonusCarried : balances.bonusCurrent;
      this.db
        .prepare("INSERT INTO credits_ledger (user_id, delta, bucket, reason, source_type, source_id, idempotency_key, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(userId, delta, bucket, reason, opts.sourceType ?? null, opts.sourceId ?? null, opts.idempotencyKey ?? null, balanceAfter, now);
      this.db.exec("RELEASE credits_append");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK TO credits_append");
      this.db.exec("RELEASE credits_append");
      throw e;
    }
  }

  // ---- 点数消费（reserve / settle / release / spend）----

  /** 按请求幂等键查 hold（reserve/settle/spend 共用）。 */
  getCreditHoldByRequestId(requestId: string): CreditHoldRow | null {
    const row = this.db.prepare("SELECT * FROM credit_holds WHERE request_id = ?").get(requestId);
    return row === undefined ? null : this.mapCreditHold(row as unknown as Record<string, unknown>);
  }

  /**
   * 预占点数：不扣余额，只创建 hold。
   * available = 三桶总额 - 该用户 active holds；不足返回 insufficient。
   */
  reserveCreditHold(
    userId: number,
    amountMicro: number,
    opts: { scopeType: string; scopeId?: string | null; requestId: string; ttlMs: number; now?: number },
  ): CreditHoldReserveResult {
    this.assertMicroAmount(amountMicro, true);
    if (opts.requestId.trim() === "") throw new Error("credit hold requestId required");
    if (!Number.isSafeInteger(opts.ttlMs) || opts.ttlMs <= 0) throw new Error("credit hold ttlMs must be a positive integer");
    const now = opts.now ?? Date.now();
    const existing = this.getCreditHoldByRequestId(opts.requestId);
    if (existing !== null) {
      if (existing.userId !== userId) throw new Error("credit hold requestId belongs to another user");
      return { status: "existing", hold: existing, availableMicro: this.availableCreditMicro(userId, now) };
    }
    this.db.exec("SAVEPOINT credit_reserve");
    try {
      const available = this.availableCreditMicro(userId, now);
      if (available < amountMicro) {
        this.db.exec("RELEASE credit_reserve");
        return { status: "insufficient", hold: null, availableMicro: available };
      }
      const hold: CreditHoldRow = {
        id: randomUUID(),
        userId,
        scopeType: opts.scopeType,
        scopeId: opts.scopeId ?? null,
        requestId: opts.requestId,
        amountMicro,
        settledMicro: 0,
        status: "held",
        expiresAt: now + opts.ttlMs,
        createdAt: now,
      };
      this.db
        .prepare(
          "INSERT INTO credit_holds (id, user_id, scope_type, scope_id, request_id, amount_micro, settled_micro, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(hold.id, hold.userId, hold.scopeType, hold.scopeId, hold.requestId, hold.amountMicro, hold.settledMicro, hold.status, hold.expiresAt, hold.createdAt);
      this.db.exec("RELEASE credit_reserve");
      return { status: "held", hold, availableMicro: available - amountMicro };
    } catch (err) {
      this.db.exec("ROLLBACK TO credit_reserve");
      this.db.exec("RELEASE credit_reserve");
      throw err;
    }
  }

  /**
   * 结算 hold：按实际金额多桶扣减，写 consume 流水，释放差额。
   * hold 已 settled/released 时幂等返回；过期 hold 仍允许补 settle。
   * allowOverdraft=true 只用于“provider 成本已发生”的场景；它允许越过其他 active holds，
   * 调用方必须自行保证不会因此挤占其他请求的预留。
   */
  settleCreditHold(
    holdId: string,
    actualMicro: number,
    opts: { reason?: string; allowOverdraft?: boolean; now?: number } = {},
  ): CreditHoldSettleResult {
    this.assertMicroAmount(actualMicro, false);
    const now = opts.now ?? Date.now();
    this.db.exec("SAVEPOINT credit_settle");
    try {
      const hold = this.getCreditHoldById(holdId);
      if (hold === null) {
        this.db.exec("RELEASE credit_settle");
        return { status: "not_found", chargedMicro: 0, balance: this.getCreditBalances(0), hold: null };
      }
      const balance = this.getCreditBalances(hold.userId);
      if (hold.status === "settled") {
        this.db.exec("RELEASE credit_settle");
        return { status: "already_settled", chargedMicro: hold.settledMicro, balance, hold };
      }
      if (hold.status === "released") {
        this.db.exec("RELEASE credit_settle");
        return { status: "released", chargedMicro: 0, balance, hold };
      }
      const heldOther = this.activeHeldMicro(hold.userId, now, holdId);
      const maxPayable = balance.total - heldOther;
      if (actualMicro > maxPayable && opts.allowOverdraft !== true) {
        this.db.exec("RELEASE credit_settle");
        return { status: "insufficient", chargedMicro: 0, balance, hold };
      }
      const debit = this.debitBuckets(hold.userId, actualMicro, {
        reason: opts.reason ?? "consume",
        sourceType: "credit_hold",
        sourceId: holdId,
        idempotencyPrefix: holdId,
        allowOverdraft: opts.allowOverdraft === true,
        now,
      });
      if (!debit.ok) {
        this.db.exec("ROLLBACK TO credit_settle");
        this.db.exec("RELEASE credit_settle");
        return { status: "insufficient", chargedMicro: 0, balance, hold };
      }
      this.db.prepare("UPDATE credit_holds SET status = 'settled', settled_micro = ? WHERE id = ?").run(actualMicro, holdId);
      const updated = this.getCreditHoldById(holdId);
      this.db.exec("RELEASE credit_settle");
      return { status: "settled", chargedMicro: actualMicro, balance: debit.balance, hold: updated };
    } catch (err) {
      this.db.exec("ROLLBACK TO credit_settle");
      this.db.exec("RELEASE credit_settle");
      throw err;
    }
  }

  /** 释放 hold：只解冻，不写账本；已释放幂等返回 true，已结算返回 false。 */
  releaseCreditHold(holdId: string): boolean {
    const hold = this.getCreditHoldById(holdId);
    if (hold === null) return false;
    if (hold.status === "released") return true;
    if (hold.status === "settled") return false;
    const info = this.db.prepare("UPDATE credit_holds SET status = 'released' WHERE id = ? AND status IN ('held', 'expired')").run(holdId);
    return info.changes > 0;
  }

  /**
   * 无 hold 的批量扣减（relay 等已知金额场景）。
   * requestId 作为请求级幂等键；内部也写一条 settled hold 供审计/去重。
   * allowOverdraft=true 会允许负余额，调用方负责确认这是已发生成本。
   */
  spendCredits(
    userId: number,
    amountMicro: number,
    opts: { reason: string; sourceType?: string | null; sourceId?: string | null; idempotencyKey: string; allowOverdraft?: boolean; now?: number },
  ): CreditSpendResult {
    this.assertMicroAmount(amountMicro, true);
    if (opts.idempotencyKey.trim() === "") throw new Error("credit spend idempotencyKey required");
    const now = opts.now ?? Date.now();
    const existing = this.getCreditHoldByRequestId(opts.idempotencyKey);
    if (existing !== null) {
      if (existing.userId !== userId) throw new Error("credit spend requestId belongs to another user");
      // requestId 已存在：无论 held 还是 settled，都不再扣第二次；调用方应使用独立 requestId。
      return { status: "already_spent", chargedMicro: existing.settledMicro, balance: this.getCreditBalances(userId) };
    }
    this.db.exec("SAVEPOINT credit_spend");
    try {
      const balance = this.getCreditBalances(userId);
      const available = this.availableCreditMicro(userId, now);
      if (amountMicro > available && opts.allowOverdraft !== true) {
        this.db.exec("RELEASE credit_spend");
        return { status: "insufficient", chargedMicro: 0, balance };
      }
      const hold: CreditHoldRow = {
        id: randomUUID(),
        userId,
        scopeType: "spend",
        scopeId: null,
        requestId: opts.idempotencyKey,
        amountMicro,
        settledMicro: amountMicro,
        status: "settled",
        expiresAt: now,
        createdAt: now,
      };
      this.db
        .prepare(
          "INSERT INTO credit_holds (id, user_id, scope_type, scope_id, request_id, amount_micro, settled_micro, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(hold.id, hold.userId, hold.scopeType, hold.scopeId, hold.requestId, hold.amountMicro, hold.settledMicro, hold.status, hold.expiresAt, hold.createdAt);
      const debit = this.debitBuckets(userId, amountMicro, {
        reason: opts.reason,
        sourceType: opts.sourceType ?? null,
        sourceId: opts.sourceId ?? null,
        idempotencyPrefix: opts.idempotencyKey,
        allowOverdraft: opts.allowOverdraft === true,
        now,
      });
      if (!debit.ok) {
        this.db.exec("ROLLBACK TO credit_spend");
        this.db.exec("RELEASE credit_spend");
        return { status: "insufficient", chargedMicro: 0, balance };
      }
      this.db.exec("RELEASE credit_spend");
      return { status: "spent", chargedMicro: amountMicro, balance: debit.balance };
    } catch (err) {
      this.db.exec("ROLLBACK TO credit_spend");
      this.db.exec("RELEASE credit_spend");
      throw err;
    }
  }

  /** 把过期未结算的 hold 标记 expired；返回处理数量。 */
  sweepExpiredCreditHolds(now = Date.now()): number {
    const info = this.db.prepare("UPDATE credit_holds SET status = 'expired' WHERE status = 'held' AND expires_at <= ?").run(now);
    return Number(info.changes);
  }

  private assertMicroAmount(amountMicro: number, positive: boolean): void {
    if (!Number.isSafeInteger(amountMicro) || (positive ? amountMicro <= 0 : amountMicro < 0)) {
      throw new Error(`invalid credit micro amount: ${amountMicro}`);
    }
  }

  private mapCreditHold(row: Record<string, unknown>): CreditHoldRow {
    return {
      id: String(row.id),
      userId: Number(row.user_id),
      scopeType: String(row.scope_type),
      scopeId: row.scope_id === null || row.scope_id === undefined ? null : String(row.scope_id),
      requestId: String(row.request_id),
      amountMicro: Number(row.amount_micro),
      settledMicro: Number(row.settled_micro),
      status: String(row.status) as CreditHoldStatus,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
    };
  }

  private getCreditHoldById(holdId: string): CreditHoldRow | null {
    const row = this.db.prepare("SELECT * FROM credit_holds WHERE id = ?").get(holdId);
    return row === undefined ? null : this.mapCreditHold(row as unknown as Record<string, unknown>);
  }

  private activeHeldMicro(userId: number, now: number, excludeId?: string): number {
    const row = excludeId === undefined
      ? this.db
          .prepare("SELECT COALESCE(SUM(amount_micro), 0) AS s FROM credit_holds WHERE user_id = ? AND status = 'held' AND expires_at > ?")
          .get(userId, now) as { s: number }
      : this.db
          .prepare("SELECT COALESCE(SUM(amount_micro), 0) AS s FROM credit_holds WHERE user_id = ? AND status = 'held' AND expires_at > ? AND id != ?")
          .get(userId, now, excludeId) as { s: number };
    return Number(row.s);
  }

  private availableCreditMicro(userId: number, now: number): number {
    const balances = this.getCreditBalances(userId);
    return balances.total - this.activeHeldMicro(userId, now);
  }

  /** 事务内多桶扣减；调用方负责 SAVEPOINT/锁。 */
  private debitBuckets(
    userId: number,
    amountMicro: number,
    opts: {
      reason: string;
      sourceType: string | null;
      sourceId: string | null;
      idempotencyPrefix: string;
      allowOverdraft: boolean;
      now: number;
    },
  ): { ok: boolean; chargedMicro: number; balance: CreditBalances } {
    const balances = this.getCreditBalances(userId);
    if (amountMicro === 0) return { ok: true, chargedMicro: 0, balance: balances };
    const order: Array<{ bucket: string; balance: number }> = [
      { bucket: "bonus_carried", balance: balances.bonusCarried },
      { bucket: "bonus_current", balance: balances.bonusCurrent },
      { bucket: "purchased", balance: balances.purchased },
    ];
    let remaining = amountMicro;
    const parts: Array<{ bucket: string; amount: number; balanceAfter: number }> = [];
    for (const entry of order) {
      if (remaining <= 0) break;
      const take = Math.min(Math.max(0, entry.balance), remaining);
      if (take > 0) {
        parts.push({ bucket: entry.bucket, amount: take, balanceAfter: entry.balance - take });
        remaining -= take;
      }
    }
    if (remaining > 0) {
      if (!opts.allowOverdraft) return { ok: false, chargedMicro: 0, balance: balances };
      const purchasedPart = parts.find((p) => p.bucket === "purchased");
      if (purchasedPart !== undefined) {
        purchasedPart.amount += remaining;
        purchasedPart.balanceAfter -= remaining;
      } else {
        parts.push({ bucket: "purchased", amount: remaining, balanceAfter: balances.purchased - remaining });
      }
      remaining = 0;
    }
    const columns: Record<string, string> = {
      purchased: "purchased_credits",
      bonus_carried: "bonus_carried",
      bonus_current: "bonus_current",
    };
    for (const part of parts) {
      const col = columns[part.bucket];
      if (col === undefined) throw new Error(`invalid credit bucket: ${part.bucket}`);
      this.db.prepare(`UPDATE users SET ${col} = ${col} - ? WHERE id = ?`).run(part.amount, userId);
      this.db
        .prepare("INSERT INTO credits_ledger (user_id, delta, bucket, reason, source_type, source_id, idempotency_key, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(userId, -part.amount, part.bucket, opts.reason, opts.sourceType, opts.sourceId, `${opts.idempotencyPrefix}:${part.bucket}`, part.balanceAfter, opts.now);
    }
    return { ok: true, chargedMicro: amountMicro, balance: this.getCreditBalances(userId) };
  }

  /** 管理面：某用户账本流水（按 id 倒序）。 */
  listCreditLedger(userId: number): CreditLedgerRow[] {
    const rows = this.db.prepare("SELECT * FROM credits_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1000").all(userId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapCreditLedger(r));
  }

  /** 结转用：返回所有 bonus 桶非零的用户 id。 */
  listUsersWithBonusCredits(): number[] {
    const rows = this.db.prepare("SELECT id FROM users WHERE bonus_carried != 0 OR bonus_current != 0").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => Number(r.id));
  }

  /** 读 meta 键值（点数月度结算等持久化状态）。 */
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row === undefined ? null : String(row.value);
  }

  /** 写 meta 键值（upsert）。 */
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
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
