/**
 * e2ee.ts — 内层 Noise NK（X25519 + HKDF-SHA256 + AES-256-GCM）Node 端（gateway 用）。
 *
 * 简化自 Noise NK 模式（host 静态密钥 + 浏览器临时密钥，浏览器靠 pin 认证 host）：
 * - 共享密钥 = X25519(本端私钥, 对端公钥)
 * - 派生 = HKDF-SHA256(ikm=ss, salt=PROTOCOL_LABEL, info="session") → 64B → [initiator→responder(32), responder→initiator(32)]
 * - AEAD = AES-256-GCM，包格式 [12B nonce][ciphertext][16B tag]，显式 nonce + 每方向独立计数
 *
 * 注：为浏览器 WebCrypto 兼容选 AES-256-GCM（ChaCha20-Poly1305 在 WebCrypto 支持不普及）。
 * 上线前建议与 Noise 规范 / 被审计库交叉复核（见 solution.md §6/§7）。
 */
import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

export const PROTOCOL_LABEL = Buffer.from("rdsh-e2ee-nk-v1");
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
/** X25519 PKCS8 DER 前缀（16B，后接 32B raw 私钥）。 */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export interface KeyPair {
  privateKey: KeyObject;
  publicRaw: Buffer;
}

export interface E2eeKeys {
  /** initiator（浏览器）→ responder（host）方向密钥 */
  initiatorToResponder: Buffer;
  /** responder（host）→ initiator（浏览器）方向密钥 */
  responderToInitiator: Buffer;
}

/** 生成 X25519 密钥对。 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { privateKey, publicRaw: publicToRaw(publicKey) };
}

export function publicToRaw(pub: KeyObject): Buffer {
  const jwk = pub.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url");
}

export function publicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

export function privateFromRaw(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** 持久化：raw 私钥 + 公钥（base64url 字符串）。 */
export function serializeKeyPair(kp: KeyPair): { publicRaw: string; privateRaw: string } {
  const jwk = kp.privateKey.export({ format: "jwk" }) as { d: string };
  return { publicRaw: kp.publicRaw.toString("base64url"), privateRaw: Buffer.from(jwk.d, "base64url").toString("base64url") };
}

export function deserializeKeyPair(publicRaw: string, privateRaw: string): KeyPair {
  return { privateKey: privateFromRaw(Buffer.from(privateRaw, "base64url")), publicRaw: Buffer.from(publicRaw, "base64url") };
}

/** X25519 共享密钥（32B）。 */
export function ecdh(privateKey: KeyObject, theirPublicRaw: Buffer): Buffer {
  return diffieHellman({ privateKey, publicKey: publicFromRaw(theirPublicRaw) });
}

/** HKDF 派生双向密钥。 */
export function deriveKeys(sharedSecret: Buffer): E2eeKeys {
  const okm = Buffer.from(hkdfSync("sha256", sharedSecret, PROTOCOL_LABEL, Buffer.from("session"), 2 * KEY_LEN));
  return {
    initiatorToResponder: okm.subarray(0, KEY_LEN),
    responderToInitiator: okm.subarray(KEY_LEN, 2 * KEY_LEN),
  };
}

/** 指纹（pinning 展示）：SHA-256 前 8 字节 hex 分组。 */
export function fingerprint(publicRaw: Buffer): string {
  const h = createHash("sha256").update(publicRaw).digest("hex").slice(0, 16).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}

/** 发起方（浏览器）：临时密钥 × host 静态公钥 → 会话密钥；返回要发送的临时公钥。 */
export function initiatorHandshake(responderStaticPublicRaw: Buffer): { ephemeralPublicRaw: Buffer; keys: E2eeKeys } {
  const eph = generateKeyPair();
  const ss = ecdh(eph.privateKey, responderStaticPublicRaw);
  return { ephemeralPublicRaw: eph.publicRaw, keys: deriveKeys(ss) };
}

/** 响应方（host）：静态私钥 × 收到的发起方临时公钥 → 会话密钥。 */
export function responderHandshake(staticKeyPair: KeyPair, initiatorEphemeralPublicRaw: Buffer): E2eeKeys {
  const ss = ecdh(staticKeyPair.privateKey, initiatorEphemeralPublicRaw);
  return deriveKeys(ss);
}

/** AES-256-GCM 包：[12B nonce][ciphertext][16B tag]。显式 nonce（每方向独立计数，防错）。 */
export class Aead {
  private readonly key: Buffer;
  private counter = 0n;
  constructor(key: Buffer) {
    this.key = key;
  }

  encrypt(plaintext: Buffer, aad: Buffer): Buffer {
    const nonce = this.nextNonce();
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
  }

  decrypt(packet: Buffer, aad: Buffer): Buffer {
    if (packet.length < NONCE_LEN + TAG_LEN) throw new Error("e2ee: packet too short");
    const nonce = packet.subarray(0, NONCE_LEN);
    const tag = packet.subarray(packet.length - TAG_LEN);
    const ct = packet.subarray(NONCE_LEN, packet.length - TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  private nextNonce(): Buffer {
    const n = Buffer.alloc(NONCE_LEN);
    n.writeBigUInt64BE(this.counter, NONCE_LEN - 8);
    this.counter += 1n;
    return n;
  }
}
