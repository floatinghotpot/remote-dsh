/**
 * voice-session.ts — 55-voice-router：App 换取语音票据的公开端点。
 *
 * 用户 JWT 鉴权。签发一次性、短时效（≤5 分钟）的 HS256 票据，内含余额快照与欠费下限；
 * 票据由语音路由本地验签（密钥经 /api/internal/voice/config 下发）。
 *
 * 首期不做服务端防重放（不引入 Redis）：只校验签名 + 过期，TTL 内重放属可接受风险。
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate, writeError, type HubRuntime } from "./api.ts";
import { VOICE_DEFAULTS } from "./config.ts";

const TICKET_TTL_MS = 300_000; // 5 分钟
const TICKET_KID = "voice-ticket-v1";

const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: TICKET_KID })).toString("base64url");

function sign(payload: object, secret: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}

/** 从路由上报的公网基址（https:// 或 wss://，可带尾斜杠）推导 ASR/TTS 完整地址。 */
function deriveVoiceUrls(base: string): { wsUrl: string; ttsUrl: string } {
  let host = "";
  try {
    host = new URL(base).host;
  } catch {
    host = base.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
  }
  return { wsUrl: `wss://${host}/v1/asr`, ttsUrl: `https://${host}/v1/tts` };
}

/** 票据密钥：config 优先，否则进程内随机（路由经 config 端点拿到同一密钥）。 */
let fallbackSecret: Buffer | null = null;
function ticketSecret(runtime: HubRuntime): Buffer {
  const v = runtime.config.billing?.voice?.ticketSecret;
  if (v !== undefined && v.length >= 16) return Buffer.from(v, "utf8");
  fallbackSecret ??= randomBytes(32);
  return fallbackSecret;
}

export async function handleVoiceSession(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  if (url.pathname !== "/api/voice/session" || (req.method ?? "GET") !== "POST") return false;

  const auth = authenticate(req, runtime);
  if (auth === null) return void writeError(res, 401, "UNAUTHORIZED", "login required"), true;

  const v = runtime.config.billing?.voice;
  const balance = await runtime.store.getCreditBalances(auth.userId);
  // wsUrl/ttsUrl：优先取 active 的 voice router 上报的公网基址（join 时上报），无则回退 config。
  const activeVoice = await runtime.store.getActiveRouter("voice");
  const base = activeVoice?.publicBaseUrl ?? (v?.wsUrl ?? "");
  const { wsUrl, ttsUrl } = base !== "" ? deriveVoiceUrls(base) : { wsUrl: "", ttsUrl: "" };
  const floor = v?.overdraftFloor ?? VOICE_DEFAULTS.overdraftFloor;
  const now = Date.now();
  const jti = randomUUID();
  const ticket = sign(
    {
      sub: auth.userId,
      jti,
      iat: now,
      exp: now + TICKET_TTL_MS,
      bal: Math.floor(balance.total / 10000), // 点数
      flr: floor,
    },
    ticketSecret(runtime),
  );
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ticket,
    expiresAt: now + TICKET_TTL_MS,
    balance: Math.floor(balance.total / 10000),
    floor,
    wsUrl,
    ttsUrl,
    serverNow: now,
  }));
  return true;
}


/** 68：把 services/service_pool 投影成 App 公开形状 `{provider, asrModel?, ttsVoices}`。 */
export function toVoiceProvidersFromServices(
  services: Array<{ service: string; capability: string; enabled: boolean; params: string | null }>,
  pool: Array<{ service: string; provider: string; enabled: boolean }>,
): Array<Record<string, unknown>> {
  const byProvider = new Map<string, { asrModel?: string; ttsVoices: string[] }>();
  for (const s of services) {
    if (!s.enabled || (s.capability !== "asr" && s.capability !== "tts")) continue;
    const candidate = pool.find((p) => p.service === s.service && p.enabled);
    if (candidate === undefined) continue;
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(s.params ?? "{}") as Record<string, unknown>; } catch { params = {}; }
    const entry = byProvider.get(candidate.provider) ?? { ttsVoices: [] };
    if (s.capability === "asr") {
      const alias = Array.isArray(params.aliases) ? (params.aliases as unknown[]).find((x): x is string => typeof x === "string" && x !== "") : undefined;
      entry.asrModel = alias ?? s.service;
    } else {
      const raw = Array.isArray(params.voices) ? (params.voices as unknown[]) : [];
      entry.ttsVoices = raw.map((v) => (typeof v === "string" ? v : typeof (v as Record<string, unknown>)?.id === "string" ? String((v as Record<string, unknown>).id) : "")).filter((v) => v !== "");
    }
    byProvider.set(candidate.provider, entry);
  }
  return [...byProvider.entries()].map(([provider, e]) => (
    e.asrModel === undefined ? { provider, ttsVoices: e.ttsVoices } : { provider, asrModel: e.asrModel, ttsVoices: e.ttsVoices }
  ));
}

export async function handleVoiceConfig(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  if (url.pathname !== "/api/voice/config" || (req.method ?? "GET") !== "GET") return false;
  const auth = authenticate(req, runtime);
  if (auth === null) return void writeError(res, 401, "UNAUTHORIZED", "login required"), true;

  const services = await runtime.store.listServices();
  const pool = await runtime.store.listServicePool();
  const providers = toVoiceProvidersFromServices(services, pool);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ providers }));
  return true;
}
