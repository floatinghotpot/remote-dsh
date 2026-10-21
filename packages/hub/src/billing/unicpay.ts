/**
 * billing/unicpay.ts — unicpay 平台 REST 客户端（feature 121 订阅支付接入）。
 *
 * 出站（initiate / store/verify）用 `auth_secret` 做 HMAC-SHA256 签名（caller→unicpay）；
 * 入站 webhook 用 `webhook_secret` 验签（unicpay→caller），两把密钥分离（req R8）。
 *
 * 契约来源：unicpay `backend/doc/api/01-app-api.md` §4（签名）、§1/§3（initiate/prepay）、
 * `04-store-api.md` §1（store/verify）、`03-webhook.md` §3（webhook 验签）。
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface UnicPayConfig {
  /** 应用业务键（Authorization: `UnicPay-App <appId>`） */
  appId: string;
  /** 平台地址，如 https://pay.example.com（自动去尾斜杠） */
  baseUrl: string;
  /** caller→unicpay 的 HMAC 密钥（出站签名） */
  authSecret: string;
  /** unicpay→caller 的 HMAC 密钥（入站 webhook 验签） */
  webhookSecret: string;
}

/** 出站签名规范化串：`METHOD\nPATH\ntimestamp\nnonce\nhex(sha256(body))`（01-app-api §4）。 */
function canonicalRequest(method: string, path: string, timestamp: string, nonce: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return `${method}\n${path}\n${timestamp}\n${nonce}\n${digest}`;
}

export function signRequest(authSecret: string, method: string, path: string, timestamp: string, nonce: string, body: string): string {
  return createHmac("sha256", authSecret).update(canonicalRequest(method, path, timestamp, nonce, body)).digest("hex");
}

/**
 * 入站 webhook 验签：canonical = `<Timestamp>.<Nonce>.<原始 body 字符串>`（03-webhook §3）。
 * 用恒定时间比较防时序侧信道。
 */
export function verifyWebhookSignature(webhookSecret: string, timestamp: string, nonce: string, rawBody: string, signature: string): boolean {
  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${nonce}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface InitiateParams {
  /** 支付场景（服务端路由决定实际渠道，接入方无法指定） */
  scene: "miniapp" | "native" | "app" | "alipay" | "h5" | "jsapi";
  /** 接入方订单号，幂等键 */
  appOrderId: string;
  /** 金额（最小货币单位）；与 goodsId 二选一 */
  amount?: number;
  /** 平台已登记商品；与 amount 二选一 */
  goodsId?: string;
  currency?: string;
  orderType?: "payment" | "subscription";
  /** 消费方用户标识；订阅必填 */
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface StoreVerifyParams {
  /** 消费方用户标识；订阅必填，一次性商品可省 */
  userId?: string;
  store: "apple" | "google";
  storeProductId: string;
  /** Apple：StoreKit 2 JWS；Google：purchaseToken */
  receipt: string;
}

/** unicpay 响应：HTTP 状态 + 解析后的 JSON（解析失败时返回原始文本）。 */
export interface UnicPayResponse {
  status: number;
  data: unknown;
}

export class UnicPayClient {
  private readonly baseUrl: string;
  private readonly cfg: UnicPayConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: UnicPayConfig, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  }

  /** 应用 HMAC 签名请求（initiate / store/verify）。body 为空对象时仍发 `{}`（签名需要 body 字节）。 */
  private async signedRequest(method: string, path: string, bodyObj: unknown): Promise<UnicPayResponse> {
    const body = JSON.stringify(bodyObj ?? {});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const signature = signRequest(this.cfg.authSecret, method, path, timestamp, nonce, body);
    return this.doFetch(this.baseUrl + path, {
      method,
      headers: {
        "content-type": "application/json",
        Authorization: `UnicPay-App ${this.cfg.appId}`,
        "X-UnicPay-Timestamp": timestamp,
        "X-UnicPay-Nonce": nonce,
        "X-UnicPay-Signature": signature,
      },
      body,
    });
  }

  /** prepay 无签名，凭 ticket（可选：小程序 wx.login `code` / jsapi `openid` / h5 `clientIp`）。 */
  async prepay(ticket: string, opts?: { code?: string; openid?: string; clientIp?: string }): Promise<UnicPayResponse> {
    const body: Record<string, string> = { ticket };
    if (opts?.code !== undefined) body.code = opts.code;
    if (opts?.openid !== undefined) body.openid = opts.openid;
    if (opts?.clientIp !== undefined) body.clientIp = opts.clientIp;
    return this.doFetch(this.baseUrl + "/v1/pay/prepay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async initiate(params: InitiateParams): Promise<UnicPayResponse> {
    return this.signedRequest("POST", "/v1/pay/initiate", params);
  }

  async storeVerify(params: StoreVerifyParams): Promise<UnicPayResponse> {
    return this.signedRequest("POST", "/v1/pay/store/verify", params);
  }

  /** 查支付单（按 ticket；平台侧无签名校验）。34-payment-order-check 补发用。 */
  async getOrder(ticket: string): Promise<UnicPayResponse> {
    return this.doFetch(this.baseUrl + "/v1/pay/order?ticket=" + encodeURIComponent(ticket), { method: "GET" });
  }

  /** 带超时 + 传输错误兜底的出站请求：超时/断连不再悬挂、也不抛异常，而是合成一个可透传的 504/502。 */
  private async doFetch(url: string, init: Parameters<typeof fetch>[1]): Promise<UnicPayResponse> {
    const opts: Parameters<typeof fetch>[1] = { ...(init ?? {}), signal: AbortSignal.timeout(this.timeoutMs) };
    try {
      const res = await this.fetchImpl(url, opts);
      return await this.readResponse(res);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const timedOut = name === "AbortError" || name === "TimeoutError";
      return {
        status: timedOut ? 504 : 502,
        data: {
          code: timedOut ? "upstream_timeout" : "upstream_unreachable",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private async readResponse(res: Response): Promise<UnicPayResponse> {
    const text = await res.text();
    let data: unknown = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data };
  }
}
