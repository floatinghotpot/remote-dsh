/**
 * admin.ts — 管理面服务层（RBAC + 审计的单一来源）。
 *
 * 纯函数 over HubDb；CLI（离线直开 HubDb）与 `/api/admin/*`（在线用 runtime.db）共用。
 * 每个写操作内部做角色断言 + 写审计（source='admin'、actorUserId、reason）。
 * 只做数据层变更；隧道终止等 runtime 副作用由调用方（api.ts）负责。
 */
import type { AuditEventRow, HostRow, HubDb, OrderRow, PaymentRow, UserRow } from "./db.ts";
import { hashPassword } from "./auth.ts";

/** 管理面三档角色（req R1）。 */
export const ADMIN_ROLES = ["readonly", "operator", "admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** 操作上下文：谁（actorId + role）在什么来源（ip）执行。 */
export interface AdminCtx {
  actorId: number;
  role: string;
  ip: string;
}

export class AdminError extends Error {
  readonly code: "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT";
  constructor(code: "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT", message: string) {
    super(message);
    this.code = code;
  }
}

const ROLE_RANK: Record<string, number> = { user: 0, readonly: 1, operator: 2, admin: 3 };

function assertRole(ctx: AdminCtx, min: "operator" | "admin"): void {
  const need = min === "admin" ? 3 : 2;
  if ((ROLE_RANK[ctx.role] ?? 0) < need) throw new AdminError("FORBIDDEN", `role "${ctx.role}" cannot perform this action`);
}

function audit(db: HubDb, ctx: AdminCtx, userId: number | null, event: string, detail: unknown, reason?: string): void {
  db.recordAudit(userId, event, { ...(detail as Record<string, unknown>), reason }, ctx.ip, Date.now(), {
    source: "admin",
    actorUserId: ctx.actorId,
  });
}

// ---- 读（API 守卫已保证 role ∈ 三档；readonly 可读） ----

export function listUsers(db: HubDb): UserRow[] {
  return db.listUsers();
}

export function listHosts(db: HubDb): HostRow[] {
  return db.listAllHosts();
}

export function listOrders(db: HubDb): OrderRow[] {
  return db.listOrders();
}

export function listPayments(db: HubDb): PaymentRow[] {
  return db.listPayments();
}

export function listAudit(db: HubDb, filter: { userId?: number; event?: string; since?: number; source?: string } = {}): AuditEventRow[] {
  return db.listAudit(filter);
}

export function getUser(db: HubDb, userId: number): UserRow | null {
  return db.getUserById(userId);
}

export function getHost(db: HubDb, hostId: string): HostRow | null {
  return db.getHostById(hostId);
}

// ---- 写：operator 级（客服日常） ----

export function banUser(db: HubDb, ctx: AdminCtx, userId: number, reason: string): void {
  assertRole(ctx, "operator");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  db.setAccountStatus(userId, "banned");
  db.revokeAllRefreshForUser(userId);
  audit(db, ctx, userId, "admin.ban", { name: user.name }, reason);
}

export function unbanUser(db: HubDb, ctx: AdminCtx, userId: number, reason: string): void {
  assertRole(ctx, "operator");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  db.setAccountStatus(userId, "active");
  audit(db, ctx, userId, "admin.unban", { name: user.name }, reason);
}

export async function resetUserPassword(db: HubDb, ctx: AdminCtx, userId: number, newPassword: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  db.setPassword(userId, await hashPassword(newPassword));
  db.revokeAllRefreshForUser(userId);
  audit(db, ctx, userId, "admin.reset-password", { name: user.name }, reason);
}

/** email 规范化（宽松）：小写含 @；非邮箱返回 null。 */
function adminEmail(s: string): string | null {
  const e = s.trim().toLowerCase();
  return e.length === 0 || e.length > 254 || !e.includes("@") ? null : e;
}

/** +86 手机号规范化：11 位 → E.164；否则 null。 */
function adminCnPhone(s: string): string | null {
  const p = s.trim();
  return /^1[3-9]\d{9}$/.test(p) ? `+86${p}` : null;
}

export interface AdminCreateUserInput {
  identifier: string;
  password: string;
  role: "user" | "readonly" | "operator" | "admin";
  /** 初始密码是否强制首登改密（默认 true，见 req D2）。 */
  mustChange: boolean;
  /** 到期时间戳 ms；null = 无期限（默认，req D4）。E1：plan 保持 null + 设 plan_expires_at → 到期由计费状态机降 free。 */
  expiresAtMs: number | null;
}

/** 管理台建号（feature 16）：identifier = name / 邮箱 / +86 手机（邮箱/手机自动绑定列，未验证）。
 * operator 可建 user/readonly；建 operator/admin 仅 admin（D3）；默认 mustChange=true（D2）；默认无期限（D4）。 */
export async function createUser(db: HubDb, ctx: AdminCtx, input: AdminCreateUserInput, reason: string): Promise<UserRow> {
  assertRole(ctx, "operator");
  const role = input.role;
  if (role !== "user" && !(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new AdminError("BAD_REQUEST", `invalid role '${role}'`);
  }
  if ((role === "operator" || role === "admin") && (ROLE_RANK[ctx.role] ?? 0) < 3) {
    throw new AdminError("FORBIDDEN", `role "${ctx.role}" cannot create ${role}`);
  }
  if (input.password.length < 8) throw new AdminError("BAD_REQUEST", "password must be >= 8 chars");
  const identifier = input.identifier.trim();
  if (identifier === "" || identifier.length > 128) throw new AdminError("BAD_REQUEST", "invalid identifier");
  const email = adminEmail(identifier);
  const phone = email === null ? adminCnPhone(identifier) : null;
  // 邮箱形态 → name 用规范化邮箱；手机/裸名 → 原始标识（与登录 resolveLoginName 语义一致）
  const name = email ?? identifier;
  if (db.getUserByName(name) !== null) throw new AdminError("CONFLICT", "identifier already in use");
  if (email !== null && db.getUserByEmail(email) !== null) throw new AdminError("CONFLICT", "email already in use");
  if (phone !== null && db.getUserByPhone(phone) !== null) throw new AdminError("CONFLICT", "phone already in use");
  const hash = await hashPassword(input.password);
  const user = db.createUser(name, hash, new Date().toISOString(), input.mustChange);
  if (email !== null) db.setEmail(user.id, email);
  if (phone !== null) db.setPhone(user.id, phone);
  if (input.expiresAtMs !== null) db.setPlan(user.id, null, input.expiresAtMs); // E1：plan null + 到期
  audit(db, ctx, user.id, "admin.user.create", { name, role, email, phone, expiresAtMs: input.expiresAtMs }, reason);
  const created = db.getUserById(user.id);
  if (created === null) throw new AdminError("BAD_REQUEST", "create failed");
  return created;
}

export function unlockUser(db: HubDb, ctx: AdminCtx, userId: number, reason: string): void {
  assertRole(ctx, "operator");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  db.unlockAccount(userId);
  audit(db, ctx, userId, "admin.unlock", { name: user.name }, reason);
}

export function resetUser2fa(db: HubDb, ctx: AdminCtx, userId: number, reason: string): void {
  assertRole(ctx, "operator");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  db.clearTotpSecret(userId);
  db.bumpVersion(userId);
  db.revokeAllRefreshForUser(userId);
  audit(db, ctx, userId, "admin.reset-2fa", { name: user.name }, reason);
}

/** 手动调整套餐（订阅/降级）。planStatus: subscribed|grace|free|null；expiresAtMs 为 null 时立即生效无到期。 */
export function adjustPlan(db: HubDb, ctx: AdminCtx, userId: number, planStatus: string | null, expiresAtMs: number | null, reason: string): void {
  assertRole(ctx, "operator");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  db.setPlan(userId, planStatus, expiresAtMs);
  if (planStatus === "free") db.setFreeSince(userId, Date.now());
  audit(db, ctx, userId, "admin.adjust-plan", { name: user.name, planStatus, expiresAtMs }, reason);
}

export function revokeHost(db: HubDb, ctx: AdminCtx, hostId: string, reason: string): void {
  assertRole(ctx, "operator");
  const host = db.getHostById(hostId);
  if (host === null) throw new AdminError("NOT_FOUND", "host not found");
  db.removeHost(hostId);
  audit(db, ctx, host.ownerId, "admin.revoke-host", { hostId, name: host.name }, reason);
}

/** 记录人工退款：订单置 refunded + 取消订阅并降级免费档 + 审计（不接渠道退款 API）。 */
export function refundOrder(db: HubDb, ctx: AdminCtx, orderId: string, reason: string): void {
  assertRole(ctx, "operator");
  const order = db.getOrder(orderId);
  if (order === null) throw new AdminError("NOT_FOUND", "order not found");
  if (order.status !== "paid") throw new AdminError("BAD_REQUEST", `order is ${order.status}, not paid`);
  db.markOrderRefunded(orderId);
  const sub = db.getActiveSubscription(order.userId);
  if (sub !== null) db.setSubscriptionStatus(sub.id, "canceled");
  db.setPlan(order.userId, "free", null);
  db.setFreeSince(order.userId, Date.now());
  audit(db, ctx, order.userId, "admin.refund", { orderId, amountCny: order.amountCny }, reason);
}

// ---- 写：admin 级（高危） ----

export function deleteUser(db: HubDb, ctx: AdminCtx, userId: number, reason: string): void {
  assertRole(ctx, "admin");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  if (user.role === "admin" && ctx.actorId === userId) throw new AdminError("BAD_REQUEST", "cannot delete self");
  audit(db, ctx, userId, "admin.delete-account", { name: user.name, email: user.email, phone: user.phone }, reason);
  db.deleteAccount(userId);
}

export function setUserRole(db: HubDb, ctx: AdminCtx, userId: number, role: string, reason: string): void {
  assertRole(ctx, "admin");
  if (ctx.actorId === userId) throw new AdminError("FORBIDDEN", "cannot change your own role");
  if (!ADMIN_ROLES.includes(role as AdminRole) && role !== "user") throw new AdminError("BAD_REQUEST", `invalid role "${role}"`);
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  db.setRole(userId, role);
  audit(db, ctx, userId, "admin.set-role", { name: user.name, from: user.role, to: role }, reason);
}

/** 移除管理员 = 降级为普通用户（admin only）。 */
export function removeAdmin(db: HubDb, ctx: AdminCtx, userId: number, reason: string): void {
  assertRole(ctx, "admin");
  const user = db.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  if (ctx.actorId === userId) throw new AdminError("BAD_REQUEST", "cannot remove self");
  db.setRole(userId, "user");
  audit(db, ctx, userId, "admin.remove-admin", { name: user.name }, reason);
}

/** 补单（人工入账）：建订单 → 标 paid（channel=manual）→ 激活订阅。admin only。 */
export function creditOrder(
  db: HubDb,
  ctx: AdminCtx,
  params: { userId: number; planId: string; amountCny: number; expiresAtMs: number },
  reason: string,
): string {
  assertRole(ctx, "admin");
  const user = db.getUserById(params.userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  const orderId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.createOrder(orderId, params.userId, params.planId, params.amountCny);
  db.markOrderPaid(orderId, "manual", null);
  db.setPlan(params.userId, "subscribed", params.expiresAtMs);
  db.createSubscription(params.userId, params.planId, Date.now(), params.expiresAtMs);
  audit(db, ctx, params.userId, "admin.credit-order", { orderId, planId: params.planId, amountCny: params.amountCny }, reason);
  return orderId;
}
