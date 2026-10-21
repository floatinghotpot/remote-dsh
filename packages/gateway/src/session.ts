/**
 * session.ts — 会话密钥管理 + 签名 Cookie。
 *
 * 会话为无状态签名 Cookie：HMAC-SHA256(payload, key)。
 * 密钥存 ~/.rdsh/secret.key（0600，首次生成）；reset() 删除重建（全部会话失效）。
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RDSH_DIR = join(homedir(), ".rdsh");
const KEY_BYTES = 32;
export const SESSION_COOKIE = "rdsh_session";
/** 兜底上限：防伪造"未来过期时间"的 token 长存。 */
const MAX_EXP_FUTURE_SECONDS = 365 * 24 * 3600;

export interface SessionPayload {
  sid: string;
  /** 过期时刻（epoch 秒） */
  exp: number;
  /** auth.version（M2 改密版本；不匹配 → 会话无效） */
  v: number;
}

export class SessionManager {
  private key: Buffer | null = null;
  private readonly dir: string;

  /** @param dir 密钥目录（默认 ~/.rdsh；测试可注入临时目录） */
  constructor(dir?: string) {
    this.dir = dir ?? RDSH_DIR;
  }

  private get keyFile(): string {
    return join(this.dir, "secret.key");
  }

  /** 加载或创建密钥；必须在 sign/verify 前调用。 */
  async init(): Promise<void> {
    this.key = await loadOrCreateKey(this.keyFile);
  }

  /** 删除密钥并重建 —— 全部已签发会话立即失效。 */
  async reset(): Promise<void> {
    this.key = null;
    await rm(this.keyFile, { force: true });
    this.key = await loadOrCreateKey(this.keyFile);
  }

  /** 签发一个有效期 ttlSeconds 的会话 token（携带 auth 版本号）。 */
  sign(ttlSeconds: number, version = 1): string {
    const key = this.requireKey();
    const payload: SessionPayload = {
      sid: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      v: version,
    };
    const body = Buffer.from(JSON.stringify(payload));
    const mac = createHmac("sha256", key).update(body).digest("base64url");
    return `${mac}.${body.toString("base64url")}`;
  }

  /** 校验 token；无效/过期/被篡改/版本不匹配 → null。 */
  verify(token: string, version?: number): SessionPayload | null {
    const key = this.requireKey();
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const mac = token.slice(0, dot);
    const body = token.slice(dot + 1);
    let bodyBytes: Buffer;
    try {
      bodyBytes = Buffer.from(body, "base64url");
    } catch {
      return null;
    }
    const expected = createHmac("sha256", key).update(bodyBytes).digest("base64url");
    if (!safeEqual(mac, expected)) return null;
    try {
      const payload = JSON.parse(bodyBytes.toString("utf8")) as SessionPayload;
      if (typeof payload.sid !== "string" || typeof payload.exp !== "number" || typeof payload.v !== "number") return null;
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) return null;
      if (payload.exp > now + MAX_EXP_FUTURE_SECONDS) return null;
      if (version !== undefined && payload.v !== version) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** 生成 Set-Cookie 头（HttpOnly + SameSite=Lax）。 */
  cookieHeader(ttlSeconds: number, version = 1): string {
    const token = this.sign(ttlSeconds, version);
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}`;
  }

  private requireKey(): Buffer {
    if (this.key === null) throw new Error("SessionManager.init() must be called before sign/verify");
    return this.key;
  }
}

/** 从请求 Cookie 头解析出会话 token（无 → null）。 */
export function sessionTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function loadOrCreateKey(keyFile: string): Promise<Buffer> {
  let existing: Buffer | null = null;
  try {
    existing = await readFile(keyFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // 读失败但文件可能存在（EACCES/EIO）——绝不当「密钥不存在」重建，否则全量会话
      // cookie 静默失效、用户集体被踢。显式抛错，让启动失败可见。
      throw new Error(`cannot read session key ${keyFile}: ${(err as Error).message}`);
    }
  }
  if (existing !== null) {
    // 半截/损坏密钥：同样不能静默重建（会踢全量会话），显式抛错。
    if (existing.length !== KEY_BYTES) {
      throw new Error(`session key ${keyFile} has invalid length ${existing.length} (expected ${KEY_BYTES})`);
    }
    return existing;
  }
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  // 原子写（tmp + rename），避免崩溃残留半截密钥。
  const tmp = `${keyFile}.${process.pid}.tmp`;
  await writeFile(tmp, key, { mode: 0o600 });
  await rename(tmp, keyFile);
  return key;
}
