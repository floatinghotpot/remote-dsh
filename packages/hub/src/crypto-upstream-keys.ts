/**
 * crypto-upstream-keys.ts — 51-llm-model-catalog：上游 key 的信封加密 + config 下发密封。
 *
 * - 上游 key：每行随机 DEK(32B) 用 AES-256-GCM 加密 key；KEK 只包裹 DEK（信封）。
 * - config 下发：用 Router 唯一 token 派生密钥（HKDF-SHA256）加密整段配置。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENC_VERSION = 1;

function aad(...parts: string[]): Buffer {
  return Buffer.from(parts.join(":"), "utf8");
}

/** 从目录按版本加载 KEK（base64，解码后必须 32 字节）。 */
export function loadKek(kekDir: string, version: number): Buffer {
  const raw = readFileSync(join(kekDir, `upstream-keys.kek.v${version}`), "utf8").trim();
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`KEK v${version} must decode to 32 bytes`);
  return buf;
}

/** 加密上游 key：返回 `{ keyCipher, dekWrapped }`（均为 base64）。 */
export function encryptUpstreamKey(plain: string, kek: Buffer, kekVersion: number, id: string, provider: string): { keyCipher: string; dekWrapped: string } {
  const dek = randomBytes(32);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(aad(id, provider));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const keyCipher = Buffer.concat([Buffer.from([ENC_VERSION]), iv, ct, tag]).toString("base64");

  const dekIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", kek, dekIv);
  wrap.setAAD(aad(id, String(kekVersion)));
  const dekCt = Buffer.concat([wrap.update(dek), wrap.final()]);
  const dekTag = wrap.getAuthTag();
  const dekWrapped = Buffer.concat([dekIv, dekCt, dekTag]).toString("base64");

  return { keyCipher, dekWrapped };
}

/** 解密上游 key（先解 DEK，再解 key）。 */
export function decryptUpstreamKey(keyCipherB64: string, dekWrappedB64: string, kek: Buffer, kekVersion: number, id: string, provider: string): string {
  const dekBlob = Buffer.from(dekWrappedB64, "base64");
  const dekIv = dekBlob.subarray(0, 12);
  const dekCt = dekBlob.subarray(12, dekBlob.length - 16);
  const dekTag = dekBlob.subarray(dekBlob.length - 16);
  const unwrap = createDecipheriv("aes-256-gcm", kek, dekIv);
  unwrap.setAAD(aad(id, String(kekVersion)));
  unwrap.setAuthTag(dekTag);
  const dek = Buffer.concat([unwrap.update(dekCt), unwrap.final()]);

  const blob = Buffer.from(keyCipherB64, "base64");
  if (blob[0] !== ENC_VERSION) throw new Error(`unsupported key cipher version ${blob[0]}`);
  const iv = blob.subarray(1, 13);
  const ct = blob.subarray(13, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const dec = createDecipheriv("aes-256-gcm", dek, iv);
  dec.setAAD(aad(id, provider));
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
}

/** 用 Router 唯一 token 派生密钥，密封整段 config JSON。返回 base64 blob。 */
export function sealConfig(plainJson: string, routerToken: string, routerId: string): string {
  const salt = randomBytes(16);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(routerToken, "utf8"), salt, Buffer.from(`rdsh-llm-config-v1:${routerId}`, "utf8"), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(routerId, "utf8"));
  const ct = Buffer.concat([cipher.update(plainJson, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENC_VERSION]), salt, iv, ct, tag]).toString("base64");
}

/** 解密密封的 config（对称于 sealConfig；供调试/测试与 Go Router 交叉验证）。 */
export function unsealConfig(payloadB64: string, routerToken: string, routerId: string): string {
  const blob = Buffer.from(payloadB64, "base64");
  if (blob[0] !== ENC_VERSION) throw new Error(`unsupported seal version ${blob[0]}`);
  const salt = blob.subarray(1, 17);
  const iv = blob.subarray(17, 29);
  const ct = blob.subarray(29, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(routerToken, "utf8"), salt, Buffer.from(`rdsh-llm-config-v1:${routerId}`, "utf8"), 32));
  const dec = createDecipheriv("aes-256-gcm", key, iv);
  dec.setAAD(Buffer.from(routerId, "utf8"));
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
}

