/**
 * api.ts — 层 1 hub 对外 API（契约见 req R5，错误统一 {error:{code,message}}）。
 *
 * 认证：`Authorization: Bearer <access>` 或 Cookie `rdsh_hub_session`（HttpOnly）。
 * 无开放注册端点（账号由 `rdsh hub user add` 创建，防 bot/垃圾注入）。
 */
import { randomInt, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubConfig, PlanSpec, WechatLoginConfig, AppleLoginConfig } from "./config.ts";
import { BILLING_DEFAULTS } from "./config.ts";
import type { HubDb, UserRow } from "./db.ts";
import type { HubAuth } from "./auth.ts";
import { createLoginLimiter, hashPassword, verifyPassword, ADMIN_TTL_MS, RECENT_TOTP_WINDOW_MS, ACCESS_TTL_MS, REFRESH_TTL_MS } from "./auth.ts";
import type { TunnelRegistry, TunnelTimings } from "./tunnel.ts";
import type { EventHub } from "./events.ts";
import { randomToken, sha256 } from "./jwt.ts";
import { createEmailSender } from "./email/index.ts";
import type { EmailSender } from "./email/index.ts";
import { createSmsSender } from "./sms/index.ts";
import type { SmsSender } from "./sms/index.ts";
import { createPaymentProvider, verifyWechatCallback, decryptWechatResource, getWechatOpenid } from "./billing/index.ts";
import { UnicPayClient, verifyWebhookSignature } from "./billing/unicpay.ts";
import { exchangeWechatLoginCode, wechatLoginUrl } from "./wechat-login.ts";
import { verifyAppleIdToken, exchangeAppleCode, revokeAppleToken, makeAppleClientSecret, loadApplePrivateKey, encryptToken, decryptToken } from "./apple-login.ts";
import { createChallenge, verifyChallenge } from "./captcha.ts";
import { verifyCaptchaParam } from "./captcha/aliyun.ts";
import { DailyWindowLimiter } from "./ratelimit.ts";
import { clearHostCookie } from "./server.ts";
import { AdminError } from "./admin.ts";
import type { AdminCtx, AdminCreateUserInput } from "./admin.ts";
import * as admin from "./admin.ts";
import { lastBackupAt } from "./backup.ts";
import QRCode from "qrcode";

export const SESSION_COOKIE = "rdsh_hub_session";
/** 续期凭证 cookie（HttpOnly；`Path=/api/auth` 使其只出现在续期/登出/改密请求，普通页面与中继不携带）。 */
export const REFRESH_COOKIE = "rdsh_hub_refresh";
/** 可信设备 cookie（30 天免 TOTP；签名含 ver，改密即失效）。 */
export const TRUSTED_COOKIE = "rdsh_trusted";
export const OPENID_COOKIE = "rdsh_openid";
export const ADMIN_COOKIE = "rdsh_admin_session";
const HUB_VERSION = "0.9.0";
const JOIN_TOKEN_DEFAULT_TTL = 30 * 24 * 3600; // join token 默认 30 天（秒）
const JOIN_TOKEN_MAX_TTL = 365 * 24 * 3600; // join token 上限 1 年（秒）
const REGISTER_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 }; // register 未认证端点：10 次/分钟/IP
const WECHAT_STATE_TTL_MS = 10 * 60 * 1000; // 微信登录 state：一次性、10 分钟
const WECHAT_TRIAL_LIMIT = { max: 3, windowMs: 24 * 3600 * 1000 }; // 同 IP 自动建号上限（R8）

export interface HubRuntime {
  /** 隧道心跳时序（测试注入；缺省见 PROTOCOL.md） */
  tunnelTimings?: TunnelTimings;
  config: HubConfig;
  db: HubDb;
  auth: HubAuth;
  tunnels: TunnelRegistry;
  events: EventHub;
}

export interface AuthResult {
  userId: number;
  name: string;
  /** 门户会话签发时的最近 2FA 验证时间（毫秒）；无 2FA 验证的会话为 undefined */
  totpVerifiedAt?: number;
}

/** 认证：Authorization: Bearer 或 Cookie。 */
export function authenticate(req: IncomingMessage, runtime: HubRuntime): AuthResult | null {
  const read = (v: { user: { id: number; name: string }; claims: { totpVerifiedAt?: number } } | null): AuthResult | null =>
    v === null ? null : { userId: v.user.id, name: v.user.name, ...(v.claims.totpVerifiedAt !== undefined ? { totpVerifiedAt: v.claims.totpVerifiedAt } : {}) };
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return read(runtime.auth.verifyAccess(header.slice(7).trim()));
  }
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies[SESSION_COOKIE];
  if (typeof session === "string" && session.length > 0) {
    return read(runtime.auth.verifyAccess(session));
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
    const status = err.code === "FORBIDDEN" ? 403 : err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" ? 409 : 400;
    writeError(res, status, err.code, err.message);
    return;
  }
  writeError(res, 500, "INTERNAL", "internal error");
}

/** 读必需 reason 字段（危险操作必填）。 */
/** 分页 limit：默认 50，上限 200（防超大页拖垮序列化）。 */
function clampLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

/** admin 面用户视图：仅暴露展示/运营所需字段，绝不外泄 passwordHash / totpSecret / ver / failedAttempts。
 * lockedUntil 可暴露（feature 16：admin 需知锁定状态与到期；失败次数不可见，防爆破反馈）。 */
function adminUserView(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    accountStatus: u.accountStatus,
    planStatus: u.planStatus,
    planExpiresAt: u.planExpiresAt,
    createdAt: u.createdAt,
    emailVerified: u.emailVerified === 1,
    phoneVerified: u.phoneVerified === 1,
    lastLoginAt: u.lastLoginAt,
    locked: u.lockedUntil !== null && u.lockedUntil > Date.now(),
    lockedUntil: u.lockedUntil,
  };
}

function requireReason(body: Record<string, unknown> | null): string | null {  return body !== null && typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : null;
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

  // 登录：正常会话 + TOTP → 签发 admin 短会话（强制 2FA，req R2；可信设备可免输动态码）
  if (path === "/api/admin/login" && method === "POST") {
    const auth = authenticate(req, runtime);
    if (auth === null) {
      writeError(res, 401, "UNAUTHORIZED", "sign in required");
      return true;
    }
    const body = await readJsonBody(req);
    const totp = typeof body?.totp === "string" ? body.totp : "";
    // 免二次输入条件：可信设备（30 天 cookie）或门户会话 30 分钟内验证过 2FA
    const cookies = parseCookies(req.headers.cookie);
    const trusted = cookies[TRUSTED_COOKIE];
    const trustedUid = typeof trusted === "string" && trusted.length > 0 ? runtime.auth.verifyTrustedDevice(trusted) : null;
    const recentTotp = auth.totpVerifiedAt !== undefined && Date.now() - auth.totpVerifiedAt < RECENT_TOTP_WINDOW_MS;
    const token = runtime.auth.issueAdminSession(auth.userId, totp, trustedUid === auth.userId, recentTotp);
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
    const q = url.searchParams.get("q") ?? undefined;
    const limit = clampLimit(url.searchParams.get("limit"));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    const { rows, total } = db.listUsersPage({ q, limit, offset });
    // 主机数仍一次 GROUP BY 聚合（索引），避免对每个用户子查询
    const hostCounts = new Map<number, number>();
    for (const row of db.countHostsByOwner()) hostCounts.set(row.ownerId, row.count);
    const users = rows.map((u) => ({ ...adminUserView(u), hostCount: hostCounts.get(u.id) ?? 0 }));
    res.end(JSON.stringify({ users, total }));
    return true;
  }
  // 建号（feature 16）：identifier = name / 邮箱 / +86 手机；角色按 D3；mustChange 默认 true；到期可空（E1）
  if (path === "/api/admin/users" && method === "POST") {
    const body = await readJsonBody(req);
    try {
      if (body === null || typeof body.identifier !== "string" || typeof body.password !== "string") {
        writeError(res, 400, "BAD_REQUEST", "identifier/password required");
        return true;
      }
      const roleRaw = body.role;
      if (roleRaw !== undefined && (typeof roleRaw !== "string" || !["user", "readonly", "operator", "admin"].includes(roleRaw))) {
        writeError(res, 400, "BAD_REQUEST", "invalid role");
        return true;
      }
      const role = typeof roleRaw === "string" ? roleRaw : "user";
      // 试用到期：trialDays（新，服务端算到期）与 expiresAtMs（遗留，直接到期）二选一；都不给 → 永久无限
      if (body.trialDays !== undefined && typeof body.trialDays !== "number") {
        writeError(res, 400, "BAD_REQUEST", "trialDays must be an integer in [1, 3650]");
        return true;
      }
      if (typeof body.trialDays === "number" && typeof body.expiresAtMs === "number") {
        writeError(res, 400, "BAD_REQUEST", "trialDays and expiresAtMs are mutually exclusive");
        return true;
      }
      let expiresAtMs: number | null = null;
      if (typeof body.trialDays === "number") {
        if (!Number.isInteger(body.trialDays) || body.trialDays < 1 || body.trialDays > 3650) {
          writeError(res, 400, "BAD_REQUEST", "trialDays must be an integer in [1, 3650]");
          return true;
        }
        expiresAtMs = Date.now() + body.trialDays * 24 * 3600 * 1000;
      } else if (typeof body.expiresAtMs === "number") {
        expiresAtMs = body.expiresAtMs;
      }
      const input: AdminCreateUserInput = {
        identifier: body.identifier,
        password: body.password,
        role: role as AdminCreateUserInput["role"],
        mustChange: body.mustChange !== false,
        expiresAtMs,
      };
      const created = await admin.createUser(db, ctx, input, requireReason(body) ?? "no reason");
      res.end(JSON.stringify({ ok: true, user: adminUserView(created) }));
    } catch (err) {
      writeAdminError(res, err);
    }
    return true;
  }
  if (path === "/api/admin/hosts" && method === "GET") {
    const q = url.searchParams.get("q") ?? undefined;
    const limit = clampLimit(url.searchParams.get("limit"));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
    const { rows, total } = db.listHostsPage({ q, limit, offset });
    const hosts = rows.map((h) => ({ ...h, online: runtime.tunnels.isOnline(h.id) }));
    res.end(JSON.stringify({ hosts, total }));
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
    const backupDir = runtime.config.backup?.dir;
    res.end(
      JSON.stringify({
        uptimeSeconds: Math.floor(process.uptime()),
        tunnelCount: runtime.tunnels.list().length,
        onlineHosts: online,
        dbSize,
        version: HUB_VERSION,
        lastBackupAt: backupDir !== undefined ? lastBackupAt(backupDir) : null,
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

  // ---- 用户详情（账号 + 配额 + 订阅/订单/支付 + 审计）----
  const userDetail = /^\/api\/admin\/users\/([^/]+)$/.exec(path);
  if (userDetail !== null && method === "GET") {
    const id = Number(decodeURIComponent(userDetail[1]!));
    const user = admin.getUser(db, id);
    if (user === null) {
      writeError(res, 404, "NOT_FOUND", "user not found");
      return true;
    }
    const hostCount = db.listHostsByOwner(id).length;
    res.end(JSON.stringify({
      user: adminUserView(user),
      hostCount,
      quota: hostQuota(runtime, user),
      subscriptions: db.listSubscriptionsByUser(id),
      orders: db.listOrdersByUser(id),
      payments: db.listPaymentsByUser(id),
      audit: admin.listAudit(db, { userId: id }),
    }));
    return true;
  }

  // ---- 写端点（服务层 RBAC + 审计） ----
  const userAction = /^\/api\/admin\/users\/([^/]+)\/(ban|unban|reset-password|unlock|reset-2fa|plan|grant-trial|grant-subscription|set-role|delete)$/.exec(path);
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
        // "null"/null → 真正 NULL（无期限）；否则限 planStatus 枚举（修复此前「null 字符串错存字面量」）
        const raw = body === null ? undefined : body.planStatus;
        if (raw !== null && raw !== undefined && typeof raw !== "string") {
          writeError(res, 400, "BAD_REQUEST", "planStatus required");
          return true;
        }
        if (typeof raw === "string" && raw !== "null" && !["trial", "subscribed", "grace", "free"].includes(raw)) {
          writeError(res, 400, "BAD_REQUEST", `invalid planStatus '${raw}'`);
          return true;
        }
        const planStatus = raw === null || raw === undefined || raw === "null" ? null : raw;
        const expiresAtMs = body === null ? null : typeof body.expiresAtMs === "number" ? body.expiresAtMs : null;
        admin.adjustPlan(db, ctx, id, planStatus, expiresAtMs, requireReason(body) ?? "no reason");
      } else if (action === "grant-trial") {
        const days = body === null ? undefined : body.days;
        if (typeof days !== "number" || !Number.isInteger(days)) {
          writeError(res, 400, "BAD_REQUEST", "days must be an integer in [1, 3650]");
          return true;
        }
        admin.grantTrial(db, ctx, id, days, requireReason(body) ?? "no reason");
      } else if (action === "grant-subscription") {
        if (body === null || typeof body.planId !== "string") {
          writeError(res, 400, "BAD_REQUEST", "planId required");
          return true;
        }
        if (!(runtime.config.billing?.plans ?? []).some((p) => p.id === body.planId)) {
          writeError(res, 400, "BAD_REQUEST", `unknown planId '${body.planId}'`);
          return true;
        }
        if (body.days !== undefined && typeof body.days !== "number") {
          writeError(res, 400, "BAD_REQUEST", "days must be an integer");
          return true;
        }
        if (body.expiresAtMs !== undefined && typeof body.expiresAtMs !== "number") {
          writeError(res, 400, "BAD_REQUEST", "expiresAtMs must be a number");
          return true;
        }
        if (body.amountCny !== undefined && typeof body.amountCny !== "number") {
          writeError(res, 400, "BAD_REQUEST", "amountCny must be a number");
          return true;
        }
        admin.grantSubscription(
          db,
          ctx,
          {
            userId: id,
            planId: body.planId,
            ...(typeof body.days === "number" ? { days: body.days } : {}),
            ...(typeof body.expiresAtMs === "number" ? { expiresAtMs: body.expiresAtMs } : {}),
            ...(typeof body.amountCny === "number" ? { amountCny: body.amountCny } : {}),
          },
          requireReason(body) ?? "no reason",
        );
      } else if (action === "set-role") {
        if (body === null || typeof body.role !== "string") {
          writeError(res, 400, "BAD_REQUEST", "role required");
          return true;
        }
        admin.setUserRole(db, ctx, id, body.role, requireReason(body) ?? "no reason");
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
      if (body === null || typeof body.userId !== "number" || typeof body.planId !== "string" || typeof body.amountCny !== "number") {
        writeError(res, 400, "BAD_REQUEST", "userId/planId/amountCny required");
        return true;
      }
      if (!(runtime.config.billing?.plans ?? []).some((p) => p.id === body.planId)) {
        writeError(res, 400, "BAD_REQUEST", `unknown planId '${body.planId}'`);
        return true;
      }
      if (body.days !== undefined && typeof body.days !== "number") {
        writeError(res, 400, "BAD_REQUEST", "days must be an integer");
        return true;
      }
      if (body.expiresAtMs !== undefined && typeof body.expiresAtMs !== "number") {
        writeError(res, 400, "BAD_REQUEST", "expiresAtMs must be a number");
        return true;
      }
      if (typeof body.days !== "number" && typeof body.expiresAtMs !== "number") {
        writeError(res, 400, "BAD_REQUEST", "days or expiresAtMs required");
        return true;
      }
      const expiresAtMs = typeof body.days === "number" ? Date.now() + body.days * 24 * 3600 * 1000 : body.expiresAtMs!;
      const orderId = admin.creditOrder(db, ctx, { userId: body.userId, planId: body.planId, amountCny: body.amountCny, expiresAtMs }, requireReason(body) ?? "no reason");
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
  // ---- 微信登录（网站应用 qrconnect/snsapi_login；仅登录，与支付无关） ----
  if (path === "/api/wechat/login/authorize" && method === "GET") {
    await handleWechatLoginAuthorize(req, res, runtime);
    return true;
  }
  if (path === "/api/wechat/login/callback" && method === "GET") {
    await handleWechatLoginCallback(req, res, runtime);
    return true;
  }
  if (path === "/api/wechat/confirm" && method === "POST") {
    await handleWechatConfirm(req, res, runtime);
    return true;
  }
  if (path === "/api/wechat/bind/authorize" && method === "GET") {
    await handleWechatBindAuthorize(req, res, runtime);
    return true;
  }
  if (path === "/api/wechat/bind/callback" && method === "GET") {
    await handleWechatBindCallback(req, res, runtime);
    return true;
  }
  // ---- App 苹果登录（Sign in with Apple，仅 iOS）----
  if (path === "/api/app/apple/login" && method === "POST") {
    await handleAppleLogin(req, res, runtime);
    return true;
  }
  // ---- App 微信登录（/api/app/wechat/*，JSON 会话 + scheme 回跳）----
  if (path === "/api/app/wechat/login" && method === "POST") {
    await handleAppWechatLogin(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/confirm" && method === "POST") {
    await handleAppWechatConfirm(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/authorize" && method === "GET") {
    await handleAppWechatAuthorize(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/callback" && method === "GET") {
    await handleAppWechatCallback(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/handoff" && method === "POST") {
    await handleAppWechatHandoff(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/bind" && method === "POST") {
    await handleAppWechatBind(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/bind/init" && method === "POST") {
    await handleAppWechatBindInit(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/bind/authorize" && method === "GET") {
    await handleAppWechatBindAuthorize(req, res, runtime);
    return true;
  }
  if (path === "/api/app/wechat/bind/callback" && method === "GET") {
    await handleAppWechatBindCallback(req, res, runtime);
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
  if (path === "/api/billing/unicpay/initiate" && method === "POST") {
    await handleUnicpayInitiate(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/unicpay/prepay" && method === "POST") {
    await handleUnicpayPrepay(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/unicpay/store/verify" && method === "POST") {
    await handleUnicpayStoreVerify(req, res, runtime);
    return true;
  }
  if (path === "/api/billing/unicpay/webhook" && method === "POST") {
    await handleUnicpayWebhook(req, res, runtime);
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
  if (path === "/api/bind-sessions" && method === "POST") {
    await handleCreateBindSession(req, res, runtime);
    return true;
  }
  const bindApproveMatch = /^\/api\/bind-sessions\/([^/]+)\/approve$/.exec(path);
  if (bindApproveMatch !== null && method === "POST") {
    await handleApproveBindSession(req, res, runtime, decodeURIComponent(bindApproveMatch[1]!));
    return true;
  }
  const bindConsumeMatch = /^\/api\/bind-sessions\/([^/]+)\/consume$/.exec(path);
  if (bindConsumeMatch !== null && method === "POST") {
    await handleConsumeBindSession(req, res, runtime, decodeURIComponent(bindConsumeMatch[1]!));
    return true;
  }
  const bindMatch = /^\/api\/bind-sessions\/([^/]+)$/.exec(path);
  if (bindMatch !== null && method === "GET") {
    await handleGetBindSession(req, res, runtime, decodeURIComponent(bindMatch[1]!));
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
      wechatLoginEnabled: runtime.config.wechatLogin !== undefined,
      appleLoginEnabled: runtime.config.appleLogin !== undefined,
    }),
  );
}

// ---- 微信登录（网站应用 OAuth；仅登录，与支付无关） ----

function wechatLoginConfig(runtime: HubRuntime): WechatLoginConfig | null {
  return runtime.config.wechatLogin ?? null;
}

function wechatLoginError(res: ServerResponse): void {
  writeError(res, 404, "WECHAT_LOGIN_DISABLED", "wechat login is not configured (hub.json wechatLogin)");
}

function wechatAppLoginError(res: ServerResponse): void {
  writeError(res, 404, "WECHAT_LOGIN_DISABLED", "wechat app login is not configured (hub.json wechatAppLogin)");
}

const appWechatLoginLimiter = createLoginLimiter(5, 10 * 60 * 1000); // 同 IP 5 次/10 分钟

/** 当前部署的 App 回跳 scheme（白名单首个；未配置 → null，安全失败）。 */
function appScheme(runtime: HubRuntime): string | null {
  const schemes = runtime.config.appSchemes ?? [];
  return schemes.length > 0 ? schemes[0]! : null;
}

/** 构建 `scheme://oauth/callback?<params>` 回跳；白名单空 → null（不默认放行）。 */
function appRedirect(runtime: HubRuntime, params: Record<string, string>): string | null {
  const scheme = appScheme(runtime);
  if (scheme === null) return null;
  const qs = new URLSearchParams(params).toString();
  return `${scheme}://oauth/callback${qs ? `?${qs}` : ""}`;
}

// ---- App 苹果登录（Sign in with Apple，仅 iOS）----

function appleLoginConfig(runtime: HubRuntime): AppleLoginConfig | null {
  return runtime.config.appleLogin ?? null;
}

function appleLoginError(res: ServerResponse): void {
  writeError(res, 404, "APPLE_LOGIN_DISABLED", "apple login is not configured (hub.json appleLogin)");
}

const appleLoginLimiter = createLoginLimiter(5, 10 * 60 * 1000); // 同 IP 5 次/10 分钟

/**
 * App 苹果登录：验 identityToken（含 nonce 防重放）→ 换 authorizationCode →
 * 仅凭 sub 找号/建号 → 加密存令牌 → 签发会话。
 */
async function handleAppleLogin(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const cfg = appleLoginConfig(runtime);
  if (cfg === null) {
    appleLoginError(res);
    return;
  }
  const ip = clientIp(req, runtime);
  if (appleLoginLimiter.allow(ip) > 0) {
    writeError(res, 429, "RATE_LIMITED", "too many apple login attempts");
    return;
  }
  const body = await readJsonBody(req);
  const identityToken = typeof body?.identity_token === "string" ? body.identity_token : "";
  const nonce = typeof body?.nonce === "string" ? body.nonce : "";
  const code = typeof body?.authorization_code === "string" ? body.authorization_code : "";
  const fullName = typeof body?.full_name === "string" && body.full_name !== "" ? body.full_name : null;
  if (identityToken === "" || nonce === "") {
    writeError(res, 400, "BAD_REQUEST", "identity_token and nonce are required");
    return;
  }

  let privateKeyPem: string;
  try {
    privateKeyPem = await loadApplePrivateKey(cfg.privateKeyPath);
  } catch {
    writeError(res, 503, "APPLE_KEY_ERROR", "failed to load apple private key");
    return;
  }
  const clientSecret = makeAppleClientSecret({
    teamId: cfg.teamId,
    keyId: cfg.keyId,
    clientId: cfg.clientId,
    privateKeyPem,
    nowMs: Date.now(),
  });

  const claims = await verifyAppleIdToken(identityToken, { clientId: cfg.clientId, nonce, nowMs: Date.now(), fetchImpl: fetch });
  if (claims === null) {
    appleLoginLimiter.fail(ip);
    writeError(res, 401, "APPLE_IDENTITY_INVALID", "apple identity token verification failed");
    return;
  }

  // 换 authorizationCode（每次登录都换；refresh_token 仅首次返回）
  let refreshToken: string | null = null;
  let accessToken: string | null = null;
  if (code !== "") {
    const tok = await exchangeAppleCode(code, { clientId: cfg.clientId, clientSecret, fetchImpl: fetch });
    if (tok === null) {
      appleLoginLimiter.fail(ip);
      writeError(res, 401, "APPLE_CODE_FAILED", "failed to exchange apple authorization code");
      return;
    }
    refreshToken = tok.refreshToken;
    accessToken = tok.accessToken;
  }

  // 找号/建号：仅凭 sub（绝不按邮箱并号 → 防账号接管）
  let user = runtime.db.getUserByAppleSub(claims.sub);
  if (user === null) {
    const name = `apple-${claims.sub.slice(0, 12)}`;
    user = runtime.db.createAppleUser(name, claims.sub, claims.email, fullName);
  } else {
    const email = claims.email ?? user.appleEmail;
    const fn = fullName ?? user.appleFullName;
    runtime.db.bindApple(user.id, claims.sub, email, fn);
  }

  if (user.accountStatus !== "active") {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }

  // 加密存令牌
  runtime.db.storeAppleTokens(
    user.id,
    refreshToken !== null ? encryptToken(refreshToken, cfg.tokenEncKey) : null,
    accessToken !== null ? encryptToken(accessToken, cfg.tokenEncKey) : null,
    Date.now(),
  );

  const tokens = runtime.auth.issueSession(user.id);
  if (tokens === null) {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }
  runtime.db.recordAudit(user.id, "apple.login.ok", {}, ip);
  appleLoginLimiter.clear(ip);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: user.id, name: user.name } }));
}

/** 未认证用户登录：生成一次性 state（含回跳 next）→ 302 到 qrconnect（PC 扫码 / 微信内一键）。 */
async function handleWechatLoginAuthorize(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const next = safeRedirect(url.searchParams.get("next")) ?? "/hosts";
  const ip = clientIp(req, runtime);
  const state = randomToken(24);
  wechatLoginStates.set(state, { kind: "login", ip, next, expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  // 惰性清理过期 state
  for (const [s, v] of wechatLoginStates) {
    if (v.expiresAt < Date.now()) wechatLoginStates.delete(s);
  }
  res.writeHead(302, { location: wechatLoginUrl(wl.appid, wl.redirectUri, state) });
  res.end();
}

/** 登录回调：校验 state → code→openid/unionid → 找号/建号 → 发会话 → 302 回首页。 */
async function handleWechatLoginCallback(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (typeof code !== "string" || code === "" || typeof state !== "string" || state === "") {
    writeError(res, 400, "BAD_REQUEST", "missing code or state");
    return;
  }
  const ip = clientIp(req, runtime);
  const st = wechatLoginStates.get(state);
  // state = 随机 24 字符 + 一次性 + 10 分钟 TTL（标准 OAuth CSRF 防护）；
  // 不做 IP 绑定——国内宽带/移动 CGNAT 或 IP 轮换下回调 IP 会变，误伤正常登录
  if (st === undefined || st.kind !== "login" || st.expiresAt < Date.now()) {
    writeError(res, 400, "BAD_STATE", "invalid or expired state");
    return;
  }
  wechatLoginStates.delete(state); // 一次性

  const id = await exchangeWechatLoginCode(wl.appid, wl.appSecret, code);
  if (id === null) {
    writeError(res, 400, "OAUTH_FAILED", "failed to exchange code for openid");
    return;
  }

  // 找号：unionid 优先（跨应用账号身份），wxweb_openid 兜底（unionid 缺失时）
  let user = id.unionid !== null ? runtime.db.getUserByWechatUnionid(id.unionid) : null;
  if (user === null) user = runtime.db.getUserByWxwebOpenid(id.openid);
  if (user !== null) {
    // unionid 命中但本网站 openid 未记（同用户未来另一 AppID 建号后首次网页登录）→ 补绑 openid
    if (user.wxwebOpenid === null) runtime.db.bindWechat(user.id, id.openid, id.unionid, id.nickname, id.avatar);
    runtime.db.touchLastLogin(user.id); // feature 16
    runtime.db.recordAudit(user.id, "wechat.login.ok", {}, ip);
    const tokens = runtime.auth.issueSession(user.id);
    if (tokens === null) {
      writeError(res, 403, "FORBIDDEN", "account not active");
      return;
    }
    res.writeHead(302, {
      location: st.next ?? "/hosts",
      "set-cookie": [sessionCookie(tokens.accessToken), refreshCookie(tokens.refreshToken)],
    });
    res.end();
    return;
  }

  // 未找到已绑定账号 → 暂存微信身份，跳登录页让用户确认是否新建（不静默建号）
  const pendingToken = randomToken(24);
  wechatPending.set(pendingToken, { openid: id.openid, unionid: id.unionid, nickname: id.nickname, avatar: id.avatar, app: false, ip, expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  res.writeHead(302, { location: `/login?wechat-new=${encodeURIComponent(pendingToken)}&next=${encodeURIComponent(st.next ?? "/hosts")}` });
  res.end();
}

/** 确认新建账号：校验待确认 token → 建号 + 试用（同 IP 上限）→ 发会话（JSON，前端导航）。 */
async function handleWechatConfirm(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  if (wechatLoginConfig(runtime) === null) {
    wechatLoginError(res);
    return;
  }
  const body = await readJsonBody(req);
  const token = typeof body?.token === "string" ? body.token : "";
  if (token === "") {
    writeError(res, 400, "BAD_REQUEST", "missing token");
    return;
  }
  const ip = clientIp(req, runtime);
  const pending = wechatPending.get(token);
  if (pending === undefined || pending.expiresAt < Date.now()) {
    writeError(res, 400, "BAD_STATE", "invalid or expired token");
    return;
  }
  wechatPending.delete(token); // 一次性

  // 竞态兜底：确认前该微信已被绑（如另一窗口已建号）→ 直接登录
  const existing = (pending.unionid !== null ? runtime.db.getUserByWechatUnionid(pending.unionid) : null) ?? runtime.db.getUserByWxwebOpenid(pending.openid);
  let user = existing;
  if (user === null) {
    // 同 IP 试用上限（R8）
    let lim = wechatTrialRate.get(ip);
    if (lim === undefined || Date.now() - lim.windowStart > WECHAT_TRIAL_LIMIT.windowMs) {
      lim = { count: 0, windowStart: Date.now() };
    }
    if (lim.count >= WECHAT_TRIAL_LIMIT.max) {
      wechatTrialRate.set(ip, lim);
      writeError(res, 429, "RATE_LIMITED", "too many trial accounts from this IP");
      return;
    }
    lim.count += 1;
    wechatTrialRate.set(ip, lim);

    let name = `wx_${pending.unionid ?? pending.openid}`;
    let n = 1;
    while (runtime.db.getUserByName(name) !== null) {
      name = `wx_${pending.unionid ?? pending.openid}_${n++}`;
    }
    user = runtime.db.createWechatUser(name, pending.openid, pending.unionid, pending.nickname, pending.avatar);
    const trialDays = runtime.config.billing?.trialDays ?? BILLING_DEFAULTS.trialDays;
    const now = Date.now();
    runtime.db.startTrial(user.id, now, now + trialDays * 24 * 3600 * 1000);
    runtime.db.recordAudit(user.id, "wechat.login.created", { openid: pending.openid }, ip);
  }
  if (user.accountStatus !== "active") {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }
  runtime.db.touchLastLogin(user.id); // feature 16
  const tokens = runtime.auth.issueSession(user.id);
  if (tokens === null) {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "set-cookie": [sessionCookie(tokens.accessToken), refreshCookie(tokens.refreshToken)] });
  res.end(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: user.id, name: user.name } }));
}

/** 已登录用户绑定微信：state 绑定 userId → 302 到 qrconnect。 */
async function handleWechatBindAuthorize(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const state = randomToken(24);
  wechatLoginStates.set(state, { kind: "bind", ip: clientIp(req, runtime), userId: auth.userId, expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  // 绑定流程回调到 bind/callback（同域名换路径，微信校验的是授权回调域名而非路径）
  const bindUri = new URL(wl.redirectUri);
  bindUri.pathname = "/api/wechat/bind/callback";
  res.writeHead(302, { location: wechatLoginUrl(wl.appid, bindUri.toString(), state) });
  res.end();
}

/** 绑定回调：校验 state（含 userId）→ code→openid → 校验未被占用 → 绑定当前用户 → 302 回设置页。 */
async function handleWechatBindCallback(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (typeof code !== "string" || code === "" || typeof state !== "string" || state === "") {
    writeError(res, 400, "BAD_REQUEST", "missing code or state");
    return;
  }
  const st = wechatLoginStates.get(state);
  // 不做 IP 绑定（同登录流程：CGNAT/IP 轮换下会误伤）
  if (st === undefined || st.kind !== "bind" || st.expiresAt < Date.now()) {
    writeError(res, 400, "BAD_STATE", "invalid or expired state");
    return;
  }
  wechatLoginStates.delete(state);
  const userId = st.userId;
  if (userId === undefined || !Number.isInteger(userId) || userId <= 0) {
    writeError(res, 400, "BAD_STATE", "invalid state");
    return;
  }
  const id = await exchangeWechatLoginCode(wl.appid, wl.appSecret, code);
  if (id === null) {
    writeError(res, 400, "OAUTH_FAILED", "failed to exchange code for openid");
    return;
  }
  const holder = (id.unionid !== null ? runtime.db.getUserByWechatUnionid(id.unionid) : null) ?? runtime.db.getUserByWxwebOpenid(id.openid);
  if (holder !== null && holder.id !== userId) {
    writeError(res, 409, "WECHAT_ALREADY_BOUND", "this wechat is already bound to another account");
    return;
  }
  runtime.db.bindWechat(userId, id.openid, id.unionid, id.nickname, id.avatar);
  runtime.db.recordAudit(userId, "wechat.bind.ok", {}, clientIp(req, runtime));
  res.writeHead(302, { location: "/settings" });
  res.end();
}

// ---- App 微信登录（/api/app/wechat/*，JSON 会话 + scheme 回跳，复用门户公共逻辑）----

/** SDK 路径：移动应用 code → 找号/建号 → JSON 会话；新用户返回 needConfirm+pendingToken。 */
async function handleAppWechatLogin(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const cfg = runtime.config.wechatAppLogin;
  if (cfg === undefined) {
    wechatAppLoginError(res);
    return;
  }
  const ip = clientIp(req, runtime);
  if (appWechatLoginLimiter.allow(ip) > 0) {
    writeError(res, 429, "RATE_LIMITED", "too many wechat login attempts");
    return;
  }
  const body = await readJsonBody(req);
  const code = typeof body?.code === "string" ? body.code : "";
  if (code === "") {
    writeError(res, 400, "BAD_REQUEST", "missing code");
    return;
  }
  const id = await exchangeWechatLoginCode(cfg.appid, cfg.appSecret, code);
  if (id === null) {
    appWechatLoginLimiter.fail(ip);
    writeError(res, 400, "OAUTH_FAILED", "failed to exchange code for openid");
    return;
  }
  let user = id.unionid !== null ? runtime.db.getUserByWechatUnionid(id.unionid) : null;
  if (user === null) user = runtime.db.getUserByWxappOpenid(id.openid);
  if (user !== null) {
    if (user.wxappOpenid === null) runtime.db.bindWechatApp(user.id, id.openid, id.unionid, id.nickname, id.avatar);
    if (user.accountStatus !== "active") {
      writeError(res, 403, "FORBIDDEN", "account not active");
      return;
    }
    runtime.db.touchLastLogin(user.id);
    runtime.db.recordAudit(user.id, "wechat.app.login.ok", {}, ip);
    const tokens = runtime.auth.issueSession(user.id);
    if (tokens === null) {
      writeError(res, 403, "FORBIDDEN", "account not active");
      return;
    }
    appWechatLoginLimiter.clear(ip);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: user.id, name: user.name } }));
    return;
  }
  // 新用户 → 不静默建号，返回 pendingToken 由 App 确认
  const pendingToken = randomToken(24);
  wechatPending.set(pendingToken, { openid: id.openid, unionid: id.unionid, nickname: id.nickname, avatar: id.avatar, app: true, ip, expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ needConfirm: true, pendingToken }));
}

/** 确认新建账号（App 两条路径共用）：校验 pendingToken → 建号 + 试用（同 IP 上限）→ JSON 会话。 */
async function handleAppWechatConfirm(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  if (runtime.config.wechatAppLogin === undefined && wechatLoginConfig(runtime) === null) {
    wechatAppLoginError(res);
    return;
  }
  const body = await readJsonBody(req);
  const token = typeof body?.pendingToken === "string" ? body.pendingToken : "";
  if (token === "") {
    writeError(res, 400, "BAD_REQUEST", "missing pendingToken");
    return;
  }
  const ip = clientIp(req, runtime);
  const pending = wechatPending.get(token);
  if (pending === undefined || pending.expiresAt < Date.now()) {
    writeError(res, 400, "BAD_STATE", "invalid or expired token");
    return;
  }
  wechatPending.delete(token); // 一次性
  const existing = (pending.unionid !== null ? runtime.db.getUserByWechatUnionid(pending.unionid) : null) ?? (pending.app ? runtime.db.getUserByWxappOpenid(pending.openid) : runtime.db.getUserByWxwebOpenid(pending.openid));
  let user = existing;
  if (user === null) {
    let lim = wechatTrialRate.get(ip);
    if (lim === undefined || Date.now() - lim.windowStart > WECHAT_TRIAL_LIMIT.windowMs) {
      lim = { count: 0, windowStart: Date.now() };
    }
    if (lim.count >= WECHAT_TRIAL_LIMIT.max) {
      wechatTrialRate.set(ip, lim);
      writeError(res, 429, "RATE_LIMITED", "too many trial accounts from this IP");
      return;
    }
    lim.count += 1;
    wechatTrialRate.set(ip, lim);
    let name = `wx_${pending.unionid ?? pending.openid}`;
    let n = 1;
    while (runtime.db.getUserByName(name) !== null) name = `wx_${pending.unionid ?? pending.openid}_${n++}`;
    user = pending.app
      ? runtime.db.createWechatAppUser(name, pending.openid, pending.unionid, pending.nickname, pending.avatar)
      : runtime.db.createWechatUser(name, pending.openid, pending.unionid, pending.nickname, pending.avatar);
    const trialDays = runtime.config.billing?.trialDays ?? BILLING_DEFAULTS.trialDays;
    const now = Date.now();
    runtime.db.startTrial(user.id, now, now + trialDays * 24 * 3600 * 1000);
    runtime.db.recordAudit(user.id, "wechat.app.login.created", { openid: pending.openid }, ip);
  }
  if (user.accountStatus !== "active") {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }
  runtime.db.touchLastLogin(user.id);
  const tokens = runtime.auth.issueSession(user.id);
  if (tokens === null) {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: user.id, name: user.name } }));
}

/** 扫码路径第 1 步：302 到 qrconnect（网站应用），回调 /api/app/wechat/callback。 */
async function handleAppWechatAuthorize(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const state = randomToken(24);
  wechatLoginStates.set(state, { kind: "app-login", ip: clientIp(req, runtime), expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  const cb = new URL(wl.redirectUri);
  cb.pathname = "/api/app/wechat/callback";
  cb.search = "";
  cb.hash = "";
  res.writeHead(302, { location: wechatLoginUrl(wl.appid, cb.toString(), state) });
  res.end();
}

/** 扫码路径第 2 步：微信回调 → 302 回 App（handoff 一次性码 / 新用户带 needConfirm）。 */
async function handleAppWechatCallback(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  const redirect = (params: Record<string, string>): void => {
    const target = appRedirect(runtime, params);
    if (target === null) {
      writeError(res, 503, "APP_REDIRECT_DISABLED", "no app scheme configured (hub.json appSchemes)");
      return;
    }
    res.writeHead(302, { location: target });
    res.end();
  };
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (typeof code !== "string" || code === "" || typeof state !== "string" || state === "") {
    redirect({ error: "BAD_REQUEST" });
    return;
  }
  const st = wechatLoginStates.get(state);
  if (st === undefined || st.kind !== "app-login" || st.expiresAt < Date.now()) {
    redirect({ error: "BAD_STATE" });
    return;
  }
  wechatLoginStates.delete(state); // 一次性
  const ip = clientIp(req, runtime);
  const id = await exchangeWechatLoginCode(wl.appid, wl.appSecret, code);
  if (id === null) {
    redirect({ error: "OAUTH_FAILED" });
    return;
  }
  // 扫码路径用网站应用 openid（wxweb）
  let user = id.unionid !== null ? runtime.db.getUserByWechatUnionid(id.unionid) : null;
  if (user === null) user = runtime.db.getUserByWxwebOpenid(id.openid);
  if (user !== null) {
    if (user.wxwebOpenid === null) runtime.db.bindWechat(user.id, id.openid, id.unionid, id.nickname, id.avatar);
    if (user.accountStatus !== "active") {
      redirect({ error: "FORBIDDEN" });
      return;
    }
    runtime.db.touchLastLogin(user.id);
    runtime.db.recordAudit(user.id, "wechat.app.login.ok", {}, ip);
    const handoff = randomToken(24);
    wechatHandoffs.set(handoff, { userId: user.id, expiresAt: Date.now() + 60 * 1000 });
    redirect({ handoff });
    return;
  }
  const pendingToken = randomToken(24);
  wechatPending.set(pendingToken, { openid: id.openid, unionid: id.unionid, nickname: id.nickname, avatar: id.avatar, app: false, ip, expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  redirect({ needConfirm: "1", pending: pendingToken });
}

/** 扫码路径第 3 步：App 用 handoff 一次性码换 JSON 会话。 */
async function handleAppWechatHandoff(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const body = await readJsonBody(req);
  const handoff = typeof body?.handoff === "string" ? body.handoff : "";
  if (handoff === "") {
    writeError(res, 400, "BAD_REQUEST", "missing handoff");
    return;
  }
  const h = wechatHandoffs.get(handoff);
  if (h === undefined || h.expiresAt < Date.now()) {
    writeError(res, 400, "BAD_STATE", "invalid or expired handoff");
    return;
  }
  wechatHandoffs.delete(handoff); // 一次性
  const tokens = runtime.auth.issueSession(h.userId);
  if (tokens === null) {
    writeError(res, 403, "FORBIDDEN", "account not active");
    return;
  }
  const user = runtime.db.getUserById(h.userId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: h.userId, name: user?.name ?? "" } }));
}

/** SDK 绑定：已登录 + 移动应用 code → 越权检测 → 绑定 wxapp_openid。 */
async function handleAppWechatBind(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const cfg = runtime.config.wechatAppLogin;
  if (cfg === undefined) {
    wechatAppLoginError(res);
    return;
  }
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const code = typeof body?.code === "string" ? body.code : "";
  if (code === "") {
    writeError(res, 400, "BAD_REQUEST", "missing code");
    return;
  }
  const id = await exchangeWechatLoginCode(cfg.appid, cfg.appSecret, code);
  if (id === null) {
    writeError(res, 400, "OAUTH_FAILED", "failed to exchange code for openid");
    return;
  }
  const holder = (id.unionid !== null ? runtime.db.getUserByWechatUnionid(id.unionid) : null) ?? runtime.db.getUserByWxappOpenid(id.openid);
  if (holder !== null && holder.id !== auth.userId) {
    writeError(res, 409, "WECHAT_ALREADY_BOUND", "this wechat is already bound to another account");
    return;
  }
  runtime.db.bindWechatApp(auth.userId, id.openid, id.unionid, id.nickname, id.avatar);
  runtime.db.recordAudit(auth.userId, "wechat.app.bind.ok", {}, clientIp(req, runtime));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/** 扫码绑定第 0 步：已登录用户换取短时 bind token（浏览器不带会话，用它交接身份）。 */
async function handleAppWechatBindInit(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const bindToken = randomToken(24);
  wechatBindTokens.set(bindToken, { userId: auth.userId, expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ bindToken }));
}

/** 扫码绑定第 1 步：校验 bind token → 302 qrconnect（网站应用），回调 bind/callback。 */
async function handleAppWechatBindAuthorize(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const bindToken = url.searchParams.get("bindToken");
  if (bindToken === null) {
    writeError(res, 400, "BAD_STATE", "invalid or expired bind token");
    return;
  }
  const bt = wechatBindTokens.get(bindToken);
  if (bt === undefined || bt.expiresAt < Date.now()) {
    writeError(res, 400, "BAD_STATE", "invalid or expired bind token");
    return;
  }
  wechatBindTokens.delete(bindToken); // 一次性
  const state = randomToken(24);
  wechatLoginStates.set(state, { kind: "app-bind", ip: clientIp(req, runtime), userId: bt.userId, expiresAt: Date.now() + WECHAT_STATE_TTL_MS });
  const cb = new URL(wl.redirectUri);
  cb.pathname = "/api/app/wechat/bind/callback";
  cb.search = "";
  cb.hash = "";
  res.writeHead(302, { location: wechatLoginUrl(wl.appid, cb.toString(), state) });
  res.end();
}

/** 扫码绑定第 2 步：微信回调 → 越权检测 → 绑定 wxweb_openid → 302 回 App。 */
async function handleAppWechatBindCallback(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const wl = wechatLoginConfig(runtime);
  const redirect = (params: Record<string, string>): void => {
    const target = appRedirect(runtime, params);
    if (target === null) {
      writeError(res, 503, "APP_REDIRECT_DISABLED", "no app scheme configured (hub.json appSchemes)");
      return;
    }
    res.writeHead(302, { location: target });
    res.end();
  };
  if (wl === null) {
    wechatLoginError(res);
    return;
  }
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (typeof code !== "string" || code === "" || typeof state !== "string" || state === "") {
    redirect({ error: "BAD_REQUEST" });
    return;
  }
  const st = wechatLoginStates.get(state);
  if (st === undefined || st.kind !== "app-bind" || st.expiresAt < Date.now()) {
    redirect({ error: "BAD_STATE" });
    return;
  }
  wechatLoginStates.delete(state);
  const userId = st.userId;
  if (userId === undefined || !Number.isInteger(userId) || userId <= 0) {
    redirect({ error: "BAD_STATE" });
    return;
  }
  const id = await exchangeWechatLoginCode(wl.appid, wl.appSecret, code);
  if (id === null) {
    redirect({ error: "OAUTH_FAILED" });
    return;
  }
  const holder = (id.unionid !== null ? runtime.db.getUserByWechatUnionid(id.unionid) : null) ?? runtime.db.getUserByWxwebOpenid(id.openid);
  if (holder !== null && holder.id !== userId) {
    redirect({ error: "WECHAT_ALREADY_BOUND" });
    return;
  }
  runtime.db.bindWechat(userId, id.openid, id.unionid, id.nickname, id.avatar);
  runtime.db.recordAudit(userId, "wechat.app.bind.ok", {}, clientIp(req, runtime));
  redirect({ ok: "1" });
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
    case "requires-totp": {
      // 可信设备（30 天免 TOTP cookie）：签名含 ver（改密即失效），同账号才放行
      const cookies = parseCookies(req.headers.cookie);
      const trusted = cookies[TRUSTED_COOKIE];
      if (typeof trusted === "string" && trusted.length > 0) {
        const uid = runtime.auth.verifyTrustedDevice(trusted);
        const user = runtime.db.getUserByName(loginName);
        if (uid !== null && user !== null && uid === user.id) {
          limiter.clear(ip);
          const tokens = runtime.auth.issueTokens(user, true); // 可信设备 = 已验证过 2FA
          runtime.db.touchLastLogin(user.id); // feature 16
          runtime.db.recordAudit(user.id, "login.ok", { name: user.name, trustedDevice: true }, ip);
          res.writeHead(200, {
            "content-type": "application/json",
            "set-cookie": [sessionCookie(tokens.accessToken), refreshCookie(tokens.refreshToken), trustedDeviceCookie(runtime.auth.signTrustedDevice(user.id))],
          });
          res.end(
            JSON.stringify({
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              mustChangePassword: user.mustChange === 1,
              user: { id: user.id, name: user.name },
            }),
          );
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requiresTotp: true, pendingToken: result.pendingToken, name: result.name }));
      return;
    }
    case "ok": {
      limiter.clear(ip);
      const user = runtime.db.getUserByName(loginName);
      runtime.db.recordAudit(user?.id ?? null, "login.ok", {}, ip);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [sessionCookie(result.tokens.accessToken), refreshCookie(result.tokens.refreshToken)],
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
  // 全局总量闸（资源保护，MVP/试用服务器）：总量硬顶 + 每日滚动 24h 上限
  if (runtime.config.registrationMaxUsers !== undefined && runtime.db.countUsers() >= runtime.config.registrationMaxUsers) {
    writeError(res, 429, "REGISTRATION_LIMIT_REACHED", "registration capacity reached");
    return;
  }
  if (runtime.config.registrationDailyLimit !== undefined && runtime.db.countUsersCreatedSince(now - 24 * 3600 * 1000) >= runtime.config.registrationDailyLimit) {
    writeError(res, 429, "REGISTRATION_DAILY_LIMIT", "daily registration limit reached");
    return;
  }
  const body = await readJsonBody(req);
  if (!(await verifyCaptchaBody(runtime, body, { route: "auth.register", ip, userAgent: userAgentOf(req) }))) {
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
  if (!(await verifyCaptchaBody(runtime, body, { route: "auth.register.resend", ip, userAgent: userAgentOf(req) }))) {
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
  res.writeHead(200, { "content-type": "application/json", "set-cookie": [sessionCookie(tokens.accessToken), refreshCookie(tokens.refreshToken)] });
  res.end(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: user.id, name: user.name } }));
}

async function handleRefresh(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const body = await readJsonBody(req);
  const cookies = parseCookies(req.headers.cookie);
  // 优先从 HttpOnly 续期 cookie 取令牌；body 作兼容回退（旧 portal 仍以 body 传）。
  const token = cookies[REFRESH_COOKIE] ?? (body !== null && typeof body.refreshToken === "string" ? body.refreshToken : null);
  if (token === null) {
    // 无令牌 = 未登录：门户 401 → 静默续期 → 这里 401 → 判 invalid → 跳登录。
    // （若返回 400，门户会把 !ok 当作 transient「网络错误」，而不是跳登录。）
    writeError(res, 401, "MISSING_REFRESH", "missing refresh token");
    return;
  }
  const pair = runtime.auth.refresh(token);
  if (pair === null) {
    writeError(res, 401, "INVALID_REFRESH", "refresh token invalid or revoked");
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": [sessionCookie(pair.accessToken), refreshCookie(pair.refreshToken)],
  });
  res.end(JSON.stringify(pair));
}

async function handleLogout(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const body = await readJsonBody(req);
  const cookies = parseCookies(req.headers.cookie);
  // 优先从 HttpOnly 续期 cookie 取令牌吊销；body 作兼容回退。
  const token = cookies[REFRESH_COOKIE] ?? (body !== null && typeof body.refreshToken === "string" ? body.refreshToken : null);
  if (token !== null) runtime.auth.logout(token);
  // 清除访问令牌 cookie + 续期 cookie（httpOnly，客户端无法自行删除）+ host 转发 cookie：
  // 否则登出后 access JWT（1h）仍可认证 /api/*，根路径仍会直接转发进 host。
  res.writeHead(204, {
    "set-cookie": [`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, clearRefreshCookie(), clearHostCookie()],
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
  // 改密已吊销全部会话（ver+1 + revokeAllRefresh）；这里顺手清掉会话/续期 cookie，避免死 cookie 残留。
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": [`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, clearRefreshCookie()],
  });
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
const wechatLoginStates = new Map<string, { kind: "login" | "bind" | "app-login" | "app-bind"; ip: string; userId?: number; next?: string; expiresAt: number }>();
const wechatTrialRate = new Map<string, { count: number; windowStart: number }>();
const wechatPending = new Map<string, { openid: string; unionid: string | null; nickname: string | null; avatar: string | null; app: boolean; ip: string; expiresAt: number }>();
const wechatHandoffs = new Map<string, { userId: number; expiresAt: number }>();
const wechatBindTokens = new Map<string, { userId: number; expiresAt: number }>();

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

/** 绑定会话有效期（毫秒）。二维码一次性短码，行业惯例 5 分钟。 */
const BIND_SESSION_TTL_MS = 5 * 60 * 1000;

/** 创建绑定会话（未认证，限流）：插件面板「扫码接入」调用。返回一次性 consumeToken + 二维码 data URI。 */
async function handleCreateBindSession(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const ip = clientIp(req, runtime);
  const now = Date.now();
  const hit = registerRate.get(ip);
  if (hit !== undefined && now - hit.windowStart < REGISTER_RATE_LIMIT.windowMs) {
    if (hit.count >= REGISTER_RATE_LIMIT.max) {
      writeError(res, 429, "RATE_LIMITED", "too many bind-session requests");
      return;
    }
    hit.count += 1;
  } else {
    registerRate.set(ip, { count: 1, windowStart: now });
  }
  const body = await readJsonBody(req);
  const name = typeof body?.name === "string" && body.name.length > 0 ? body.name.slice(0, 64) : null;
  const e2eePublicKey = typeof body?.e2eePublicKey === "string" && body.e2eePublicKey.length > 0 ? body.e2eePublicKey.slice(0, 256) : null;
  const id = randomUUID();
  const consumeToken = randomToken();
  const expiresAt = now + BIND_SESSION_TTL_MS;
  runtime.db.createBindSession(id, sha256(consumeToken), e2eePublicKey, name, expiresAt);
  runtime.db.recordAudit(null, "bind.session.create", { bindId: id, name }, ip, now);
  let qrDataUri: string | null = null;
  try {
    qrDataUri = await QRCode.toDataURL(`rdsh://bind?code=${id}`);
  } catch {
    qrDataUri = null; // 面板可回退为展示明文 rdsh://bind?code=...
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ bindId: id, consumeToken, expiresAt, qrDataUri }));
}

/** 查询绑定会话状态（未认证；面板轮询）。过期为懒判定。 */
async function handleGetBindSession(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, id: string): Promise<void> {
  const session = runtime.db.getBindSession(id);
  if (session === null) {
    writeError(res, 404, "NOT_FOUND", "bind session not found");
    return;
  }
  const status = session.status === "pending" && session.expiresAt <= Date.now() ? "expired" : session.status;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status }));
}

/** 批准绑定会话（登录态）：把会话归属到当前账号并置 approved。重复批准幂等。 */
async function handleApproveBindSession(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, id: string): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const session = runtime.db.getBindSession(id);
  if (session === null) {
    writeError(res, 404, "NOT_FOUND", "bind session not found");
    return;
  }
  if (session.status === "consumed") {
    writeError(res, 409, "CONSUMED", "bind session already consumed");
    return;
  }
  if (session.status === "approved") {
    // 已批准：同一账号重复扫幂等返回；他人扫应明确拒绝（否则会误以为绑定成功）
    if (session.ownerId === auth.userId) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: session.name }));
      return;
    }
    writeError(res, 409, "CONFLICT", "bind session already approved by another account");
    return;
  }
  if (session.expiresAt <= Date.now()) {
    writeError(res, 410, "EXPIRED", "bind session expired");
    return;
  }
  const user = runtime.db.getUserById(auth.userId);
  if (user !== null) {
    const quota = hostQuota(runtime, user);
    if (quota !== null && runtime.db.listHostsByOwner(user.id).length >= quota) {
      writeError(res, 403, "QUOTA_EXCEEDED", "host quota exceeded for current plan");
      return;
    }
  }
  if (!runtime.db.approveBindSession(id, auth.userId)) {
    writeError(res, 409, "CONFLICT", "bind session state changed");
    return;
  }
  runtime.db.recordAudit(auth.userId, "bind.session.approve", { bindId: id, name: session.name }, clientIp(req, runtime), Date.now());
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ name: session.name }));
}

/** 领取（消费）：面板凭 consumeToken 换取 host token，会话置 consumed。 */
async function handleConsumeBindSession(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, id: string): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null || typeof body.consumeToken !== "string" || body.consumeToken.length < 16) {
    writeError(res, 400, "BAD_REQUEST", "consumeToken required");
    return;
  }
  const session = runtime.db.getBindSessionByConsumeTokenHash(sha256(body.consumeToken));
  if (session === null || session.id !== id) {
    writeError(res, 401, "UNAUTHORIZED", "invalid consume token");
    return;
  }
  if (session.status === "consumed") {
    writeError(res, 409, "CONSUMED", "bind session already consumed");
    return;
  }
  if (session.status !== "approved" || session.expiresAt <= Date.now()) {
    writeError(res, 409, "NOT_APPROVED", "bind session not approved or expired");
    return;
  }
  const hostId = randomUUID();
  const hostToken = randomToken();
  const ownerId = session.ownerId as number;
  runtime.db.createHost(hostId, ownerId, session.name ?? `host-${hostId.slice(0, 8)}`, sha256(hostToken), session.e2eePublicKey ?? undefined);
  runtime.db.consumeBindSession(id);
  runtime.db.recordAudit(ownerId, "bind.session.consume", { bindId: id, hostId, name: session.name }, clientIp(req, runtime), Date.now());
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hostId, hostToken }));
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
  return `${SESSION_COOKIE}=${accessToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL_MS / 1000}`;
}

/** 续期凭证 cookie：`Max-Age` 由 `REFRESH_TTL_MS` 换算（禁止写死，避免与常量漂移）。 */
function refreshCookie(refreshToken: string): string {
  return `${REFRESH_COOKIE}=${refreshToken}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${Math.floor(REFRESH_TTL_MS / 1000)}`;
}

/** 清续期凭证 cookie（登出/改密用）。 */
function clearRefreshCookie(): string {
  return `${REFRESH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0`;
}

function trustedDeviceCookie(token: string): string {
  return `${TRUSTED_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`;
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

/** 验证码校验（按 provider 分发）：none 跳过；aliyun VerifyCaptcha 验签；arithmetic token+answer。
 *
 * 每次结果都写日志（route/ip/ua + 失败分类 + 阿里云 RequestId）：票据是一次性的，
 * "偶发验证失败"只能靠这些字段区分"阿里云判未过""票据被复用/过期""压根没带票据""调用出错"。
 * 绝不记录票据原文，只记 sha256 指纹，便于把前端拿到的票与后端验签结果对上。 */
async function verifyCaptchaBody(
  runtime: HubRuntime,
  body: Record<string, unknown> | null,
  meta: { route: string; ip: string; userAgent: string },
): Promise<boolean> {
  const provider = runtime.config.captcha?.provider;
  if (provider === "none") return true;
  if (provider === "aliyun") {
    const cfg = runtime.config.captcha?.aliyun;
    const param = body === null ? undefined : body.captchaVerifyParam;
    if (cfg === undefined) {
      logCaptcha(meta, { outcome: "config-missing" });
      return false;
    }
    if (typeof param !== "string" || param.length === 0) {
      logCaptcha(meta, { outcome: "missing-param" });
      return false;
    }
    const r = await verifyCaptchaParam(cfg, param);
    logCaptcha(meta, {
      outcome: r.ok ? "verified" : r.error === null ? "rejected" : "error",
      ticket: param,
      requestId: r.requestId,
      code: r.code,
      error: r.error,
    });
    return r.ok;
  }
  // arithmetic（缺省）：题目 token 一次性（verifyChallenge 命中即删）
  if (body === null || typeof body.captchaToken !== "string" || typeof body.captchaAnswer !== "string") {
    logCaptcha(meta, { outcome: "missing-param" });
    return false;
  }
  const ok = verifyChallenge(body.captchaToken, body.captchaAnswer);
  logCaptcha(meta, { outcome: ok ? "verified" : "rejected", ticket: body.captchaToken });
  return ok;
}

/** 验证码结果落日志：成功走 stdout、失败走 stderr（journalctl 里可按 `rdsh hub captcha:` 筛）。 */
function logCaptcha(
  meta: { route: string; ip: string; userAgent: string },
  info: { outcome: string; ticket?: string; requestId?: string | null; code?: string | null; error?: string | null },
): void {
  const parts = [`route=${meta.route}`, `outcome=${info.outcome}`, `ip=${meta.ip}`];
  if (info.ticket !== undefined && info.ticket !== "") parts.push(`ticket=${sha256(info.ticket).slice(0, 8)}/${info.ticket.length}`);
  if (info.code !== undefined && info.code !== null) parts.push(`code=${info.code}`);
  if (info.requestId !== undefined && info.requestId !== null) parts.push(`requestId=${info.requestId}`);
  if (info.error !== undefined && info.error !== null) parts.push(`error=${info.error.replace(/\s+/g, " ").slice(0, 120)}`);
  if (meta.userAgent !== "") parts.push(`ua=${meta.userAgent.slice(0, 60)}`);
  const line = `rdsh hub captcha: ${parts.join(" ")}`;
  if (info.outcome === "verified") console.log(line);
  else console.warn(line);
}

/** 日志用 UA（长度在 logCaptcha 内截断）。 */
function userAgentOf(req: IncomingMessage): string {
  return String(req.headers["user-agent"] ?? "");
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
  const cookies = [sessionCookie(result.tokens.accessToken), refreshCookie(result.tokens.refreshToken)];
  if (body.trustDevice === true) {
    // 用户勾选「记住此设备」→ 签发 30 天可信设备 cookie（同一次 TOTP 验证即信任）
    cookies.push(trustedDeviceCookie(runtime.auth.signTrustedDevice(result.userId)));
  }
  res.writeHead(200, { "content-type": "application/json", "set-cookie": cookies });
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
  if (!(await verifyCaptchaBody(runtime, body, { route: "auth.reset", ip, userAgent: userAgentOf(req) }))) {
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

/** 日历月顺延：1月31 → 2月28/29，1月15 → 2月15（对齐商店「按月订阅」语义）。 */
export function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTarget));
  return d.getTime();
}

/** 激活订阅：建订阅行 + plan_status=subscribed + 到期时间。 */
function activateSubscription(runtime: HubRuntime, userId: number, plan: PlanSpec): void {
  const now = Date.now();
  const expiresAt = addMonths(now, plan.intervalMonths);
  runtime.db.createSubscription(userId, plan.id, now, expiresAt);
  runtime.db.setPlan(userId, "subscribed", expiresAt);
}

/** 取 unicpay 客户端；未配置时返回 null。 */
function getUnicpayClient(runtime: HubRuntime): UnicPayClient | null {
  const cfg = runtime.config.billing?.unicpay;
  return cfg === undefined ? null : new UnicPayClient(cfg);
}

/** RFC3339 字符串 → 毫秒时间戳；无效/缺省返回 null。 */
function parseRfc3339Ms(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** A 类下单代理：登录态下单 → unicpay initiate + prepay → 返回支付参数（SDK `pay()` 用）。 */
async function handleUnicpayInitiate(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const client = getUnicpayClient(runtime);
  if (client === null) {
    writeError(res, 404, "NOT_CONFIGURED", "unicpay not configured");
    return;
  }
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid JSON");
    return;
  }
  const goodsId = typeof body.goodsId === "string" ? body.goodsId : "";
  const plan = (runtime.config.billing?.plans ?? []).find((p) => p.id === goodsId);
  if (plan === undefined) {
    writeError(res, 400, "BAD_REQUEST", "unknown goodsId");
    return;
  }
  // scene：App 微信唤起（app）；portal 网页扫码（native）。缺省 app。
  const sceneRaw = typeof body.scene === "string" ? body.scene : "app";
  if (sceneRaw !== "app" && sceneRaw !== "native" && sceneRaw !== "miniapp" && sceneRaw !== "alipay") {
    writeError(res, 400, "BAD_REQUEST", "unknown scene");
    return;
  }
  const scene = sceneRaw as "app" | "native" | "miniapp" | "alipay";
  const appOrderId = randomUUID().replaceAll("-", "");
  runtime.db.createOrder(appOrderId, auth.userId, plan.id, plan.priceCny);

  const initiated = await client.initiate({
    scene,
    appOrderId,
    goodsId: plan.id,
    orderType: "subscription",
    userId: String(auth.userId),
  });
  if (initiated.status !== 200) {
    writeError(res, 502, "UPSTREAM_ERROR", "unicpay initiate failed");
    return;
  }
  const initiatedData = initiated.data as Record<string, unknown>;
  const ticketRaw = initiatedData.ticket;
  const ticket = typeof ticketRaw === "string" ? ticketRaw : "";
  if (ticket === "") {
    writeError(res, 502, "UPSTREAM_ERROR", "unicpay initiate returned no ticket");
    return;
  }
  const prepaid = await client.prepay(ticket);
  if (prepaid.status !== 200) {
    writeError(res, 502, "UPSTREAM_ERROR", "unicpay prepay failed");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ appOrderId, payParams: prepaid.data }));
}

/** prepay 代理（重取支付参数，登录态）。 */
async function handleUnicpayPrepay(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const client = getUnicpayClient(runtime);
  if (client === null) {
    writeError(res, 404, "NOT_CONFIGURED", "unicpay not configured");
    return;
  }
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  const ticket = body !== null && typeof body.ticket === "string" ? body.ticket : "";
  if (ticket === "") {
    writeError(res, 400, "BAD_REQUEST", "ticket required");
    return;
  }
  const prepaid = await client.prepay(ticket);
  if (prepaid.status !== 200) {
    writeError(res, 502, "UPSTREAM_ERROR", "unicpay prepay failed");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(prepaid.data));
}

/** B 类（商店）校验代签代理：SDK 把收据 POST 到这里，hub 验登录态后补 HMAC 转发 unicpay。 */
async function handleUnicpayStoreVerify(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const client = getUnicpayClient(runtime);
  if (client === null) {
    writeError(res, 404, "NOT_CONFIGURED", "unicpay not configured");
    return;
  }
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid JSON");
    return;
  }
  const store = typeof body.store === "string" ? body.store : "";
  const storeProductId = typeof body.storeProductId === "string" ? body.storeProductId : "";
  const receipt = typeof body.receipt === "string" ? body.receipt : "";
  if (store !== "apple" && store !== "google") {
    writeError(res, 400, "BAD_REQUEST", "unknown store");
    return;
  }
  if (storeProductId === "" || receipt === "") {
    writeError(res, 400, "BAD_REQUEST", "storeProductId and receipt required");
    return;
  }
  // userId 用鉴权结果（authoritative，改用不可变 users.id），不信任客户端声称的 body.userId。
  // 平台已废弃 environment 字段（H6a：不再转发）。
  const result = await client.storeVerify({
    userId: String(auth.userId),
    store,
    storeProductId,
    receipt,
  });
  if (result.status !== 200) {
    writeError(res, 502, "UPSTREAM_ERROR", "unicpay store/verify failed");
    return;
  }
  const data = result.data as Record<string, unknown>;
  // 映射 unicpay 响应 { goodsId, orderType, purchase, subscription } → SDK 期望的 { purchase }。
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ purchase: typeof data.purchase === "string" ? data.purchase : null }));
}

/** 入站 webhook：验签 + 幂等 + 落订阅事实/入账；退款只记录 + 告警，不撤权益（req R5）。 */
async function handleUnicpayWebhook(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const cfg = runtime.config.billing?.unicpay;
  if (cfg === undefined) {
    writeError(res, 404, "NOT_CONFIGURED", "unicpay not configured");
    return;
  }
  const rawBody = await readRawBody(req);
  const ts = req.headers["x-webhook-timestamp"];
  const nonce = req.headers["x-webhook-nonce"];
  const sig = req.headers["x-webhook-signature"];
  if (typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string" ||
      !verifyWebhookSignature(cfg.webhookSecret, ts, nonce, rawBody, sig)) {
    writeError(res, 401, "BAD_SIGNATURE", "webhook signature verification failed");
    return;
  }
  // H3：校验时间戳新鲜度（±5 分钟）。签名只覆盖 ts.nonce.body，不含新鲜度，故必须显式拒绝陈旧请求以防重放。
  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    writeError(res, 401, "BAD_SIGNATURE", "webhook timestamp is stale");
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    writeError(res, 400, "BAD_REQUEST", "invalid JSON");
    return;
  }
  const eventType = typeof body.eventType === "string" ? body.eventType : "";
  const ip = clientIp(req, runtime);

  if (eventType.startsWith("subscription.")) {
    const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId : "";
    const userIdRaw = typeof body.userId === "string" ? body.userId : "";
    if (subscriptionId === "" || userIdRaw === "") {
      writeError(res, 400, "BAD_REQUEST", "subscriptionId and userId required");
      return;
    }
    const userIdNum = Number(userIdRaw);
    const user = Number.isInteger(userIdNum) && userIdNum > 0 ? runtime.db.getUserById(userIdNum) : null;
    if (user === null) {
      // H5：未知用户不再 4xx（环境差异/DB 重建/用户已删等重试无效），改 ack + 审计，避免平台 6 次重试→死信告警。
      runtime.db.recordAudit(null, "billing.unicpay.subscription_unknown_user", { eventType, subscriptionId, userId: userIdRaw }, ip);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: "unknown userId" }));
      return;
    }
    const userId = user.id;
    const status = typeof body.status === "string" ? body.status : "active";
    const channel = typeof body.store === "string" ? body.store : "unicpay";
    const goodsId = typeof body.goodsId === "string" ? body.goodsId : "";
    const plan = (runtime.config.billing?.plans ?? []).find((p) => p.id === goodsId);
    const expiresAt = parseRfc3339Ms(body.expiresAt) ?? Date.now();
    const now = Date.now();
    const willRenew = body.willRenew === true;
    const existing = runtime.db.getSubscriptionBySubscriptionId(subscriptionId);
    // H6b 乱序守卫：revoked 对同一 subscriptionId 是终态（再购买会新建 subscriptionId），
    // 任何迟到的非 revoked 事件（active/grace/expired）整条忽略，不改订阅行、不改 plan —— 尤其防止退款后一条迟到的 expired 走 setPlan(null) 撤权。
    // 其余更新到期时间只延长（防旧 renewed 把 expires_at 改短）。
    const staleRevival = existing !== null && existing.status === "revoked" && status !== "revoked";
    const nextStatus = staleRevival ? "revoked" : status;
    const nextExpiresAt = existing === null ? expiresAt : Math.max(existing.expiresAt, expiresAt);
    runtime.db.db.exec("BEGIN");
    try {
      if (existing === null) {
        runtime.db.createSubscription(userId, plan?.id ?? goodsId, now, nextExpiresAt, now, { channel, subscriptionId, willRenew });
      } else if (!staleRevival) {
        // 同一订阅实体：续订/宽限/到期/换档复用同一行，更新档位、状态与渠道权威到期。
        runtime.db.updateSubscriptionBySubscriptionId(subscriptionId, plan?.id ?? goodsId, nextStatus, nextExpiresAt, willRenew);
      }
      if (nextStatus === "active" || nextStatus === "grace") {
        runtime.db.setPlan(userId, "subscribed", nextExpiresAt);
      } else if (nextStatus === "expired") {
        runtime.db.setPlan(userId, null, null);
      }
      // revoked / refunded / staleRevival：只记录，不撤权益
      runtime.db.db.exec("COMMIT");
    } catch (e) {
      runtime.db.db.exec("ROLLBACK");
      throw e;
    }
    runtime.db.recordAudit(userId, "billing.unicpay.subscription", { eventType, subscriptionId, status: nextStatus, channel }, ip);
  } else if (eventType === "payment.succeeded") {
    const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
    const appOrderId = typeof body.appOrderId === "string" ? body.appOrderId : "";
    if (paymentId === "" || appOrderId === "") {
      writeError(res, 400, "BAD_REQUEST", "paymentId and appOrderId required");
      return;
    }
    if (runtime.db.getPaymentByChannelOrderId("unicpay", paymentId) !== null) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, duplicate: true }));
      return;
    }
    const order = runtime.db.getOrder(appOrderId);
    if (order === null || order.status !== "created") {
      // H5：未知/已关闭订单 ack 化（环境差异/DB 重建等重试无效），改 200 + 审计，避免死信告警。
      runtime.db.recordAudit(null, "billing.unicpay.payment_unknown_order", { paymentId, appOrderId }, ip);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: "unknown or closed order" }));
      return;
    }
    // H4：金额比对 —— 平台 `amount` 为「分」（最小单位整数），本地 `order.amountCny` 为「元」。
    // 金额不符是真实的完整性故障（hub 套餐价与平台商品价漂移），保留 4xx 触发平台重试→告警，区别于 H5 的静默 ack。
    const amountMinor = typeof body.amount === "number" ? body.amount : null;
    const expectedMinor = Math.round(order.amountCny * 100);
    if (amountMinor === null || amountMinor !== expectedMinor) {
      runtime.db.recordAudit(order.userId, "billing.unicpay.payment_amount_mismatch", { paymentId, appOrderId, expectedMinor, amount: body.amount }, ip);
      writeError(res, 422, "AMOUNT_MISMATCH", "amount does not match the order");
      return;
    }
    runtime.db.db.exec("BEGIN");
    try {
      runtime.db.markOrderPaid(appOrderId, "unicpay", paymentId);
      runtime.db.createPayment(randomUUID(), appOrderId, order.userId, "unicpay", paymentId, order.amountCny, Date.now(), rawBody);
      const plan = (runtime.config.billing?.plans ?? []).find((p) => p.id === order.planId);
      if (plan !== undefined) activateSubscription(runtime, order.userId, plan);
      runtime.db.db.exec("COMMIT");
    } catch (e) {
      runtime.db.db.exec("ROLLBACK");
      throw e;
    }
    runtime.db.recordAudit(order.userId, "billing.unicpay.payment", { paymentId, appOrderId }, ip);
  } else if (eventType === "payment.refunded") {
    const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
    runtime.db.recordAudit(null, "billing.unicpay.refunded", { paymentId, appOrderId: body.appOrderId ?? null }, ip);
    console.error(`[unicpay] refunded: paymentId=${paymentId} appOrderId=${String(body.appOrderId ?? "")}`);
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ignored: eventType }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
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
  // 订单号同时作微信 out_trade_no：必须 6~32 字符（微信 v3 规则）→ UUID 去连字符 = 32 hex
  const orderId = randomUUID().replaceAll("-", "");
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
  const subs = runtime.db.listSubscriptionsByUser(auth.userId);
  const sub = subs.length > 0 ? subs[0] : null;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      planStatus: user?.planStatus ?? null,
      planId: sub?.planId ?? null,
      planExpiresAt: user?.planExpiresAt ?? null,
      channel: sub?.channel ?? null,
      willRenew: sub?.willRenew ?? false,
      status: sub?.status ?? null,
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
    const serial = req.headers["wechatpay-serial"];
    if (
      typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string" ||
      (typeof serial === "string" && serial !== cfg.platformCertSerialNo) ||
      !verifyWechatCallback(cfg.platformCert, ts, nonce, sig, rawBody)
    ) {
      writeError(res, 400, "BAD_SIGNATURE", "wechatpay signature verification failed");
      return;
    }
    // F10：只处理交易成功事件；退款等其他事件 ACK 忽略（退款后置 T6）
    const eventType = typeof body.event_type === "string" ? body.event_type : "";
    if (eventType !== "" && eventType !== "TRANSACTION.SUCCESS") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ignored: eventType }));
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
  // F9：实付金额必须等于订单金额（防短款/配置漂移）
  if (amountCny !== null && Math.abs(amountCny - order.amountCny) > 0.009) {
    writeError(res, 400, "AMOUNT_MISMATCH", "paid amount does not match order");
    return;
  }
  const amount = amountCny ?? order.amountCny;
  const plan = (runtime.config.billing?.plans ?? []).find((p) => p.id === order.planId);
  // F11：入账 + 订阅激活原子化（订单置 paid + payment 记录 + 订阅同事务），任一步失败整体回滚 → 重试可完整重放
  runtime.db.db.exec("BEGIN");
  try {
    runtime.db.markOrderPaid(orderId, channel, channelOrderId);
    runtime.db.createPayment(randomUUID(), orderId, order.userId, channel, channelOrderId, amount, Date.now(), rawBody);
    if (plan !== undefined) activateSubscription(runtime, order.userId, plan);
    runtime.db.db.exec("COMMIT");
  } catch (err) {
    runtime.db.db.exec("ROLLBACK");
    throw err;
  }
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
      role: user.role,
      email: user.email,
      emailVerified: user.emailVerified === 1,
      phone: user.phone,
      phoneVerified: user.phoneVerified === 1,
      totpEnabled: user.totpSecret !== null,
      wechatBound: user.wxwebOpenid !== null,
      wechatNickname: user.wechatNickname,
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
  // 吊销 Apple 令牌（尽力而为；失败仅记审计，不阻断删号）
  const appleCfg = appleLoginConfig(runtime);
  if (appleCfg !== null) {
    const atok = runtime.db.getAppleTokens(auth.userId);
    if (atok !== null && atok.refreshTokenEnc !== null) {
      const refreshToken = decryptToken(atok.refreshTokenEnc, appleCfg.tokenEncKey);
      if (refreshToken !== null) {
        try {
          const key = await loadApplePrivateKey(appleCfg.privateKeyPath);
          const clientSecret = makeAppleClientSecret({ teamId: appleCfg.teamId, keyId: appleCfg.keyId, clientId: appleCfg.clientId, privateKeyPem: key, nowMs: Date.now() });
          const ok = await revokeAppleToken(refreshToken, { clientId: appleCfg.clientId, clientSecret, fetchImpl: fetch });
          if (!ok) runtime.db.recordAudit(auth.userId, "apple.revoke.failed", {}, clientIp(req, runtime));
        } catch {
          runtime.db.recordAudit(auth.userId, "apple.revoke.failed", {}, clientIp(req, runtime));
        }
      }
    }
  }
  runtime.db.recordAudit(auth.userId, "account.deleted", {}, clientIp(req, runtime));
  runtime.db.deleteAccount(auth.userId);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/** 计费状态机定时扫描：trial/subscribed 到期 → grace → free（0 台离线）；
 * 管理台手工给 plan-null 账号设的到期（feature 16 E1）→ 到期硬降 free（无 grace）。 */
export function sweepBilling(runtime: HubRuntime, now = Date.now()): void {
  const billing = runtime.config.billing;
  const graceDays = billing?.graceDays ?? BILLING_DEFAULTS.graceDays;
  const retentionDays = billing?.retentionDays ?? BILLING_DEFAULTS.retentionDays;
  const day = 24 * 3600 * 1000;
  const dropHosts = (userId: number): void => {
    for (const host of runtime.db.listHostsByOwner(userId)) {
      const conn = runtime.tunnels.get(host.id);
      if (conn !== null) conn.terminate();
      runtime.tunnels.unregister(host.id);
    }
  };
  for (const user of runtime.db.listUsers()) {
    if (user.accountStatus !== "active") continue;
    // E1：plan-null 账号被手工设了到期（billing 路径总带 planStatus，不会走到这）→ 到期硬降 free
    if (user.planStatus === null && user.planExpiresAt !== null && user.planExpiresAt <= now) {
      runtime.db.setPlan(user.id, "free", null);
      runtime.db.setFreeSince(user.id, now);
      dropHosts(user.id);
      runtime.db.recordAudit(user.id, "billing.expired", { from: "manual-expiry" }, "");
      continue;
    }
    if (user.planStatus === null || user.planExpiresAt === null) continue;
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
      dropHosts(user.id);
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
