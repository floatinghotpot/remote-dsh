/**
 * e2ee-key-store.ts — host 端 E2EE 静态密钥对持久化（~/.rdsh/e2ee-key.json，0600）。
 *
 * 一次生成、跨 hub 复用（host 身份与 join 到哪个 hub 无关）；指纹（公钥）在 join 注册时
 * 上送 hub，供 portal「添加主机」pin 展示。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** 加载或生成 host E2EE 静态密钥对（一次生成，持久化复用；损坏则重新生成）。 */
export function loadOrCreateE2eeKeyPair(dir = RDSH_DIR): KeyPair {
  const p = e2eeKeyFilePath(dir);
  try {
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8")) as { publicRaw: string; privateRaw: string };
      if (typeof j.publicRaw === "string" && typeof j.privateRaw === "string") {
        return deserializeKeyPair(j.publicRaw, j.privateRaw);
      }
    }
  } catch {
    /* 损坏 → 重新生成 */
  }
  const kp = generateKeyPair();
  const s = serializeKeyPair(kp);
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify(s), { mode: 0o600 });
  } catch {
    /* 写失败 → 用内存密钥（下次重启指纹会变，属异常场景） */
  }
  return kp;
}
