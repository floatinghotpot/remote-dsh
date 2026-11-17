/**
 * pg-store/index.ts — 43b-2：组装各领域模块为完整 `HubStore`（PostgreSQL 实现）。
 */
import type { Pool } from "pg";
import { withTransaction } from "../pg.ts";
import { computeCostFromRates } from "../pricing/index.ts";
import type { HubStore } from "../store.ts";
import { users } from "./users.ts";
import { hosts } from "./hosts.ts";
import { tokens } from "./tokens.ts";
import { codes } from "./codes.ts";
import { billing } from "./billing.ts";
import { credits } from "./credits.ts";
import { usage } from "./usage.ts";
import { nodes } from "./nodes.ts";
import { internalLlm } from "./internal-llm.ts";
import { llmCatalog } from "./llm-catalog.ts";
import { serviceProviders } from "./service-providers.ts";
import { upstreamCost } from "./upstream-cost.ts";
import { analytics } from "./analytics.ts";
import { captcha } from "./captcha.ts";
import { wechat } from "./wechat.ts";
import { revocations } from "./revocations.ts";
import { hubInstances } from "./hub-instances.ts";

/** 由连接池构造 PostgreSQL 版 `HubStore`（供 `startHubServer` 在 `db.driver=postgres` 时使用）。 */
export function createPgStore(pool: Pool): HubStore {
  const parts = {
    ...users(pool),
    ...hosts(pool),
    ...tokens(pool),
    ...codes(pool),
    ...billing(pool),
    ...credits(pool),
    ...usage(pool),
    ...nodes(pool),
    ...internalLlm(pool),
    ...llmCatalog(pool),
    ...serviceProviders(pool),
    ...upstreamCost(pool),
    ...analytics(pool),
    ...captcha(pool),
    ...wechat(pool),
    ...revocations(pool),
    ...hubInstances(pool),
  };
  return {
    ...parts,
    /** 结算 LLM hold：扣费 + 加 spent + 写用量在同一事务（嵌套调用走 SAVEPOINT）。 */
    settleLlmHold: async (holdId, actualMicro, u) =>
      withTransaction(pool, async () => {
        const settle = await parts.settleCreditHold(holdId, actualMicro);
        if (settle.status === "settled") {
          if (actualMicro > 0) await parts.addLlmKeySpent(u.keyId, actualMicro);
          await parts.upsertLlmUsageDaily({ ...u, chargedMicro: actualMicro, now: Date.now() });
        }
        // 69：上游成本在「已结算」与「欠费未结」都要记（上游已消耗）；hold 级幂等防重试重复计。
        if ((settle.status === "settled" || settle.status === "insufficient") && await parts.markUpstreamRecorded(holdId)) {
          const now = Date.now();
          if (u.provider !== undefined && u.provider !== "" && u.upstreamModel !== undefined && u.upstreamModel !== "") {
            const price = await parts.getUpstreamPrice(u.provider, u.upstreamModel);
            if (price === null) console.warn(`rdsh-hub: llm upstream price missing provider=${u.provider} model=${u.upstreamModel}`);
            const costMicro = price === null ? 0 : computeCostFromRates(u.provider, u.upstreamModel, "llm", u, new Date(now), price.rates);
            await parts.upsertUpstreamUsageDaily({
              provider: u.provider, upstreamModel: u.upstreamModel, modelAlias: u.modelAlias, date: u.date,
              inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens, reasoningTokens: u.reasoningTokens, costMicro, now,
            });
          }
        }
        return settle;
      }),
    withTransaction: (fn) => withTransaction(pool, async (client) => fn(client)),
    close: async () => {
      await pool.end();
    },
    // backupTo 是 SQLite 的 VACUUM INTO；PostgreSQL 走 pg_dump（43c 迁移工具 / 托管备份）。
    backupTo: async (_targetPath: string) => {
      throw new Error("backupTo is SQLite-only; use pg_dump for PostgreSQL");
    },
  } as HubStore;
}
