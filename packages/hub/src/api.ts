/**
 * api.ts — 层 1 hub 对外 API（契约见 req R5，错误统一 {error:{code,message}}）。
 *
 * 认证：`Authorization: Bearer <access>` 或 Cookie `rdsh_session`（HttpOnly）。
 * 无开放注册端点（账号由 `rdsh hub user add` 创建，防 bot/垃圾注入）。
 */
import { randomInt, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubConfig, PlanSpec } from "./config.ts";
import { BILLING_DEFAULTS } from "./config.ts";
import type { HubDb, UserRow } from "./db.ts";
import type { HubAuth } from "./auth.ts";
import { createLoginLimiter, hashPassword, verifyPassword, ADMIN_TTL_MS } from "./auth.ts";
import type { TunnelRegistry } from "./tunnel.ts";
import type { EventHub } from "./events.ts";
import { randomToken, sha256 } from "./jwt.ts";
import { createEmailSender } from "./email/index.ts";
import type { EmailSender } from "./email/index.ts";
import { createSmsSender } from "./sms/index.ts";
import type { SmsSender } from "./sms/index.ts";
import { createPaymentProvider, verifyWechatCallback, decryptWechatResource, getWechatOpenid } from "./billing/index.ts";
import { createChallenge, verifyChallenge } from "./captcha.ts";
import { verifyCaptchaParam } from "./captcha/aliyun.ts";
import { DailyWindowLimiter } from "./ratelimit.ts";
import { clearHostCookie } from "./server.ts";
import { AdminError } from "./admin.ts";
import type { AdminCtx } from "./admin.ts";
import * as admin from "./admin.ts";

export const SESSION_COOKIE = "rdsh_session";
export const OPENID_COOKIE = "rdsh_openid";
export const ADMIN_COOKIE = "rdsh_admin_session";
const HUB_VERSION = "0.4.0";
const JOIN_TOKEN_DEFAULT_TTL = 30 * 24 * 3600; // join token 默认 30 天（秒）
const JOIN_TOKEN_MAX_TTL = 365 * 24 * 3600; // join token 上限 1 年（秒）
const REGISTER_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 }; // register 未认证端点：10 次/分钟/IP

export interface HubRuntime {
  config: HubConfig;
  db: HubDb;
  auth: HubAuth;
  tunnels: TunnelRegistry;
  events: EventHub;
}

export interface AuthResult {
  userId: number;
  name: string;
}

/** 认证：Authorization: Bearer 或 Cookie。 */
export function authenticate(req: IncomingMessage, runtime: HubRuntime): AuthResult | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    const v = runtime.auth.verifyAccess(token);
    return v === null ? null : { userId: v.user.id, name: v.user.name };
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies[SESSION_COOKIE];
  if (typeof session === "string" && session.length > 0) {
    const v = runtime.auth.verifyAccess(session);
    return v === null ? null : { userId: v.user.id, name: v.user.name };
  }
  return null;
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/** 客户端真实 IP（behindProxy 时取 XFF，仅连接来自回环时信任 —— 防伪造）。 */
export function clientIp(req: IncomingMessage, runtime: HubRuntime): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (runtime.config.behindProxy && (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      return xff.split(",")[0]!.trim();
    }
  }
  return remote;
}

/** 管理面会话认证：读 rdsh_admin_session cookie → verifyAdminAccess（独立短效会话）。 */
export function authenticateAdmin(req: IncomingMessage, runtime: HubRuntime): { userId: number; name: string; role: string } | null {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[ADMIN_COOKIE];
  if (typeof token !== "string" || token.length === 0) return null;
  const v = runtime.auth.verifyAdminAccess(token);
  return v === null ? null : { userId: v.user.id, name: v.user.name, role: v.user.role };
}

/** admin 服务层错误 → HTTP 状态映射。 */
function writeAdminError(res: ServerResponse, err: unknown): void {
  if (err instanceof AdminError) {
    const status = err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : 400;
    writeError(res, status, err.code, err.message);
    return;
  }
  writeError(res, 500, "INTERNAL", "internal error");
}

/** 读必需 reason 字段（危险操作必填）。 */
function requireReason(body: Record<string, unknown> | null): string | null {
  return body !== null && typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : null;
}

function adminSessionCookie(token: string): string {
  return `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ADMIN_TTL_MS / 1000)}`;
}

/** 管理面 API：/api/admin/*（守卫链：admin 会话 → role → 服务层 RBAC + 审计）。 */
export async function handleAdminApi(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (!path.startsWith("/api/admin/")) return false;

  // 登录：正常会话 + TOTP → 签发 admin 短会话（强制 2FA，req R2）
  if (path === "/api/admin/login" && method === "POST") {
    const auth = authenticate(req, runtime);
    if (auth === null) {
      writeError(res, 401, "UNAUTHORIZED", "sign in required");
      return true;
    }
    const body = await readJsonBody(req);
    const totp = typeof body?.totp === "string" ? body.totp : "";
    const token = runtime.auth.issueAdminSession(auth.userId, totp);
    if (token === null) {
      writeError(res, 403, "TOTP_REQUIRED", "admin console requires 2FA enabled and a valid TOTP code");
      return true;
    }
    res.writeHead(200, { "content-type": "application/json", "set-cookie": adminSessionCookie(token) });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (path === "/api/admin/logout" && method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": `${ADMIN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // 其余端点：admin 会话守卫
  const auth = authenticateAdmin(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "admin session required");
    return true;
  }
  const ctx: AdminCtx = { actorId: auth.userId, role: auth.role, ip: clientIp(req, runtime) };
  const db = runtime.db;

  // ---- 读端点（readonly 可读） ----
  if (path === "/api/admin/me" && method === "GET") {
    res.end(JSON.stringify({ userId: auth.userId, name: auth.name, role: auth.role }));
    return true;
  }
  if (path === "/api/admin/dashboard" && method === "GET") {
    const users = db.listUsers();
    const hosts = db.listAllHosts();
    const online = hosts.filter((h) => runtime.tunnels.isOnline(h.id)).length;
    let dbSize = -1;
    try {
      if (db.path !== ":memory:") dbSize = statSync(db.path).size;
    } catch {
      /* 忽略 */
    }
    res.end(
      JSON.stringify({
        totalUsers: users.length,
        totalHosts: hosts.length,
        onlineHosts: online,
        tunnelCount: runtime.tunnels.list().length,
        subscribed: users.filter((u) => u.planStatus === "subscribed").length,
        dbSize,
        uptimeSeconds: Math.floor(process.uptime()),
        version: HUB_VERSION,
      }),
    );
    return true;
  }
  if (path === "/api/admin/users" && method === "GET") {
    res.end(JSON.stringify({ users: admin.listUsers(db) }));
    return true;
  }
  if (path === "/api/admin/hosts" && method === "GET") {
    const hosts = admin.listHosts(db).map((h) => ({ ...h, online: runtime.tunnels.isOnline(h.id) }));
    res.end(JSON.stringify({ hosts }));
    return true;
  }
  if (path === "/api/admin/orders" && method === "GET") {
    res.end(JSON.stringify({ orders: admin.listOrders(db) }));
    return true;
  }
  if (path === "/api/admin/payments" && method === "GET") {
    res.end(JSON.stringify({ payments: admin.listPayments(db) }));
    return true;
  }
  if (path === "/api/admin/audit" && method === "GET") {
    const userId = url.searchParams.get("userId");
    const event = url.searchParams.get("event") ?? undefined;
    const since = url.searchParams.get("since");
    const source = url.searchParams.get("source") ?? undefined;
    const rows = admin.listAudit(db, {
      userId: userId !== null && userId !== "" ? Number(userId) : undefined,
      event,
      since: since !== null && since !== "" ? Number(since) : undefined,
      source,
    });
    res.end(JSON.stringify({ events: rows }));
    return true;
  }
  if (path === "/api/admin/audit.csv" && method === "GET") {
    const rows = admin.listAudit(db);
    const lines = ["id,created_at,user_id,event,source,detail"];
    for (const r of rows) {
      lines.push([r.id, r.createdAt, r.userId ?? "", r.event, r.source, r.detailJson.replace(/"/g, '""')].map((c) => `"${c}"`).join(","));
    }
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    res.end(lines.join("\n"));
    return true;
  }
  if (path === "/api/admin/health" && method === "GET") {
    const hosts = db.listAllHosts();
    const online = hosts.filter((h) => runtime.tunnels.isOnline(h.id)).length;
    let dbSize = -1;
    try {
      if (db.path !== ":memory:") dbSize = statSync(db.path).size;
    } catch {
      /* 忽略 */
    }
    res.end(
      JSON.stringify({
        uptimeSeconds: Math.floor(process.uptime()),
        tunnelCount: runtime.tunnels.list().length,
        onlineHosts: online,
        dbSize,
        version: HUB_VERSION,
      }),
    );
    return true;
  }
  if (path === "/api/admin/config" && method === "GET") {
    const c = runtime.config;
    res.end(
      JSON.stringify({
        registration: c.registration ?? "closed",
        emailEnabled: c.email !== undefined,
        smsEnabled: c.sms !== undefined,
        captchaProvider: c.captcha?.provider ?? "arithmetic",
        e2eeMode: c.e2ee?.mode ?? "optional",
        plans: c.billing?.plans ?? [],
        site: c.site ?? {},
      }),
    );
    return true;
  }
  if (path === "/api/admin/admins" && method === "GET") {
    const admins = db.listUsers().filter((u) => u.role !== "user").map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
    res.end(JSON.stringify({ admins }));
    return true;
  }

  // ---- 用户详情 ----
  const userDetail = /^\/api\/admin\/users\/([^/]+)$/.exec(path);
  if (userDetail !== null && method === "GET") {
    const id = Number(decodeURIComponent(userDetail[1]!));
    const user = admin.getUser(db, id);
    if (user === null) {
      writeError(res, 404, "NOT_FOUND", "user not found");
      return true;
    }
    const events = db.listAudit({ userId: id });
    res.end(JSON.stringify({ user, audit: events }));
    return true;
  }

  // ---- 写端点（服务层 RBAC + 审计） ----
  const userAction = /^\/api\/admin\/users\/([^/]+)\/(ban|unban|reset-password|unlock|reset-2fa|plan|delete)$/.exec(path);
  if (userAction !== null && method === "POST") {
    const id = Number(decodeURIComponent(userAction[1]!));
    const action = userAction[2]!;
    const body = await readJsonBody(req);
    try {
      if (action === "ban") admin.banUser(db, ctx, id, requireReason(body) ?? "no reason");
      else if (action === "unban") admin.unbanUser(db, ctx, id, requireReason(body) ?? "no reason");
      else if (action === "unlock") admin.unlockUser(db, ctx, id, requireReason(body) ?? "no reason");
      else if (action === "reset-2fa") admin.resetUser2fa(db, ctx, id, requireReason(body) ?? "no reason");
      else if (action === "delete") admin.deleteUser(db, ctx, id, requireReason(body) ?? "no reason");
      else if (action === "reset-password") {
        if (body === null || typeof body.password !== "string" || body.password.length < 8) {
          writeError(res, 400, "BAD_REQUEST", "password must be >= 8 chars");
          return true;
        }
        await admin.resetUserPassword(db, ctx, id, body.password, requireReason(body) ?? "no reason");
      } else if (action === "plan") {
        if (body === null || typeof body.planStatus !== "string") {
          writeError(res, 400, "BAD_REQUEST", "planStatus required");
          return true;
        }
        const expiresAtMs = typeof body.expiresAtMs === "number" ? body.expiresAtMs : null;
        admin.adjustPlan(db, ctx, id, body.planStatus, expiresAtMs, requireReason(body) ?? "no reason");
      }
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      writeAdminError(res, err);
    }
    return true;
  }

  const hostRevoke = /^\/api\/admin\/hosts\/([^/]+)\/revoke$/.exec(path);
  if (hostRevoke !== null && method === "POST") {
    const hostId = decodeURIComponent(hostRevoke[1]!);
    const body = await readJsonBody(req);
    try {
      const conn = runtime.tunnels.get(hostId);
      if (conn !== null) conn.terminate(); // 即时断隧道（req R6）
      admin.revokeHost(db, ctx, hostId, requireReason(body) ?? "no reason");
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      writeAdminError(res, err);
    }
    return true;
  }

  const orderRefund = /^\/api\/admin\/orders\/([^/]+)\/refund$/.exec(path);
  if (orderRefund !== null && method === "POST") {
    const orderId = decodeURIComponent(orderRefund[1]!);
    const body = await readJsonBody(req);
    try {
      admin.refundOrder(db, ctx, orderId, requireReason(body) ?? "no reason");
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      writeAdminError(res, err);
    }
    return true;
  }

  if (path === "/api/admin/credit" && method === "POST") {
    const body = await readJsonBody(req);
    try {
      if (body === null || typeof body.userId !== "number" || typeof body.planId !== "string" || typeof body.amountCny !== "number" || typeof body.expiresAtMs !== "number") {
        writeError(res, 400, "BAD_REQUEST", "userId/planId/amountCny/expiresAtMs required");
        return true;
      }
      const orderId = admin.creditOrder(db, ctx, { userId: body.userId, planId: body.planId, amountCny: body.amountCny, expiresAtMs: body.expiresAtMs }, requireReason(body) ?? "no reason");
      res.end(JSON.stringify({ ok: true, orderId }));
    } catch (err) {
      writeAdminError(res, err);
    }
    return true;
  }

  const adminAction = /^\/api\/admin\/admins\/([^/]+)\/(role|remove)$/.exec(path);
  if (adminAction !== null && method === "POST") {
    const id = Number(decodeURIComponent(adminAction[1]!));
    const action = adminAction[2]!;
    const body = await readJsonBody(req);
    try {
      if (action === "role") {
        if (body === null || typeof body.role !== "string") {
          writeError(res, 400, "BAD_REQUEST", "role required");
          return true;
        }
        admin.setUserRole(db, ctx, id, body.role, requireReason(body) ?? "no reason");
      } else {
        admin.removeAdmin(db, ctx, id, requireReason(body) ?? "no reason");
      }
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      writeAdminError(res, err);
    }
    return true;
  }

  writeError(res, 404, "NOT_FOUND", "unknown admin endpoint");
  return true;
}

/** 主入口：处理 /api/*（含 /api/auth/*）；返回是否已处理。 */
export async function handleApi(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  if (!url.pathname.startsWith("/api/")) return false;

  const path = url.pathname;
  const method = req.method ?? "GET";

  // ---- 管理面 API（/api/admin/*，独立守卫链） ----
  if (path.startsWith("/api/admin/")) {
    await handleAdminApi(req, res, runtime);
    return true;
  }

  // ---- 认证端点 ----
  if (path === "/api/capabilities" && method === "GET") {
    await handleCapabilities(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/login" && method === "POST") {
    await handleLogin(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/first-password" && method === "POST") {
    await handleFirstPassword(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/refresh" && method === "POST") {
    await handleRefresh(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/logout" && method === "POST") {
    await handleLogout(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/password" && method === "POST") {
    await handlePassword(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/register" && method === "POST") {
    await handleAccountRegister(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/register/resend" && method === "POST") {
    await handleAccountResend(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/verify" && method === "POST") {
    await handleAccountVerify(req, res, runtime);
    return true;
  }
  // ---- M5：2FA / 验证码 / 找回密码 / 邮箱 ----
  if (path === "/api/auth/totp" && method === "POST") {
    await handleTotpLogin(req, res, runtime);
    return true;
  }
  if (path === "/api/captcha/arithmetic" && method === "POST") {
    await handleCaptchaChallenge(req, res, runtime);
    return true;
  }
  if (path === "/api/captcha/config" && method === "GET") {
    const provider = runtime.config.captcha?.provider ?? "arithmetic";
    const sceneId = provider === "aliyun" ? runtime.config.captcha?.aliyun?.sceneId : undefined;
    const prefix = provider === "aliyun" ? runtime.config.captcha?.aliyun?.prefix : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ provider, sceneId, prefix }));
    return true;
  }
  if (path === "/api/auth/password/reset" && method === "POST") {
    await handleResetRequest(req, res, runtime);
    return true;
  }
  if (path === "/api/auth/password/reset/confirm" && method === "POST") {
    await handleResetConfirm(req, res, runtime);
    return true;
  }
  if (path === "/api/account/email" && method === "POST") {
    await handleBindEmail(req, res, runtime);
    return true;
  }
  if (path === "/api/account/email/verify" && method === "POST") {
    await handleVerifyEmail(req, res, runtime);
    return true;
  }
  if (path === "/api/account/email/unbind" && method === "POST") {
    await handleUnbindEmail(req, res, runtime);
    return true;
  }
  if (path === "/api/account/phone" && method === "POST") {
    await handleBindPhone(req, res, runtime);
    return true;
  }
  if (path === "/api/account/phone/verify" && method === "POST") {
    await handleVerifyPhone(req, res, runtime);
    return true;
  }
  if (path === "/api/account/phone/unbind" && method === "POST") {
    await handleUnbindPhone(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/plans" && method === "GET") {
    await handleBillingPlans(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/subscribe" && method === "POST") {
    await handleSubscribe(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/subscription" && method === "GET") {
    await handleSubscription(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/cancel" && method === "POST") {
    await handleCancelSubscription(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/callback" && method === "POST") {
    await handleBillingCallback(req, res, runtime);
    return true;
  }
  if (path === "/api/wechat/oauth/authorize" && method === "GET") {
    await handleWechatOauthAuthorize(req, res, runtime);
    return true;
  }
  if (path === "/api/wechat/oauth/callback" && method === "GET") {
    await handleWechatOauthCallback(req, res, runtime);
    return true;
  }
  if (path === "/api/account" && method === "GET") {
    await handleAccountInfo(req, res, runtime);
    return true;
  }
  if (path === "/api/account" && method === "DELETE") {
    await handleDeleteAccount(req, res, runtime);
    return true;
  }
  if (path === "/api/account/2fa/enable" && method === "POST") {
    await handleEnable2fa(req, res, runtime);
    return true;
  }
  if (path === "/api/account/2fa/verify" && method === "POST") {
    await handleActivate2fa(req, res, runtime);
    return true;
  }
  if (path === "/api/account/2fa/disable" && method === "POST") {
    await handleDisable2fa(req, res, runtime);
    return true;
  }

  // ---- host 端点 ----
  if (path === "/api/hosts" && method === "GET") {
    await handleListHosts(req, res, runtime);
    return true;
  }
  if (path === "/api/hosts/self-revoke" && method === "POST") {
    await handleSelfRevoke(req, res, runtime);
    return true;
  }
  if (path === "/api/hosts/register" && method === "POST") {
    await handleRegister(req, res, runtime);
    return true;
  }
  if (path === "/api/hosts/join-token" && method === "POST") {
    await handleCreateJoinToken(req, res, runtime);
    return true;
  }
  if (path === "/api/hosts/join-tokens" && method === "GET") {
    await handleListJoinTokens(req, res, runtime);
    return true;
  }
  const joinTokenMatch = /^\/api\/hosts\/join-tokens\/([^/]+)$/.exec(path);
  if (joinTokenMatch !== null && method === "DELETE") {
    await handleRevokeJoinToken(req, res, runtime, decodeURIComponent(joinTokenMatch[1]!));
    return true;
  }
  const shareMatch = /^\/api\/hosts\/([^/]+)\/share(?:\/([^/]+))?$/.exec(path);
  if (shareMatch !== null) {
    const hostId = decodeURIComponent(shareMatch[1]!);
    if (method === "POST") {
      await handleShareHost(req, res, runtime, hostId);
      return true;
    }
    if (method === "GET") {
      await handleListShares(req, res, runtime, hostId);
      return true;
    }
    if (method === "DELETE" && shareMatch[2] !== undefined) {
      await handleRevokeShare(req, res, runtime, hostId, decodeURIComponent(shareMatch[2]));
      return true;
    }
  }
  const hostMatch = /^\/api\/hosts\/([^/]+)$/.exec(path);
  if (hostMatch !== null) {
    const hostId = decodeURIComponent(hostMatch[1]!);
    if (method === "PATCH") {
      await handleRenameHost(req, res, runtime, hostId);
      return true;
    }
    if (method === "DELETE") {
      await handleRevokeHost(req, res, runtime, hostId);
      return true;
    }
  }

  writeError(res, 404, "NOT_FOUND", `no such endpoint: ${method} ${path}`);
  return true;
}

/** 公开客户端能力：注册开关/通道可用性（注册页、找回密码页显隐入口用，未认证）。 */
async function handleCapabilities(_req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      registration: runtime.config.registration ?? "closed",
      emailEnabled: runtime.config.email !== undefined,
      smsEnabled: runtime.config.sms !== undefined,
      captchaProvider: runtime.config.captcha?.provider ?? "arithmetic",
      beian: runtime.config.beian ?? {},
      site: runtime.config.site ?? {},
    }),
  );
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const ip = clientIp(req, runtime);
  let limiter = loginLimiters.get(ip);
  if (limiter === undefined) {
    limiter = createLoginLimiter();
    loginLimiters.set(ip, limiter);
  }
  const lockedMs = limiter.allow(ip);
  if (lockedMs > 0) {
    writeError(res, 429, "RATE_LIMITED", "too many attempts", lockedMs);
    return;
  }
  const body = await readJsonBody(req);
  const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : typeof body?.name === "string" ? body.name.trim() : "";
  if (body === null || identifier.length === 0 || typeof body.password !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  const loginName = resolveLoginName(runtime.db, identifier) ?? identifier;
  const result = await runtime.auth.login(loginName, body.password);
  switch (result.kind) {
    case "locked":
      limiter.clear(ip);
      runtime.db.recordAudit(null, "login.locked", { name: identifier }, ip);
      writeError(res, 423, "ACCOUNT_LOCKED", "account locked due to too many failures", result.lockedUntil - Date.now());
      return;
    case "bad-credentials": {
      const locked = limiter.fail(ip);
      runtime.db.recordAudit(null, "login.failed", { name: identifier }, ip);
      if (locked > 0) {
        writeError(res, 429, "RATE_LIMITED", "too many attempts", locked);
        return;
      }
      writeError(res, 401, "BAD_CREDENTIALS", "invalid username or password");
      return;
    }
    case "requires-totp":
      limiter.clear(ip);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requiresTotp: true, pendingToken: result.pendingToken, name: result.name }));
      return;
    case "ok": {
      limiter.clear(ip);
      const user = runtime.db.getUserByName(loginName);
      runtime.db.recordAudit(user?.id ?? null, "login.ok", {}, ip);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": sessionCookie(result.tokens.accessToken),
      });
      res.end(
        JSON.stringify({
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
          mustChangePassword: result.mustChangePassword,
          user: { id: user?.id, name: user?.name },
        }),
      );
      return;
    }
  }
}

async function handleFirstPassword(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  // 激活流程：--no-password 建号的用户首次设密码（仅 must_change=1 可用一次）
  const ip = clientIp(req, runtime);
  let limiter = loginLimiters.get(ip);
  if (limiter === undefined) {
    limiter = createLoginLimiter(5, 10 * 60 * 1000);
    loginLimiters.set(ip, limiter);
  }
  const lockedMs = limiter.allow(ip);
  if (lockedMs > 0) {
    writeError(res, 429, "RATE_LIMITED", "too many attempts", lockedMs);
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.name !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 8) {
    writeError(res, 400, "BAD_REQUEST", "invalid body (newPassword must be >= 8 chars)");
    return;
  }
  const result = await runtime.auth.firstPassword(body.name, body.newPassword);
  if (result === null) {
    limiter.fail(ip);
    writeError(res, 400, "NOT_ELIGIBLE", "user not found or already activated");
    return;
  }
  limiter.clear(ip);
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": sessionCookie(result.tokens.accessToken),
  });
  res.end(JSON.stringify(result.tokens));
}

/** register：双通道注册（email/+86 phone）→ 建 pending 用户 → 发验证码。 */
async function handleAccountRegister(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  if (runtime.config.registration !== "open") {
    writeError(res, 404, "REGISTRATION_DISABLED", "registration is disabled");
    return;
  }
  const ip = clientIp(req, runtime);
  const now = Date.now();
  const hit = accountRegisterRate.get(ip);
  if (hit !== undefined && now - hit.windowStart < REGISTER_RATE_LIMIT.windowMs) {
    if (hit.count >= REGISTER_RATE_LIMIT.max) {
      writeError(res, 429, "RATE_LIMITED", "too many register requests");
      return;
    }
    hit.count += 1;
  } else {
    accountRegisterRate.set(ip, { count: 1, windowStart: now });
  }
  const body = await readJsonBody(req);
  if (!(await verifyCaptchaBody(runtime, body))) {
    writeError(res, 400, "BAD_CAPTCHA", "captcha failed");
    return;
  }
  const channel = body?.channel;
  const password = typeof body?.password === "string" ? body.password : "";
  const rawId = typeof body?.identifier === "string" ? body.identifier : "";
  if (password.length < 8) {
    writeError(res, 400, "BAD_REQUEST", "password must be >= 8 chars");
    return;
  }
  let identifier: string | null;
  if (channel === "email") identifier = normalizeEmailStr(rawId);
  else if (channel === "phone") identifier = normalizeCnPhone(rawId);
  else {
    writeError(res, 400, "BAD_REQUEST", "channel must be email|phone");
    return;
  }
  if (identifier === null) {
    writeError(res, 400, "BAD_REQUEST", channel === "email" ? "invalid email" : "invalid phone (+86, 11 digits)");
    return;
  }

  const existing = runtime.db.getUserByName(identifier) ?? (channel === "email" ? runtime.db.getUserByEmail(identifier) : runtime.db.getUserByPhone(identifier));
  if (existing !== null && existing.accountStatus === "active") {
    writeError(res, 409, "ALREADY_EXISTS", "identifier already registered");
    return;
  }
  let user = existing;
  if (user === null) {
    user = runtime.db.createUser(identifier, await hashPassword(password));
    runtime.db.setAccountStatus(user.id, "pending");
    if (channel === "email") runtime.db.setEmail(user.id, identifier);
    else runtime.db.setPhone(user.id, identifier);
  }

  const r =
    channel === "email"
      ? await sendEmailCode(runtime, { purpose: "verify", email: identifier, userId: user.id, ip, subject: "remote-dsh email verification" })
      : await sendSmsCode(runtime, { purpose: "verify", phone: identifier, userId: user.id, ip });
  if (r === "disabled") writeError(res, 400, channel === "email" ? "EMAIL_DISABLED" : "SMS_DISABLED", "verification service not configured");
  else if (r === "limited" || r === "resend") writeError(res, 429, "RATE_LIMITED", r === "resend" ? "resend too soon" : "too many requests");
  else if (r === "error") writeError(res, 500, "SEND_FAILED", "failed to send code");
  else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
}

/** register/resend：重发验证码（未认证 + 限流）。 */
async function handleAccountResend(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  if (runtime.config.registration !== "open") {
    writeError(res, 404, "REGISTRATION_DISABLED", "registration is disabled");
    return;
  }
  const ip = clientIp(req, runtime);
  const body = await readJsonBody(req);
  if (!(await verifyCaptchaBody(runtime, body))) {
    writeError(res, 400, "BAD_CAPTCHA", "captcha failed");
    return;
  }
  const channel = body?.channel;
  const rawId = typeof body?.identifier === "string" ? body.identifier : "";
  let identifier: string | null;
  if (channel === "email") identifier = normalizeEmailStr(rawId);
  else if (channel === "phone") identifier = normalizeCnPhone(rawId);
  else {
    writeError(res, 400, "BAD_REQUEST", "channel must be email|phone");
    return;
  }
  if (identifier === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid identifier");
    return;
  }
  const user = runtime.db.getUserByName(identifier) ?? (channel === "email" ? runtime.db.getUserByEmail(identifier) : runtime.db.getUserByPhone(identifier));
  if (user === null || user.accountStatus === "active") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true })); // 统一响应（防枚举）
    return;
  }
  const r =
    channel === "email"
      ? await sendEmailCode(runtime, { purpose: "verify", email: identifier, userId: user.id, ip, subject: "remote-dsh email verification" })
      : await sendSmsCode(runtime, { purpose: "verify", phone: identifier, userId: user.id, ip });
  if (r === "disabled") writeError(res, 400, channel === "email" ? "EMAIL_DISABLED" : "SMS_DISABLED", "verification service not configured");
  else if (r === "limited" || r === "resend") writeError(res, 429, "RATE_LIMITED", r === "resend" ? "resend too soon" : "too many requests");
  else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
}

/** verify：验证码激活 → active + trial + 自动登录。 */
async function handleAccountVerify(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const body = await readJsonBody(req);
  const channel = body?.channel;
  const rawId = typeof body?.identifier === "string" ? body.identifier : "";
  const code = typeof body?.code === "string" ? body.code : "";
  let identifier: string | null;
  if (channel === "email") identifier = normalizeEmailStr(rawId);
  else if (channel === "phone") identifier = normalizeCnPhone(rawId);
  else {
    writeError(res, 400, "BAD_REQUEST", "channel must be email|phone");
    return;
  }
  if (identifier === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid identifier");
    return;
  }
  const user = runtime.db.getUserByName(identifier) ?? (channel === "email" ? runtime.db.getUserByEmail(identifier) : runtime.db.getUserByPhone(identifier));
  if (user === null) {
    writeError(res, 400, "BAD_CODE", "invalid or expired code"); // 防枚举
    return;
  }
  const ok = channel === "email" ? verifyEmailCode(runtime.db, identifier, "verify", code) : verifySmsCode(runtime.db, identifier, "verify", code);
  if (!ok) {
    writeError(res, 400, "BAD_CODE", "invalid or expired code");
    return;
  }
  if (user.accountStatus === "pending") {
    runtime.db.setAccountStatus(user.id, "active");
    if (channel === "email") runtime.db.setEmailVerified(user.id);
    else runtime.db.setPhoneVerified(user.id);
    const trialDays = runtime.config.billing?.trialDays ?? BILLING_DEFAULTS.trialDays;
    const now = Date.now();
    runtime.db.startTrial(user.id, now, now + trialDays * 24 * 3600 * 1000);
    runtime.db.recordAudit(user.id, "register.verified", { channel }, clientIp(req, runtime));
  }
  const tokens = runtime.auth.issueSession(user.id);
  if (tokens === null) {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "set-cookie": sessionCookie(tokens.accessToken) });
  res.end(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: user.id, name: user.name } }));
}

async function handleRefresh(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null || typeof body.refreshToken !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  const pair = runtime.auth.refresh(body.refreshToken);
  if (pair === null) {
    writeError(res, 401, "INVALID_REFRESH", "refresh token invalid or revoked");
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": sessionCookie(pair.accessToken),
  });
  res.end(JSON.stringify(pair));
}

async function handleLogout(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const body = await readJsonBody(req);
  if (body !== null && typeof body.refreshToken === "string") {
    runtime.auth.logout(body.refreshToken);
  }
  // 清除访问令牌 cookie（httpOnly，客户端无法自行删除）+ host 转发 cookie：
  // 否则登出后 access JWT（1h）仍可认证 /api/*，根路径仍会直接转发进 host。
  res.writeHead(204, {
    "set-cookie": [`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, clearHostCookie()],
  });
  res.end();
}

async function handlePassword(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  if (
    body === null ||
    typeof body.currentPassword !== "string" ||
    typeof body.newPassword !== "string" ||
    body.newPassword.length < 8
  ) {
    writeError(res, 400, "BAD_REQUEST", "invalid body (newPassword must be >= 8 chars)");
    return;
  }
  const ok = await runtime.auth.changePassword(auth.userId, body.currentPassword, body.newPassword);
  if (!ok) {
    writeError(res, 400, "BAD_CREDENTIALS", "current password incorrect");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: "password updated; all sessions revoked" }));
}

async function handleListHosts(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const hosts = runtime.db.listHostsForUser(auth.userId);
  const out = hosts.map((h) => ({
    id: h.id,
    name: h.name,
    online: runtime.tunnels.isOnline(h.id),
    createdAt: h.createdAt,
    role: h.ownerId === auth.userId ? "owner" : "member",
    e2eePublicKey: h.e2eePublicKey,
  }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hosts: out }));
}

const loginLimiters = new Map<string, ReturnType<typeof createLoginLimiter>>();
const SELF_REVOKE_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 }; // 未认证端点：10 次/分钟/IP
const selfRevokeRate = new Map<string, { count: number; windowStart: number }>();
const registerRate = new Map<string, { count: number; windowStart: number }>();
const accountRegisterRate = new Map<string, { count: number; windowStart: number }>();

async function handleRenameHost(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, hostId: string): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const host = runtime.db.getHostById(hostId);
  if (host === null || host.ownerId !== auth.userId) {
    writeError(res, 403, "FORBIDDEN", "host not owned by you");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.name !== "string" || body.name.length === 0 || body.name.length > 64) {
    writeError(res, 400, "BAD_REQUEST", "invalid name (1-64 chars)");
    return;
  }
  runtime.db.renameHost(hostId, body.name);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, name: body.name }));
}

async function handleRevokeHost(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, hostId: string): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const host = runtime.db.getHostById(hostId);
  if (host === null || host.ownerId !== auth.userId) {
    writeError(res, 403, "FORBIDDEN", "host not owned by you");
    return;
  }
  revokeHost(runtime, hostId, auth.userId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, revoked: hostId }));
}

/** 删除 host + 断隧道 + 摘注册表 + 推送 offline（用户吊销 / host 自吊销共用）。 */
function revokeHost(runtime: HubRuntime, hostId: string, ownerId: number): void {
  runtime.db.removeHost(hostId);
  const conn = runtime.tunnels.get(hostId);
  if (conn !== null) conn.terminate();
  runtime.tunnels.unregister(hostId);
  runtime.events.pushToUser(ownerId, { type: "host.offline", hostId });
}

/** host 自吊销：持自己的 host token 注销（未认证端点，IP 限流）。`rdsh host leave` 调用。 */
async function handleSelfRevoke(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const ip = clientIp(req, runtime);
  const now = Date.now();
  const hit = selfRevokeRate.get(ip);
  if (hit !== undefined && now - hit.windowStart < SELF_REVOKE_RATE_LIMIT.windowMs) {
    if (hit.count >= SELF_REVOKE_RATE_LIMIT.max) {
      writeError(res, 429, "RATE_LIMITED", "too many self-revoke requests");
      return;
    }
    hit.count += 1;
  } else {
    selfRevokeRate.set(ip, { count: 1, windowStart: now });
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.token !== "string" || body.token.length < 16) {
    writeError(res, 400, "BAD_REQUEST", "invalid body (token required)");
    return;
  }
  const host = runtime.db.findHostByTokenHash(sha256(body.token));
  if (host === null) {
    writeError(res, 401, "UNAUTHORIZED", "host token not found");
    return;
  }
  revokeHost(runtime, host.id, host.ownerId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, revoked: host.id }));
}

/** 创建用户级 join token（需登录）：{label?, ttlSeconds?} → 返回明文一次，服务端只存 SHA-256。 */
async function handleCreateJoinToken(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const label = typeof body?.label === "string" && body.label.length > 0 ? body.label.slice(0, 64) : null;
  let ttlSeconds = JOIN_TOKEN_DEFAULT_TTL;
  if (body?.ttlSeconds !== undefined) {
    if (!Number.isInteger(body.ttlSeconds) || (body.ttlSeconds as number) <= 0 || (body.ttlSeconds as number) > JOIN_TOKEN_MAX_TTL) {
      writeError(res, 400, "BAD_REQUEST", `ttlSeconds must be 1..${JOIN_TOKEN_MAX_TTL}`);
      return;
    }
    ttlSeconds = body.ttlSeconds as number;
  }
  const id = randomUUID();
  const token = randomToken();
  const expiresAt = Date.now() + ttlSeconds * 1000;
  runtime.db.createJoinToken(id, label, auth.userId, sha256(token), expiresAt);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id, token, expiresAt }));
}

/** join token 列表（需登录，仅 owner）。 */
async function handleListJoinTokens(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const tokens = runtime.db.listJoinTokens(auth.userId).map((t) => ({
    id: t.id,
    label: t.label,
    fingerprint: `${t.tokenHash.slice(0, 6)}…${t.tokenHash.slice(-4)}`,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    revoked: t.revoked === 1,
  }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ tokens }));
}

/** 吊销 join token（需登录，仅 owner）→ 只阻止未来注册，已注册主机不受影响。 */
async function handleRevokeJoinToken(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, id: string): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const token = runtime.db.getJoinTokenById(id);
  if (token === null || token.ownerId !== auth.userId) {
    writeError(res, 403, "FORBIDDEN", "not owned by you");
    return;
  }
  runtime.db.revokeJoinToken(id);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, revoked: id }));
}

/** register：gateway 持 join token 注册（未认证 + IP 限流）→ 建 host → 返回 host token。 */
async function handleRegister(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const ip = clientIp(req, runtime);
  const now = Date.now();
  const hit = registerRate.get(ip);
  if (hit !== undefined && now - hit.windowStart < REGISTER_RATE_LIMIT.windowMs) {
    if (hit.count >= REGISTER_RATE_LIMIT.max) {
      writeError(res, 429, "RATE_LIMITED", "too many register requests");
      return;
    }
    hit.count += 1;
  } else {
    registerRate.set(ip, { count: 1, windowStart: now });
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.token !== "string" || body.token.length < 16) {
    writeError(res, 400, "BAD_REQUEST", "invalid body (token required)");
    return;
  }
  const name = typeof body.name === "string" && body.name.length > 0 ? body.name.slice(0, 64) : undefined;
  const hash = sha256(body.token);

  // 1) 已是 host token → 幂等返回（兼容旧 --token <hostToken>）
  const existing = runtime.db.findHostByTokenHash(hash);
  if (existing !== null) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hostId: existing.id, hostToken: body.token }));
    return;
  }
  // 2) join token → 校验 + 建 host（账号配额检查点，SaaS）
  const jt = runtime.db.getJoinTokenByHash(hash);
  if (jt === null || jt.revoked === 1 || jt.expiresAt <= now) {
    writeError(res, 401, "UNAUTHORIZED", "join token invalid, expired, or revoked");
    return;
  }
  const owner = runtime.db.getUserById(jt.ownerId);
  if (owner !== null) {
    const quota = hostQuota(runtime, owner);
    if (quota !== null && runtime.db.listHostsByOwner(owner.id).length >= quota) {
      writeError(res, 403, "QUOTA_EXCEEDED", "host quota exceeded for current plan");
      return;
    }
  }
  const hostId = randomUUID();
  const hostToken = randomToken();
  const e2eePublicKey = typeof body.e2eePublicKey === "string" && body.e2eePublicKey.length > 0 ? body.e2eePublicKey.slice(0, 256) : undefined;
  runtime.db.createHost(hostId, jt.ownerId, name ?? `host-${hostId.slice(0, 8)}`, sha256(hostToken), e2eePublicKey);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hostId, hostToken }));
}

function sessionCookie(accessToken: string): string {
  return `${SESSION_COOKIE}=${accessToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`;
}

// ---- M5：邮件/验证码/2FA/共享 ----

const PIN_TTL_MS = 10 * 60 * 1000;
const RESEND_WINDOW_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const UNBIND_LOCK_MS = 24 * 3600 * 1000;

const emailSenders = new WeakMap<HubRuntime, EmailSender | null>();
function getEmailSender(runtime: HubRuntime): EmailSender | null {
  if (!emailSenders.has(runtime)) emailSenders.set(runtime, createEmailSender(runtime.config.email));
  return emailSenders.get(runtime)!;
}

const emailLimiters = new WeakMap<HubRuntime, { recipient: DailyWindowLimiter; ip: DailyWindowLimiter; user: DailyWindowLimiter; global: DailyWindowLimiter }>();
function getEmailLimiters(runtime: HubRuntime) {
  let l = emailLimiters.get(runtime);
  if (l === undefined) {
    const sec = runtime.config.security ?? { emailDailyLimit: 5, globalEmailDailyLimit: 200, loginLockThreshold: 10, loginLockMinutes: 15, auditRetentionDays: 90 };
    l = {
      recipient: new DailyWindowLimiter(sec.emailDailyLimit),
      ip: new DailyWindowLimiter(3),
      user: new DailyWindowLimiter(5),
      global: new DailyWindowLimiter(sec.globalEmailDailyLimit),
    };
    emailLimiters.set(runtime, l);
  }
  return l;
}

// ---- 08-saas：SmsSender 抽象 + 短信限流 ----

const SMS_PER_PHONE_DAILY = 3; // 每手机号每日 ≤3 条（比 email 更严，短信有成本）
const smsSenders = new WeakMap<HubRuntime, SmsSender | null>();
function getSmsSender(runtime: HubRuntime): SmsSender | null {
  if (!smsSenders.has(runtime)) smsSenders.set(runtime, createSmsSender(runtime.config.sms));
  return smsSenders.get(runtime)!;
}

const smsLimiters = new WeakMap<HubRuntime, { phone: DailyWindowLimiter; ip: DailyWindowLimiter; global: DailyWindowLimiter }>();
function getSmsLimiters(runtime: HubRuntime) {
  let l = smsLimiters.get(runtime);
  if (l === undefined) {
    l = { phone: new DailyWindowLimiter(SMS_PER_PHONE_DAILY), ip: new DailyWindowLimiter(5), global: new DailyWindowLimiter(200) };
    smsLimiters.set(runtime, l);
  }
  return l;
}

/** 生成并发送验证码/重置码（含限流 + 审计）。返回状态。 */
async function sendEmailCode(
  runtime: HubRuntime,
  opts: { purpose: "verify" | "reset"; email: string; userId: number; ip: string; subject: string },
): Promise<"sent" | "disabled" | "limited" | "resend" | "error"> {
  const sender = getEmailSender(runtime);
  if (sender === null) return "disabled";
  const limiters = getEmailLimiters(runtime);
  const last = runtime.db.getEmailCodeByEmail(opts.email, opts.purpose);
  if (last !== null && last.createdAt > Date.now() - RESEND_WINDOW_MS) return "resend";

  if (opts.purpose === "reset") {
    if (limiters.recipient.used(opts.email) >= 3 || limiters.ip.isLimited(opts.ip) || limiters.global.isLimited("g")) return "limited";
  } else {
    if (limiters.recipient.isLimited(opts.email) || limiters.user.isLimited(String(opts.userId)) || limiters.global.isLimited("g")) return "limited";
  }
  limiters.recipient.count(opts.email);
  if (opts.purpose === "reset") limiters.ip.count(opts.ip);
  else limiters.user.count(String(opts.userId));
  limiters.global.count("g");

  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  try {
    await sender.send({ to: opts.email, subject: opts.subject, text: `Your remote-dsh code is ${code} (valid 10 minutes).` });
  } catch (err) {
    console.error(`[email] send failed to ${opts.email}:`, err instanceof Error ? err.message : err);
    return "error";
  }
  runtime.db.createEmailCode(opts.userId, opts.email, opts.purpose, sha256(code), Date.now() + PIN_TTL_MS);
  runtime.db.recordAudit(opts.userId, `email.${opts.purpose}.sent`, { email: opts.email }, opts.ip);
  return "sent";
}

/** 生成并发送短信验证码（含防轰炸限流 + 审计）。 */
async function sendSmsCode(
  runtime: HubRuntime,
  opts: { purpose: string; phone: string; userId: number; ip: string },
): Promise<"sent" | "disabled" | "limited" | "resend" | "error"> {
  const sender = getSmsSender(runtime);
  if (sender === null) return "disabled";
  const limiters = getSmsLimiters(runtime);
  const last = runtime.db.getSmsCodeByPhone(opts.phone, opts.purpose);
  if (last !== null && last.createdAt > Date.now() - RESEND_WINDOW_MS) return "resend";
  if (limiters.phone.isLimited(opts.phone) || limiters.ip.isLimited(opts.ip) || limiters.global.isLimited("g")) return "limited";
  limiters.phone.count(opts.phone);
  limiters.ip.count(opts.ip);
  limiters.global.count("g");
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  try {
    await sender.send({ to: opts.phone, code });
  } catch (err) {
    console.error(`[sms] send failed to ${opts.phone}:`, err instanceof Error ? err.message : err);
    return "error";
  }
  runtime.db.createSmsCode(opts.userId, opts.phone, opts.purpose, sha256(code), Date.now() + PIN_TTL_MS);
  runtime.db.recordAudit(opts.userId, `sms.${opts.purpose}.sent`, { phone: opts.phone }, opts.ip);
  return "sent";
}

/** 校验短信验证码（一次性 + 错误计数）。 */
export function verifySmsCode(db: HubDb, phone: string, purpose: string, code: string): boolean {
  const row = db.getSmsCodeByPhone(phone, purpose);
  if (row === null || row.expiresAt <= Date.now()) return false;
  if (row.attempts >= MAX_CODE_ATTEMPTS) return false;
  db.incrementSmsCodeAttempts(row.id);
  if (row.codeHash !== sha256(code)) return false;
  db.deleteSmsCodes(phone);
  return true;
}

/** 校验验证码（一次性 + 错误计数）。 */
export function verifyEmailCode(db: HubDb, email: string, purpose: string, code: string): boolean {
  const row = db.getEmailCodeByEmail(email, purpose);
  if (row === null || row.expiresAt <= Date.now()) return false;
  if (row.attempts >= MAX_CODE_ATTEMPTS) return false;
  db.incrementCodeAttempts(row.id);
  if (row.codeHash !== sha256(code)) return false;
  db.deleteEmailCodes(email);
  return true;
}

function normalEmail(body: Record<string, unknown> | null): string | null {
  if (body === null || typeof body.email !== "string") return null;
  const email = body.email.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !email.includes("@")) return null;
  return email;
}

/** 纯邮箱规范化（注册/登录用）。 */
function normalizeEmailStr(s: string): string | null {
  const email = s.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !email.includes("@")) return null;
  return email;
}

/** +86 手机号规范化：11 位合法号段 → E.164；否则 null。 */
function normalizeCnPhone(s: string): string | null {
  const p = s.trim();
  if (!/^1[3-9]\d{9}$/.test(p)) return null;
  return `+86${p}`;
}

/** 登录标识符解析：邮箱 → 其 name；手机号 → 其 name；否则视为用户名（自托管兼容）。 */
function resolveLoginName(db: HubDb, identifier: string): string | null {
  const email = normalizeEmailStr(identifier);
  if (email !== null) return db.getUserByEmail(email)?.name ?? null;
  const phone = normalizeCnPhone(identifier);
  if (phone !== null) return db.getUserByPhone(phone)?.name ?? null;
  return identifier;
}

/** 当前账号 host 配额：null = 不限；否则为上限（trial/subscribed/grace/free）。 */
function hostQuota(runtime: HubRuntime, user: UserRow): number | null {
  const plan = user.planStatus;
  if (plan === null) return null;
  const billing = runtime.config.billing;
  if (plan === "trial") return billing?.trialHosts ?? BILLING_DEFAULTS.trialHosts;
  if (plan === "free") return 0;
  const sub = runtime.db.getActiveSubscription(user.id);
  const spec = (billing?.plans ?? []).find((p) => p.id === sub?.planId);
  return spec?.hosts ?? 0;
}

/** 验证码校验（按 provider 分发）：none 跳过；aliyun VerifyCaptcha 验签；arithmetic token+answer。 */
async function verifyCaptchaBody(runtime: HubRuntime, body: Record<string, unknown> | null): Promise<boolean> {
  const provider = runtime.config.captcha?.provider;
  if (provider === "none") return true;
  if (provider === "aliyun") {
    const cfg = runtime.config.captcha?.aliyun;
    if (cfg === undefined || body === null || typeof body.captchaVerifyParam !== "string") return false;
    try {
      return await verifyCaptchaParam(cfg, body.captchaVerifyParam);
    } catch {
      return false;
    }
  }
  // arithmetic（缺省）
  if (body === null || typeof body.captchaToken !== "string" || typeof body.captchaAnswer !== "string") return false;
  return verifyChallenge(body.captchaToken, body.captchaAnswer);
}

async function handleTotpLogin(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null || typeof body.pendingToken !== "string" || typeof body.code !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  const result = runtime.auth.verifyTotpLogin(body.pendingToken, body.code);
  if (result === null) {
    writeError(res, 401, "BAD_TOTP", "invalid or expired 2FA code");
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "set-cookie": sessionCookie(result.tokens.accessToken) });
  res.end(JSON.stringify({ accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken, mustChangePassword: result.mustChangePassword }));
}

async function handleCaptchaChallenge(_req: IncomingMessage, res: ServerResponse, _runtime: HubRuntime): Promise<void> {
  const { token, question } = createChallenge();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ token, question }));
}

async function handleResetRequest(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const ip = clientIp(req, runtime);
  const body = await readJsonBody(req);
  const channel = body?.channel ?? "email";
  let identifier: string | null;
  if (channel === "phone") identifier = normalizeCnPhone(typeof body?.identifier === "string" ? body.identifier : "");
  else identifier = normalizeEmailStr(typeof body?.identifier === "string" ? body.identifier : typeof body?.email === "string" ? body.email : "");
  if (identifier === null) {
    writeError(res, 400, "BAD_REQUEST", channel === "phone" ? "invalid phone (+86, 11 digits)" : "invalid email");
    return;
  }
  if (!(await verifyCaptchaBody(runtime, body))) {
    writeError(res, 400, "BAD_CAPTCHA", "captcha failed");
    return;
  }
  if (channel === "phone") {
    const user = runtime.db.getUserByPhone(identifier);
    if (user !== null && user.phoneVerified === 1) {
      await sendSmsCode(runtime, { purpose: "reset", phone: identifier, userId: user.id, ip });
    }
  } else {
    const user = runtime.db.getUserByEmail(identifier);
    if (user !== null && user.emailVerified === 1) {
      await sendEmailCode(runtime, { purpose: "reset", email: identifier, userId: user.id, ip, subject: "remote-dsh password reset" });
    }
  }
  // 统一响应（防枚举）：邮箱/手机号是否存在都返回 ok
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleResetConfirm(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const ip = clientIp(req, runtime);
  const body = await readJsonBody(req);
  const channel = body?.channel ?? "email";
  let identifier: string | null;
  if (channel === "phone") identifier = normalizeCnPhone(typeof body?.identifier === "string" ? body.identifier : "");
  else identifier = normalizeEmailStr(typeof body?.identifier === "string" ? body.identifier : typeof body?.email === "string" ? body.email : "");
  if (identifier === null || body === null || typeof body.code !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 8) {
    writeError(res, 400, "BAD_REQUEST", "invalid body (newPassword must be >= 8 chars)");
    return;
  }
  const user = channel === "phone" ? runtime.db.getUserByPhone(identifier) : runtime.db.getUserByEmail(identifier);
  if (user === null) {
    writeError(res, 400, "BAD_RESET", "invalid or expired reset code");
    return;
  }
  const ok = channel === "phone" ? verifySmsCode(runtime.db, identifier, "reset", body.code) : verifyEmailCode(runtime.db, identifier, "reset", body.code);
  if (!ok) {
    writeError(res, 400, "BAD_RESET", "invalid or expired reset code");
    return;
  }
  runtime.db.setPassword(user.id, await hashPassword(body.newPassword));
  runtime.db.revokeAllRefreshForUser(user.id);
  runtime.db.recordAudit(user.id, "password.reset", {}, ip);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: "password reset; all sessions revoked" }));
}

async function handleBindEmail(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const email = normalEmail(body);
  if (email === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid email");
    return;
  }
  const recentUnbind = runtime.db.listAudit({ userId: auth.userId, event: "email.unbind", since: Date.now() - UNBIND_LOCK_MS });
  if (recentUnbind.length > 0) {
    writeError(res, 429, "UNBIND_COOLDOWN", "recently unbound; retry later", UNBIND_LOCK_MS - (Date.now() - recentUnbind[0]!.createdAt));
    return;
  }
  const r = await sendEmailCode(runtime, { purpose: "verify", email, userId: auth.userId, ip: clientIp(req, runtime), subject: "remote-dsh email verification" });
  if (r === "disabled") writeError(res, 400, "EMAIL_DISABLED", "email service not configured");
  else if (r === "limited" || r === "resend") writeError(res, 429, "RATE_LIMITED", r === "resend" ? "resend too soon" : "too many requests");
  else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
}

async function handleVerifyEmail(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const email = normalEmail(body);
  if (email === null || body === null || typeof body.code !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  if (!verifyEmailCode(runtime.db, email, "verify", body.code)) {
    writeError(res, 400, "BAD_CODE", "invalid or expired code");
    return;
  }
  runtime.db.setEmail(auth.userId, email);
  runtime.db.setEmailVerified(auth.userId);
  runtime.db.recordAudit(auth.userId, "email.verified", { email }, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleUnbindEmail(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  runtime.db.clearEmail(auth.userId);
  runtime.db.recordAudit(auth.userId, "email.unbind", {}, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/** 绑定/换绑手机号：发短信码（sms 关闭 → 不可用）。 */
async function handleBindPhone(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const phone = normalizeCnPhone(typeof body?.phone === "string" ? body.phone : "");
  if (phone === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid phone (+86, 11 digits)");
    return;
  }
  const taken = runtime.db.getUserByPhone(phone);
  if (taken !== null && taken.id !== auth.userId) {
    writeError(res, 409, "ALREADY_EXISTS", "phone already bound to another account");
    return;
  }
  const recentUnbind = runtime.db.listAudit({ userId: auth.userId, event: "phone.unbind", since: Date.now() - UNBIND_LOCK_MS });
  if (recentUnbind.length > 0) {
    writeError(res, 429, "UNBIND_COOLDOWN", "recently unbound; retry later", UNBIND_LOCK_MS - (Date.now() - recentUnbind[0]!.createdAt));
    return;
  }
  const r = await sendSmsCode(runtime, { purpose: "verify", phone, userId: auth.userId, ip: clientIp(req, runtime) });
  if (r === "disabled") writeError(res, 400, "SMS_DISABLED", "sms service not configured");
  else if (r === "limited" || r === "resend") writeError(res, 429, "RATE_LIMITED", r === "resend" ? "resend too soon" : "too many requests");
  else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
}

/** 验证手机号 → 落库（phone + verified）。 */
async function handleVerifyPhone(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const phone = normalizeCnPhone(typeof body?.phone === "string" ? body.phone : "");
  if (phone === null || body === null || typeof body.code !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  if (!verifySmsCode(runtime.db, phone, "verify", body.code)) {
    writeError(res, 400, "BAD_CODE", "invalid or expired code");
    return;
  }
  runtime.db.setPhone(auth.userId, phone);
  runtime.db.setPhoneVerified(auth.userId);
  runtime.db.recordAudit(auth.userId, "phone.verified", { phone }, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleUnbindPhone(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  runtime.db.clearPhone(auth.userId);
  runtime.db.recordAudit(auth.userId, "phone.unbind", {}, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ---- 08-saas：计费 / 订阅 / 账号删除（S2）----

/** 激活订阅：建订阅行 + plan_status=subscribed + 到期时间。 */
function activateSubscription(runtime: HubRuntime, userId: number, plan: PlanSpec): void {
  const now = Date.now();
  const expiresAt = now + plan.intervalDays * 24 * 3600 * 1000;
  runtime.db.createSubscription(userId, plan.id, now, expiresAt);
  runtime.db.setPlan(userId, "subscribed", expiresAt);
}

async function handleBillingPlans(_req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ plans: runtime.config.billing?.plans ?? [] }));
}

/** 校验站内相对重定向路径（防开放重定向）。 */
function safeRedirect(p: unknown): string | null {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//")) return null;
  return p;
}

/** 读取并校验 jsapi openid 短期签名 Cookie。 */
function readOpenidCookie(req: IncomingMessage, runtime: HubRuntime): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[OPENID_COOKIE];
  if (typeof token !== "string" || token === "") return null;
  const v = runtime.auth.verifyOpenidToken(token);
  return v === null ? null : v.openid;
}

/** 组装微信 OAuth 授权 URL（redirect_uri 由 notifyUrl 的 origin 推导，回调固定 /api/wechat/oauth/callback）。 */
function wechatOauthUrl(cfg: { appid: string; notifyUrl: string }, redirect: string): string {
  const origin = new URL(cfg.notifyUrl).origin;
  const redirectUri = encodeURIComponent(`${origin}/api/wechat/oauth/callback`);
  const state = encodeURIComponent(redirect);
  return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${cfg.appid}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=${state}#wechat_redirect`;
}

async function handleWechatOauthAuthorize(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const cfg = runtime.config.billing?.payment?.wechatpay;
  if (runtime.config.billing?.payment?.provider !== "wechatpay" || cfg === undefined || typeof cfg.appSecret !== "string" || cfg.appSecret === "") {
    writeError(res, 400, "WECHAT_OAUTH_DISABLED", "wechat oauth (jsapi) requires billing.payment.wechatpay.appSecret");
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const redirect = safeRedirect(url.searchParams.get("redirect"));
  if (redirect === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid redirect");
    return;
  }
  res.writeHead(302, { location: wechatOauthUrl(cfg, redirect) });
  res.end();
}

async function handleWechatOauthCallback(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const cfg = runtime.config.billing?.payment?.wechatpay;
  if (runtime.config.billing?.payment?.provider !== "wechatpay" || cfg === undefined || typeof cfg.appSecret !== "string" || cfg.appSecret === "") {
    writeError(res, 400, "WECHAT_OAUTH_DISABLED", "wechat oauth (jsapi) requires billing.payment.wechatpay.appSecret");
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const code = url.searchParams.get("code");
  const redirect = safeRedirect(url.searchParams.get("state"));
  if (typeof code !== "string" || code === "" || redirect === null) {
    writeError(res, 400, "BAD_REQUEST", "missing code or state");
    return;
  }
  const openid = await getWechatOpenid(cfg.appid, cfg.appSecret, code);
  if (openid === null) {
    writeError(res, 400, "OAUTH_FAILED", "failed to exchange code for openid");
    return;
  }
  const token = runtime.auth.issueOpenidToken(auth.userId, openid);
  res.writeHead(302, { location: redirect, "set-cookie": `${OPENID_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` });
  res.end();
}

async function handleSubscribe(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const planId = typeof body?.planId === "string" ? body.planId : "";
  const plan = (runtime.config.billing?.plans ?? []).find((p) => p.id === planId);
  if (plan === undefined) {
    writeError(res, 400, "BAD_REQUEST", "unknown planId");
    return;
  }
  const rawForm = typeof body?.form === "string" ? body.form : "native";
  if (rawForm !== "native" && rawForm !== "h5" && rawForm !== "jsapi") {
    writeError(res, 400, "BAD_REQUEST", "unknown form");
    return;
  }
  let openid: string | undefined;
  if (rawForm === "jsapi") {
    const oid = readOpenidCookie(req, runtime);
    if (oid === null) {
      writeError(res, 400, "JSAPI_OPENID_REQUIRED", "jsapi payment requires wechat oauth openid");
      return;
    }
    openid = oid;
  }
  const orderId = randomUUID();
  runtime.db.createOrder(orderId, auth.userId, plan.id, plan.priceCny);
  const result = await createPaymentProvider(runtime.config.billing?.payment).createPayment({
    orderId,
    amountCny: plan.priceCny,
    subject: `remote-dsh ${plan.name}`,
    form: rawForm,
    openid,
    clientIp: clientIp(req, runtime),
  });
  if (result.paid) {
    runtime.db.markOrderPaid(orderId, "mock", result.channelOrderId);
    runtime.db.createPayment(randomUUID(), orderId, auth.userId, "mock", result.channelOrderId, plan.priceCny, Date.now(), "{}");
    activateSubscription(runtime, auth.userId, plan);
    runtime.db.recordAudit(auth.userId, "billing.subscribed", { planId, orderId }, clientIp(req, runtime));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ orderId, paid: result.paid, payInfo: result.payInfo }));
}

async function handleSubscription(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const user = runtime.db.getUserById(auth.userId);
  const sub = runtime.db.getActiveSubscription(auth.userId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      planStatus: user?.planStatus ?? null,
      planId: sub?.planId ?? null,
      planExpiresAt: user?.planExpiresAt ?? null,
      hostQuota: user === null ? null : hostQuota(runtime, user),
      hostsInUse: user === null ? 0 : runtime.db.listHostsByOwner(user.id).length,
    }),
  );
}

async function handleCancelSubscription(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const sub = runtime.db.getActiveSubscription(auth.userId);
  if (sub !== null) runtime.db.setSubscriptionStatus(sub.id, "canceled");
  runtime.db.recordAudit(auth.userId, "billing.canceled", {}, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: "subscription canceled; remains active until expiry" }));
}

/** 支付异步回调（幂等）。mock 直通；wechatpay 验签（HMAC）+ AES-GCM 解密 resource。 */
async function handleBillingCallback(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const rawBody = await readRawBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, "BAD_REQUEST", "invalid JSON");
    return;
  }
  const payment = runtime.config.billing?.payment;
  const isWechat = payment?.provider === "wechatpay";
  let channel: string;
  let channelOrderId: string;
  let orderId: string;
  let amountCny: number | null = null;

  if (isWechat) {
    const cfg = payment!.wechatpay!;
    const ts = req.headers["wechatpay-timestamp"];
    const nonce = req.headers["wechatpay-nonce"];
    const sig = req.headers["wechatpay-signature"];
    if (typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string" || !verifyWechatCallback(cfg.apiV3Key, ts, nonce, sig, rawBody)) {
      writeError(res, 400, "BAD_SIGNATURE", "wechatpay signature verification failed");
      return;
    }
    const resource = body.resource as { ciphertext?: string; nonce?: string; associated_data?: string } | undefined;
    if (resource === undefined || typeof resource.ciphertext !== "string" || typeof resource.nonce !== "string") {
      writeError(res, 400, "BAD_REQUEST", "invalid wechatpay resource");
      return;
    }
    const decrypted = decryptWechatResource(cfg.apiV3Key, { ciphertext: resource.ciphertext, nonce: resource.nonce, associated_data: resource.associated_data });
    const outTradeNo = typeof decrypted.out_trade_no === "string" ? decrypted.out_trade_no : "";
    const transactionId = typeof decrypted.transaction_id === "string" ? decrypted.transaction_id : "";
    if (outTradeNo === "") {
      writeError(res, 400, "BAD_REQUEST", "missing out_trade_no");
      return;
    }
    channel = "wechatpay";
    channelOrderId = transactionId !== "" ? transactionId : outTradeNo;
    orderId = outTradeNo;
    const total = (decrypted.amount as { total?: number } | undefined)?.total;
    if (typeof total === "number") amountCny = total / 100;
  } else {
    channel = typeof body?.channel === "string" ? body.channel : "mock";
    channelOrderId = typeof body?.channelOrderId === "string" ? body.channelOrderId : "";
    orderId = typeof body?.orderId === "string" ? body.orderId : "";
  }

  if (channelOrderId === "" || orderId === "") {
    writeError(res, 400, "BAD_REQUEST", "invalid callback");
    return;
  }
  const existing = runtime.db.getPaymentByChannelOrderId(channel, channelOrderId);
  if (existing !== null) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, duplicate: true })); // 幂等：重复通知只入账一次
    return;
  }
  const order = runtime.db.getOrder(orderId);
  if (order === null || order.status !== "created") {
    writeError(res, 400, "BAD_REQUEST", "unknown or already-closed order");
    return;
  }
  const amount = amountCny ?? order.amountCny;
  runtime.db.markOrderPaid(orderId, channel, channelOrderId);
  runtime.db.createPayment(randomUUID(), orderId, order.userId, channel, channelOrderId, amount, Date.now(), rawBody);
  const plan = (runtime.config.billing?.plans ?? []).find((p) => p.id === order.planId);
  if (plan !== undefined) activateSubscription(runtime, order.userId, plan);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/** 当前账号信息（绑定状态）：账户页回显（邮箱/手机号/2FA/plan）。 */
async function handleAccountInfo(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const user = runtime.db.getUserById(auth.userId);
  if (user === null) {
    writeError(res, 404, "NOT_FOUND", "user not found");
    return;
  }
  const sub = runtime.db.getActiveSubscription(auth.userId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified === 1,
      phone: user.phone,
      phoneVerified: user.phoneVerified === 1,
      totpEnabled: user.totpSecret !== null,
      smsEnabled: runtime.config.sms !== undefined,
      planStatus: user.planStatus,
      planExpiresAt: user.planExpiresAt,
      planId: sub?.planId ?? null,
    }),
  );
}

/** 自助删除账号（R7）：密码二次确认 → 断隧道 → 墓碑化。 */
async function handleDeleteAccount(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const user = runtime.db.getUserById(auth.userId);
  if (user === null || typeof body?.password !== "string" || !(await verifyPassword(body.password, user.passwordHash))) {
    writeError(res, 400, "BAD_CREDENTIALS", "password incorrect");
    return;
  }
  for (const host of runtime.db.listHostsByOwner(auth.userId)) {
    const conn = runtime.tunnels.get(host.id);
    if (conn !== null) conn.terminate();
    runtime.tunnels.unregister(host.id);
  }
  runtime.db.recordAudit(auth.userId, "account.deleted", {}, clientIp(req, runtime));
  runtime.db.deleteAccount(auth.userId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/** 计费状态机定时扫描：trial/subscribed 到期 → grace → free（0 台离线）。 */
export function sweepBilling(runtime: HubRuntime, now = Date.now()): void {
  const billing = runtime.config.billing;
  const graceDays = billing?.graceDays ?? BILLING_DEFAULTS.graceDays;
  const retentionDays = billing?.retentionDays ?? BILLING_DEFAULTS.retentionDays;
  const day = 24 * 3600 * 1000;
  for (const user of runtime.db.listUsers()) {
    if (user.accountStatus !== "active" || user.planStatus === null || user.planExpiresAt === null) continue;
    if (user.planStatus === "trial" || user.planStatus === "subscribed") {
      if (user.planExpiresAt <= now) {
        runtime.db.setPlan(user.id, "grace", now + graceDays * day);
        runtime.db.recordAudit(user.id, "billing.grace", { from: user.planStatus }, "");
      }
    } else if (user.planStatus === "grace" && user.planExpiresAt <= now) {
      runtime.db.setPlan(user.id, "free", null);
      runtime.db.setFreeSince(user.id, now);
      const sub = runtime.db.getActiveSubscription(user.id);
      if (sub !== null) runtime.db.setSubscriptionStatus(sub.id, "expired");
      for (const host of runtime.db.listHostsByOwner(user.id)) {
        const conn = runtime.tunnels.get(host.id);
        if (conn !== null) conn.terminate();
        runtime.tunnels.unregister(host.id);
      }
      runtime.db.recordAudit(user.id, "billing.downgraded", { to: "free" }, "");
    }
  }
  // 30 天数据保留：free 且超期的 host 记录删除（R6）
  runtime.db.purgeExpiredFreeHosts(now, retentionDays * day);
}

async function handleEnable2fa(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const { secret, otpauthUrl } = runtime.auth.enableTotp();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ secret, otpauthUrl }));
}

async function handleActivate2fa(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.secret !== "string" || typeof body.code !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  if (!runtime.auth.activateTotp(auth.userId, body.secret, body.code)) {
    writeError(res, 400, "BAD_TOTP", "invalid 2FA code");
    return;
  }
  runtime.db.recordAudit(auth.userId, "2fa.enabled", {}, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleDisable2fa(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.code !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  if (!runtime.auth.disableTotp(auth.userId, body.code)) {
    writeError(res, 400, "BAD_TOTP", "invalid 2FA code");
    return;
  }
  runtime.db.recordAudit(auth.userId, "2fa.disabled", {}, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleShareHost(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, hostId: string): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  if (!runtime.db.isHostOwner(hostId, auth.userId)) {
    writeError(res, 403, "FORBIDDEN", "host not owned by you");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.name !== "string" || body.name.length === 0) {
    writeError(res, 400, "BAD_REQUEST", "invalid body (name required)");
    return;
  }
  const target = runtime.db.getUserByName(body.name);
  if (target === null) {
    writeError(res, 400, "BAD_REQUEST", "user not found");
    return;
  }
  runtime.db.shareHost(hostId, target.id, "member");
  runtime.db.recordAudit(auth.userId, "host.share", { hostId, sharedUserId: target.id }, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleListShares(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, hostId: string): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  if (!runtime.db.isHostOwner(hostId, auth.userId)) {
    writeError(res, 403, "FORBIDDEN", "host not owned by you");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ shares: runtime.db.listShares(hostId) }));
}

async function handleRevokeShare(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, hostId: string, targetUserId: string): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  if (!runtime.db.isHostOwner(hostId, auth.userId)) {
    writeError(res, 403, "FORBIDDEN", "host not owned by you");
    return;
  }
  const uid = Number(targetUserId);
  runtime.db.revokeShare(hostId, uid);
  runtime.db.recordAudit(auth.userId, "host.share.revoke", { hostId, revokedUserId: uid }, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 读原始 body 字符串（支付回调验签需原文）。 */
async function readRawBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256 * 1024) break;
  }
  return body;
}

export function writeError(res: ServerResponse, status: number, code: string, message: string, retryAfterMs?: number): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfterMs !== undefined) headers["retry-after"] = String(Math.ceil(retryAfterMs / 1000));
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { code, message } }));
}
