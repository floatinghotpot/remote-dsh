/**
 * internal-voice.ts — 55-voice-router：语音路由与 Hub 的内部机器对机器 API。
 *
 * 由语音路由服务（私有 Go 服务）以服务令牌调用；不经用户会话，也不对外。
 * 职责：语音按天累计上报（usage）+ 语音配置下发（config，封签）。
 *
 * 存储红线：voice 只按天累计（voice_usage_daily），本文件绝不产生逐笔记录。
 */
import { createCipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientIp, writeError, type HubRuntime } from "./api.ts";
import { VOICE_DEFAULTS } from "./config.ts";
import { authenticateService, readJson } from "./internal-llm.ts";
import { randomToken, sha256 } from "./jwt.ts";
import { decryptKeyRow, listEnabledKeys } from "./llm-upstream-keys.ts";
import type { LlmUpstreamKeyRow } from "./db.ts";
import { localDate } from "./relay-usage.ts";

/** 封签 info 前缀（与 Go 路由的解密侧一致）。 */
const VOICE_SEAL_INFO = "rdsh-voice-config-v1";
const VOICE_SEAL_VERSION = 1;

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 与 crypto-upstream-keys.sealConfig 同构，但用语音自己的 info 前缀（Go 路由对称解密）。 */
export function sealVoiceConfig(plainJson: string, token: string, routerId: string): string {
  const salt = randomBytes(16);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), salt, Buffer.from(`${VOICE_SEAL_INFO}:${routerId}`, "utf8"), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(routerId, "utf8"));
  const ct = Buffer.concat([cipher.update(plainJson, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VOICE_SEAL_VERSION]), salt, iv, ct, tag]).toString("base64");
}

// voiceKeyRR 是语音 key 的加权轮询游标（同 llm-upstream-keys.pickUpstreamKey 的核心
// 逻辑，但不做粘性：语音每 60s 重选即可；禁用的 key 从池里消失后自然切到备用）。
let voiceKeyRR = 0;

function pickVoiceKey(rows: LlmUpstreamKeyRow[]): LlmUpstreamKeyRow {
  const total = rows.reduce((sum, k) => sum + Math.max(1, k.weight), 0);
  const target = ((voiceKeyRR % total) + total) % total;
  voiceKeyRR++;
  let acc = 0;
  for (const k of rows) {
    acc += Math.max(1, k.weight);
    if (target < acc) return k;
  }
  return rows[rows.length - 1]!;
}

async function effectiveVoiceConfig(runtime: HubRuntime) {
  const v = runtime.config.billing?.voice;
  // 上游凭据来自 key 池（service='voice'），不在 hub.json 明文；按 provider 分组，
  // 每 provider 加权选一把下发（同 provider 多把 key 不再静默覆盖；坏 key 禁用后
  // 下一轮 config 拉取（≤60s）即切到备用 key）。
  const byProvider = new Map<string, LlmUpstreamKeyRow[]>();
  for (const k of await listEnabledKeys(runtime, "voice")) {
    const list = byProvider.get(k.provider) ?? [];
    list.push(k);
    byProvider.set(k.provider, list);
  }
  const upstreams: Record<string, { credentialType: string; params: Record<string, unknown>; secrets: Record<string, string> }> = {};
  for (const [provider, rows] of byProvider) {
    const k = pickVoiceKey(rows);
    const plain = decryptKeyRow(runtime, k);
    let secrets: Record<string, string>;
    try {
      secrets = JSON.parse(plain) as Record<string, string>;
    } catch {
      secrets = { apiKey: plain }; // 兜底：非 JSON 明文按单 Key 处理
    }
    let params: Record<string, unknown> = {};
    if (k.params !== null) {
      try {
        params = JSON.parse(k.params) as Record<string, unknown>;
      } catch {
        params = {};
      }
    }
    upstreams[provider] = { credentialType: k.credentialType ?? "api_key", params, secrets };
  }
  return {
    reportIntervalSeconds: v?.reportIntervalSeconds ?? VOICE_DEFAULTS.reportIntervalSeconds,
    overdraftFloorPoints: v?.overdraftFloor ?? VOICE_DEFAULTS.overdraftFloor,
    asrPriceMicroPerSecond: v?.asrPriceMicroPerSecond ?? VOICE_DEFAULTS.asrPriceMicroPerSecond,
    ttsPriceMicroPerChar: v?.ttsPriceMicroPerChar ?? VOICE_DEFAULTS.ttsPriceMicroPerChar,
    session: {
      maxSeconds: v?.sessionMaxSeconds ?? VOICE_DEFAULTS.sessionMaxSeconds,
      idleTimeoutSeconds: v?.idleTimeoutSeconds ?? VOICE_DEFAULTS.idleTimeoutSeconds,
      maxPerUser: v?.maxPerUser ?? VOICE_DEFAULTS.maxPerUser,
    },
    globalConcurrency: v?.globalConcurrency ?? VOICE_DEFAULTS.globalConcurrency,
    bufferMaxSeconds: v?.bufferMaxSeconds ?? VOICE_DEFAULTS.bufferMaxSeconds,
    ticketSecret: v?.ticketSecret ?? "",
    wsUrl: v?.wsUrl ?? "",
    upstreams,
  };
}

export async function handleInternalVoice(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const path = url.pathname;
  if (!path.startsWith("/api/internal/voice/")) return false;
  const method = req.method ?? "GET";

  // GET /api/internal/voice/config（per-router token；密文封签，AAD=routerId）
  if (path === "/api/internal/voice/config" && method === "GET") {
    const rawToken = bearerToken(req);
    if (rawToken === null || rawToken.length < 16) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const row = await authenticateService(req, runtime, "voice:config:read");
    if (row === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const router = await runtime.store.getLlmRouterByTokenId(row.id);
    if (router === null || router.status !== "active" || router.service !== "voice") return void writeError(res, 403, "ROUTER_NOT_APPROVED", "router not approved"), true;
    await runtime.store.touchLlmRouterSeen(router.id, clientIp(req, runtime));
    const cfg = await effectiveVoiceConfig(runtime);
    if (Object.keys(cfg.upstreams).length === 0) return void writeError(res, 503, "NO_UPSTREAM_KEY", "no enabled voice upstream key"), true;
    const payload = sealVoiceConfig(JSON.stringify(cfg), rawToken, router.id);
    return void json(res, 200, { v: 1, payload }), true;
  }

  // POST /api/internal/voice/routers/join（一次性 voice join token → 唯一 token + pending router）
  if (path === "/api/internal/voice/routers/join" && method === "POST") {
    const joinToken = bearerToken(req);
    if (joinToken === null || joinToken.length < 16) return void writeError(res, 401, "UNAUTHORIZED", "missing join token"), true;
    const jt = await runtime.store.findLlmRouterJoinTokenByHash(sha256(joinToken));
    if (jt === null || jt.usedAt !== null || jt.expiresAt <= Date.now()) return void writeError(res, 401, "UNAUTHORIZED", "invalid, used or expired join token"), true;
    if (jt.service !== "voice") return void writeError(res, 401, "UNAUTHORIZED", "join token is not for voice routers"), true;
    const body = await readJson(req);
    const name = body !== null && typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : "voice-router";
    const publicBaseUrl = body !== null && typeof body.publicBaseURL === "string" && body.publicBaseURL.trim() !== "" ? body.publicBaseURL.trim() : null;
    if (!(await runtime.store.markLlmRouterJoinTokenUsed(jt.id))) return void writeError(res, 409, "CONFLICT", "join token already used"), true;
    const token = `rdsh-vt-${randomToken()}`;
    const tokenRow = await runtime.store.createServiceToken(randomUUID(), `voice-router:${name}`, sha256(token), "voice:config:read,voice:usage:write");
    const routerId = randomUUID();
    await runtime.store.createLlmRouter(routerId, name, tokenRow.id, clientIp(req, runtime), publicBaseUrl, "voice");
    return void json(res, 200, { routerId, token }), true;
  }

  // POST /api/internal/voice/usage（按天累计上报；幂等水位）
  if (path === "/api/internal/voice/usage" && method === "POST") {
    if ((await authenticateService(req, runtime, "voice:usage:write")) === null) return void writeError(res, 401, "UNAUTHORIZED", "missing or invalid service token"), true;
    const body = await readJson(req);
    if (body === null) return void writeError(res, 400, "BAD_REQUEST", "invalid json"), true;
    const userId = Number(body.userId);
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    const provider = typeof body.provider === "string" && body.provider.trim() !== "" ? body.provider.trim() : "volcengine";
    const cumulative = body.cumulative === undefined ? -1 : Number(body.cumulative);
    if (!Number.isSafeInteger(userId) || userId <= 0) return void writeError(res, 400, "BAD_REQUEST", "userId required"), true;
    if (kind !== "asr" && kind !== "tts") return void writeError(res, 400, "BAD_REQUEST", "kind must be asr|tts"), true;
    if (!Number.isSafeInteger(cumulative) || cumulative < 0) return void writeError(res, 400, "BAD_REQUEST", "invalid cumulative"), true;
    // 日期由服务端归日（不信任客户端；与 relay 的 localDate 同一口径）。
    const date = localDate();
    const v = runtime.config.billing?.voice;
    const price = kind === "asr"
      ? (v?.asrPriceMicroPerSecond ?? VOICE_DEFAULTS.asrPriceMicroPerSecond)
      : (v?.ttsPriceMicroPerChar ?? VOICE_DEFAULTS.ttsPriceMicroPerChar);
    const floor = v?.overdraftFloor ?? VOICE_DEFAULTS.overdraftFloor;
    const out = await runtime.store.chargeVoiceUsage(userId, date, kind, provider, cumulative, price, floor);
    return void json(res, 200, { balance: out.balance.total, storedCumulative: out.storedCumulative, chargedMicro: out.chargedMicro }), true;
  }

  return false;
}
