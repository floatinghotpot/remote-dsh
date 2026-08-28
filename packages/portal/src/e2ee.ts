/**
 * e2ee.ts — 内层 Noise NK（X25519 + HKDF-SHA256 + AES-256-GCM）浏览器端（portal 用，WebCrypto）。
 *
 * 与 `gateway/src/e2ee.ts` 线级兼容：同 PROTOCOL_LABEL、同 HKDF 参数（salt=label, info="session"）、
 * 同包格式 [12B nonce][ciphertext][16B tag]、同密钥派生（64B → [initiator→responder, responder→initiator]）。
 */
export const PROTOCOL_LABEL = new TextEncoder().encode("rdsh-e2ee-nk-v1");
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const enc = new TextEncoder();

export interface E2eeKeys {
  initiatorToResponder: Uint8Array;
  responderToInitiator: Uint8Array;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 生成 X25519 密钥对（浏览器临时密钥 / host 静态密钥）。 */
export async function generateKeyPair(): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { privateKey: kp.privateKey, publicRaw };
}

async function publicFromRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "X25519", false, []);
}

async function ecdh(privateKey: CryptoKey, theirPublicRaw: Uint8Array): Promise<Uint8Array> {
  const pub = await publicFromRaw(theirPublicRaw);
  const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, privateKey, 256);
  return new Uint8Array(bits);
}

/** HKDF 派生双向密钥（与 Node 端一致：salt=PROTOCOL_LABEL, info="session", 64B）。 */
export async function deriveKeys(sharedSecret: Uint8Array): Promise<E2eeKeys> {
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: PROTOCOL_LABEL, info: enc.encode("session") },
      hkdfKey,
      (2 * KEY_LEN) * 8,
    ),
  );
  return {
    initiatorToResponder: okm.slice(0, KEY_LEN),
    responderToInitiator: okm.slice(KEY_LEN),
  };
}

/** 发起方（浏览器）：临时密钥 × host 静态公钥 → 会话密钥；返回要发送的临时公钥。 */
export async function initiatorHandshake(responderStaticPublicRaw: Uint8Array): Promise<{ ephemeralPublicRaw: Uint8Array; keys: E2eeKeys }> {
  const eph = await generateKeyPair();
  const ss = await ecdh(eph.privateKey, responderStaticPublicRaw);
  return { ephemeralPublicRaw: eph.publicRaw, keys: await deriveKeys(ss) };
}

/** 指纹（pinning 展示）：SHA-256 前 8 字节 hex 分组，与 Node 端一致。 */
export async function fingerprint(publicRaw: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", publicRaw));
  const hex = [...h.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

/** AES-256-GCM 包：[12B nonce][ciphertext][16B tag]。显式 nonce（每方向独立计数）。 */
export class Aead {
  private key: Uint8Array;
  private counter = 0n;
  constructor(key: Uint8Array) {
    this.key = key;
  }

  async encrypt(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const nonce = this.nextNonce();
    const key = await this.aesKey();
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext));
    return concat(nonce, ct);
  }

  async decrypt(packet: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    if (packet.length < NONCE_LEN + TAG_LEN) throw new Error("e2ee: packet too short");
    const nonce = packet.subarray(0, NONCE_LEN);
    const data = packet.subarray(NONCE_LEN);
    const key = await this.aesKey();
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, data));
  }

  private async aesKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", this.key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  private nextNonce(): Uint8Array {
    const n = new Uint8Array(NONCE_LEN);
    new DataView(n.buffer).setBigUint64(4, this.counter);
    this.counter += 1n;
    return n;
  }
}
