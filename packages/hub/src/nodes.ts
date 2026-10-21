/**
 * nodes.ts — 协议 B 上行端点（节点 ↔ 账号服务，30-relay-node）。
 *
 * N1 注册 / N2 心跳 / N4 主机登记 / N5 数据同步 / leave。节点鉴权 = node token
 *（Bearer）→ token_hash 查目录（R12-N6）。
 *
 * 43a：数据访问走异步 `runtime.store`（SQLite 由 createSqliteStore 包装）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { sha256, randomToken } from "./jwt.ts";
import { clientIp, writeError } from "./api.ts";
import type { HubRuntime } from "./api.ts";
import type { NodeRow } from "./db.ts";

/** 读 JSON 请求体（非 JSON / 超大 → null）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 4 << 20) return null; // 4 MiB 上限（N2 心跳可携带数万 hostId；42 P0）
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
async function authenticateNode(req: IncomingMessage, runtime: HubRuntime): Promise<NodeRow | null> {
  const token = bearerToken(req);
  if (token === null || token.length < 16) return null;
  return runtime.store.findNodeByTokenHash(sha256(token));
}

/** 从 advertiseUrl 取主机名（域名双匹配，R24）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** N1：节点注册/入网（41-relay-node-onboarding R3/R18/R23）。
 *  鉴权二选一：joinToken（新节点自助入网 → 建目录 + 发身份，默认 disabled）或
 *  nodeToken（已有节点重注册 → 更新状态 + last_ip）。
 */
export async function handleNodeRegister(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const token = bearerToken(req);
  if (token === null || token.length < 16) {
    writeError(res, 401, "UNAUTHORIZED", "invalid token");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.advertiseUrl !== "string") {
    writeError(res, 400, "BAD_REQUEST", "advertiseUrl required");
    return;
  }
  const srcIp = clientIp(req, runtime);
  const reportToken = runtime.config.relayNodeToken ?? "";

  // ① joinToken：新节点自助入网（默认 disabled，等管理员 enable）。
  const joinTok = await runtime.store.findRelayJoinTokenByHash(sha256(token));
  if (joinTok !== null) {
    if (joinTok.revokedAt !== null) {
      writeError(res, 401, "UNAUTHORIZED", "join token revoked");
      return;
    }
    const nodeId = randomUUID();
    const nodeToken = randomToken();
    const name = typeof body.name === "string" ? body.name : "";
    await runtime.store.createNode(nodeId, name, body.advertiseUrl, sha256(nodeToken), "", 0, 100, false, srcIp);
    await runtime.store.recordRelayJoinEvent(randomUUID(), joinTok.id, nodeId, srcIp);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ nodeId, nodeToken, reportToken }));
    return;
  }

  // ② nodeToken：已有节点重注册（域名双匹配，R24）。
  const node = await runtime.store.findNodeByTokenHash(sha256(token));
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid token");
    return;
  }
  if (hostOf(body.advertiseUrl) !== hostOf(node.advertiseUrl)) {
    writeError(res, 403, "DOMAIN_MISMATCH", "advertiseUrl does not match the pre-registered domain");
    return;
  }
  await runtime.store.markNodeAlive(node.id); // 只 offline→online，不覆写 draining（R39）
  await runtime.store.updateNodeLastIp(node.id, srcIp);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ nodeId: node.id, nodeToken: "", reportToken }));
}

/** N2：心跳 + 负载（P1 只记心跳时间；负载字段留待 P2 调度）。 */
export async function handleNodeHeartbeat(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = await authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  const body = await readJsonBody(req);
  await runtime.store.recordNodeMetric(node.id, {
    connections: Number(body?.connections ?? 0),
    activeStreams: Number(body?.activeStreams ?? 0),
    bytesIn: Number(body?.bytesIn ?? 0),
    bytesOut: Number(body?.bytesOut ?? 0),
  });
  // N2 携带本节点在线 host 列表（42 P0）：替换该节点 presence，不写 DB。
  // 只接受分配给本节点的 host，防伪造/串节点（节点 token 已认证，这里做归属校验）。
  const hosts = body?.hosts;
  if (Array.isArray(hosts)) {
    const reported = hosts.filter((h): h is string => typeof h === "string");
    const assigned = new Set((await runtime.store.listHostsByNode(node.id)).map((h) => h.id));
    runtime.presence.setNodeHosts(node.id, reported.filter((id) => assigned.has(id)));
  }
  // 心跳即存活证明：节点被离线扫描误判后无需重启即可自愈（draining 不被改写）。
  await runtime.store.markNodeAlive(node.id);
  await runtime.store.updateNodeLastIp(node.id, clientIp(req, runtime)); // R23：源 IP 随心跳更新（反代走 XFF）
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

/** N4：主机上线/下线登记（幂等；online → 该主机落在本节点）。 */
export async function handleNodeHosts(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = await authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.hostId !== "string" || typeof body.online !== "boolean") {
    writeError(res, 400, "BAD_REQUEST", "hostId + online required");
    return;
  }
  const host = await runtime.store.getHostById(body.hostId);
  if (host === null) {
    writeError(res, 404, "NOT_FOUND", "host not found");
    return;
  }
  // 42 P0：N4 只更新内存 presence，不写 DB；node_id 归属由分配/迁移路径写一次。
  // 串节点拒绝；仅当 host 上线且尚未归属时补一次归属写（旧 relay 兼容）。
  if (host.nodeId !== null && host.nodeId !== node.id) {
    writeError(res, 409, "CONFLICT", "host not assigned to node");
    return;
  }
  if (body.online && host.nodeId === null) await runtime.store.setHostNode(host.id, node.id);
  runtime.presence.set(body.hostId, node.id, body.online);
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

/** N5：数据同步 —— 本节点主机 + 归属/共享/ver + Ed25519 公钥 + draining。 */
export async function handleNodeSync(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = await authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  // P1.5 迁移（R39）：draining 节点 → 每个主机给一张账号服务签发的迁移票据。
  const draining = node.status === "draining";
  const target = draining ? await runtime.store.pickNode() : null;
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 分钟票据 TTL
  // 43b：并行处理 host（并发上限 50），避免 PG 下逐 host 顺序 await 的 N 次 RTT。
  const nodeHosts = await runtime.store.listHostsByNode(node.id);
  const CONCURRENCY = 50;
  const hosts: Array<Record<string, unknown>> = [];
  for (let i = 0; i < nodeHosts.length; i += CONCURRENCY) {
    const batch = nodeHosts.slice(i, i + CONCURRENCY);
    const entries = await Promise.all(batch.map(async (h) => {
      // ver 是"进入用户"的（owner 或 member 各自 ver），故给 owner + 所有 member 各一份。
      const owner = await runtime.store.getUserById(h.ownerId);
      const userVers: Record<string, number> = { [String(h.ownerId)]: owner?.ver ?? 1 };
      const shares = await runtime.store.listShares(h.id);
      const shareUsers = await Promise.all(shares.map((s) => runtime.store.getUserById(s.userId)));
      for (const u of shareUsers) {
        if (u !== null) userVers[String(u.id)] = u.ver;
      }
      const entry: Record<string, unknown> = { hostId: h.id, ownerId: h.ownerId, online: true, userVers };
      if (draining && target !== null && target.id !== node.id && runtime.hostCookieSigner !== undefined) {
        const nodeUrl = `wss://${hostOf(target.advertiseUrl)}/tunnel`;
        entry.migrateTo = { nodeUrl, expiresAt, sig: runtime.hostCookieSigner.sign(`${h.id}.${nodeUrl}.${expiresAt}`) };
      }
      return entry;
    }));
    hosts.push(...entries);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    hosts,
    hostCookiePubKey: runtime.config.hostCookiePubKey ?? "",
    draining,
  }));
}

/** leave：解除主机分配 + 删除节点。 */
export async function handleNodeLeave(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = await authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  for (const h of await runtime.store.listHostsByNode(node.id)) await runtime.store.setHostNode(h.id, null);
  await runtime.store.removeNode(node.id);
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

// ---- 动态分配（R35）：一次性 assign 令牌 ----
// 无状态签名令牌（60s TTL）见 HubAuth.signAssignToken / verifyAssignToken。
// 此前用进程内 Map（hub 重启即失效 + 严格 nodeId 比对 → 重启/节点换 id 导致大面积 401），已移除。

/** 节点侧验证 assign 令牌（gateway 连到节点后，节点回源账号服务确认并取 hostId）。 */
export async function handleNodeAssign(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<void> {
  const node = await authenticateNode(req, runtime);
  if (node === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid node token");
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.assign !== "string") {
    writeError(res, 400, "BAD_REQUEST", "assign required");
    return;
  }
  const rec = runtime.auth.verifyAssignToken(body.assign);
  if (rec === null || rec.nodeId !== node.id) {
    writeError(res, 403, "FORBIDDEN", "assign token invalid, expired, or not for this node");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ hostId: rec.hostId }));
}
