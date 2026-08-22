/**
 * pair.ts — 配对码生成/校验 + IP 维度限流。
 *
 * 安全要点：
 * - 恒定时间比较：先 SHA-256 再 timingSafeEqual（规避长度侧信道）；
 * - 限流：每 IP 5 次失败锁定 10 分钟（内存实现，进程生命周期有效）。
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

const PAIR_DIGITS = 6;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

interface LockState {
  fails: number;
  lockedUntil: number;
}

export interface PairCheckResult {
  ok: boolean;
  /** 该 IP 当前是否处于锁定状态 */
  locked: boolean;
  /** 剩余锁定毫秒数（用于 429 Retry-After） */
  retryAfterMs: number;
}

export class PairManager {
  private readonly code: string;
  private readonly locks = new Map<string, LockState>();

  constructor(code?: string) {
    this.code = code ?? generateCode();
  }

  /** 当前配对码（终端展示用）。 */
  codeValue(): string {
    return this.code;
  }

  /**
   * 校验输入；成功清零该 IP 失败计数；失败累加并可能触发锁定。
   */
  check(input: string, ip: string): PairCheckResult {
    const now = Date.now();
    const state = this.locks.get(ip) ?? { fails: 0, lockedUntil: 0 };
    if (state.lockedUntil > now) {
      return { ok: false, locked: true, retryAfterMs: state.lockedUntil - now };
    }
    if (constantEqual(input.trim(), this.code)) {
      this.locks.delete(ip);
      return { ok: true, locked: false, retryAfterMs: 0 };
    }
    state.fails += 1;
    if (state.fails >= MAX_FAILS) {
      state.fails = 0;
      state.lockedUntil = now + LOCK_MS;
    }
    this.locks.set(ip, state);
    return { ok: false, locked: state.lockedUntil > now, retryAfterMs: Math.max(0, state.lockedUntil - now) };
  }

  /** 该 IP 剩余锁定毫秒（0 = 未锁定），供 429 Retry-After。 */
  lockRemainingMs(ip: string): number {
    const state = this.locks.get(ip);
    if (!state) return 0;
    return Math.max(0, state.lockedUntil - Date.now());
  }
}

/** 恒定时间字符串比较（长度差异也走相同路径：hash 后定长比较）。 */
function constantEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function generateCode(): string {
  return String(randomInt(10 ** (PAIR_DIGITS - 1), 10 ** PAIR_DIGITS));
}
