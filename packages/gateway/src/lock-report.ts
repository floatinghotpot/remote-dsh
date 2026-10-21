/**
 * lock-report.ts — join 锁的诊断与受闸门解锁（面板「诊断 / 强制清锁」的后端原语）。
 *
 * 职责边界：
 * - `lock.ts` 管「互斥」：acquire / release / reap（不变量见 lock.ts 头注释）；
 * - 本文件管「解释 + 修复」：读原始锁、探测持有者进程、判定能否安全强解锁、受闸门删除。
 *
 * 全部判定收敛进纯函数 `describeLock`（可单测），文件系统与 `ps` 探测由组合函数注入。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FRESH_LOCK_MS,
  JOIN_LOCK_PATH,
  rawJoinLockFromSnapshot,
  readJoinLockRaw,
  removeJoinLockIfUnchanged,
  snapshotJoinLock,
} from "./lock.ts";
import type { JoinLockRole, RawJoinLock } from "./lock.ts";

/** 持有者进程探测结果。`startedAtMs` / `command` 仅在 `ps` 可用且解析成功时出现。 */
export interface ProcessProbe {
  alive: boolean;
  startedAtMs?: number;
  command?: string;
}

/** 锁判定原因（`reason` 即面板本地化文案的 key）。 */
export type LockReason =
  | "none"
  | "dead"
  | "pid-reuse"
  | "unconfirmed"
  | "alive"
  | "self"
  | "damaged"
  | "fresh-corrupt";

/** 诊断报告：面板据此渲染「谁占着锁 / 能不能强解锁 / 给什么建议」。 */
export interface LockReport {
  held: boolean;
  corrupt: boolean;
  role?: JoinLockRole;
  pid?: number;
  /** 持有者进程是否存活（`kill(pid,0)`）。 */
  alive: boolean;
  /** 是否为 pid 复用（持有者进程启动时间晚于锁文件写入时间）。 */
  pidReuse: boolean;
  /** `ps` 探测是否成功（拿得到 startedAtMs/command）。 */
  confirmed: boolean;
  reason: LockReason;
  unlock: "allowed" | "blocked" | "unnecessary";
  /** 英文兜底提示；面板按 `reason` 本地化，此字段仅作兜底。 */
  hint: string;
  /** 持有者进程命令行（`ps` 探测成功时才有；供面板识别来源 kind）。 */
  command?: string;
}

const REUSE_SLACK_MS = 2000;

const HINTS: Record<LockReason, string> = {
  none: "no lock present",
  dead: "the holder process is gone; the lock is stale",
  "pid-reuse": "the pid now belongs to a different process; the lock is stale",
  unconfirmed: "holder liveness could not be confirmed",
  alive: "another instance is actively using the tunnel",
  self: "this process already holds the lock",
  damaged: "the lock file is unreadable",
  "fresh-corrupt": "another instance may be creating the lock; retry shortly",
};

/** `describeLock` 的注入输入（纯函数，不碰 FS / 进程）。 */
export interface DescribeLockInput {
  raw: RawJoinLock;
  /** 持有者进程探测结果；`raw.lock` 为本进程、或锁损坏/不存在时为 null。 */
  probe: ProcessProbe | null;
  selfPid: number;
  now: number;
  /** 新鲜度保护窗口（缺省 `FRESH_LOCK_MS`）。 */
  freshMs?: number;
  /** pid 复用判定的宽松阈值（缺省 2000ms，容纳 `lstart` 秒级粒度）。 */
  reuseSlackMs?: number;
}

/**
 * 锁诊断的纯函数：给定原始锁 + 探测结果 → 报告与「能否强解锁」。
 * 闸门规则（discussion §5 Q2 用户原决定 + §5.1）：
 * - `dead` / `pid-reuse` / `damaged` / `unconfirmed` → allowed（其中 unconfirmed 由面板更醒目二次确认）；
 * - `alive` / `self` / `fresh-corrupt` → blocked；
 * - `none` → unnecessary。
 */
export function describeLock(input: DescribeLockInput): LockReport {
  const { raw, probe, selfPid, now } = input;
  const freshMs = input.freshMs ?? FRESH_LOCK_MS;
  const reuseSlackMs = input.reuseSlackMs ?? REUSE_SLACK_MS;
  const base = { corrupt: raw.corrupt, alive: false, pidReuse: false, confirmed: false } as const;

  // 1) 锁不存在
  if (raw.lock === null && !raw.corrupt) {
    return { ...base, held: false, reason: "none", unlock: "unnecessary", hint: HINTS.none };
  }

  // 2) 锁损坏（解析不出）
  if (raw.lock === null) {
    const fresh = raw.mtimeMs !== null && now - raw.mtimeMs < freshMs;
    const reason: LockReason = fresh ? "fresh-corrupt" : "damaged";
    return { ...base, held: false, reason, unlock: fresh ? "blocked" : "allowed", hint: HINTS[reason] };
  }

  // 3) 可解析的锁
  const { pid, role } = raw.lock;
  if (pid === selfPid) {
    return { ...base, held: true, role, pid, alive: true, reason: "self", unlock: "blocked", hint: HINTS.self };
  }
  const alive = probe?.alive === true;
  if (!alive) {
    return { ...base, held: true, role, pid, reason: "dead", unlock: "allowed", hint: HINTS.dead };
  }
  // 活着 → 看能否证明「pid 复用」（持有者启动时间晚于锁写入时间）
  const startedAtMs = probe?.startedAtMs;
  const confirmed = startedAtMs !== undefined;
  if (confirmed && raw.mtimeMs !== null && startedAtMs! > raw.mtimeMs + reuseSlackMs) {
    return { ...base, held: true, role, pid, alive: true, pidReuse: true, confirmed: true, reason: "pid-reuse", unlock: "allowed", hint: HINTS["pid-reuse"], command: probe?.command };
  }
  if (confirmed) {
    return { ...base, held: true, role, pid, alive: true, confirmed: true, reason: "alive", unlock: "blocked", hint: HINTS.alive, command: probe?.command };
  }
  // ps 不可用/失败 → 无法确认（用户原决定：开放，面板更醒目二次确认）
  return { ...base, held: true, role, pid, alive: true, reason: "unconfirmed", unlock: "allowed", hint: HINTS.unconfirmed, command: probe?.command };
}

/** `ps` 执行器（可注入，便于单测）：跑 `ps` 并返回 stdout；失败抛错。 */
export type PsExecutor = (args: string[]) => Promise<string>;

const execFileP = promisify(execFile);

/** 默认 `ps` 执行器：固定 `LC_ALL=C` 输出格式，1s 超时。 */
const psStdout: PsExecutor = async (args: string[]): Promise<string> => {
  const { stdout } = await execFileP("ps", args, {
    timeout: 1000,
    killSignal: "SIGKILL",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024,
  });
  return String(stdout);
};

/**
 * 探测持有者进程（异步、非阻塞）：`kill(pid,0)` 判活；POSIX 下 best-effort `ps` 取启动时间 + 命令行。
 * `ps` 失败/受限/Windows → 只保证 `alive`（`startedAtMs`/`command` 缺失 = 未确认）。
 */
export async function probeProcess(pid: number, runPs: PsExecutor = psStdout): Promise<ProcessProbe> {
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = (err as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!alive) return { alive: false };
  if (process.platform === "win32") return { alive: true };
  try {
    const line = (await runPs(["-p", String(pid), "-o", "lstart=,command="])).trim();
    // lstart = "<weekday> <month> <day> <hh:mm:ss> <yyyy>"，command 紧随其后（可含空格）。
    const m = /^(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    const lstartStr = m?.[1];
    const startedAtMs = lstartStr === undefined ? undefined : Date.parse(lstartStr);
    const command = (m?.[2] ?? line).trim();
    return {
      alive: true,
      startedAtMs: Number.isNaN(startedAtMs) ? undefined : startedAtMs,
      command: command === "" ? undefined : command,
    };
  } catch {
    return { alive: true };
  }
}

/** 给定原始锁 + 探测函数 → 报告（`describeLock` 的组合封装，`describeJoinLockAt` / `forceUnlockJoinLock` 共用）。 */
async function describeFromRaw(raw: RawJoinLock, probeFn: (pid: number) => Promise<ProcessProbe>): Promise<LockReport> {
  let probe: ProcessProbe | null = null;
  if (raw.lock !== null && raw.lock.pid !== process.pid) {
    probe = await probeFn(raw.lock.pid);
  } else if (raw.lock !== null && raw.lock.pid === process.pid) {
    probe = { alive: true };
  }
  return describeLock({ raw, probe, selfPid: process.pid, now: Date.now() });
}

/** 组合：读原始锁 + 探测持有者 → 报告。 */
export async function describeJoinLockAt(
  path = JOIN_LOCK_PATH,
  deps: { probe?: (pid: number) => Promise<ProcessProbe> } = {},
): Promise<LockReport> {
  return describeFromRaw(readJoinLockRaw(path), deps.probe ?? probeProcess);
}

/**
 * 受闸门强解锁：判定与 CAS 删除用**同一份快照**（先 snapshot → 解析判定 → 用该快照删除），
 * 杜绝「判定为死锁后、删除前被另一实例发布成新活锁」的 TOCTOU。
 */
export async function forceUnlockJoinLock(
  path = JOIN_LOCK_PATH,
  deps: { probe?: (pid: number) => Promise<ProcessProbe> } = {},
): Promise<{ removed: boolean; reason: LockReason; report: LockReport }> {
  const probeFn = deps.probe ?? probeProcess;
  const first = snapshotJoinLock(path);
  if (first === null) {
    const report = describeLock({ raw: { lock: null, corrupt: false, mtimeMs: null }, probe: null, selfPid: process.pid, now: Date.now() });
    return { removed: false, reason: report.reason, report };
  }
  const report = await describeFromRaw(rawJoinLockFromSnapshot(first), probeFn);
  if (report.unlock !== "allowed") {
    return { removed: false, reason: report.reason, report };
  }
  const removed = removeJoinLockIfUnchanged(path, first);
  if (removed) return { removed: true, reason: report.reason, report };
  // CAS 失败 = 期间锁被替换/已不存在 → 重取当前报告，避免把「替换前」的 stale reason 交给面板
  const fresh = await describeJoinLockAt(path, { probe: probeFn });
  return { removed: false, reason: fresh.reason, report: fresh };
}
