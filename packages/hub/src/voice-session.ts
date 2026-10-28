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


/** App 公开端点：返回供应商级语音配置里的音色白名单（供设置页展示，不含机密）。 */
export async function handleVoiceConfig(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  if (url.pathname !== "/api/voice/config" || (req.method ?? "GET") !== "GET") return false;
  const auth = authenticate(req, runtime);
  if (auth === null) return void writeError(res, 401, "UNAUTHORIZED", "login required"), true;
  const cfgs = await runtime.store.listVoiceProviderConfigs();
  const providers = cfgs.map((c) => {
    let voices: string[] = [];
    try {
      const p = JSON.parse(c.params) as Record<string, unknown>;
      if (Array.isArray(p.voices)) voices = (p.voices as unknown[]).filter((v): v is string => typeof v === "string");
    } catch {
      // ignore malformed params
    }
    return { provider: c.provider, voices };
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ providers }));
  return true;
}
