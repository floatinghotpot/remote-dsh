/**
 * pg-store/mappers.ts — 43b-2：共享行映射器 + 查询辅助（从 db.ts 原样搬移）。
 *
 * 行映射与 SQLite 版逐字段一致（0/1→boolean、null 归一、JSON 字段原样），
 * 保证 `PgStore` 与 `SqliteStore` 返回同构数据。领域模块（users/hosts/…）复用它。
 */
import type { Pool, PoolClient } from "pg";
import type {
  UserRow, HostRow, NodeRow, RefreshRow, JoinTokenRow, BindSessionRow, HostShareRow,
  AuditEventRow, EmailCodeRow, SmsCodeRow, SubscriptionRow, OrderRow, PaymentRow, CreditLedgerRow,
  CreditHoldRow, CreditHoldStatus,
} from "../db.ts";

/** 查询句柄：方法内既可能是 Pool（无事务）也可能是 PoolClient（事务内）。 */
export type Db = Pool | PoolClient;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export async function q<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
  const r = await db.query(sql, params);
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
}

export function one<T>(r: QueryResult<T>): T | null {
  return r.rows.length > 0 ? r.rows[0]! : null;
}

export function mapUser(row: Record<string, unknown>): UserRow {
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

export function mapHost(row: Record<string, unknown>): HostRow {
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

export function mapNode(row: Record<string, unknown>): NodeRow {
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

export function mapRefresh(row: Record<string, unknown>): RefreshRow {
  return {
    id: Number(row.id), userId: Number(row.user_id), tokenHash: String(row.token_hash),
    expiresAt: Number(row.expires_at), revoked: Number(row.revoked), createdAt: Number(row.created_at),
  };
}

export function mapJoinToken(row: Record<string, unknown>): JoinTokenRow {
  return {
    id: String(row.id),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    ownerId: Number(row.owner_id), tokenHash: String(row.token_hash), expiresAt: Number(row.expires_at),
    revoked: Number(row.revoked), createdAt: String(row.created_at),
  };
}

export function mapBindSession(row: Record<string, unknown>): BindSessionRow {
  return {
    id: String(row.id), consumeTokenHash: String(row.consume_token_hash),
    e2eePublicKey: row.e2ee_public_key === null || row.e2ee_public_key === undefined ? null : String(row.e2ee_public_key),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id),
    status: String(row.status) as BindSessionRow["status"], createdAt: String(row.created_at), expiresAt: Number(row.expires_at),
  };
}

export function mapHostShare(row: Record<string, unknown>): HostShareRow {
  return { hostId: String(row.host_id), userId: Number(row.user_id), role: String(row.role), createdAt: String(row.created_at) };
}

export function mapAudit(row: Record<string, unknown>): AuditEventRow {
  return {
    id: Number(row.id),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    event: String(row.event), detailJson: String(row.detail_json ?? "{}"), ip: String(row.ip ?? ""),
    source: String(row.source ?? "user"),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined ? null : Number(row.actor_user_id),
    createdAt: Number(row.created_at),
  };
}

export function mapEmailCode(row: Record<string, unknown>): EmailCodeRow {
  return {
    id: Number(row.id), userId: Number(row.user_id), email: String(row.email), purpose: String(row.purpose),
    codeHash: String(row.code_hash), expiresAt: Number(row.expires_at), attempts: Number(row.attempts ?? 0), createdAt: Number(row.created_at),
  };
}

export function mapSmsCode(row: Record<string, unknown>): SmsCodeRow {
  return {
    id: Number(row.id), userId: Number(row.user_id), phone: String(row.phone), purpose: String(row.purpose),
    codeHash: String(row.code_hash), expiresAt: Number(row.expires_at), attempts: Number(row.attempts ?? 0), createdAt: Number(row.created_at),
  };
}

export function mapSubscription(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: Number(row.id), userId: Number(row.user_id), planId: String(row.plan_id), status: String(row.status),
    startedAt: Number(row.started_at), expiresAt: Number(row.expires_at), createdAt: Number(row.created_at),
    channel: row.channel === null || row.channel === undefined ? null : String(row.channel),
    subscriptionId: row.subscription_id === null || row.subscription_id === undefined ? null : String(row.subscription_id),
    willRenew: Number(row.will_renew ?? 0) === 1,
  };
}

export function mapOrder(row: Record<string, unknown>): OrderRow {
  return {
    id: String(row.id), userId: Number(row.user_id), planId: String(row.plan_id), amountCny: Number(row.amount_cny),
    status: String(row.status),
    channel: row.channel === null || row.channel === undefined ? null : String(row.channel),
    outId: row.out_id === null || row.out_id === undefined ? null : String(row.out_id),
    ticket: row.ticket === null || row.ticket === undefined ? null : String(row.ticket),
    paymentId: row.payment_id === null || row.payment_id === undefined ? null : String(row.payment_id),
    createdAt: Number(row.created_at),
    paidAt: row.paid_at === null || row.paid_at === undefined ? null : Number(row.paid_at),
  };
}

export function mapPayment(row: Record<string, unknown>): PaymentRow {
  return {
    id: String(row.id), orderId: String(row.order_id), userId: Number(row.user_id), channel: String(row.channel),
    channelOrderId: String(row.channel_order_id), amountCny: Number(row.amount_cny), paidAt: Number(row.paid_at), raw: String(row.raw ?? "{}"),
  };
}

export function mapCreditLedger(row: Record<string, unknown>): CreditLedgerRow {
  return {
    id: Number(row.id), userId: Number(row.user_id), delta: Number(row.delta), bucket: String(row.bucket), reason: String(row.reason),
    sourceType: row.source_type === null || row.source_type === undefined ? null : String(row.source_type),
    sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
    idempotencyKey: row.idempotency_key === null || row.idempotency_key === undefined ? null : String(row.idempotency_key),
    balanceAfter: row.balance_after === null || row.balance_after === undefined ? null : Number(row.balance_after),
    createdAt: Number(row.created_at),
  };
}

export function mapCreditHold(row: Record<string, unknown>): CreditHoldRow {
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
