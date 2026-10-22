/**
 * account-llm.ts — 用户自助 LLM API key（Portal 设置页调用）。
 *
 * 用户会话鉴权（非服务令牌）：只能管理自己的 key；token 仅在创建时返回一次。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomToken, sha256 } from "./jwt.ts";
import { authenticate, writeError, type HubRuntime } from "./api.ts";
import { readJson } from "./internal-llm.ts";

const LLM_KEY_PREFIX = "sk-rdsh-";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function keyView(k: { id: string; name: string; hostId: string | null; tokenHead4: string; tokenTail4: string; status: string; spentMicro: number; budgetMicro: number; createdAt: number; lastUsedAt: number | null }): Record<string, unknown> {
  return {
    id: k.id,
    name: k.name,
    hostId: k.hostId,
    tokenHead4: k.tokenHead4,
    tokenTail4: k.tokenTail4,
    status: k.status,
    spentMicro: k.spentMicro,
    budgetMicro: k.budgetMicro,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
  };
}

export async function handleAccountLlm(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "login required");
    return true;
  }

  if (path === "/api/account/llm/keys" && method === "GET") {
    const keys = await runtime.store.listLlmKeysByUser(auth.userId);
    return void json(res, 200, { keys: keys.map(keyView) }), true;
  }

  if (path === "/api/account/llm/keys" && method === "POST") {
    const body = await readJson(req);
    const name = body !== null && typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : "api-key";
    const token = `${LLM_KEY_PREFIX}${randomToken()}`;
    const key = await runtime.store.createLlmKey({
      id: randomUUID(),
      userId: auth.userId,
      agentId: null,
      hostId: null,
      tokenHash: sha256(token),
      name,
      tokenHead4: token.slice(8, 12),
      tokenTail4: token.slice(-4),
    });
    return void json(res, 200, { keyId: key.id, token, name: key.name }), true;
  }

  const revokeMatch = /^\/api\/account\/llm\/keys\/([^/]+)\/revoke$/.exec(path);
  if (revokeMatch !== null && method === "POST") {
    const id = decodeURIComponent(revokeMatch[1]!);
    const key = await runtime.store.getLlmKeyById(id);
    if (key === null || key.userId !== auth.userId) {
      return void writeError(res, 404, "NOT_FOUND", "key not found"), true;
    }
    if (key.hostId !== null) {
      return void writeError(res, 403, "FORBIDDEN", "host-managed key cannot be revoked here"), true;
    }
    const ok = await runtime.store.revokeLlmKey(id);
    return void json(res, ok ? 200 : 404, { ok }), true;
  }

  // 重命名 / 删除（仅用户自建 key；host 自动 key 只读）。
  const keyMatch = /^\/api\/account\/llm\/keys\/([^/]+)$/.exec(path);
  if (keyMatch !== null && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(keyMatch[1]!);
    const key = await runtime.store.getLlmKeyById(id);
    if (key === null || key.userId !== auth.userId) {
      return void writeError(res, 404, "NOT_FOUND", "key not found"), true;
    }
    if (key.hostId !== null) {
      return void writeError(res, 403, "FORBIDDEN", "host-managed key cannot be modified here"), true;
    }
    if (method === "PATCH") {
      const body = await readJson(req);
      const name = body !== null && typeof body.name === "string" ? body.name.trim() : "";
      if (name === "" || name.length > 64) {
        return void writeError(res, 400, "BAD_REQUEST", "name must be 1-64 chars"), true;
      }
      const ok = await runtime.store.updateLlmKeyName(id, name);
      return void json(res, ok ? 200 : 404, { ok, name }), true;
    }
    const ok = await runtime.store.deleteLlmKey(id);
    return void json(res, ok ? 200 : 404, { ok }), true;
  }

  // 用量统计：按模型 + 天聚合当前用户的 llm_requests（仅成功请求）。
  if (path === "/api/account/llm/usage" && method === "GET") {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const fromMs = Date.parse(`${from}T00:00:00`);
    const toMs = Date.parse(`${to}T23:59:59.999`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      return void writeError(res, 400, "BAD_REQUEST", "invalid from/to"), true;
    }
    const rows = await runtime.store.listLlmRequests({ userId: auth.userId, from: fromMs, to: toMs, limit: 10000 });
    const catalog = await runtime.store.listLlmModels();
    const nameById = new Map(catalog.map((m) => [m.id, m.displayName]));
    type DayAgg = { inputTokens: number; outputTokens: number };
    const byModel = new Map<string, { model: string; inputTokens: number; outputTokens: number; requests: number; chargedMicro: number; byDay: Map<string, DayAgg> }>();
    const pad = (n: number): string => String(n).padStart(2, "0");
    for (const r of rows) {
      if (r.status !== "ok") continue;
      const d = new Date(r.createdAt);
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      let m = byModel.get(r.modelAlias);
      if (m === undefined) {
        m = { model: r.modelAlias, inputTokens: 0, outputTokens: 0, requests: 0, chargedMicro: 0, byDay: new Map() };
        byModel.set(r.modelAlias, m);
      }
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.requests += 1;
      m.chargedMicro += r.chargedMicro;
      const dayEntry = m.byDay.get(day) ?? { inputTokens: 0, outputTokens: 0 };
      dayEntry.inputTokens += r.inputTokens;
      dayEntry.outputTokens += r.outputTokens;
      m.byDay.set(day, dayEntry);
    }
    const models = [...byModel.values()].map((m) => ({
      model: m.model,
      displayName: nameById.get(m.model) ?? null,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      requests: m.requests,
      chargedMicro: m.chargedMicro,
      byDay: [...m.byDay.entries()].map(([date, v]) => ({ date, inputTokens: v.inputTokens, outputTokens: v.outputTokens })).sort((a, b) => a.date.localeCompare(b.date)),
    }));
    return void json(res, 200, { models }), true;
  }

  // 用户侧模型目录（用量页渲染卡片用；只含公开字段，不含价格）
  if (path === "/api/account/llm/models" && method === "GET") {
    const models = (await runtime.store.listLlmModels({ enabledOnly: true })).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    return void json(res, 200, { models }), true;
  }

  return false;
}
