/**
 * hostcookie.ts — host 访问 cookie 的 Ed25519 签名器（R17：密钥分离）。
 *
 * 账号服务持私钥签发；节点经 N5 拿公钥（publicKeyHex）验签。私钥存 PEM 文件
 *（默认与 hub-jwt.key 同目录，0600），首次启动自动生成。
 */
import { generateKeyPairSync, sign, createPublicKey, createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface HostCookieSigner {
  /** Ed25519 签名，返回 hex（64B → 128 hex 字符）。 */
  sign(payload: string): string;
  /** 原始公钥（32B），供 Node 端 crypto.verify。 */
  publicKey: KeyObject;
  /** 公钥 hex（64 字符），经 N5 下发给节点。 */
  publicKeyHex: string;
}

/** 从 SPKI DER 提取原始 32 字节公钥（DER 尾部 32B）→ hex。 */
function publicKeyHexFrom(pub: KeyObject): string {
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(der.length - 32).toString("hex");
}

export function loadHostCookieSigner(path: string): HostCookieSigner {
  let priv: KeyObject;
  try {
    priv = createPrivateKey(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dirname(path), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    return {
      sign: (payload: string): string => sign(null, Buffer.from(payload), privateKey).toString("hex"),
      publicKey,
      publicKeyHex: publicKeyHexFrom(publicKey),
    };
  }
  const pub = createPublicKey(priv);
  return {
    sign: (payload: string): string => sign(null, Buffer.from(payload), priv).toString("hex"),
    publicKey: pub,
    publicKeyHex: publicKeyHexFrom(pub),
  };
}
