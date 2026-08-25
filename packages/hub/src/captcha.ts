/**
 * captcha.ts — 算术验证码（零依赖，防裸脚本 bot）。
 *
 * 进程内内存存答案（5 分钟 TTL、一次性）；找回密码匿名页用。08-saas 换 aliyun 验证码。
 */
import { randomInt, randomUUID } from "node:crypto";

const challenges = new Map<string, { answer: number; exp: number }>();
const TTL_MS = 5 * 60 * 1000;

export function createChallenge(ttlMs = TTL_MS): { token: string; question: string } {
  const a = randomInt(1, 10);
  const b = randomInt(1, 10);
  const token = randomUUID();
  challenges.set(token, { answer: a + b, exp: Date.now() + ttlMs });
  return { token, question: `${a} + ${b} = ?` };
}

/** 校验答案；一次性（用过即删）。 */
export function verifyChallenge(token: string, answer: string): boolean {
  const c = challenges.get(token);
  if (c === undefined) return false;
  challenges.delete(token);
  if (c.exp <= Date.now()) return false;
  return String(c.answer) === answer.trim();
}
