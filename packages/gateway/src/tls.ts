/**
 * tls.ts — TLS 证书材料加载。
 *
 * - 有 `tls.cert/key`（任意 PEM：acme.sh / Let's Encrypt / 云厂商）→ 读取返回；
 * - 无 → 返回 null（网关跑 http；`auth.mode=password` 且非反代时由
 *   server.ts 的安全约束拒绝启动）；
 * - `behindProxy`（反代终止 TLS）→ 返回 null。
 *
 * 注：不内置自签证书生成 —— 无证书即 http；需要 https 请自行提供证书
 * （acme.sh / Let's Encrypt / 云厂商 / openssl 手动生成）。
 */
import { readFile } from "node:fs/promises";

export interface TlsMaterial {
  key: string;
  cert: string;
}

/**
 * 解析 TLS 材料。
 * @param tls config.tls（cert/key 路径）
 * @param behindProxy 反代终止 TLS 时返回 null
 */
export async function loadTls(tls?: { cert: string; key: string }, behindProxy = false): Promise<TlsMaterial | null> {
  if (behindProxy) return null;
  if (!tls) return null;
  const [cert, key] = await Promise.all([readFile(tls.cert, "utf8"), readFile(tls.key, "utf8")]);
  return { cert, key };
}
