/**
 * pg-store/captcha.ts — 71 B2：算术验证码（PG 端口，从 db.ts 同名方法照搬）。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { HubStore } from "../store.ts";
import { q, one } from "./mappers.ts";

export function captcha(pool: Pool): Pick<
  HubStore,
  "createCaptchaChallenge" | "consumeCaptchaChallenge" | "pruneExpiredCaptchaChallenges"
> {
  return {
    createCaptchaChallenge: async (token: string, answer: number, expiresAt: number): Promise<void> => {
      await q(
        txDb(pool),
        "INSERT INTO captcha_challenges (token, answer, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET answer = excluded.answer, expires_at = excluded.expires_at",
        [token, answer, expiresAt],
      );
    },

    /** 原子 consume：同一 token 只有一次成功（DELETE ... RETURNING）；过期/不存在 → null。 */
    consumeCaptchaChallenge: async (token: string, now: number = Date.now()): Promise<{ answer: number } | null> => {
      const row = one(
        await q<{ answer: number }>(
          txDb(pool),
          "DELETE FROM captcha_challenges WHERE token = $1 AND expires_at > $2 RETURNING answer",
          [token, now],
        ),
      );
      return row === null ? null : { answer: Number(row.answer) };
    },

    pruneExpiredCaptchaChallenges: async (now: number = Date.now()): Promise<void> => {
      await q(txDb(pool), "DELETE FROM captcha_challenges WHERE expires_at <= $1", [now]);
    },
  };
}
