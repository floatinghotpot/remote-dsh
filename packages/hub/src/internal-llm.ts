/**
 * internal-llm.ts — 49-llm-router：Hub 内部机器对机器 API。
 *
 * 由 LLM Router（私有 Go 服务）以服务令牌调用；不经用户会话，也不对外。
 * 职责：LLM key 生命周期 + authorize（验 key + reserve）+ settle / release + usage。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomToken, sha256 } from "./jwt.ts";
import { clientIp, writeError, type HubRuntime } from "./api.ts";
import { sealConfig } from "./crypto-upstream-keys.ts";
import { decryptKeyRow } from "./llm-upstream-keys.ts";
import { beijingDate } from "./pricing/index.ts";
import type { ServiceTokenRow } from "./db.ts";

const LLM_KEY_PREFIX = "sk-";

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
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

export async function authenticateService(req: IncomingMessage, runtime: HubRuntime, scope: string): Promise<ServiceTokenRow | null> {
  const token = bearerToken(req);
  if (token === null || token.length < 16) return null;
  const row = await runtime.store.findServiceTokenByHash(sha256(token));
  if (row === null || row.revokedAt !== null) return null;
  if (!scopesOf(row).has(scope)) return null;
  return row;
}

export function parseCapabilities(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
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
      hostId: null,
      tokenHash: sha256(token),
      name: typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : agentId,
      tokenHead4: token.slice(3, 7),
      tokenTail4: token.slice(-4),
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
    const id = decodeURIComponent(revokeMatch[1]!);
    const key = await runtime.store.getLlmKeyById(id);
    if (key === null) return void json(res, 404, { ok: false }), true;
    if (key.hostId !== null) return void writeError(res, 403, "FORBIDDEN", "host-managed key cannot be revoked here"), true;
    const ok = await runtime.store.revokeLlmKey(id);
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
    // 按天聚合（不写逐条明细）：存储量 = 用户 × key × 模型 × 天，而非请求数。
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const created = Date.now();
    const date = beijingDate(new Date(created));
    // 扣费 + 加 spent + 写用量 同一事务（失败整体回滚，Router 重试整段重做）。
    const settle = await runtime.store.settleLlmHold(decodeURIComponent(settleMatch[1]!), actualMicro, {
      keyId: key.id,
      agentId: key.agentId ?? "",
      userId: key.userId,
      modelAlias: typeof body.modelAlias === "string" ? body.modelAlias : "",
      date,
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      reasoningTokens: Number(usage.reasoningTokens ?? 0),
      provider: typeof body.provider === "string" ? body.provider.trim() : "",
      upstreamModel: typeof body.upstreamModel === "string" ? body.upstreamModel.trim() : "",
    });
    if (settle.status === "not_found") return void writeError(res, 404, "NOT_FOUND", "hold not found"), true;
    if (settle.status === "released") return void writeError(res, 409, "CONFLICT", "hold already released"), true;
    if (settle.status === "insufficient") return void writeError(res, 402, "INSUFFICIENT_CREDITS", "insufficient credits"), true;
    if (settle.status === "already_settled") {
      // 幂等重试：hold 已结算，用量已随首次结算写入。
      return void json(res, 200, { chargedMicro: settle.chargedMicro, balance: settle.balance }), true;
    }
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
    const rows = await runtime.store.listLlmUsageDaily({
      userId: userId === null ? undefined : Number(userId),
      agentId: agentId ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
    });
    return void json(res, 200, { daily: rows }), true;
  }

  // POST /api/internal/llm/routers/join（一次性 join token → 唯一 token + pending router）
  if (path === "/api/internal/llm/routers/join" && method === "POST") {
    const joinToken = bearerToken(req);
    if (joinToken === null || joinToken.length < 16) return void writeError(res, 401, "UNAUTHORIZED", "missing join token"), true;
    const jt = await runtime.store.findLlmRouterJoinTokenByHash(sha256(joinToken));
    if (jt === null || jt.usedAt !== null || jt.expiresAt <= Date.now()) return void writeError(res, 401, "UNAUTHORIZED", "invalid, used or expired join token"), true;
    if (jt.service !== "llm") return void writeError(res, 401, "UNAUTHORIZED", "join token is not for llm routers"), true;
    const body = await readJson(req);
    const name = body !== null && typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : "router";
    const publicBaseUrl = body !== null && typeof body.publicBaseURL === "string" && body.publicBaseURL.trim() !== "" ? body.publicBaseURL.trim() : null;
    if (!(await runtime.store.markLlmRouterJoinTokenUsed(jt.id))) return void writeError(res, 409, "CONFLICT", "join token already used"), true;
    const token = `rdsh-rt-${randomToken()}`;
    const tokenRow = await runtime.store.createServiceToken(randomUUID(), `llm-router:${name}`, sha256(token), "llm:config:read,llm:authorize,llm:settle,llm:release");
    const routerId = randomUUID();
    await runtime.store.createLlmRouter(routerId, name, tokenRow.id, clientIp(req, runtime), publicBaseUrl, "llm");
    return void json(res, 200, { routerId, token }), true;
  }

  // GET /api/internal/llm/config（唯一 token + active 才返回整段配置，密文密封）
  // 68：下发 v2 —— providers（keys + protocols）+ models（目录 + 内嵌 pool）。
  if (path === "/api/internal/llm/config" && method === "GET") {
    const rawToken = bearerToken(req);
    if (rawToken === null || rawToken.length < 16) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const row = await authenticateService(req, runtime, "llm:config:read");
    if (row === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const router = await runtime.store.getLlmRouterByTokenId(row.id);
    if (router === null || router.status !== "active") return void writeError(res, 403, "ROUTER_NOT_APPROVED", "router not approved"), true;
    await runtime.store.touchLlmRouterSeen(router.id, clientIp(req, runtime));

    // providers：enabled 的 llm key，按 provider 分组；capabilities 过滤 llm。
    const providers: Record<string, { keys: Array<{ id: string; apiKey: string; capabilities: string[] | null; weight: number; maxConcurrency: number }>; protocols: Record<string, { baseURL: string }> }> = {};
    for (const k of await runtime.store.listLlmUpstreamKeys()) {
      if (!k.enabled || k.revokedAt !== null || k.service !== "llm") continue;
      const caps = parseCapabilities(k.capabilities);
      if (caps !== null && !caps.includes("llm")) continue;
      const pcfg = await runtime.store.getProviderConfig(k.provider);
      if (pcfg === null) continue;
      let params: Record<string, unknown>;
      try { params = JSON.parse(pcfg.params) as Record<string, unknown>; } catch { continue; }
      const llm = (params.llm ?? {}) as Record<string, unknown>;
      const protocols = (llm.protocols ?? {}) as Record<string, { baseURL?: string }>;
      const cleaned: Record<string, { baseURL: string }> = {};
      for (const [name, cfg] of Object.entries(protocols)) {
        if (typeof cfg?.baseURL === "string" && cfg.baseURL !== "") cleaned[name] = { baseURL: cfg.baseURL };
      }
      if (Object.keys(cleaned).length === 0) continue;
      let apiKey: string;
      try {
        apiKey = decryptKeyRow(runtime, k);
      } catch (err) {
        console.warn(`rdsh-hub: skip llm key ${k.id} (provider=${k.provider}): decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const entry = providers[k.provider] ?? (providers[k.provider] = { keys: [], protocols: cleaned });
      entry.keys.push({ id: k.id, apiKey, capabilities: caps, weight: k.weight, maxConcurrency: k.maxConcurrency });
    }
    if (Object.keys(providers).length === 0) return void writeError(res, 503, "NO_UPSTREAM_KEY", "no enabled upstream key"), true;

    // models：enabled 的 llm 模型代理 + 有效上游（enabled 池条目 + provider 有 key）。
    // 目录元数据（displayName/context/maxTokens）沿用 llm_models；价格优先 services.prices。
    const llmModels = new Map((await runtime.store.listLlmModels({ enabledOnly: true })).map((m) => [m.id, m]));
    const pool = await runtime.store.listServicePool();
    const models: Record<string, {
      displayName: string; inputPriceMicro: number; outputPriceMicro: number;
      cacheReadPriceMicro: number; cacheWritePriceMicro: number;
      contextWindow: number; maxTokens: number;
      pool: Record<string, string>;
    }> = {};
    for (const s of await runtime.store.listServices()) {
      if (!s.enabled || s.capability !== "llm") continue;
      const meta = llmModels.get(s.service);
      const candidates = pool.filter((p) => p.service === s.service && p.enabled && providers[p.provider] !== undefined);
      if (candidates.length === 0) continue;
      let prices: Record<string, number> = {};
      try { prices = JSON.parse(s.prices) as Record<string, number>; } catch { prices = {}; }
      // P2-1：llm_models 缺失（UI 新增的模型代理）时用 services 自身 + 默认容量，仍可路由。
      models[s.service] = {
        displayName: s.displayName ?? meta?.displayName ?? s.service,
        inputPriceMicro: prices.input ?? meta?.inputPriceMicro ?? 0,
        outputPriceMicro: prices.output ?? meta?.outputPriceMicro ?? 0,
        cacheReadPriceMicro: prices.cacheRead ?? meta?.cacheReadPriceMicro ?? 0,
        cacheWritePriceMicro: prices.cacheWrite ?? meta?.cacheWritePriceMicro ?? 0,
        contextWindow: meta?.contextWindow ?? 1_048_576,
        maxTokens: meta?.maxTokens ?? 393_216,
        pool: Object.fromEntries(candidates.map((c) => [c.provider, c.upstreamModel ?? s.service])),
      };
    }
    if (Object.keys(models).length === 0) return void writeError(res, 503, "NO_UPSTREAM_KEY", "no configured model"), true;

    const payload = sealConfig(JSON.stringify({ schemaVersion: 2, providers, models }), rawToken, router.id);
    return void json(res, 200, { v: 2, payload }), true;
  }

  return false;
}
