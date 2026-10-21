/**
 * pg-store/billing.ts — 43b-2：订阅 / 订单 / 支付（S2）方法的 PostgreSQL 端口。
 *
 * 从 db.ts 的 HubDb 同名方法逐个照搬 SQL，按方言规则转成 PG（占位符 $n、
 * lastInsertRowid → RETURNING、布尔入参落库转 0/1）。行映射复用 ../pg-store/mappers.ts。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { SubscriptionRow, OrderRow, PaymentRow } from "../db.ts";
import type { HubStore } from "../store.ts";
import { q, one, mapSubscription, mapOrder, mapPayment } from "./mappers.ts";

export function billing(
  pool: Pool,
): Pick<
  HubStore,
  | "createSubscription"
  | "getActiveSubscription"
  | "getLatestSubscription"
  | "setSubscriptionStatus"
  | "getSubscriptionBySubscriptionId"
  | "updateSubscriptionBySubscriptionId"
  | "listSubscriptionsByUser"
  | "createOrder"
  | "getOrder"
  | "setOrderUnicpayRefs"
  | "markOrderPaid"
  | "markOrderPaidIfCreated"
  | "closeOrder"
  | "markOrderRefunded"
  | "listOrders"
  | "listOrdersByUser"
  | "listPaymentsByUser"
  | "listPayments"
  | "createPayment"
  | "getPaymentByChannelOrderId"
> {
  return {
    async createSubscription(
      userId: number,
      planId: string,
      startedAt: number,
      expiresAt: number,
      now = Date.now(),
      opts?: { channel?: string | null; subscriptionId?: string | null; willRenew?: boolean },
    ): Promise<SubscriptionRow> {
      const row = one(
        await q(txDb(pool),
          `INSERT INTO subscriptions (user_id, plan_id, status, started_at, expires_at, created_at, channel, subscription_id, will_renew)
           VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8) RETURNING *`,
          [userId, planId, startedAt, expiresAt, now, opts?.channel ?? null, opts?.subscriptionId ?? null, opts?.willRenew ? 1 : 0],
        ),
      );
      return mapSubscription(row!);
    },

    async getActiveSubscription(userId: number): Promise<SubscriptionRow | null> {
      const row = one(
        await q(txDb(pool), "SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1", [userId]),
      );
      return row === null ? null : mapSubscription(row);
    },

    /**
     * 取用户**最近一条**订阅（不按 status 过滤）。
     *
     * 用于配额计算：取消订阅（status=canceled）或进入宽限期（status 尚未翻但计划仍有效）时，
     * plan_status 仍是 subscribed/grace —— 当前周期仍有效，配额应保留。
     * 若用 getActiveSubscription（只看 active），此时会返回 null，配额被误判为 0。
     */
    async getLatestSubscription(userId: number): Promise<SubscriptionRow | null> {
      const row = one(await q(txDb(pool), "SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [userId]));
      return row === null ? null : mapSubscription(row);
    },

    async setSubscriptionStatus(id: number, status: string): Promise<void> {
      await txDb(pool).query("UPDATE subscriptions SET status = $1 WHERE id = $2", [status, id]);
    },

    /** 按平台订阅实体 ID（unicpay subscriptionId）查订阅，用于 webhook 幂等去重。 */
    async getSubscriptionBySubscriptionId(subscriptionId: string): Promise<SubscriptionRow | null> {
      const row = one(await q(txDb(pool), "SELECT * FROM subscriptions WHERE subscription_id = $1 LIMIT 1", [subscriptionId]));
      return row === null ? null : mapSubscription(row);
    },

    /** 按 subscriptionId 更新订阅状态（生命周期事件同实体，续订/宽限/到期/换档复用同一行）。 */
    async updateSubscriptionBySubscriptionId(
      subscriptionId: string,
      planId: string,
      status: string,
      expiresAt: number,
      willRenew: boolean,
    ): Promise<void> {
      await txDb(pool).query("UPDATE subscriptions SET plan_id = $1, status = $2, expires_at = $3, will_renew = $4 WHERE subscription_id = $5", [
        planId,
        status,
        expiresAt,
        willRenew ? 1 : 0,
        subscriptionId,
      ]);
    },

    /** 某用户的订阅历史（详情页）。 */
    async listSubscriptionsByUser(userId: number): Promise<SubscriptionRow[]> {
      const rows = (await q(txDb(pool), "SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows;
      return rows.map((r) => mapSubscription(r));
    },

    async createOrder(id: string, userId: number, planId: string, amountCny: number, now = Date.now()): Promise<OrderRow> {
      const row = one(
        await q(txDb(pool), "INSERT INTO orders (id, user_id, plan_id, amount_cny, status, created_at) VALUES ($1, $2, $3, $4, 'created', $5) RETURNING *", [
          id,
          userId,
          planId,
          amountCny,
          now,
        ]),
      );
      return mapOrder(row!);
    },

    async getOrder(id: string): Promise<OrderRow | null> {
      const row = one(await q(txDb(pool), "SELECT * FROM orders WHERE id = $1", [id]));
      return row === null ? null : mapOrder(row);
    },

    /** 34-payment-order-check：落库平台查单凭据（发起下单成功后调用一次）。 */
    async setOrderUnicpayRefs(id: string, ticket: string, paymentId: string): Promise<void> {
      await txDb(pool).query("UPDATE orders SET ticket = $1, payment_id = $2 WHERE id = $3", [ticket, paymentId, id]);
    },

    async markOrderPaid(id: string, channel: string, outId: string | null, paidAt = Date.now()): Promise<void> {
      await txDb(pool).query("UPDATE orders SET status = 'paid', channel = $1, out_id = $2, paid_at = $3 WHERE id = $4", [channel, outId, paidAt, id]);
    },

    /** 原子地 created→paid（带条件守卫）：返回是否真的跃迁成功。并发下只有一个调用方会得到 true。 */
    async markOrderPaidIfCreated(id: string, channel: string, outId: string | null, paidAt = Date.now()): Promise<boolean> {
      const res = await txDb(pool).query("UPDATE orders SET status = 'paid', channel = $1, out_id = $2, paid_at = $3 WHERE id = $4 AND status = 'created'", [
        channel,
        outId,
        paidAt,
        id,
      ]);
      return (res.rowCount ?? 0) > 0;
    },

    async closeOrder(id: string): Promise<void> {
      await txDb(pool).query("UPDATE orders SET status = 'closed' WHERE id = $1", [id]);
    },

    /** 记录人工退款：订单置 refunded（不接渠道退款 API，见 req R7）。 */
    async markOrderRefunded(id: string): Promise<void> {
      await txDb(pool).query("UPDATE orders SET status = 'refunded' WHERE id = $1", [id]);
    },

    /** 管理台订单分页 + 过滤（订单号精确 / 套餐 / 状态）；返回 { rows, total }。 */
    async listOrders(
      opts: { q?: string; planId?: string; status?: string; limit?: number; offset?: number } = {},
    ): Promise<{ rows: OrderRow[]; total: number }> {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (opts.q !== undefined && opts.q !== "") {
        params.push(opts.q);
        conds.push(`id = $${params.length}`);
      }
      if (opts.planId !== undefined && opts.planId !== "") {
        params.push(opts.planId);
        conds.push(`plan_id = $${params.length}`);
      }
      if (opts.status !== undefined && opts.status !== "") {
        params.push(opts.status);
        conds.push(`status = $${params.length}`);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const totalRow = one(await q(txDb(pool), `SELECT COUNT(*) AS c FROM orders ${where}`, params));
      const total = Number(totalRow?.c ?? 0);
      const limit = opts.limit !== undefined ? opts.limit : 50;
      const offset = opts.offset !== undefined ? opts.offset : 0;
      const rows = (
        await q(txDb(pool), `SELECT * FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
          ...params,
          limit,
          offset,
        ])
      ).rows;
      return { rows: rows.map((r) => mapOrder(r)), total };
    },

    /** 某用户的订单（详情页，按时间倒序）。 */
    async listOrdersByUser(userId: number): Promise<OrderRow[]> {
      const rows = (await q(txDb(pool), "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows;
      return rows.map((r) => mapOrder(r));
    },

    /** 某用户的支付流水（详情页）。 */
    async listPaymentsByUser(userId: number): Promise<PaymentRow[]> {
      const rows = (await q(txDb(pool), "SELECT * FROM payments WHERE user_id = $1 ORDER BY paid_at DESC", [userId])).rows;
      return rows.map((r) => mapPayment(r));
    },

    /** 全部支付流水（admin 账单运营，按支付时间倒序）。 */
    async listPayments(): Promise<PaymentRow[]> {
      const rows = (await q(txDb(pool), "SELECT * FROM payments ORDER BY paid_at DESC LIMIT 1000")).rows;
      return rows.map((r) => mapPayment(r));
    },

    async createPayment(
      id: string,
      orderId: string,
      userId: number,
      channel: string,
      channelOrderId: string,
      amountCny: number,
      paidAt: number,
      raw: string,
    ): Promise<PaymentRow> {
      const row = one(
        await q(txDb(pool),
          "INSERT INTO payments (id, order_id, user_id, channel, channel_order_id, amount_cny, paid_at, raw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
          [id, orderId, userId, channel, channelOrderId, amountCny, paidAt, raw],
        ),
      );
      return mapPayment(row!);
    },

    /** 按渠道单号查入账（支付回调幂等）。 */
    async getPaymentByChannelOrderId(channel: string, channelOrderId: string): Promise<PaymentRow | null> {
      const row = one(await q(txDb(pool), "SELECT * FROM payments WHERE channel = $1 AND channel_order_id = $2", [channel, channelOrderId]));
      return row === null ? null : mapPayment(row);
    },
  };
}
