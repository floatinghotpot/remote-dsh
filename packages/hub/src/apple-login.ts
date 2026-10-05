/**
 * apple-login.ts — Sign in with Apple 服务端接入（仅 iOS App）。
 *
 * - 身份令牌校验：Apple JWKS（RS256）验签 + iss/aud/exp/nonce
 * - client secret：用「Sign in with Apple」.p8（EC P-256）按需现签 ES256 JWT
 * - /auth/token 换码 / refresh；/auth/revoke 吊销
 * - 令牌 AES-256-GCM 加密落库（密钥来自 hub.json appleLogin.tokenEncKey）
 *
 * 全部基于 node:crypto（零新依赖，遵循仓库依赖最小化纪律）。
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const APPLE_ISS = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const JWKS_TTL_MS = 24 * 3600 * 1000;
/** Apple 限制 client secret 有效期 ≤ 6 个月；取 180 天留余量。 */
const CLIENT_SECRET_TTL_S = 180 * 24 * 3600;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 读取「Sign in with Apple」私钥（.p8，PKCS#8 PEM）。 */
export async function loadApplePrivateKey(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * 现签 client secret（ES256 JWT）：iss=Team ID、sub=Client ID、aud=appleid.apple.com。
 * ES256 签名取原始 R||S（IEEE-P1363），符合 JOSE（JWT ES256）规范。
 */
export function makeAppleClientSecret(opts: { teamId: string; keyId: string; clientId: string; privateKeyPem: string; nowMs: number }): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: opts.keyId })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        iss: opts.teamId,
        iat: Math.floor(opts.nowMs / 1000),
        exp: Math.floor(opts.nowMs / 1000) + CLIENT_SECRET_TTL_S,
        aud: APPLE_ISS,
        sub: opts.clientId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(opts.privateKeyPem);
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const raw = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(raw)}`;
}

export interface AppleIdTokenClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

interface JwksKey {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
}

let jwksCache: { keys: JwksKey[]; fetchedAt: number } | null = null;

async function fetchAppleJwks(fetchImpl: typeof fetch): Promise<JwksKey[] | null> {
  const now = Date.now();
  if (jwksCache !== null && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  let json: unknown;
  try {
    const res = await fetchImpl(APPLE_JWKS_URL);
    if (!res.ok) return jwksCache?.keys ?? null;
    json = await res.json();
  } catch {
    return jwksCache?.keys ?? null;
  }
  if (typeof json !== "object" || json === null || !Array.isArray((json as { keys?: unknown }).keys)) return null;
  jwksCache = { keys: (json as { keys: JwksKey[] }).keys, fetchedAt: now };
  return jwksCache.keys;
}

/** 取签名公钥（kid 未命中时强制刷新一次，应对 Apple 轮换密钥）。 */
async function getAppleSigningKey(kid: string, fetchImpl: typeof fetch): Promise<JwksKey | null> {
  let keys = await fetchAppleJwks(fetchImpl);
  if (keys === null) return null;
  let key = keys.find((k) => k.kid === kid);
  if (key === undefined) {
    jwksCache = null;
    keys = await fetchAppleJwks(fetchImpl);
    key = keys?.find((k) => k.kid === kid);
  }
  if (key === undefined || key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string") return null;
  return key;
}

/**
 * 校验 Apple 身份令牌：RS256 验签 + iss/aud/exp + nonce 一致性（防重放）。
 * 返回 null 表示任一校验失败。
 */
export async function verifyAppleIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; nowMs: number; fetchImpl: typeof fetch },
): Promise<AppleIdTokenClaims | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  if (payload.iss !== APPLE_ISS) return null;
  if (payload.aud !== opts.clientId) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= opts.nowMs) return null;
  if (typeof payload.sub !== "string" || payload.sub === "") return null;
  // nonce：App 传入的 raw nonce 的 SHA-256 摘要，须等于 token 里 base64url 编码的 nonce 声明
  if (typeof payload.nonce !== "string") return null;
  const expected = sha256Hex(opts.nonce);
  const actual = Buffer.from(payload.nonce, "base64url").toString("hex");
  if (actual !== expected) return null;

  const key = await getAppleSigningKey(header.kid, opts.fetchImpl);
  if (key === null) return null;
  const pub = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  if (!verifier.verify(pub, Buffer.from(s, "base64url"))) return null;

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
  };
}

export interface AppleTokenResponse {
  accessToken: string;
  /** 仅首次授权时返回；之后为 null */
  refreshToken: string | null;
  idToken: string | null;
}

function appleAuthBody(clientId: string, clientSecret: string, extra: Record<string, string>): string {
  return new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...extra }).toString();
}

/** authorizationCode → access_token（+ 首次的 refresh_token）。失败返回 null。 */
export async function exchangeAppleCode(
  code: string,
  opts: { clientId: string; clientSecret: string; fetchImpl: typeof fetch },
): Promise<AppleTokenResponse | null> {
  try {
    const res = await opts.fetchImpl(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: appleAuthBody(opts.clientId, opts.clientSecret, { code, grant_type: "authorization_code" }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (typeof json.access_token !== "string") return null;
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" && json.refresh_token !== "" ? json.refresh_token : null,
      idToken: typeof json.id_token === "string" ? json.id_token : null,
    };
  } catch {
    return null;
  }
}

/** refresh_token → 新 access_token。失败返回 null。 */
export async function refreshAppleToken(
  refreshToken: string,
  opts: { clientId: string; clientSecret: string; fetchImpl: typeof fetch },
): Promise<string | null> {
  try {
    const res = await opts.fetchImpl(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: appleAuthBody(opts.clientId, opts.clientSecret, { refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return typeof json.access_token === "string" ? json.access_token : null;
  } catch {
    return null;
  }
}

/** 吊销 Apple 令牌（refresh/access 皆可）。成功返回 true。 */
export async function revokeAppleToken(
  token: string,
  opts: { clientId: string; clientSecret: string; fetchImpl: typeof fetch },
): Promise<boolean> {
  try {
    const res = await opts.fetchImpl(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: appleAuthBody(opts.clientId, opts.clientSecret, { token, token_type_hint: "refresh_token" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** AES-256-GCM 加密（`iv.密文.tag`，base64url 三段）。 */
export function encryptToken(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), enc.toString("base64url"), tag.toString("base64url")].join(".");
}

/** AES-256-GCM 解密；失败返回 null。 */
export function decryptToken(ciphertext: string, keyHex: string): string | null {
  try {
    const parts = ciphertext.split(".");
    if (parts.length !== 3) return null;
    const [ivB64, encB64, tagB64] = parts as [string, string, string];
    const key = Buffer.from(keyHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64url")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}
