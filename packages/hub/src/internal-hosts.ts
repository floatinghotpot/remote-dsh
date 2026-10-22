/**
 * internal-hosts.ts — 50-hub-host-invite：Hub 内部机器对机器 host 接入 API。
 *
 * 由平台（鲸湾后端）/AI 以服务令牌调用，签发绑定 userId 的 host join token，
 * 复用现有 `rdsh join --token` 与 `/api/hosts/register` 消费端。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomToken, sha256 } from "./jwt.ts";
import { writeError, type HubRuntime } from "./api.ts";
import { authenticateService, readJson } from "./internal-llm.ts";

const INVITE_TTL_DEFAULT = 600;
const INVITE_TTL_MAX = 3600;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 缺省 label：`YYYYMMDDHHmmss`（与 relay join token 的默认名一致）。 */
function timestampLabel(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export async function handleInternalHosts(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  if (url.pathname !== "/api/internal/hosts/invite" || (req.method ?? "GET") !== "POST") return false;

  if ((await authenticateService(req, runtime, "host:invite")) === null) {
    return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
  }
  const body = await readJson(req);
  if (body === null) return void writeError(res, 400, "BAD_REQUEST", "invalid json"), true;

  const userId = Number(body.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return void writeError(res, 400, "BAD_REQUEST", "invalid userId"), true;
  }
  const user = await runtime.store.getUserById(userId);
  if (user === null) return void writeError(res, 404, "NOT_FOUND", "user not found"), true;

  let ttlSeconds = INVITE_TTL_DEFAULT;
  if (body.ttlSeconds !== undefined) {
    const t = Number(body.ttlSeconds);
    if (!Number.isInteger(t) || t <= 0 || t > INVITE_TTL_MAX) {
      return void writeError(res, 400, "BAD_REQUEST", `ttlSeconds must be 1..${INVITE_TTL_MAX}`), true;
    }
    ttlSeconds = t;
  }

  const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 64) : timestampLabel();
  const id = randomUUID();
  const token = randomToken();
  const expiresAt = Date.now() + ttlSeconds * 1000;
  await runtime.store.createJoinToken(id, label, userId, sha256(token), expiresAt);
  return void json(res, 200, { id, token, expiresAt }), true;
}
