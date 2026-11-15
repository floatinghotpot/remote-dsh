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
import { parseParams } from "./service-families.ts";
import { beijingDate, voiceUnitRate } from "./pricing/index.ts";
import { VOICE_DEFAULTS } from "./config.ts";
import { authenticateService, parseCapabilities, readJson } from "./internal-llm.ts";
import { randomToken, sha256 } from "./jwt.ts";
import { decryptKeyRow, listEnabledKeys } from "./llm-upstream-keys.ts";
import type { LlmUpstreamKeyRow } from "./db.ts";


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

async function effectiveVoiceConfig(runtime: HubRuntime) {
  const v = runtime.config.billing?.voice;
  // providers：enabled 的 voice key 按 provider 分组；capabilities 过滤 asr/tts。
  const providers: Record<string, {
    credentialType: string;
    keys: Array<{ id: string; secrets: Record<string, string>; capabilities: string[] | null; weight: number; maxConcurrency: number }>;
    asr?: { url: string; protocol: string };
    tts?: { url: string; protocol: string; resourceId?: string };
  }> = {};
  for (const k of await listEnabledKeys(runtime, "voice")) {
    const caps = parseCapabilities(k.capabilities);
    if (caps !== null && !caps.includes("asr") && !caps.includes("tts")) continue;
    const pcfg = await runtime.store.getProviderConfig(k.provider);
    if (pcfg === null) continue;
    let params: Record<string, unknown>;
    try { params = JSON.parse(pcfg.params) as Record<string, unknown>; } catch { continue; }
    const asr = params.asr as Record<string, unknown> | undefined;
    const tts = params.tts as Record<string, unknown> | undefined;
    if (asr === undefined && tts === undefined) continue;
    let plain: string;
    try {
      plain = decryptKeyRow(runtime, k);
    } catch (err) {
      console.warn(`rdsh-hub: skip voice key ${k.id} (provider=${k.provider}): decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let secrets: Record<string, string>;
    try { secrets = JSON.parse(plain) as Record<string, string>; } catch { secrets = { apiKey: plain }; }
    const entry = providers[k.provider] ?? (providers[k.provider] = { credentialType: k.credentialType ?? "api_key", keys: [] });
    if (asr !== undefined && typeof asr.url === "string" && typeof asr.protocol === "string") {
      entry.asr = { url: asr.url, protocol: asr.protocol };
    }
    if (tts !== undefined && typeof tts.url === "string" && typeof tts.protocol === "string") {
      const models = Array.isArray(tts.models) ? (tts.models as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const resourceId = typeof tts.resourceId === "string" && tts.resourceId !== "" ? tts.resourceId : models[0];
      entry.tts = resourceId === undefined ? { url: tts.url, protocol: tts.protocol } : { url: tts.url, protocol: tts.protocol, resourceId };
    }
    entry.keys.push({ id: k.id, secrets, capabilities: caps, weight: k.weight, maxConcurrency: k.maxConcurrency });
  }
  // 丢掉没有任何可用 endpoint 的 provider（配置残缺时不把无效候选发给 Router）。
  for (const [name, p] of Object.entries(providers)) {
    if (p.asr === undefined && p.tts === undefined) delete providers[name];
  }
  if (Object.keys(providers).length === 0) return { providers, models: {}, ticketSecret: "", session: {}, globalConcurrency: 0, bufferMaxSeconds: 0, reportIntervalSeconds: 0 };

  // models：enabled 的 asr/tts 模型代理 + 有效上游（enabled 池条目 + provider 有 key）。
  const pool = await runtime.store.listServicePool();
  const models: Record<string, { capability: string; aliases: string[]; voices: string[]; pool: Record<string, string | Record<string, string>> }> = {};
  for (const s of await runtime.store.listServices()) {
    if (!s.enabled || (s.capability !== "asr" && s.capability !== "tts")) continue;
    const candidates = pool.filter((p) => p.service === s.service && p.enabled && providers[p.provider] !== undefined);
    if (candidates.length === 0) continue;
    let sparams: Record<string, unknown> = {};
    try { sparams = JSON.parse(s.params ?? "{}") as Record<string, unknown>; } catch { sparams = {}; }
    const aliases = Array.isArray(sparams.aliases) ? (sparams.aliases as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const rawVoices = Array.isArray(sparams.voices) ? (sparams.voices as unknown[]) : [];
    const voices = rawVoices.map((x) => (typeof x === "string" ? x : typeof (x as Record<string, unknown>)?.id === "string" ? String((x as Record<string, unknown>).id) : "")).filter((x) => x !== "");
    const poolMap: Record<string, string | Record<string, string>> = {};
    for (const c of candidates) {
      let cparams: Record<string, unknown> = {};
      try { cparams = JSON.parse(c.params ?? "{}") as Record<string, unknown>; } catch { cparams = {}; }
      const voiceMap = cparams.voiceMap;
      if (s.capability === "tts" && voiceMap !== undefined && typeof voiceMap === "object" && voiceMap !== null) {
        poolMap[c.provider] = voiceMap as Record<string, string>;
      } else {
        poolMap[c.provider] = c.upstreamModel ?? s.service;
      }
    }
    models[s.service] = { capability: s.capability, aliases, voices, pool: poolMap };
  }

  return {
    reportIntervalSeconds: v?.reportIntervalSeconds ?? VOICE_DEFAULTS.reportIntervalSeconds,
    session: {
      maxSeconds: v?.sessionMaxSeconds ?? VOICE_DEFAULTS.sessionMaxSeconds,
      idleTimeoutSeconds: v?.idleTimeoutSeconds ?? VOICE_DEFAULTS.idleTimeoutSeconds,
      maxPerUser: v?.maxPerUser ?? VOICE_DEFAULTS.maxPerUser,
    },
    globalConcurrency: v?.globalConcurrency ?? VOICE_DEFAULTS.globalConcurrency,
    bufferMaxSeconds: v?.bufferMaxSeconds ?? VOICE_DEFAULTS.bufferMaxSeconds,
    schemaVersion: 2,
    ticketSecret: v?.ticketSecret ?? "",
    providers,
    models,
  };
}

/** 69：解析语音服务的上游模型 id（ASR 取池 upstream；TTS 取 provider 配置 models[0]，否则用 service）。 */
async function resolveVoiceUpstreamModel(store: HubRuntime["store"], service: string, provider: string, kind: string): Promise<string> {
  const pool = (await store.listServicePoolByService(service)).find((p) => p.provider === provider && p.enabled);
  if (pool !== undefined && pool.upstreamModel !== null && pool.upstreamModel !== "") return pool.upstreamModel;
  const pcfg = await store.getProviderConfig(provider);
  const cap = parseParams(pcfg?.params ?? null)[kind] as Record<string, unknown> | undefined;
  const models = Array.isArray(cap?.models) ? (cap.models as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return models.length > 0 ? models[0]! : service;
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
    if (Object.keys(cfg.providers).length === 0 || Object.keys(cfg.models).length === 0) {
      return void writeError(res, 503, "NO_UPSTREAM_KEY", "no enabled voice upstream key"), true;
    }
    const payload = sealVoiceConfig(JSON.stringify(cfg), rawToken, router.id);
    return void json(res, 200, { v: 2, payload }), true;
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
    const service = typeof body.service === "string" ? body.service.trim() : "";
    const provider = typeof body.provider === "string" && body.provider.trim() !== "" ? body.provider.trim() : "volcengine";
    const cumulative = body.cumulative === undefined ? -1 : Number(body.cumulative);
    if (!Number.isSafeInteger(userId) || userId <= 0) return void writeError(res, 400, "BAD_REQUEST", "userId required"), true;
    if (kind !== "asr" && kind !== "tts") return void writeError(res, 400, "BAD_REQUEST", "kind must be asr|tts"), true;
    if (!Number.isSafeInteger(cumulative) || cumulative < 0) return void writeError(res, 400, "BAD_REQUEST", "invalid cumulative"), true;
    // 日期由服务端归日（不信任客户端；与 relay 的 localDate 同一口径）。
    const date = beijingDate();
    const v = runtime.config.billing?.voice;
    const globalPrice = kind === "asr"
      ? (v?.asrPriceMicroPerSecond ?? VOICE_DEFAULTS.asrPriceMicroPerSecond)
      : (v?.ttsPriceMicroPerChar ?? VOICE_DEFAULTS.ttsPriceMicroPerChar);
    // 68：优先按售卖服务（services.prices.price）计价；service 缺失/查不到才回退全局价。
    let price = globalPrice;
    if (service !== "") {
      const svc = await runtime.store.getService(service);
      if (svc !== null) {
        let prices: Record<string, unknown> = {};
        try { prices = JSON.parse(svc.prices) as Record<string, unknown>; } catch { prices = {}; }
        if (typeof prices.price === "number" && prices.price >= 0) price = prices.price;
      }
    }
    const floor = v?.overdraftFloor ?? VOICE_DEFAULTS.overdraftFloor;
    const out = await runtime.store.chargeVoiceUsage(userId, date, kind, service, provider, cumulative, price, floor);

    // 69：按供应商记录上游用量并换算成本（旧 Router 无 perProvider 时跳过）。
    const perProviderStored: Record<string, number> = {};
    const pp = body.perProvider;
    if (pp !== null && typeof pp === "object" && !Array.isArray(pp)) {
      const now = Date.now();
      for (const [prov, raw] of Object.entries(pp as Record<string, unknown>)) {
        if (prov === "" || !Number.isSafeInteger(raw) || (raw as number) < 0) continue;
        const upstreamModel = await resolveVoiceUpstreamModel(runtime.store, service, prov, kind);
        const up = await runtime.store.getUpstreamPrice(prov, upstreamModel);
        if (up === null) console.warn(`rdsh-hub: voice upstream price missing provider=${prov} model=${upstreamModel} kind=${kind}`);
        const perUnitMicro = up === null ? 0 : voiceUnitRate(up.rates, kind);
        const r = await runtime.store.upsertVoiceUpstreamUsageDaily({ provider: prov, kind, service, date, cumulative: raw as number, perUnitMicro, now });
        perProviderStored[prov] = r.storedCumulative;
      }
    }
    return void json(res, 200, { balance: out.balance.total, storedCumulative: out.storedCumulative, chargedMicro: out.chargedMicro, perProviderStored }), true;
  }

  return false;
}
