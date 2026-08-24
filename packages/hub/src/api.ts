/**
 * api.ts — 层 1 hub 对外 API（契约见 req R5，错误统一 {error:{code,message}}）。
 *
 * 认证：`Authorization: Bearer <access>` 或 Cookie `rdsh_session`（HttpOnly）。
 * 无开放注册端点（账号由 `rdsh hub user add` 创建，防 bot/垃圾注入）。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubConfig } from "./config.ts";
import type { HubDb } from "./db.ts";
import type { HubAuth } from "./auth.ts";
import { createLoginLimiter } from "./auth.ts";
import type { TunnelRegistry } from "./tunnel.ts";
import type { EventHub } from "./events.ts";
import { randomToken, sha256 } from "./jwt.ts";

export const SESSION_COOKIE = "rdsh_session";
const PAIR_CODE_TTL_MS = 10 * 60 * 1000; // 配对码 10 分钟
const PENDING_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 }; // pending 创建防滥用：10 次/分钟/IP
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
function clientIp(req: IncomingMessage, runtime: HubRuntime): string {
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

  // ---- host 端点 ----
  if (path === "/api/hosts" && method === "GET") {
    await handleListHosts(req, res, runtime);
    return true;
  }
  if (path === "/api/hosts/pending" && method === "POST") {
    await handleCreatePending(req, res, runtime);
    return true;
  }
  if (path === "/api/hosts/bind" && method === "POST") {
    await handleBind(req, res, runtime);
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
  const pendingMatch = /^\/api\/hosts\/pending\/([^/]+)$/.exec(path);
  if (pendingMatch !== null && method === "GET") {
    await handlePollPending(req, res, runtime, decodeURIComponent(pendingMatch[1]!));
    return true;
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
  if (result === null) {
    const locked = limiter.fail(ip);
    if (locked > 0) {
      writeError(res, 429, "RATE_LIMITED", "too many attempts", locked);
      return;
    }
    writeError(res, 401, "BAD_CREDENTIALS", "invalid username or password");
    return;
  }
  limiter.clear(ip);
  const user = runtime.db.getUserByName(body.name);
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": sessionCookie(result.tokens.accessToken),
  });
  res.end(JSON.stringify({
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    mustChangePassword: result.mustChangePassword,
    user: { id: user?.id, name: user?.name },
  }));
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
  const hosts = runtime.db.listHostsByOwner(auth.userId);
  const out = hosts.map((h) => ({
    id: h.id,
    name: h.name,
    online: runtime.tunnels.isOnline(h.id),
    createdAt: h.createdAt,
  }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hosts: out }));
}

async function handleCreatePending(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  // gateway 未认证调用（还没有 token）—— IP 限流防滥用（10 次/分钟）
  const ip = clientIp(req, runtime);
  const now = Date.now();
  const hit = pendingRate.get(ip);
  if (hit !== undefined && now - hit.windowStart < PENDING_RATE_LIMIT.windowMs) {
    if (hit.count >= PENDING_RATE_LIMIT.max) {
      writeError(res, 429, "RATE_LIMITED", "too many pending requests");
      return;
    }
    hit.count += 1;
  } else {
    pendingRate.set(ip, { count: 1, windowStart: now });
  }
  runtime.db.pruneExpiredPending();
  const pendingId = randomUUID();
  const code = generateUniqueCode(runtime);
  runtime.db.createPending(pendingId, code, now + PAIR_CODE_TTL_MS);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ pendingId, code, expiresInSeconds: PAIR_CODE_TTL_MS / 1000 }));
}

const pendingRate = new Map<string, { count: number; windowStart: number }>();
const loginLimiters = new Map<string, ReturnType<typeof createLoginLimiter>>();
const SELF_REVOKE_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 }; // 未认证端点：10 次/分钟/IP
const selfRevokeRate = new Map<string, { count: number; windowStart: number }>();
const registerRate = new Map<string, { count: number; windowStart: number }>();

function generateUniqueCode(runtime: HubRuntime): string {
  for (let i = 0; i < 100; i++) {
    const code = String(100000 + Math.floor(Math.random() * 900000)); // 6 位数字
    if (runtime.db.getPendingByCode(code) === null) return code;
  }
  throw new Error("failed to generate unique pair code");
}

async function handleBind(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
    writeError(res, 400, "BAD_REQUEST", "invalid pair code");
    return;
  }
  const pending = runtime.db.getPendingByCode(body.code);
  if (pending === null || pending.used === 1 || pending.expiresAt <= Date.now()) {
    writeError(res, 400, "BAD_CODE", "pair code invalid or expired");
    return;
  }
  const hostId = randomUUID();
  const hostToken = randomToken();
  runtime.db.createHost(hostId, auth.userId, `host-${hostId.slice(0, 8)}`, sha256(hostToken));
  runtime.db.setPendingToken(pending.id, hostToken);
  runtime.db.markPendingUsed(pending.id);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hostId, name: `host-${hostId.slice(0, 8)}` }));
}

async function handlePollPending(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, pendingId: string): Promise<void> {
  const pending = runtime.db.getPendingById(pendingId);
  if (pending === null) {
    writeError(res, 404, "NOT_FOUND", "pending not found");
    return;
  }
  if (pending.used === 0) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "pending" }));
    return;
  }
  if (pending.expiresAt <= Date.now()) {
    writeError(res, 410, "EXPIRED", "pending expired");
    return;
  }
  const token = pending.tokenPlain;
  if (token === null) {
    writeError(res, 410, "TOKEN_TAKEN", "host token already taken");
    return;
  }
  runtime.db.clearPendingToken(pending.id);
  // 从 hosts 取 hostId
  const host = runtime.db.findHostByTokenHash(sha256(token));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "bound", hostId: host?.id ?? null, token }));
}

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
