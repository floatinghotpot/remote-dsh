/**
 * lock.ts — join pid 锁：CLI 与插件共享「单身份铁律」（同机单隧道，D5 档2）。
 *
 * 锁文件 `~/.rdsh/join.lock`（0600）记 `{pid, role}`。
 * role = "cli"（rdsh CLI / systemd 服务持有）| "plugin"（dsh 插件持有）——面板据此显示「外部托管」。
 *
 * 三条不变量（2026-09-15 真机复盘：多个 `dsh web` 实例互相顶替导致面板反复掉线/连线）：
 *   1. **原子发布**「文件 + 内容」：先写临时文件再 `link` —— 锁路径要么不存在、要么内容完整，
 *      不存在「已存在但内容为空」的窗口（旧实现 `writeFileSync(..., {flag:"wx"})` 有这个窗口，
 *      会被并发清理者当成坏锁删掉，两边都以为自己持锁）；
 *   2. **拒绝任何活锁**（包括本进程自己的 pid）：同进程重复获取由 `heldPaths` 记账拦住；
 *   3. **清理只走 compare-and-delete**：读 → 判断 → 删除之间不得误删他人刚发布的锁
 *      （旧实现 `readJoinLock` 读到 stale 就无条件 `rmSync`，会删掉别人刚建立的新锁）。
 */
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** 解析锁内容；损坏/字段非法 → null。纯函数，不碰文件系统。 */
function parseLock(raw: string): JoinLock | null {
  try {
    const j = JSON.parse(raw) as Partial<JoinLock>;
    if (typeof j.pid !== "number" || (j.role !== "cli" && j.role !== "plugin")) return null;
    return { pid: j.pid, role: j.role };
  } catch {
    return null;
  }
}

/**
 * 读锁（**纯读，无副作用**）：不存在 / 损坏 / pid 已死（stale）→ null。
 * 供面板「外部托管」态判定（role=cli）与 acquire 前检测复用。
 *
 * 注意：不再顺手删除 stale 文件（旧实现有此行为且无二次校验，会误删他人新锁）；
 * 清理统一由 acquire 路径的 `reapDeadLock()` 以 compare-and-delete 完成。
 */
export function readJoinLock(path = JOIN_LOCK_PATH): JoinLock | null {
  try {
    if (!existsSync(path)) return null;
    const held = parseLock(readFileSync(path, "utf8"));
    if (held === null) return null;
    return isAlive(held.pid) ? held : null;
  } catch {
    return null;
  }
}

/**
 * 锁文件快照（内容 + 身份）。删除前用它做 compare-and-delete：**内容与 inode 都没变**才算"还是刚才那个残锁"。
 * 只比内容不够：pid 被复用后新发布的锁可能字节完全相同（ABA）。
 */
interface LockSnapshot {
  raw: string;
  ino: number;
  mtimeMs: number;
}

function snapshotLock(path: string): LockSnapshot | null {
  try {
    const st = statSync(path);
    return { raw: readFileSync(path, "utf8"), ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** 内容解析不出来的锁文件，多新以内视为"并发创建者写到一半"而不回收。 */
const FRESH_LOCK_MS = 1000;

/**
 * 清除「确定已经死了」的残锁（pid 已死，或内容损坏且已不新），成功则锁路径变空、可重试获取。
 *
 * 两道保护，避免把别人的**活锁**删掉：
 * 1. compare-and-delete 比对**内容 + inode**（同内容但换了 inode = 别人刚发布的新锁，不删）；
 * 2. 内容解析不出来（空/半截）且文件很新 → 视为并发创建者写到一半，不删
 *    （本实现的发布是原子的，这种文件只可能来自旧版本或外部写入者）。
 */
function reapDeadLock(path: string): void {
  const first = snapshotLock(path);
  if (first === null) return;
  const held = parseLock(first.raw);
  if (held !== null && isAlive(held.pid)) return; // 有效活锁
  if (held === null && Date.now() - first.mtimeMs < FRESH_LOCK_MS) return; // 可能是写到一半
  const second = snapshotLock(path);
  if (second === null || second.ino !== first.ino || second.raw !== first.raw) return; // 期间被替换
  try {
    rmSync(path, { force: true });
  } catch {
    /* 忽略 */
  }
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; heldBy: JoinLock }
  /** 连续被抢占（拿不到也读不到持有者，极罕见）：不伪造持有者，由调用方给出「被占用」提示。 */
  | { ok: false; contended: true };

/**
 * 本进程已持有的锁路径。pid 无法区分同进程的两次获取，必须单独记账。
 *
 * 必要性：插件热重载（`patchReload: "live"`）时同一进程先后起两条隧道 —— 若只按 pid 判断，
 * 「锁是自己」会被放行（旧实现正是如此）→ 同机双隧道 → 与 hub 的顶替逻辑叠加成无限互踢。
 */
const heldPaths = new Set<string>();

/** 文件系统不支持硬链接时 `linkSync` 的 errno（SMB / FUSE / exFAT 之类）。 */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

/**
 * 获取锁：**原子发布**锁文件（临时文件 + `link`；目录 0700、文件 0600），内容 `{pid, role}`。
 *
 * - 已有活锁（**无论 pid 是否为自己**）→ 拒绝，防同机 / 同进程双隧道；
 * - stale（pid 已死）或损坏残锁 → compare-and-delete 清除后重试；
 * - 文件系统不支持硬链接 → 退回 `wx` 创建（旧实现在这些文件系统上就是这个行为，
 *   短暂的"空文件窗口"由 `reapDeadLock` 的新鲜度保护兜住）；
 * - 连续 3 次被抢占 → `{ok:false, contended:true}`。
 */
export function acquireJoinLock(role: JoinLockRole, path = JOIN_LOCK_PATH): AcquireResult {
  if (heldPaths.has(path)) {
    return { ok: false, heldBy: { pid: process.pid, role } };
  }
  const data = JSON.stringify({ pid: process.pid, role });
  const tmp = `${path}.${process.pid}.tmp`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // 内容先落到临时文件（默认 flag 覆盖写，不会 EEXIST），再 link 到锁路径；
      // link 是原子的：目标已存在则 EEXIST，且目标**一出现就带完整内容**。
      writeFileSync(tmp, data, { mode: 0o600 });
      linkSync(tmp, path);
      heldPaths.add(path);
      return { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (!LINK_UNSUPPORTED.has(code ?? "")) throw err;
        try {
          writeFileSync(path, data, { flag: "wx", mode: 0o600 });
          heldPaths.add(path);
          return { ok: true };
        } catch (err2) {
          if ((err2 as NodeJS.ErrnoException).code !== "EEXIST") throw err2;
        }
      }
    } finally {
      try {
        rmSync(tmp, { force: true }); // 删掉临时名，锁路径（硬链接）不受影响
      } catch {
        /* 忽略 */
      }
    }
    const held = readJoinLock(path);
    if (held !== null) return { ok: false, heldBy: held };
    reapDeadLock(path);
  }
  return { ok: false, contended: true };
}

/** 释放锁：仅当锁是自己 pid 持有才删（不误删他人锁）；同时清本进程记账。 */
export function releaseJoinLock(path = JOIN_LOCK_PATH): void {
  heldPaths.delete(path);
  try {
    const held = readJoinLock(path);
    if (held !== null && held.pid === process.pid) {
      rmSync(path, { force: true });
    }
  } catch {
    /* 忽略 */
  }
}
