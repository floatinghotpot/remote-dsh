/**
 * captcha.ts — 算术验证码（零依赖，防裸脚本 bot）。
 *
 * 71 B2：答案入库（跨实例）；一次性由 store 的原子 consume 保证；TTL 5 分钟。
 * 仅 `provider=arithmetic` 走此路径（aliyun/none 不碰）。
 */
import { randomInt, randomUUID } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;

/** 只依赖 create/consume 两个方法，`runtime.store` 可直接满足（结构化类型）。 */
export interface CaptchaChallengeStore {
  createCaptchaChallenge(token: string, answer: number, expiresAt: number): Promise<void>;
  consumeCaptchaChallenge(token: string, now: number): Promise<{ answer: number } | null>;
}

export async function createChallenge(
  store: CaptchaChallengeStore,
  ttlMs = TTL_MS,
): Promise<{ token: string; question: string }> {
  const a = randomInt(1, 10);
  const b = randomInt(1, 10);
  const token = randomUUID();
  await store.createCaptchaChallenge(token, a + b, Date.now() + ttlMs);
  return { token, question: `${a} + ${b} = ?` };
}

/** 校验答案；一次性（store 的原子 consume 保证同一 token 只有一次成功）。 */
export async function verifyChallenge(
  store: CaptchaChallengeStore,
  token: string,
  answer: string,
): Promise<boolean> {
  const c = await store.consumeCaptchaChallenge(token, Date.now());
  if (c === null) return false;
  return String(c.answer) === answer.trim();
}
