/**
 * billing/cmb.ts — 招商银行一网通聚合支付 provider（备选通道，S3）。
 *
 * 国密 SM2withSM3 签名/验签（sm-crypto，零依赖纪律的合理例外）。API 依据：
 * https://openhome.cmbchina.com/PayNew/pay/doc/cell/H5/OneCardPayAPI
 * 下单/回调的精确 endpoint 与字段以招行开放平台文档为准（接入时核对 + 客户经理确认动态码/H5 直唤起）。
 */
import { sm2 } from "sm-crypto";
import type { PaymentProvider, PaymentRequest, PaymentResult, CmbConfig } from "./types.ts";

/** SM2withSM3 签名（hex）。 */
export function sm2Sign(message: string, privateKeyHex: string): string {
  return sm2.doSignature(message, privateKeyHex, { hash: true });
}

/** SM2withSM3 验签（招行回调验签用）。 */
export function sm2Verify(message: string, signatureHex: string, publicKeyHex: string): boolean {
  return sm2.doVerifySignature(message, signatureHex, publicKeyHex, { hash: true });
}

export function createCmbProvider(config: CmbConfig): PaymentProvider {
  return {
    async createPayment(req: PaymentRequest): Promise<PaymentResult> {
      // 聚合支付下单：精确 endpoint/字段以招行一网通支付文档为准（接入时核对）
      const body = JSON.stringify({
        merchantNo: config.merchantNo,
        orderNo: req.orderId,
        amount: req.amountCny,
        notifyUrl: config.notifyUrl,
        subject: req.subject,
      });
      const signature = sm2Sign(body, config.privateKey);
      // TODO(接入时)：POST 到招行聚合支付下单端点，返回聚合二维码/手机唤起参数
      return { channelOrderId: req.orderId, paid: false, payInfo: { orderId: req.orderId, signature } };
    },
  };
}
