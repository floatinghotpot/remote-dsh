/**
 * pg-store/codes.ts — PostgreSQL implementation of email/sms verification-code methods.
 * Ported from HubDb (SQLite) in ../db.ts; row mappers are shared from ./mappers.ts.
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { HubStore } from "../store.ts";
import { q, one, mapEmailCode, mapSmsCode } from "./mappers.ts";

export function codes(pool: Pool): Pick<
  HubStore,
  | "createEmailCode"
  | "getEmailCodeByEmail"
  | "incrementCodeAttempts"
  | "deleteEmailCodes"
  | "createSmsCode"
  | "getSmsCodeByPhone"
  | "incrementSmsCodeAttempts"
  | "deleteSmsCodes"
> {
  return {
    async createEmailCode(userId, email, purpose, codeHash, expiresAt, now = Date.now()) {
      // 同 email+purpose 只留最新一条
      await txDb(pool).query("DELETE FROM email_codes WHERE email = $1 AND purpose = $2", [email, purpose]);
      await txDb(pool).query(
        "INSERT INTO email_codes (user_id, email, purpose, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [userId, email, purpose, codeHash, expiresAt, now],
      );
      const row = one(
        await q(txDb(pool), "SELECT * FROM email_codes WHERE email = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1", [email, purpose]),
      );
      return mapEmailCode(row!);
    },

    async getEmailCodeByEmail(email, purpose) {
      const row = one(
        await q(txDb(pool), "SELECT * FROM email_codes WHERE email = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1", [email, purpose]),
      );
      return row === null ? null : mapEmailCode(row);
    },

    async incrementCodeAttempts(id) {
      await txDb(pool).query("UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1", [id]);
    },

    async deleteEmailCodes(email) {
      await txDb(pool).query("DELETE FROM email_codes WHERE email = $1", [email]);
    },

    async createSmsCode(userId, phone, purpose, codeHash, expiresAt, now = Date.now()) {
      await txDb(pool).query("DELETE FROM sms_codes WHERE phone = $1 AND purpose = $2", [phone, purpose]);
      await txDb(pool).query(
        "INSERT INTO sms_codes (user_id, phone, purpose, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [userId, phone, purpose, codeHash, expiresAt, now],
      );
      const row = one(
        await q(txDb(pool), "SELECT * FROM sms_codes WHERE phone = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1", [phone, purpose]),
      );
      return mapSmsCode(row!);
    },

    async getSmsCodeByPhone(phone, purpose) {
      const row = one(
        await q(txDb(pool), "SELECT * FROM sms_codes WHERE phone = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1", [phone, purpose]),
      );
      return row === null ? null : mapSmsCode(row);
    },

    async incrementSmsCodeAttempts(id) {
      await txDb(pool).query("UPDATE sms_codes SET attempts = attempts + 1 WHERE id = $1", [id]);
    },

    async deleteSmsCodes(phone) {
      await txDb(pool).query("DELETE FROM sms_codes WHERE phone = $1", [phone]);
    },
  };
}
