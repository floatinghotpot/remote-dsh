/**
 * admin.ts — 管理面服务层（RBAC + 审计的单一来源）。
 *
 * 纯函数 over HubDb；CLI（离线直开 HubDb）与 `/api/admin/*`（在线用 runtime.db）共用。
 * 每个写操作内部做角色断言 + 写审计（source='admin'、actorUserId、reason）。
 * 只做数据层变更；隧道终止等 runtime 副作用由调用方（api.ts）负责。
 */
import type { AuditEventRow, HostRow, RelayJoinEventRow, NodeRow, OrderRow, PaymentRow, SubscriptionRow, UserRow } from "./db.ts";
import type { HubStore } from "./store.ts";
import { grantSubscriptionBonus } from "./credits.ts";
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
  if (input.expiresAtMs !== null) {
    await store.setPlan(user.id, "trial", input.expiresAtMs); // 建号带到期 = 试用
  } else {
    await store.setPlan(user.id, "internal", null); // 建号不带到期 = 专属账号（显式 internal，不再是 NULL）
  }
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

/** 手动调整套餐（订阅/降级）。planStatus: internal|subscribed|grace|free|trial；expiresAtMs 为 null 时立即生效无到期。
 * 收紧校验：`subscribed` 必须已有有效订阅；`internal` 不得带到期（永久）；`null` 不再作为可设置值。 */
export async function adjustPlan(store: HubStore, ctx: AdminCtx, userId: number, planStatus: string | null, expiresAtMs: number | null, reason: string): Promise<void> {
  assertRole(ctx, "operator");
  const user = await store.getUserById(userId);
  if (user === null) throw new AdminError("NOT_FOUND", "user not found");
  if (planStatus === "subscribed" && await store.getActiveSubscription(userId) === null) {
    throw new AdminError("BAD_REQUEST", "subscribed requires an active subscription; use grant-subscription instead");
  }
  if (planStatus === "internal" && expiresAtMs !== null) {
    throw new AdminError("BAD_REQUEST", "internal (专属) is permanent and cannot carry expiresAtMs; use trial for time-limited access");
  }
  if (planStatus === null) {
    throw new AdminError("BAD_REQUEST", "planStatus must be internal|trial|subscribed|grace|free; use 'free' to clear billing");
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
  await store.revokeHostRecord(hostId);
  await store.revokeLlmKeysByHost(hostId);
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
  /** 首月赠点数（来自该档 `package.credits`；由调用方从 config.plans 解析后传入）。 */
  bonusCredits?: number;
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
  return await creditOrder(store, ctx, { userId: input.userId, planId: input.planId, amountCny: input.amountCny ?? 0, expiresAtMs, bonusCredits: input.bonusCredits }, reason);
}

/** 补单（人工入账）：建订单 → 标 paid（channel=manual）→ 停用旧订阅 → 激活新订阅。admin only。 */
export async function creditOrder(
  store: HubStore,
  ctx: AdminCtx,
  params: { userId: number; planId: string; amountCny: number; expiresAtMs: number; bonusCredits?: number },
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
  const sub = await store.createSubscription(params.userId, params.planId, Date.now(), params.expiresAtMs);
  // R12：订阅即有赠点（幂等键含订阅行 id）。
  if ((params.bonusCredits ?? 0) > 0) {
    await grantSubscriptionBonus(store, params.userId, params.bonusCredits ?? 0, `sub:${sub.id}`);
  }
  await audit(store, ctx, params.userId, "admin.credit-order", { orderId, planId: params.planId, amountCny: params.amountCny }, reason);
  return orderId;
}

// ---- 产品分析（57-retention-analytics，Phase 1：纯服务端，零埋点） ----

export interface AnalyticsFunnel {
  registered: number;
  subscribed: number;
  renewed: number;
}

export interface AnalyticsRetentionRow {
  month: string;
  users: number;
  m1: number | null;
  m3: number | null;
  m6: number | null;
}

export interface AnalyticsChannelRow {
  channel: string;
  count: number;
  amount: number;
}

export interface AnalyticsPlanRow {
  planId: string;
  count: number;
  amount: number;
}

export interface AnalyticsSnapshot {
  /** 今日注册用户数（users.created_at，UTC+8 日界）。 */
  newUsersToday: number;
  funnel: AnalyticsFunnel;
  retention: AnalyticsRetentionRow[];
  revenue: {
    payingUsers: number;
    totalAmount: number;
    arpu: number;
    byChannel: AnalyticsChannelRow[];
    byPlan: AnalyticsPlanRow[];
  };
  churn: {
    monthlyChurnRate: number | null;
    avgLifetimeMonths: number | null;
  };
}

// 时区：Asia/Shanghai（UTC+8，同计费账期 R13）。
const TZ_OFFSET_MS = 8 * 3600_000;

function monthKey(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseMonth(key: string): [number, number] {
  const [y, m] = key.split("-").map(Number);
  return [y!, m!];
}

function monthStartMs(key: string): number {
  const [y, m] = parseMonth(key);
  return Date.UTC(y, m - 1, 1) - TZ_OFFSET_MS;
}

function monthEndMs(key: string): number {
  const [y, m] = parseMonth(key);
  return Date.UTC(y, m, 1) - TZ_OFFSET_MS - 1;
}

function addMonths(key: string, n: number): string {
  const [y, m] = parseMonth(key);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** 该用户是否有订阅区间覆盖某自然月（在保）。 */
function inCoverageAt(subs: SubscriptionRow[], key: string): boolean {
  const start = monthStartMs(key);
  const end = monthEndMs(key);
  return subs.some((s) => s.startedAt <= end && s.expiresAt > start);
}

/** 计算 Phase 1 产品分析快照（付费留存 / 漏斗 / 收入 / 流失）。 */
export async function computeAnalytics(store: HubStore, subscriptionPlanIds: ReadonlySet<string>): Promise<AnalyticsSnapshot> {
  const subscriptions = await store.listSubscriptions();

  // 一次查询拿到全部订阅，按 user_id 分组（避免逐用户 N+1）。
  const subsByUser = new Map<number, SubscriptionRow[]>();
  for (const s of subscriptions) {
    const list = subsByUser.get(s.userId) ?? [];
    list.push(s);
    subsByUser.set(s.userId, list);
  }

  let subscribed = 0;
  const cohorts = new Map<string, { users: number; m1: number | null; m3: number | null; m6: number | null }>();

  const now = Date.now();
  const thisMonth = monthKey(now);
  const lastMonth = addMonths(thisMonth, -1);
  let atRisk = 0;
  let churned = 0;

  // 注册总量（有效注册，排除 deleted/banned）+ 今日注册：SQL COUNT，不加载全量用户（O(1) 而非 O(users)）。
  const registered = await store.countUsersActive();
  const newUsersToday = await store.countUsersCreatedSince(dayStartMs(dayKey(now)));

  // 订阅 cohort / 流失：直接遍历订阅分组，不遍历全量用户。
  for (const subs of subsByUser.values()) {
    subscribed += 1;

    const first = subs.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
    const cohortKey = monthKey(first.startedAt);
    const c = cohorts.get(cohortKey) ?? { users: 0, m1: 0, m3: 0, m6: 0 };
    c.users += 1;
    // 未来月份 → null（不可测，前端显示「—」而非误导性的 0%）。
    const [cy, cm] = parseMonth(thisMonth);
    const [fy, fm] = parseMonth(cohortKey);
    const elapsed = (cy - fy) * 12 + (cm - fm);
    c.m1 = elapsed >= 1 ? (c.m1 ?? 0) + (inCoverageAt(subs, addMonths(cohortKey, 1)) ? 1 : 0) : null;
    c.m3 = elapsed >= 3 ? (c.m3 ?? 0) + (inCoverageAt(subs, addMonths(cohortKey, 3)) ? 1 : 0) : null;
    c.m6 = elapsed >= 6 ? (c.m6 ?? 0) + (inCoverageAt(subs, addMonths(cohortKey, 6)) ? 1 : 0) : null;
    cohorts.set(cohortKey, c);

    // 月流失（近似）：上月月初在保、本月月初已不在保。
    if (inCoverageAt(subs, lastMonth)) {
      atRisk += 1;
      if (!inCoverageAt(subs, thisMonth)) churned += 1;
    }
  }

  // 收入：一次 SQL 聚合（替代分页 N 次往返；只统计订阅档位订单，排除点数充值）。
  const agg = await store.aggregateSubscriptionPaid([...subscriptionPlanIds]);
  const arpu = agg.payingUsers > 0 ? agg.totalAmount / agg.payingUsers : 0;

  return {
    newUsersToday,
    funnel: { registered, subscribed, renewed: agg.renewedUsers },
    retention: [...cohorts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, c]) => ({ month, users: c.users, m1: c.m1, m3: c.m3, m6: c.m6 })),
    revenue: {
      payingUsers: agg.payingUsers,
      totalAmount: Number(agg.totalAmount.toFixed(2)),
      arpu: Number(arpu.toFixed(2)),
      byChannel: agg.byChannel
        .map((c) => ({ channel: c.channel, count: c.count, amount: Number(c.amount.toFixed(2)) }))
        .sort((a, b) => b.amount - a.amount),
      byPlan: agg.byPlan
        .map((p) => ({ planId: p.planId, count: p.count, amount: Number(p.amount.toFixed(2)) }))
        .sort((a, b) => b.amount - a.amount),
    },
    churn: {
      monthlyChurnRate: atRisk > 0 ? Number((churned / atRisk).toFixed(4)) : null,
      avgLifetimeMonths: atRisk > 0 && churned > 0 ? Number((atRisk / churned).toFixed(2)) : null,
    },
  };
}

export interface AnalyticsEventsBlock {
  dau: number;
  mau: number;
  newUsersToday: number;
  retention: Array<{ date: string; users: number; d1: number | null; d7: number | null; d30: number | null }>;
  purchaseAttempts: { subscription: number; credit: number };
}

function dayKey(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 某日（Asia/Shanghai）的 00:00 对应 epoch ms。 */
function dayStartMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) - TZ_OFFSET_MS;
}

/** 解析事件 props（JSON 字符串）里的 kind：subscription / credit / unknown。 */
function eventKind(propsJson: string): "subscription" | "credit" | "unknown" {
  try {
    const p = JSON.parse(propsJson) as Record<string, unknown>;
    return p.kind === "subscription" ? "subscription" : p.kind === "credit" ? "credit" : "unknown";
  } catch {
    return "unknown";
  }
}

/** 计算 Phase 2 事件分析（DAU / MAU / 留存 cohort / 付费尝试）。读日聚合表，O(聚合行) 而非 O(明细)。 */
export async function computeEventAnalytics(store: HubStore): Promise<AnalyticsEventsBlock> {
  const now = Date.now();
  const dayMs = 86400_000;
  const today = dayKey(now);
  const fromDay = dayKey(now - 90 * dayMs); // 90 天窗口覆盖 D30 留存

  const daily = await store.listAnalyticsDaily(fromDay, today);
  const firstSeenRows = await store.listAnalyticsFirstSeen();

  // 活跃日集合（按聚合行累加）。
  const activeDays = new Map<number, Set<string>>();
  for (const d of daily) {
    let days = activeDays.get(d.userId);
    if (!days) {
      days = new Set();
      activeDays.set(d.userId, days);
    }
    days.add(d.day);
  }

  const firstSeen = new Map<number, string>();
  for (const f of firstSeenRows) firstSeen.set(f.userId, f.firstDay);

  const dau = [...activeDays.values()].filter((d) => d.has(today)).length;

  const thirtyDaysAgo = dayKey(now - 30 * dayMs);
  const mau = new Set<number>();
  for (const [uid, days] of activeDays) {
    for (const d of days) {
      if (d >= thirtyDaysAgo) {
        mau.add(uid);
        break;
      }
    }
  }

  const newUsersToday = [...firstSeen.values()].filter((d) => d === today).length;

  // 付费尝试（purchase_start）按 kind 细分：订阅 vs 点数充值（低频事件，读明细）。
  const purchaseAttempts = { subscription: 0, credit: 0 };
  const purchaseEvents = await store.listAnalyticsEvents(now - 30 * dayMs, now, "purchase_start");
  for (const e of purchaseEvents) {
    const kind = eventKind(e.props);
    if (kind === "subscription") purchaseAttempts.subscription += 1;
    else if (kind === "credit") purchaseAttempts.credit += 1;
  }

  const addDays = (key: string, n: number): string => dayKey(dayStartMs(key) + n * dayMs);
  const cohorts = new Map<string, { users: number; d1: number | null; d7: number | null; d30: number | null }>();
  for (const [uid, fDay] of firstSeen) {
    const days = activeDays.get(uid);
    if (days === undefined) continue; // 老用户（90 天窗口内无活跃）不进 cohort
    const c = cohorts.get(fDay) ?? { users: 0, d1: 0, d7: 0, d30: 0 };
    c.users += 1;
    // 目标日须落在 [fromDay, today] 内才可测：未来 → null，早于窗口（activeDays 只载 90 天）→ null，对称避免误导性 0%。
    const d1Day = addDays(fDay, 1);
    const d7Day = addDays(fDay, 7);
    const d30Day = addDays(fDay, 30);
    c.d1 = d1Day >= fromDay && d1Day <= today ? (c.d1 ?? 0) + (days.has(d1Day) ? 1 : 0) : null;
    c.d7 = d7Day >= fromDay && d7Day <= today ? (c.d7 ?? 0) + (days.has(d7Day) ? 1 : 0) : null;
    c.d30 = d30Day >= fromDay && d30Day <= today ? (c.d30 ?? 0) + (days.has(d30Day) ? 1 : 0) : null;
    cohorts.set(fDay, c);
  }

  return {
    dau,
    mau: mau.size,
    newUsersToday,
    purchaseAttempts,
    retention: [...cohorts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-30)
      .map(([date, c]) => ({ date, users: c.users, d1: c.d1, d7: c.d7, d30: c.d30 })),
  };
}
