/**
 * cidr.ts — IPv4 CIDR 匹配（IP 白名单，零依赖）。
 */
export interface Cidr {
  base: number; // 网络地址（uint32）
  prefix: number;
}

/** 解析 `a.b.c.d/n`（prefix 缺省 = 32）；非法返回 null。 */
export function parseCidr(cidr: string): Cidr | null {
  const slash = cidr.indexOf("/");
  const ip = slash === -1 ? cidr : cidr.slice(0, slash);
  const prefixStr = slash === -1 ? "32" : cidr.slice(slash + 1);
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  const base = (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
  return { base, prefix };
}

/** IPv4 字符串 → uint32；非法返回 null（IPv6 等不支持，返回 null）。 */
export function ipToInt(ip: string): number | null {
  // 剥离 IPv4-mapped IPv6 前缀（::ffff:a.b.c.d）
  let candidate = ip;
  if (candidate.toLowerCase().startsWith("::ffff:")) candidate = candidate.slice(7);
  if (candidate.includes(":")) return null;
  const octets = candidate.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

/** ip 是否命中任一 CIDR。 */
export function ipInCidrs(ip: string, cidrs: string[]): boolean {
  const ipInt = ipToInt(ip);
  if (ipInt === null) return false;
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed === null) continue;
    const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
    if ((ipInt & mask) === (parsed.base & mask)) return true;
  }
  return false;
}
