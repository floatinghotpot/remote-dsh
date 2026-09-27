/**
 * direct-secret.ts — 直连口专用密钥（per-host 随机密钥，自动生成）。
 *
 * 用途（24-direct-first，方案 B）：直连口门禁的 ticket 与会话 cookie 用它签名，
 * **独立于访问口令（accessCode）**——这样"不设口令"也能启用直连口（ticket 即门禁），
 * 而口令降级为可选的额外一层。密钥自动生成并持久化到 ~/.rdsh/direct-secret（0600），
 * 与 E2EE 静态密钥（e2ee-key.json）同一先例。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RDSH_DIR = join(homedir(), ".rdsh");
const SECRET_FILE_NAME = "direct-secret";

export function directSecretPath(dir = RDSH_DIR): string {
  return join(dir, SECRET_FILE_NAME);
}

/** 读取或生成直连密钥（32 字节 base64url）；坏文件/过短视为不存在并重新生成。 */
export function loadOrCreateDirectSecret(dir = RDSH_DIR): string {
  const path = directSecretPath(dir);
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length >= 32) return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const secret = randomBytes(32).toString("base64url");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}
