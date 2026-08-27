/**
 * billing/index.ts — PaymentProvider 工厂。
 *
 * S2：统一 mock（立即成功）；S3 接招行聚合收款后切换 provider。
 */
import type { PaymentConfig, PaymentProvider } from "./types.ts";
import { createMockProvider } from "./mock.ts";
import { createWechatPayProvider } from "./wechatpay.ts";
import { createCmbProvider } from "./cmb.ts";

export type { PaymentRequest, PaymentResult, PaymentProvider, PaymentConfig, WechatPayConfig, CmbConfig } from "./types.ts";
export { signWechatRequest, buildWechatAuthHeader, verifyWechatCallback, decryptWechatResource } from "./wechatpay.ts";
export { sm2Sign, sm2Verify } from "./cmb.ts";

/** 按 billing.payment.provider 创建：mock（默认）| wechatpay | cmb。 */
export function createPaymentProvider(config?: PaymentConfig): PaymentProvider {
  if (config?.provider === "wechatpay") {
    if (config.wechatpay === undefined) throw new Error("billing.payment.provider=wechatpay requires billing.payment.wechatpay config");
    return createWechatPayProvider(config.wechatpay);
  }
  if (config?.provider === "cmb") {
    if (config.cmb === undefined) throw new Error("billing.payment.provider=cmb requires billing.payment.cmb config");
    return createCmbProvider(config.cmb);
  }
  return createMockProvider();
}
