/**
 * billing/wechatpay.ts — 微信支付 APIv3 Native provider（备选通道，S3 资质未到时先行编码）。
 *
 * 手写签名/验签（node:crypto，零依赖）：
 * - 请求签名：商户私钥 RSA-SHA256 签 `METHOD\npath\ntimestamp\nnonce\nbody\n`；
 * - 回调验签：APIv3 密钥 HMAC-SHA256 签 `timestamp\nnonce\nbody\n`（Wechatpay-Signature）。
 */
import { createSign, createHmac, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import type { PaymentProvider, PaymentRequest, PaymentResult, WechatPayConfig } from "./types.ts";

/** 请求签名：RSA-SHA256 私钥签名 → base64。 */
export function signWechatRequest(method: string, path: string, timestamp: string, nonce: string, body: string, privateKey: string): string {
  const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
  return createSign("RSA-SHA256").update(canonical).sign(privateKey, "base64");
}

/** 组装 Authorization 头。 */
export function buildWechatAuthHeader(mchid: string, serialNo: string, timestamp: string, nonce: string, signature: string): string {
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
}

/** 回调验签：HMAC-SHA256(apiV3Key, timestamp\nnonce\nbody\n) 常量时间比较。 */
export function verifyWechatCallback(apiV3Key: string, timestamp: string, nonce: string, signature: string, body: string): boolean {
  const expected = createHmac("sha256", apiV3Key).update(`${timestamp}\n${nonce}\n${body}\n`).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 解密回调 resource（AES-256-GCM，key=APIv3 密钥）→ 业务明文 JSON。ciphertext = base64(cipher||authTag)。 */
export function decryptWechatResource(apiV3Key: string, resource: { ciphertext: string; nonce: string; associated_data?: string }): Record<string, unknown> {
  const raw = Buffer.from(resource.ciphertext, "base64");
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(resource.nonce));
  if (resource.associated_data !== undefined) decipher.setAAD(Buffer.from(resource.associated_data));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
}

export function createWechatPayProvider(config: WechatPayConfig): PaymentProvider {
  const endpoint = config.endpoint ?? "https://api.mch.weixin.qq.com";
  return {
    async createPayment(req: PaymentRequest): Promise<PaymentResult> {
      const path = "/v3/pay/transactions/native";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString("hex");
      const body = JSON.stringify({
        appid: config.appid,
        mchid: config.mchid,
        description: req.subject,
        out_trade_no: req.orderId,
        notify_url: config.notifyUrl,
        amount: { total: Math.round(req.amountCny * 100), currency: "CNY" },
      });
      const signature = signWechatRequest("POST", path, timestamp, nonce, body, config.privateKey);
      const auth = buildWechatAuthHeader(config.mchid, config.certSerialNo, timestamp, nonce, signature);
      const res = await fetch(endpoint + path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth, accept: "application/json" },
        body,
      });
      const json = (await res.json()) as { code_url?: string; code?: string; message?: string };
      if (json.code !== undefined) throw new Error(`wechatpay error: ${json.code}${json.message ? ` - ${json.message}` : ""}`);
      return { channelOrderId: req.orderId, paid: false, payInfo: { codeUrl: json.code_url, orderId: req.orderId } };
    },
  };
}
