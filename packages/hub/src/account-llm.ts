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

function keyView(k: { id: string; name: string; status: string; spentMicro: number; budgetMicro: number; createdAt: number; lastUsedAt: number | null }): Record<string, unknown> {
  return {
    id: k.id,
    name: k.name,
    status: k.status,
    spentMicro: k.spentMicro,
    budgetMicro: k.budgetMicro,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
  };
}

export async function handleAccountLlmKeys(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
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
      tokenHash: sha256(token),
      name,
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
    const ok = await runtime.store.revokeLlmKey(id);
    return void json(res, ok ? 200 : 404, { ok }), true;
  }

  return false;
}
