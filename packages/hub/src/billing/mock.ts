/**
 * billing/mock.ts — mock provider：立即支付成功（走通订阅全流程，不接真实渠道）。
 */
import { randomUUID } from "node:crypto";
import type { PaymentProvider, PaymentRequest, PaymentResult } from "./types.ts";

export function createMockProvider(): PaymentProvider {
  return {
    async createPayment(req: PaymentRequest): Promise<PaymentResult> {
      return {
        channelOrderId: `mock-${randomUUID()}`,
        paid: true,
        payInfo: { orderId: req.orderId, amountCny: req.amountCny, subject: req.subject },
      };
    },
  };
}
