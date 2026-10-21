/**
 * auth.ts — 用户/密码认证（scrypt 哈希）+ UserManager。
 *
 * 哈希格式：`scrypt:$N:$r:$p:$saltB64:$hashB64`（每用户随机盐，恒定时间校验）。
 * 改密（passwd）会使 `auth.version + 1` —— 会话校验绑定版本，旧会话立即失效。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { loadConfig, normalizeConfig } from "./config.ts";
import type { RdshConfig, AuthUser } from "./config.ts";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

/** 生成 scrypt 哈希（格式 `scrypt:$N:$r:$p:$salt:$hash`）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

/** 恒定时间校验密码。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4]!;
  const hashB64 = parts[5]!;
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 1 || r < 1 || p < 1) return false;
  try {
    const derived = await scryptAsync(password, Buffer.from(saltB64, "base64url"), KEY_LEN, { N: n, r, p });
    return timingSafeEqual(derived, Buffer.from(hashB64, "base64url"));
  } catch {
    return false;
  }
}

/** 用户管理：读写 config.json 的 auth.users（低频管理操作，读改写即可）。 */
export class UserManager {
  private readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  private async read(): Promise<RdshConfig> {
    return await loadConfig(this.configPath);
  }

  private async write(config: RdshConfig): Promise<void> {
    const tmp = `${this.configPath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.configPath);
  }

  async add(name: string, password: string): Promise<void> {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) {
      throw new Error(`invalid username "${name}" (allowed: letters, digits, . _ -)`);
    }
    const config = await this.read();
    if (config.auth.users.some((u) => u.name === name)) {
      throw new Error(`user "${name}" already exists`);
    }
    config.auth.users.push({ name, passwordHash: await hashPassword(password) });
    await this.write(config);
  }

  /** 改密：更新哈希并使 `auth.version + 1`（全部旧会话失效）。 */
  async passwd(name: string, password: string): Promise<boolean> {
    const config = await this.read();
    const user = config.auth.users.find((u) => u.name === name);
    if (user === undefined) return false;
    user.passwordHash = await hashPassword(password);
    config.auth.version = (config.auth.version ?? 1) + 1;
    await this.write(config);
    return true;
  }

  async list(): Promise<string[]> {
    const config = await this.read();
    return config.auth.users.map((u) => u.name);
  }

  async remove(name: string): Promise<boolean> {
    const config = await this.read();
    const before = config.auth.users.length;
    config.auth.users = config.auth.users.filter((u) => u.name !== name);
    if (config.auth.users.length === before) return false;
    await this.write(config);
    return true;
  }

  /** 校验用户名/密码；成功返回用户，失败 null。 */
  async verify(name: string, password: string): Promise<AuthUser | null> {
    const config = await this.read();
    const user = config.auth.users.find((u) => u.name === name);
    if (user === undefined) return null;
    if (await verifyPassword(password, user.passwordHash)) return user;
    return null;
  }

  /** 当前 auth.version（会话版本校验用）。 */
  async version(): Promise<number> {
    const config = await this.read();
    return config.auth.version ?? 1;
  }
}

/** 测试辅助：把内存对象规范化（供单测构造）。 */
export { normalizeConfig };
