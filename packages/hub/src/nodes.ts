/**
 * nodes.ts — 协议 B 上行端点（节点 ↔ 账号服务，30-relay-node）。
 *
 * N1 注册 / N2 心跳 / N4 主机登记 / N5 数据同步 / leave。节点鉴权 = node token
 *（Bearer）→ token_hash 查目录（R12-N6）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sha256, randomToken } from "./jwt.ts";
import { writeError } from "./api.ts";
import type { HubRuntime } from "./api.ts";
import type { NodeRow } from "./db.ts";

/** 读 JSON 请求体（非 JSON / 超大 → null）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1 << 20) return null; // 1 MiB 上限
    chunks.push(buf);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 从 Authorization: Bearer 提取 node token。 */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

/** 节点鉴权：token → 目录节点（未认证 → null）。 */
function authenticateNode(req: IncomingMessage, runtime: HubRuntime): NodeRow | null {
  const token = bearerToken(req);
  if (token === null || token.length < 16) return null;
  return runtime.db.findNodeByTokenHash(sha256(token));
}

/** 从 advertiseUrl 取主机名（域名双匹配，R24）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** N1：节点注册（域名 + token 双匹配，R24）。 */
export async function handleNodeRegister(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.advertiseUrl !== "string") {
    writeError(res, 400, "BAD_REQUEST", "advertiseUrl required");
    return;
  }
  if (hostOf(body.advertiseUrl) !== hostOf(node.advertiseUrl)) {
    writeError(res, 403, "DOMAIN_MISMATCH", "advertiseUrl does not match the pre-registered domain");
    return;
  }
  runtime.db.updateNodeStatus(node.id, "online");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ nodeId: node.id }));
}

/** N2：心跳 + 负载（P1 只记心跳时间；负载字段留待 P2 调度）。 */
export async function handleNodeHeartbeat(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  runtime.db.updateNodeHeartbeat(node.id, Date.now());
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

/** N4：主机上线/下线登记（幂等；online → 该主机落在本节点）。 */
export async function handleNodeHosts(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.hostId !== "string" || typeof body.online !== "boolean") {
    writeError(res, 400, "BAD_REQUEST", "hostId + online required");
    return;
  }
  const host = runtime.db.getHostById(body.hostId);
  if (host === null) {
    writeError(res, 404, "NOT_FOUND", "host not found");
    return;
  }
  if (body.online) runtime.db.setHostNode(body.hostId, node.id);
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

/** N5：数据同步 —— 本节点主机 + 归属/共享/ver + Ed25519 公钥 + draining。 */
export async function handleNodeSync(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  const hosts = runtime.db.listHostsByNode(node.id).map((h) => {
    // ver 是"进入用户"的（owner 或 member 各自 ver），故给 owner + 所有 member 各一份。
    const userVers: Record<string, number> = { [String(h.ownerId)]: runtime.db.getUserById(h.ownerId)?.ver ?? 1 };
    for (const s of runtime.db.listShares(h.id)) {
      const u = runtime.db.getUserById(s.userId);
      if (u !== null) userVers[String(s.userId)] = u.ver;
    }
    return { hostId: h.id, ownerId: h.ownerId, online: true, userVers };
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    hosts,
    hostCookiePubKey: runtime.config.hostCookiePubKey ?? "",
    draining: node.status === "draining",
  }));
}

/** leave：解除主机分配 + 删除节点。 */
export async function handleNodeLeave(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  for (const h of runtime.db.listHostsByNode(node.id)) runtime.db.setHostNode(h.id, null);
  runtime.db.removeNode(node.id);
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

// ---- 动态分配（R35）：一次性 assign 令牌（60s，单次消费）----

const assignTokens = new Map<string, { hostId: string; nodeId: string; exp: number }>();
const ASSIGN_TTL_MS = 60_000;

/** 生成一次性分配令牌（绑定 hostId + nodeId）。 */
export function mintAssignToken(hostId: string, nodeId: string): string {
  const token = randomToken();
  assignTokens.set(token, { hostId, nodeId, exp: Date.now() + ASSIGN_TTL_MS });
  return token;
}

function consumeAssignToken(token: string): { hostId: string; nodeId: string } | null {
  const rec = assignTokens.get(token);
  if (rec === undefined) return null;
  assignTokens.delete(token);
  if (rec.exp <= Date.now()) return null;
  return { hostId: rec.hostId, nodeId: rec.nodeId };
}

/** 节点侧验证 assign 令牌（gateway 连到节点后，节点回源账号服务确认并取 hostId）。 */
export async function handleNodeAssign(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.assign !== "string") {
    writeError(res, 400, "BAD_REQUEST", "assign required");
    return;
  }
  const rec = consumeAssignToken(body.assign);
  if (rec === null || rec.nodeId !== node.id) {
    writeError(res, 403, "FORBIDDEN", "assign token invalid, expired, or not for this node");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hostId: rec.hostId }));
}
