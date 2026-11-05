/**
 * device-id.ts — 每台设备一份的稳定标识（`~/.rdsh/device-id`，0600）。
 *
 * 用途：hub 在 `POST /api/hosts/register` 时按「同一账号 + 同一 device-id」识别
 * "这台设备以前来过"，从而在重绑时复用它的 host 记录（而不是每绑一次新建一条）。
 *
 * 为什么不用 E2EE 公钥当身份：
 * - 公钥**不是唯一值**（碰撞概率极小但非零）；
 * - 公钥会出现在 `GET /api/hosts`（**公开**），不是秘密；
 * device-id 只做身份、不对外暴露，且与密钥材料职责分离。
 *
 * 语义与 `loadOrCreateE2eeKeyPair` 一致：**仅当文件确实不存在（ENOENT）时生成**；
 * 读错误或内容损坏一律抛错——静默重建会让 hub 把同一台设备当成新设备，又留下一条记录。
 */
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RDSH_DIR = join(homedir(), ".rdsh");
const FILE_NAME = "device-id";
const ID_BYTES = 32;

/** 设备标识文件路径（可注入 dir 便于测试）。 */
export function deviceIdFilePath(dir = RDSH_DIR): string {
  return join(dir, FILE_NAME);
}

/** 合法的 device-id：16–128 字符的 base64url（hub 侧用同一判定）。 */
export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

/** 加载或生成 device-id；只在文件不存在时生成，读错误/损坏显式抛错。 */
export function loadOrCreateDeviceId(dir = RDSH_DIR): string {
  const p = deviceIdFilePath(dir);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot read device id ${p}: ${(err as Error).message}`);
    }
    return generateAndPersist(p);
  }
  const id = raw.trim();
  if (!isValidDeviceId(id)) {
    throw new Error(`device id ${p} is corrupt (expect 16-128 base64url chars)`);
  }
  return id;
}

function generateAndPersist(p: string): string {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const id = randomBytes(ID_BYTES).toString("base64url");
  // 同机两个进程（插件 + CLI）同时首绑：必须保证「只有一个 id、且读到的内容是完整的」。
  // 先把内容写进临时文件，再用 link(2) 原子占位：
  // - link 成功 = 本次获胜，目标文件一出现就是完整内容；
  // - link 失败 EEXIST = 别人先占位，直接回读（内容必然已完整，不会是半截空文件）。
  // （若用 O_EXCL 创建后再写，另一方可能在"创建完、还没写"的窗口读到空文件→误判损坏。）
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${id}\n`, { mode: 0o600 });
    linkSync(tmp, p);
    return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`cannot write device id ${p}: ${(err as Error).message}`);
    }
    const existing = readFileSync(p, "utf8").trim();
    if (!isValidDeviceId(existing)) {
      throw new Error(`device id ${p} is corrupt (expect 16-128 base64url chars)`);
    }
    return existing;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // 已被 link 掉/从未创建：忽略
    }
  }
}
