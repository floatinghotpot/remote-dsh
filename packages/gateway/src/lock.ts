/**
 * lock.ts — join pid 锁：CLI 与插件共享「单身份铁律」（同机单隧道，D5 档2）。
 *
 * 锁文件 `~/.rdsh/join.lock`（0600）记 `{pid, role}`；stale（pid 已死）自动视为无锁并清除。
 * role = "cli"（rdsh CLI / systemd 服务持有）| "plugin"（dsh 插件持有）——面板据此显示「外部托管」。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RDSH_DIR = join(homedir(), ".rdsh");
export const JOIN_LOCK_PATH = join(RDSH_DIR, "join.lock");

export type JoinLockRole = "cli" | "plugin";

export interface JoinLock {
  pid: number;
  role: JoinLockRole;
}

/** 探测 pid 是否存活：signal 0 不真正发信号；EPERM = 存活但无权限，ESRCH = 不存在。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 读锁。不存在/损坏/过短 → null；pid 已死（stale）→ 清除文件并返回 null。
 * 供面板「外部托管」态判定（role=cli）与 acquire 前检测复用。
 */
export function readJoinLock(path = JOIN_LOCK_PATH): JoinLock | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<JoinLock>;
    if (typeof raw.pid !== "number" || (raw.role !== "cli" && raw.role !== "plugin")) return null;
    if (!isAlive(raw.pid)) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* 忽略 */
      }
      return null;
    }
    return { pid: raw.pid, role: raw.role };
  } catch {
    return null;
  }
}

export type AcquireResult = { ok: true } | { ok: false; heldBy: JoinLock };

/**
 * 获取锁：写入 `{pid: process.pid, role}`（目录 0700、文件 0600）。
 * 已有**他人**（不同 pid）持有的活锁 → 拒绝（防同机双隧道）。
 */
export function acquireJoinLock(role: JoinLockRole, path = JOIN_LOCK_PATH): AcquireResult {
  const held = readJoinLock(path);
  if (held !== null && held.pid !== process.pid) {
    return { ok: false, heldBy: held };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ pid: process.pid, role }), { mode: 0o600 });
  return { ok: true };
}

/** 释放锁：仅当锁是自己 pid 持有才删（不误删他人锁）。 */
export function releaseJoinLock(path = JOIN_LOCK_PATH): void {
  try {
    const held = readJoinLock(path);
    if (held !== null && held.pid === process.pid) {
      rmSync(path, { force: true });
    }
  } catch {
    /* 忽略 */
  }
}
