/**
 * api.ts — 层 1 hub 对外 API（契约见 req R5，错误统一 {error:{code,message}}）。
 *
 * 认证：`Authorization: Bearer <access>` 或 Cookie `rdsh_session`（HttpOnly）。
 * 无开放注册端点（账号由 `rdsh hub user add` 创建，防 bot/垃圾注入）。
 */
import { randomInt, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubConfig } from "./config.ts";
import type { HubDb } from "./db.ts";
import type { HubAuth } from "./auth.ts";
import { createLoginLimiter, hashPassword } from "./auth.ts";
import type { TunnelRegistry } from "./tunnel.ts";
import type { EventHub } from "./events.ts";
import { randomToken, sha256 } from "./jwt.ts";
import { createEmailSender } from "./email/index.ts";
import type { EmailSender } from "./email/index.ts";
import { createChallenge, verifyChallenge } from "./captcha.ts";
import { DailyWindowLimiter } from "./ratelimit.ts";

export const SESSION_COOKIE = "rdsh_session";
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

/** 主入口：处理 /api/*（含 /api/auth/*）；返回是否已处理。 */
export async function handleApi(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  if (!url.pathname.startsWith("/api/")) return false;

  const path = url.pathname;
  const method = req.method ?? "GET";

  // ---- 认证端点 ----
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
  if (path === "/api/auth/register") {
    // 注册关闭（管理员建号）—— 显式 404，防 bot 探测
    writeError(res, 404, "NOT_FOUND", "registration is disabled");
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
  if (body === null || typeof body.name !== "string" || typeof body.password !== "string") {
    writeError(res, 400, "BAD_REQUEST", "invalid body");
    return;
  }
  const result = await runtime.auth.login(body.name, body.password);
  switch (result.kind) {
    case "locked":
      limiter.clear(ip);
      runtime.db.recordAudit(null, "login.locked", { name: body.name }, ip);
      writeError(res, 423, "ACCOUNT_LOCKED", "account locked due to too many failures", result.lockedUntil - Date.now());
      return;
    case "bad-credentials": {
      const locked = limiter.fail(ip);
      runtime.db.recordAudit(null, "login.failed", { name: body.name }, ip);
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
      const user = runtime.db.getUserByName(body.name);
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
  res.writeHead(204);
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
  }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hosts: out }));
}

const loginLimiters = new Map<string, ReturnType<typeof createLoginLimiter>>();
const SELF_REVOKE_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 }; // 未认证端点：10 次/分钟/IP
const selfRevokeRate = new Map<string, { count: number; windowStart: number }>();
const registerRate = new Map<string, { count: number; windowStart: number }>();

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
  // 2) join token → 校验 + 建 host（预留账号配额检查点，SaaS 时在此加 host 数限制）
  const jt = runtime.db.getJoinTokenByHash(hash);
  if (jt === null || jt.revoked === 1 || jt.expiresAt <= now) {
    writeError(res, 401, "UNAUTHORIZED", "join token invalid, expired, or revoked");
    return;
  }
  const hostId = randomUUID();
  const hostToken = randomToken();
  runtime.db.createHost(hostId, jt.ownerId, name ?? `host-${hostId.slice(0, 8)}`, sha256(hostToken));
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
  const email = normalEmail(body);
  if (email === null) {
    writeError(res, 400, "BAD_REQUEST", "invalid email");
    return;
  }
  if (runtime.config.captcha?.provider !== "none") {
    if (typeof body?.captchaToken !== "string" || typeof body.captchaAnswer !== "string" || !verifyChallenge(body.captchaToken, body.captchaAnswer)) {
      writeError(res, 400, "BAD_CAPTCHA", "captcha failed");
      return;
    }
  }
  const user = runtime.db.getUserByEmail(email);
  if (user !== null && user.emailVerified === 1) {
    await sendEmailCode(runtime, { purpose: "reset", email, userId: user.id, ip, subject: "remote-dsh password reset" });
  }
  // 统一响应（防枚举）：邮箱是否存在都返回 ok
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleResetConfirm(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const ip = clientIp(req, runtime);
  const body = await readJsonBody(req);
  const email = normalEmail(body);
  if (email === null || body === null || typeof body.code !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 8) {
    writeError(res, 400, "BAD_REQUEST", "invalid body (newPassword must be >= 8 chars)");
    return;
  }
  const user = runtime.db.getUserByEmail(email);
  if (user === null || !verifyEmailCode(runtime.db, email, "reset", body.code)) {
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

export function writeError(res: ServerResponse, status: number, code: string, message: string, retryAfterMs?: number): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfterMs !== undefined) headers["retry-after"] = String(Math.ceil(retryAfterMs / 1000));
  res.writeHead(status, headers);
  res.end(JSON.stringify({ error: { code, message } }));
}
