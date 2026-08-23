/**
 * token-store.ts — `rdsh join` host token 持久化（~/.rdsh/join-<host>[-<port>].token，0600）。
 *
 * 目的：进程重启/崩溃恢复后复用已绑定的 host token，避免每次重新配对；
 * 被 hub 拒绝（吊销/重置）时由 join 删除该文件并回退到配对码流程。
 *
 * 安全：明文 token 只落 gateway 本地（0600），hub 侧仍只存 SHA-256 摘要。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RDSH_DIR = join(homedir(), ".rdsh");
/** host token 最小长度（与 hub server.ts handleTunnelUpgrade 的 `token.length < 16` 一致）。 */
const MIN_TOKEN_LEN = 16;

/** token 文件路径：join-<hostname>[-<port>].token（按 hub URL 区分，端口非默认时带端口）。 */
export function tokenFilePath(hubUrl: string, dir = RDSH_DIR): string {
  const u = new URL(hubUrl);
  const host = u.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const port = u.port === "" ? "" : `-${u.port}`;
  return join(dir, `join-${host}${port}.token`);
}

/** 读取持久化 token；不存在/损坏/过短 → null。 */
export function readPersistedToken(hubUrl: string, dir = RDSH_DIR): string | null {
  try {
    const p = tokenFilePath(hubUrl, dir);
    if (!existsSync(p)) return null;
    const t = readFileSync(p, "utf8").trim();
    return t.length >= MIN_TOKEN_LEN ? t : null;
  } catch {
    return null;
  }
}

/** 写入 token（目录 0700、文件 0600）。 */
export function persistToken(hubUrl: string, token: string, dir = RDSH_DIR): void {
  const p = tokenFilePath(hubUrl, dir);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, token, { mode: 0o600 });
}

/** 删除持久化 token（吊销/被拒后清理）。 */
export function clearPersistedToken(hubUrl: string, dir = RDSH_DIR): void {
  try {
    rmSync(tokenFilePath(hubUrl, dir), { force: true });
  } catch {
    /* 文件不存在等，忽略 */
  }
}
