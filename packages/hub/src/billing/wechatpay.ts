/**
 * billing/wechatpay.ts — 微信支付 APIv3 Native provider（备选通道，S3 资质未到时先行编码）。
 *
 * 手写签名/验签（node:crypto，零依赖）：
 * - 请求签名：商户私钥 RSA-SHA256 签 `METHOD\npath\ntimestamp\nnonce\nbody\n`；
 * - 回调验签：微信平台私钥 RSA-SHA256 签 `timestamp\nnonce\nbody\n`，用平台证书公钥验证（Wechatpay-Signature）。
 */
import { createSign, createVerify, createDecipheriv, randomBytes } from "node:crypto";
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

/** JSAPI 调起参数签名：RSA-SHA256 签 `appId\ntimeStamp\nnonceStr\npackage\n`（canonical 与请求签名不同）。 */
export function signWechatJsapi(appId: string, timeStamp: string, nonceStr: string, pkg: string, privateKey: string): string {
  const canonical = `${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  return createSign("RSA-SHA256").update(canonical).sign(privateKey, "base64");
}

/** 回调验签：RSA-SHA256（微信平台私钥签发）→ 用平台证书公钥验证 `timestamp\nnonce\nbody\n`。 */
export function verifyWechatCallback(platformCert: string, timestamp: string, nonce: string, signature: string, body: string): boolean {
  const canonical = `${timestamp}\n${nonce}\n${body}\n`;
  try {
    return createVerify("RSA-SHA256").update(canonical).verify(platformCert, signature, "base64");
  } catch {
    return false;
  }
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

/** 公众号 OAuth2 code→openid（`api.weixin.qq.com`；fetch 可注入以便测试）。 */
export async function getWechatOpenid(appid: string, appSecret: string, code: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetchImpl(url);
  const json = (await res.json()) as { openid?: string; errcode?: number };
  if (json.errcode !== undefined || typeof json.openid !== "string" || json.openid === "") return null;
  return json.openid;
}

export function createWechatPayProvider(config: WechatPayConfig): PaymentProvider {
  const endpoint = config.endpoint ?? "https://api.mch.weixin.qq.com";
  return {
    async createPayment(req: PaymentRequest): Promise<PaymentResult> {
      const form = req.form ?? "native";
      const path = form === "native" ? "/v3/pay/transactions/native" : form === "h5" ? "/v3/pay/transactions/h5" : "/v3/pay/transactions/jsapi";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(16).toString("hex");

      const base: Record<string, unknown> = {
        appid: config.appid,
        mchid: config.mchid,
        description: req.subject,
        out_trade_no: req.orderId,
        notify_url: config.notifyUrl,
        amount: { total: Math.round(req.amountCny * 100), currency: "CNY" },
      };
      if (form === "h5") {
        base.scene_info = { payer_client_ip: req.clientIp ?? "127.0.0.1", h5_info: { type: "Wap" } };
      } else if (form === "jsapi") {
        if (typeof req.openid !== "string" || req.openid === "") throw new Error("jsapi payment requires openid");
        base.payer = { openid: req.openid };
      }

      const body = JSON.stringify(base);
      const signature = signWechatRequest("POST", path, timestamp, nonce, body, config.privateKey);
      const auth = buildWechatAuthHeader(config.mchid, config.certSerialNo, timestamp, nonce, signature);
      const res = await fetch(endpoint + path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth, accept: "application/json" },
        body,
      });
      const json = (await res.json()) as { code_url?: string; h5_url?: string; prepay_id?: string; code?: string; message?: string };
      if (json.code !== undefined) throw new Error(`wechatpay error: ${json.code}${json.message ? ` - ${json.message}` : ""}`);

      if (form === "h5") return { channelOrderId: req.orderId, paid: false, payInfo: { orderId: req.orderId, h5Url: json.h5_url } };
      if (form === "jsapi") {
        if (json.prepay_id === undefined) throw new Error("wechatpay error: missing prepay_id");
        const ts = String(Math.floor(Date.now() / 1000));
        const nonceStr = randomBytes(16).toString("hex");
        const pkg = `prepay_id=${json.prepay_id}`;
        return {
          channelOrderId: req.orderId,
          paid: false,
          payInfo: {
            orderId: req.orderId,
            appId: config.appid,
            timeStamp: ts,
            nonceStr,
            package: pkg,
            signType: "RSA",
            paySign: signWechatJsapi(config.appid, ts, nonceStr, pkg, config.privateKey),
          },
        };
      }
      return { channelOrderId: req.orderId, paid: false, payInfo: { orderId: req.orderId, codeUrl: json.code_url } };
    },
  };
}
