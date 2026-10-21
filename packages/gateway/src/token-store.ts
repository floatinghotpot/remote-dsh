/**
 * token-store.ts — `rdsh join` host token 持久化（~/.rdsh/join-<host>[-<port>].token，0600）。
 *
 * 目的：进程重启/崩溃恢复后复用已绑定的 host token，避免每次重新配对；
 * 被 hub 拒绝（吊销/重置）时由 join 删除该文件并提示重新接入（无自动重配）。
 *
 * 安全：明文 token 只落 gateway 本地（0600），hub 侧仍只存 SHA-256 摘要。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** 写入 token（目录 0700、文件 0600；原子写 tmp+rename，避免崩溃残留半截 token）。 */
export function persistToken(hubUrl: string, token: string, dir = RDSH_DIR): void {
  const p = tokenFilePath(hubUrl, dir);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, token, { mode: 0o600 });
  renameSync(tmp, p);
}

/** 删除持久化 token（吊销/被拒后清理）。 */
export function clearPersistedToken(hubUrl: string, dir = RDSH_DIR): void {
  try {
    rmSync(tokenFilePath(hubUrl, dir), { force: true });
  } catch (err) {
    // 删除失败（EACCES 等）不能静默当成功——否则下次仍复用旧 token，用户以为已注销却还在线。
    console.warn(`rdsh: failed to clear persisted token for ${hubUrl}: ${(err as Error).message}`);
  }
}

/** 持久化 join 元数据（hostId + 账号服务 host-cookie 公钥，供 REDIRECT 验签）。 */
export interface JoinMeta {
  hostId: string;
  hostCookiePubKey: string;
}

export function readJoinMeta(hubUrl: string, dir = RDSH_DIR): JoinMeta | null {
  try {
    const p = tokenFilePath(hubUrl, dir) + ".json";
    if (!existsSync(p)) return null;
    const m = JSON.parse(readFileSync(p, "utf8")) as Partial<JoinMeta>;
    return typeof m.hostId === "string" && typeof m.hostCookiePubKey === "string" ? (m as JoinMeta) : null;
  } catch {
    return null;
  }
}

export function persistJoinMeta(hubUrl: string, meta: JoinMeta, dir = RDSH_DIR): void {
  const p = tokenFilePath(hubUrl, dir) + ".json";
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  renameSync(tmp, p);
}
