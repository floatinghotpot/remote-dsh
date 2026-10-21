/**
 * internal-llm.ts — 49-llm-router：Hub 内部机器对机器 API。
 *
 * 由 LLM Router（私有 Go 服务）以服务令牌调用；不经用户会话，也不对外。
 * 职责：LLM key 生命周期 + authorize（验 key + reserve）+ settle / release + usage。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomToken, sha256 } from "./jwt.ts";
import { writeError, type HubRuntime } from "./api.ts";
import type { ServiceTokenRow } from "./db.ts";

const LLM_KEY_PREFIX = "sk-rdsh-";

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function scopesOf(token: ServiceTokenRow): Set<string> {
  return new Set(token.scopes.split(",").map((s) => s.trim()).filter((s) => s !== ""));
}

async function authenticateService(req: IncomingMessage, runtime: HubRuntime, scope: string): Promise<ServiceTokenRow | null> {
  const token = bearerToken(req);
  if (token === null || token.length < 16) return null;
  const row = await runtime.store.findServiceTokenByHash(sha256(token));
  if (row === null || row.revokedAt !== null) return null;
  if (!scopesOf(row).has(scope)) return null;
  return row;
}

/** 判定模型是否在 key 白名单内；allowlist 为 null/空 = 全部允许。 */
function modelAllowed(key: { modelAllowlist: string | null }, model: string): boolean {
  const list = key.modelAllowlist;
  if (list === null || list.trim() === "") return true;
  return list.split(",").map((s) => s.trim()).includes(model);
}

export async function handleInternalApi(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const path = url.pathname;
  if (!path.startsWith("/api/internal/llm/")) return false;
  const method = req.method ?? "GET";

  // POST /api/internal/llm/keys
  if (path === "/api/internal/llm/keys" && method === "POST") {
    if ((await authenticateService(req, runtime, "llm:key:create")) === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const body = await readJson(req);
    if (body === null) return void writeError(res, 400, "BAD_REQUEST", "invalid json"), true;
    const userId = Number(body.userId);
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!Number.isSafeInteger(userId) || userId <= 0 || agentId === "") return void writeError(res, 400, "BAD_REQUEST", "userId + agentId required"), true;
    const budgetMicro = body.budgetMicro === undefined ? 0 : Number(body.budgetMicro);
    if (!Number.isSafeInteger(budgetMicro) || budgetMicro < 0) return void writeError(res, 400, "BAD_REQUEST", "invalid budgetMicro"), true;
    const modelAllowlist = typeof body.modelAllowlist === "string" && body.modelAllowlist.trim() !== "" ? body.modelAllowlist.trim() : null;
    const expiresAt = body.expiresAt === undefined || body.expiresAt === null ? null : Number(body.expiresAt);
    if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) return void writeError(res, 400, "BAD_REQUEST", "invalid expiresAt"), true;
    const token = `${LLM_KEY_PREFIX}${randomToken()}`;
    const key = await runtime.store.createLlmKey({
      id: randomUUID(),
      userId,
      agentId,
      tokenHash: sha256(token),
      name: typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : agentId,
      modelAllowlist,
      budgetMicro,
      expiresAt,
    });
    return void json(res, 200, { keyId: key.id, token, agentId, userId, budgetMicro, modelAllowlist, expiresAt }), true;
  }

  // POST /api/internal/llm/keys/{id}/revoke
  const revokeMatch = /^\/api\/internal\/llm\/keys\/([^/]+)\/revoke$/.exec(path);
  if (revokeMatch !== null && method === "POST") {
    if ((await authenticateService(req, runtime, "llm:key:revoke")) === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const ok = await runtime.store.revokeLlmKey(decodeURIComponent(revokeMatch[1]!));
    return void json(res, ok ? 200 : 404, { ok }), true;
  }

  // POST /api/internal/llm/authorize（验 key + 模型白名单 + 预算 + reserve）
  if (path === "/api/internal/llm/authorize" && method === "POST") {
    if ((await authenticateService(req, runtime, "llm:authorize")) === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const body = await readJson(req);
    if (body === null) return void writeError(res, 400, "BAD_REQUEST", "invalid json"), true;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const estimateMicro = body.estimateMicro === undefined ? 0 : Number(body.estimateMicro);
    if (token === "" || model === "" || requestId === "" || !Number.isSafeInteger(estimateMicro) || estimateMicro <= 0) {
      return void writeError(res, 400, "BAD_REQUEST", "token + model + requestId + estimateMicro required"), true;
    }
    const key = await runtime.store.findLlmKeyByHash(sha256(token));
    if (key === null || key.status !== "active") return void writeError(res, 401, "UNAUTHORIZED", "invalid or revoked key"), true;
    if (key.expiresAt !== null && key.expiresAt <= Date.now()) return void writeError(res, 401, "UNAUTHORIZED", "key expired"), true;
    if (!modelAllowed(key, model)) return void writeError(res, 403, "MODEL_NOT_ALLOWED", "model not allowed for this key"), true;
    if (key.budgetMicro > 0 && estimateMicro > key.budgetMicro - key.spentMicro) {
      return void writeError(res, 402, "QUOTA_EXCEEDED", "agent budget exhausted"), true;
    }
    const user = await runtime.store.getUserById(key.userId);
    if (user === null || user.accountStatus !== "active") return void writeError(res, 401, "UNAUTHORIZED", "user inactive"), true;
    const reserve = await runtime.store.reserveCreditHold(key.userId, estimateMicro, {
      scopeType: "llm_agent",
      scopeId: key.agentId,
      requestId,
      ttlMs: body.ttlMs === undefined ? 600_000 : Number(body.ttlMs),
    });
    if (reserve.status === "insufficient") return void writeError(res, 402, "INSUFFICIENT_CREDITS", "insufficient credits"), true;
    const hold = reserve.hold!;
    return void json(res, 200, { keyId: key.id, userId: key.userId, agentId: key.agentId, holdId: hold.id, availableMicro: reserve.availableMicro }), true;
  }

  // POST /api/internal/llm/holds/{id}/settle
  const settleMatch = /^\/api\/internal\/llm\/holds\/([^/]+)\/settle$/.exec(path);
  if (settleMatch !== null && method === "POST") {
    if ((await authenticateService(req, runtime, "llm:settle")) === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const body = await readJson(req);
    if (body === null) return void writeError(res, 400, "BAD_REQUEST", "invalid json"), true;
    const actualMicro = body.actualMicro === undefined ? -1 : Number(body.actualMicro);
    if (!Number.isSafeInteger(actualMicro) || actualMicro < 0) return void writeError(res, 400, "BAD_REQUEST", "invalid actualMicro"), true;
    const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
    if (keyId === "") return void writeError(res, 400, "BAD_REQUEST", "keyId required"), true;
    const key = await runtime.store.getLlmKeyById(keyId);
    if (key === null) return void writeError(res, 404, "NOT_FOUND", "key not found"), true;
    const settle = await runtime.store.settleCreditHold(decodeURIComponent(settleMatch[1]!), actualMicro, { reason: "consume_llm" });
    if (settle.status === "not_found") return void writeError(res, 404, "NOT_FOUND", "hold not found"), true;
    if (settle.status === "released") return void writeError(res, 409, "CONFLICT", "hold already released"), true;
    if (settle.status === "insufficient") return void writeError(res, 402, "INSUFFICIENT_CREDITS", "insufficient credits"), true;
    if (settle.status === "already_settled") {
      // 幂等重试：hold 已结算，不再累加 spent / 重复写 usage。
      return void json(res, 200, { chargedMicro: settle.chargedMicro, balance: settle.balance }), true;
    }
    if (actualMicro > 0) await runtime.store.addLlmKeySpent(key.id, actualMicro);
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const created = Date.now();
    await runtime.store.createLlmRequest({
      id: typeof body.requestId === "string" && body.requestId !== "" ? body.requestId : randomUUID(),
      userId: key.userId,
      agentId: key.agentId,
      keyId: key.id,
      modelAlias: typeof body.modelAlias === "string" ? body.modelAlias : "",
      provider: typeof body.provider === "string" ? body.provider : "",
      upstreamModel: typeof body.upstreamModel === "string" ? body.upstreamModel : "",
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      reasoningTokens: Number(usage.reasoningTokens ?? 0),
      providerCostMicro: body.providerCostMicro === undefined ? 0 : Number(body.providerCostMicro),
      chargedMicro: actualMicro,
      status: "ok",
      errorCode: null,
      latencyMs: body.latencyMs === undefined ? null : Number(body.latencyMs),
      ttftMs: body.ttftMs === undefined ? null : Number(body.ttftMs),
      createdAt: created,
    });
    return void json(res, 200, { chargedMicro: actualMicro, balance: settle.balance }), true;
  }

  // POST /api/internal/llm/holds/{id}/release
  const releaseMatch = /^\/api\/internal\/llm\/holds\/([^/]+)\/release$/.exec(path);
  if (releaseMatch !== null && method === "POST") {
    if ((await authenticateService(req, runtime, "llm:release")) === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const ok = await runtime.store.releaseCreditHold(decodeURIComponent(releaseMatch[1]!));
    return void json(res, ok ? 200 : 404, { ok }), true;
  }

  // GET /api/internal/llm/usage
  if (path === "/api/internal/llm/usage" && method === "GET") {
    if ((await authenticateService(req, runtime, "llm:usage:read")) === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const userId = url.searchParams.get("userId");
    const agentId = url.searchParams.get("agentId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = await runtime.store.listLlmRequests({
      userId: userId === null ? undefined : Number(userId),
      agentId: agentId ?? undefined,
      from: from === null ? undefined : Number(from),
      to: to === null ? undefined : Number(to),
    });
    return void json(res, 200, { requests: rows }), true;
  }

  return false;
}
