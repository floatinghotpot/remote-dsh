/**
 * admin.ts — 管理面服务层（RBAC + 审计的单一来源）。
 *
 * 纯函数 over HubDb；CLI（离线直开 HubDb）与 `/api/admin/*`（在线用 runtime.db）共用。
 * 每个写操作内部做角色断言 + 写审计（source='admin'、actorUserId、reason）。
 * 只做数据层变更；隧道终止等 runtime 副作用由调用方（api.ts）负责。
 */
import type { AuditEventRow, HostRow, RelayJoinEventRow, NodeRow, OrderRow, PaymentRow, UserRow } from "./db.ts";
import type { HubStore } from "./store.ts";
import { hashPassword } from "./auth.ts";
import { randomToken, sha256 } from "./jwt.ts";
import { randomUUID } from "node:crypto";

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

async function audit(store: HubStore, ctx: AdminCtx, userId: number | null, event: string, detail: unknown, reason?: string): Promise<void> {
  await store.recordAudit(userId, event, { ...(detail as Record<string, unknown>), reason }, ctx.ip, Date.now(), {
    source: "admin",
    actorUserId: ctx.actorId,
  });
}

// ---- 读（API 守卫已保证 role ∈ 三档；readonly 可读） ----

export async function listUsers(store: HubStore): Promise<UserRow[]> {
  return await store.listUsers();
}

export async function listHosts(store: HubStore): Promise<HostRow[]> {
  return await store.listAllHosts();
}

export async function listOrders(store: HubStore, opts: { q?: string; planId?: string; status?: string; limit?: number; offset?: number } = {}): ReturnType<HubStore["listOrders"]> {
  return await store.listOrders(opts);
}

export async function listPayments(store: HubStore): Promise<PaymentRow[]> {
  return await store.listPayments();
}

export async function listAudit(store: HubStore, filter: { userId?: number; event?: string; since?: number; source?: string } = {}): Promise<AuditEventRow[]> {
  return await store.listAudit(filter);
}

export async function listAuditPage(store: HubStore, filter: { userId?: number; event?: string; since?: number; source?: string } = {}, limit?: number, offset?: number): ReturnType<HubStore["listAuditPage"]> {
  return await store.listAuditPage(filter, limit, offset);
}

export async function getUser(store: HubStore, userId: number): Promise<UserRow | null> {
  return await store.getUserById(userId);
}

export async function getHost(store: HubStore, hostId: string): Promise<HostRow | null> {
  return await store.getHostById(hostId);
}

// ---- 写：operator 级（客服日常） ----

export async function banUser(store: HubStore, ctx: AdminCtx, userId: number, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  await store.setAccountStatus(userId, "banned");
  await store.revokeAllRefreshForUser(userId);
  await audit(store, ctx, userId, "admin.ban", { name: user.name }, reason);
}

export async function unbanUser(store: HubStore, ctx: AdminCtx, userId: number, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  await store.setAccountStatus(userId, "active");
  await audit(store, ctx, userId, "admin.unban", { name: user.name }, reason);
}

export async function resetUserPassword(store: HubStore, ctx: AdminCtx, userId: number, newPassword: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  await store.setPassword(userId, await hashPassword(newPassword));
  await store.revokeAllRefreshForUser(userId);
  await audit(store, ctx, userId, "admin.reset-password", { name: user.name }, reason);
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
  /** 试用到该时刻 ms（写 `plan=trial`）；null = 永久无限（默认，req D4）。 */
  expiresAtMs: number | null;
}

/** 管理台建号（feature 16）：identifier = name / 邮箱 / +86 手机（邮箱/手机自动绑定列，未验证）。
 * operator 可建 user/readonly；建 operator/admin 仅 admin（D3）；默认 mustChange=true（D2）；默认无期限（D4）。 */
export async function createUser(store: HubStore, ctx: AdminCtx, input: AdminCreateUserInput, reason: string): Promise<UserRow> {
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
  if (await store.getUserByName(name) !== null) throw new AdminError("CONFLICT", "identifier already in use");
  if (email !== null && await store.getUserByEmail(email) !== null) throw new AdminError("CONFLICT", "email already in use");
  if (phone !== null && await store.getUserByPhone(phone) !== null) throw new AdminError("CONFLICT", "phone already in use");
  const hash = await hashPassword(input.password);
  const user = await store.createUser(name, hash, new Date().toISOString(), input.mustChange);
  if (email !== null) await store.setEmail(user.id, email);
  if (phone !== null) await store.setPhone(user.id, phone);
  if (input.expiresAtMs !== null) await store.setPlan(user.id, "trial", input.expiresAtMs); // 建号带到期 = 试用（不再写 null+到期）
  await audit(store, ctx, user.id, "admin.user.create", { name, role, email, phone, expiresAtMs: input.expiresAtMs }, reason);
  const created = await store.getUserById(user.id);
  if (created === null) throw new AdminError("BAD_REQUEST", "create failed");
  return created;
}

export async function unlockUser(store: HubStore, ctx: AdminCtx, userId: number, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  await store.unlockAccount(userId);
  await audit(store, ctx, userId, "admin.unlock", { name: user.name }, reason);
}

export async function resetUser2fa(store: HubStore, ctx: AdminCtx, userId: number, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  await store.clearTotpSecret(userId);
  await store.bumpVersion(userId);
  await store.revokeAllRefreshForUser(userId);
  await audit(store, ctx, userId, "admin.reset-2fa", { name: user.name }, reason);
}

/** 手动调整套餐（订阅/降级）。planStatus: subscribed|grace|free|null；expiresAtMs 为 null 时立即生效无到期。
 * 收紧校验（feature 23）：`subscribed` 必须已有有效订阅；`null` 不得带到期时间。 */
export async function adjustPlan(store: HubStore, ctx: AdminCtx, userId: number, planStatus: string | null, expiresAtMs: number | null, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  if (planStatus === "subscribed" && await store.getActiveSubscription(userId) === null) {
    throw new AdminError("BAD_REQUEST", "subscribed requires an active subscription; use grant-subscription instead");
  }
  if (planStatus === null && expiresAtMs !== null) {
    throw new AdminError("BAD_REQUEST", "a null (unlimited) plan cannot carry expiresAtMs; clear the expiry or use grant-trial / grant-subscription");
  }
  await store.setPlan(userId, planStatus, expiresAtMs);
  if (planStatus === "free") await store.setFreeSince(userId, Date.now());
  await audit(store, ctx, userId, "admin.adjust-plan", { name: user.name, planStatus, expiresAtMs }, reason);
}

/** 延长试用：`trial` 到期从 `max(now, 当前到期)` 起顺延 `days` 天；已订阅账号拒绝（防误降级，D7）。 */
export async function grantTrial(store: HubStore, ctx: AdminCtx, userId: number, days: number, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new AdminError("BAD_REQUEST", "days must be an integer in [1, 3650]");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  if (await store.getActiveSubscription(userId) !== null) throw new AdminError("CONFLICT", "user has an active subscription; use grant-subscription instead");
  const base = Math.max(Date.now(), user.planExpiresAt ?? 0);
  const expiresAtMs = base + days * 24 * 3600 * 1000;
  await store.setPlan(userId, "trial", expiresAtMs);
  await audit(store, ctx, userId, "admin.grant-trial", { name: user.name, days, expiresAtMs }, reason);
}

export async function revokeHost(store: HubStore, ctx: AdminCtx, hostId: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const host = await store.getHostById(hostId);
  if (host === null) throw new AdminError("NOT_FOUND", "host not found");
  await store.removeHost(hostId);
  await audit(store, ctx, host.ownerId, "admin.revoke-host", { hostId, name: host.name }, reason);
}

// ---- 中继节点（30-relay-node，R29–R34）----

export async function listNodes(store: HubStore): Promise<NodeRow[]> {
  return await store.listNodes();
}

export async function listNodesPage(store: HubStore, limit?: number, offset?: number): ReturnType<HubStore["listNodesPage"]> {
  return await store.listNodesPage(limit, offset);
}

/** 添加节点：生成节点 + 一次性明文令牌（令牌只存 sha256；域名预登记，R24）。 */
export async function createNodeToken(store: HubStore, ctx: AdminCtx, input: { name: string; advertiseUrl: string; capacity?: number; weight?: number }): Promise<{ nodeId: string; token: string }> {
  assertRole(ctx, "operator");
  const nodeId = randomUUID();
  const token = randomToken();
  await store.createNode(nodeId, input.name, input.advertiseUrl, sha256(token), "", input.capacity ?? 0, input.weight ?? 100, true, null);
  await audit(store, ctx, null, "admin.node.create", { nodeId, name: input.name, advertiseUrl: input.advertiseUrl });
  return { nodeId, token };
}

/** 吊销节点：解除主机分配 + 删节点 + 审计。 */
export async function revokeNode(store: HubStore, ctx: AdminCtx, nodeId: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const node = await store.getNodeById(nodeId);
  if (node === null) throw new AdminError("NOT_FOUND", "node not found");
  for (const h of await store.listHostsByNode(nodeId)) await store.setHostNode(h.id, null);
  await store.removeNode(nodeId);
  await audit(store, ctx, null, "admin.node.revoke", { nodeId, name: node.name }, reason);
}

/** 重命名节点 + 审计。 */
export async function renameNode(store: HubStore, ctx: AdminCtx, nodeId: string, name: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const node = await store.getNodeById(nodeId);
  if (node === null) throw new AdminError("NOT_FOUND", "node not found");
  await store.updateNodeName(nodeId, name);
  await audit(store, ctx, null, "admin.node.rename", { nodeId, from: node.name, to: name }, reason);
}

/** 启用节点（R9）：disabled → enabled；主机迁移由 server 层触发。 */
export async function enableNode(store: HubStore, ctx: AdminCtx, nodeId: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  if (await store.getNodeById(nodeId) === null) throw new AdminError("NOT_FOUND", "node not found");
  await store.setNodeEnabled(nodeId, true);
  await store.updateNodeStatus(nodeId, "online");
  await audit(store, ctx, null, "admin.node.enable", { nodeId }, reason);
}

/** 禁用节点（R9/R10）：enabled → disabled + draining（触发 N5 migrateTo 迁移其名下主机）。 */
export async function disableNode(store: HubStore, ctx: AdminCtx, nodeId: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  if (await store.getNodeById(nodeId) === null) throw new AdminError("NOT_FOUND", "node not found");
  await store.setNodeEnabled(nodeId, false);
  await store.updateNodeStatus(nodeId, "draining");
  await audit(store, ctx, null, "admin.node.disable", { nodeId }, reason);
}

// ---- 入网令牌（41-relay-node-onboarding R3-R5/R22）----

/** 签发入网令牌：明文可再复制（R22），故存明文（撤销 + enable 门 + 审计兜底）。 */
export async function createRelayJoinToken(store: HubStore, ctx: AdminCtx, input: { name: string }): Promise<{ id: string; name: string; token: string }> {
  assertRole(ctx, "operator");
  const id = randomUUID();
  const token = randomToken();
  await store.createRelayJoinToken(id, input.name, sha256(token), token, ctx.actorId);
  await audit(store, ctx, null, "admin.relay-join-token.create", { id, name: input.name });
  return { id, name: input.name, token };
}

/** 入网令牌列表：元数据三档角色可读；明文（tokenPlaintext）仅 operator/admin 可见（R22）。 */
export async function listRelayJoinTokens(store: HubStore, ctx: AdminCtx): ReturnType<HubStore["listRelayJoinTokens"]> {
  const tokens = await store.listRelayJoinTokens();
  if ((ROLE_RANK[ctx.role] ?? 0) < 2) {
    return tokens.map((t) => ({ ...t, tokenPlaintext: "" }));
  }
  return tokens;
}

export async function revokeRelayJoinToken(store: HubStore, ctx: AdminCtx, id: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const t = await store.getRelayJoinToken(id);
  if (t === null) throw new AdminError("NOT_FOUND", "join token not found");
  if (!await store.revokeRelayJoinToken(id)) throw new AdminError("BAD_REQUEST", "join token already revoked");
  await audit(store, ctx, null, "admin.relay-join-token.revoke", { id, name: t.name }, reason);
}

/** 入网令牌改名（只改展示名；原名记进审计）。 */
export async function renameRelayJoinToken(store: HubStore, ctx: AdminCtx, id: string, name: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const t = await store.getRelayJoinToken(id);
  if (t === null) throw new AdminError("NOT_FOUND", "join token not found");
  const trimmed = name.trim().slice(0, 64);
  if (trimmed === "") throw new AdminError("BAD_REQUEST", "name required");
  await store.renameRelayJoinToken(id, trimmed);
  await audit(store, ctx, null, "admin.relay-join-token.rename", { id, from: t.name, to: trimmed }, reason);
}

/** 取令牌明文（R22：可再次复制；仅 operator）。 */
export async function getRelayJoinTokenPlaintext(store: HubStore, ctx: AdminCtx, id: string): Promise<string> {
  assertRole(ctx, "operator");
  const t = await store.getRelayJoinToken(id);
  if (t === null) throw new AdminError("NOT_FOUND", "join token not found");
  return t.tokenPlaintext;
}

export async function listRelayJoinTokenEvents(store: HubStore, id: string): Promise<RelayJoinEventRow[]> {
  return await store.listRelayJoinEvents(id);
}

/** 记录人工退款：订单置 refunded + 取消订阅并降级免费档 + 审计（不接渠道退款 API）。 */
export async function refundOrder(store: HubStore, ctx: AdminCtx, orderId: string, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const order = await store.getOrder(orderId);
  if (order === null) throw new AdminError("NOT_FOUND", "order not found");
  if (order.status !== "paid") throw new AdminError("BAD_REQUEST", `order is ${order.status}, not paid`);
  await store.markOrderRefunded(orderId);
  const sub = await store.getActiveSubscription(order.userId);
  if (sub !== null) await store.setSubscriptionStatus(sub.id, "canceled");
  await store.setPlan(order.userId, "free", null);
  await store.setFreeSince(order.userId, Date.now());
  await audit(store, ctx, order.userId, "admin.refund", { orderId, amountCny: order.amountCny }, reason);
}

// ---- 写：admin 级（高危） ----

export async function deleteUser(store: HubStore, ctx: AdminCtx, userId: number, reason: string): Promise<void> {
  assertRole(ctx, "admin");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  if (user.role === "admin" && ctx.actorId === userId) throw new AdminError("BAD_REQUEST", "cannot delete self");
  await audit(store, ctx, userId, "admin.delete-account", { name: user.name, email: user.email, phone: user.phone }, reason);
  await store.deleteAccount(userId);
}

export async function setUserRole(store: HubStore, ctx: AdminCtx, userId: number, role: string, reason: string): Promise<void> {
  assertRole(ctx, "admin");
  if (ctx.actorId === userId) throw new AdminError("FORBIDDEN", "cannot change your own role");
  if (!ADMIN_ROLES.includes(role as AdminRole) && role !== "user") throw new AdminError("BAD_REQUEST", `invalid role "${role}"`);
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  await store.setRole(userId, role);
  await audit(store, ctx, userId, "admin.set-role", { name: user.name, from: user.role, to: role }, reason);
}

/** 移除管理员 = 降级为普通用户（admin only）。 */
export async function removeAdmin(store: HubStore, ctx: AdminCtx, userId: number, reason: string): Promise<void> {
  assertRole(ctx, "admin");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  if (ctx.actorId === userId) throw new AdminError("BAD_REQUEST", "cannot remove self");
  await store.setRole(userId, "user");
  await audit(store, ctx, userId, "admin.remove-admin", { name: user.name }, reason);
}

/** 赠送订阅入参：`days` 与 `expiresAtMs` 二选一；`amountCny` 默认 0（赠送）。 */
export interface GrantSubscriptionInput {
  userId: number;
  planId: string;
  /** 顺延天数（从 `max(now, 当前到期)` 起算）。 */
  days?: number;
  /** 明确到期时间戳 ms（未来时刻）。 */
  expiresAtMs?: number;
  /** 入账金额，默认 0（manual 渠道，营收口径按 provider 区分）。 */
  amountCny?: number;
}

/** 赠送订阅（admin only）：校验后复用 creditOrder（订单 + 停用旧订阅 + 新订阅 + subscribed）。 */
export async function grantSubscription(store: HubStore, ctx: AdminCtx, input: GrantSubscriptionInput, reason: string): Promise<string> {
  assertRole(ctx, "admin");
  if (input.days === undefined && input.expiresAtMs === undefined) {
    throw new AdminError("BAD_REQUEST", "days or expiresAtMs required");
  }
  if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > 3650)) {
    throw new AdminError("BAD_REQUEST", "days must be an integer in [1, 3650]");
  }
  if (input.expiresAtMs !== undefined && (!Number.isFinite(input.expiresAtMs) || input.expiresAtMs <= Date.now())) {
    throw new AdminError("BAD_REQUEST", "expiresAtMs must be a future timestamp");
  }
  const user = await store.getUserById(input.userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  const base = Math.max(Date.now(), user.planExpiresAt ?? 0);
  const expiresAtMs = input.days !== undefined ? base + input.days * 24 * 3600 * 1000 : input.expiresAtMs!;
  return await creditOrder(store, ctx, { userId: input.userId, planId: input.planId, amountCny: input.amountCny ?? 0, expiresAtMs }, reason);
}

/** 补单（人工入账）：建订单 → 标 paid（channel=manual）→ 停用旧订阅 → 激活新订阅。admin only。 */
export async function creditOrder(
  store: HubStore,
  ctx: AdminCtx,
  params: { userId: number; planId: string; amountCny: number; expiresAtMs: number },
  reason: string,
): Promise<string> {
  assertRole(ctx, "admin");
  const user = await store.getUserById(params.userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  // 单有效订阅（D8）：停用旧 active 订阅，避免 getActiveSubscription 取到脏数据
  const prior = await store.getActiveSubscription(params.userId);
  if (prior !== null) await store.setSubscriptionStatus(prior.id, "canceled");
  const orderId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.createOrder(orderId, params.userId, params.planId, params.amountCny);
  await store.markOrderPaid(orderId, "manual", null);
  await store.setPlan(params.userId, "subscribed", params.expiresAtMs);
  await store.createSubscription(params.userId, params.planId, Date.now(), params.expiresAtMs);
  await audit(store, ctx, params.userId, "admin.credit-order", { orderId, planId: params.planId, amountCny: params.amountCny }, reason);
  return orderId;
}
