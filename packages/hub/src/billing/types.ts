/**
 * billing/types.ts — PaymentProvider 抽象（08-saas S2/S3）。
 *
 * 镜像 EmailSender/SmsSender 的 provider 模式：S2 用 mock；S3 接招行聚合收款。
 */
/** 支付形态：native（PC 扫码）/ h5（手机浏览器唤起）/ jsapi（微信内）。 */
export type PaymentForm = "native" | "h5" | "jsapi";

export interface PaymentRequest {
  orderId: string;
  amountCny: number;
  subject: string;
  /** 支付形态，缺省 native。 */
  form?: PaymentForm;
  /** jsapi 时的用户 openid（OAuth 获取，存签名 Cookie）。 */
  openid?: string;
  /** h5 下单所需的支付方 IP（后端从请求取）。 */
  clientIp?: string;
}

export interface PaymentResult {
  /** 支付渠道单号（对账/幂等） */
  channelOrderId: string;
  /** mock 立即成功；真实通道为 false（等待异步回调） */
  paid: boolean;
  /** 支付形态数据（桌面二维码 / 手机唤起等），S3 由招行返回 */
  payInfo?: unknown;
}

export interface PaymentProvider {
  createPayment(req: PaymentRequest): Promise<PaymentResult>;
}

export interface WechatPayConfig {
  mchid: string;
  appid: string;
  /** 公众号 appSecret（JSAPI OAuth 换 openid；不配则 JSAPI 不可用） */
  appSecret?: string;
  /** 商户 API 证书序列号 */
  certSerialNo: string;
  /** 商户私钥 PEM（请求签名 RSA-SHA256） */
  privateKey: string;
  /** APIv3 密钥（回调验签 HMAC-SHA256） */
  apiV3Key: string;
  /** 支付回调通知地址（公网可达） */
  notifyUrl: string;
  /** 默认 https://api.mch.weixin.qq.com */
  endpoint?: string;
}

export interface PaymentConfig {
  provider: "mock" | "wechatpay" | "cmb";
  wechatpay?: WechatPayConfig;
  cmb?: CmbConfig;
}

/** 招商银行一网通聚合支付（SM2 国密验签）。 */
export interface CmbConfig {
  /** 商户号（招行签约后获得） */
  merchantNo: string;
  /** 商户私钥（SM2，HEX） */
  privateKey: string;
  /** 招行平台公钥（SM2，HEX，回调验签用） */
  cmbPublicKey: string;
  /** 支付回调通知地址（公网可达） */
  notifyUrl: string;
  /** 默认 https://api.cmbchina.com（接入时以招行文档为准） */
  endpoint?: string;
}
