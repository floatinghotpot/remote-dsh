/**
 * e2ee-key-store.ts — host 端 E2EE 静态密钥对持久化（~/.rdsh/e2ee-key.json，0600）。
 *
 * 一次生成、跨 hub 复用（host 身份与 join 到哪个 hub 无关）；指纹（公钥）在 join 注册时
 * 上送 hub，供 portal「添加主机」pin 展示。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPair, deserializeKeyPair, serializeKeyPair } from "./e2ee.ts";
import type { KeyPair } from "./e2ee.ts";

const RDSH_DIR = join(homedir(), ".rdsh");
const KEY_FILE_NAME = "e2ee-key.json";

/** 密钥文件路径（可注入 dir 便于测试）。 */
export function e2eeKeyFilePath(dir = RDSH_DIR): string {
  return join(dir, KEY_FILE_NAME);
}

/** 加载或生成 host E2EE 静态密钥对。**仅当文件确实不存在（ENOENT）时生成**；
 * 读错误（EACCES/EIO）或损坏绝不静默重建——否则身份指纹变化、已 pin 的客户端全部断连。 */
export function loadOrCreateE2eeKeyPair(dir = RDSH_DIR): KeyPair {
  const p = e2eeKeyFilePath(dir);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // 读失败但文件可能存在（EACCES/EIO）——绝不当「密钥不存在」重建，显式抛错。
      throw new Error(`cannot read E2EE key ${p}: ${(err as Error).message}`);
    }
    return generateAndPersist(p);
  }
  try {
    const j = JSON.parse(raw) as { publicRaw: string; privateRaw: string };
    if (typeof j.publicRaw !== "string" || typeof j.privateRaw !== "string") {
      throw new Error("missing publicRaw/privateRaw fields");
    }
    return deserializeKeyPair(j.publicRaw, j.privateRaw);
  } catch (err) {
    // 损坏/格式不符：显式抛错（静默重建会改指纹、踢掉已 pin 客户端）。
    throw new Error(`E2EE key ${p} is corrupt: ${(err as Error).message}`);
  }
}

function generateAndPersist(p: string): KeyPair {
  const kp = generateKeyPair();
  const s = serializeKeyPair(kp);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  // 原子写（tmp+rename）；写失败直接抛错，不再静默用内存密钥（否则每次重启指纹都变）。
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, p);
  return kp;
}
