/**
 * backup.ts — 每日 SQLite 快照（VACUUM INTO 在线一致快照）+ 保留策略。
 * in-process 定时器触发（serve.ts），与 sweepBilling/pruneAudit 同模式。
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { HubDb } from "./db.ts";

/** 执行一次快照：写 <dir>/hub-YYYY-MM-DD.db（同一天覆盖）；返回路径 + 时间戳。 */
export function backupNow(db: HubDb, dir: string): { path: string; at: number } {
  mkdirSync(dir, { recursive: true });
  const name = `hub-${new Date().toISOString().slice(0, 10)}.db`;
  const path = join(dir, name);
  db.backupTo(path);
  return { path, at: Date.now() };
}

/** 清理过期快照（保留最近 keepDays 天）。 */
export function pruneBackups(dir: string, keepDays: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 目录不存在 / 无权限
  }
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
  for (const name of entries) {
    if (!name.startsWith("hub-") || !name.endsWith(".db")) continue;
    try {
      const full = join(dir, name);
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      /* 忽略单个文件错误 */
    }
  }
}

/** 最近一次成功快照的时间戳（ms）；无则 null。 */
export function lastBackupAt(dir: string): number | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let latest = -1;
  for (const name of entries) {
    if (!name.startsWith("hub-") || !name.endsWith(".db")) continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* 忽略 */
    }
  }
  return latest < 0 ? null : latest;
}
