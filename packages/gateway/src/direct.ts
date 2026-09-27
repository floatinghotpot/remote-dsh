/**
 * direct.ts — 直连口（A 案）：join 进程额外监听的内网端口，转发到**同一个 dsh**。
 *
 * 门禁 = **ticket（方案 B）**：直连口始终监听（join 模式），ticket/会话 cookie 用 per-host
 * 随机密钥（direct-secret）签名，独立于访问口令；口令（accessCode）为可选增强层（手动访问）。
 * P1 为 http 明文，P3 换 https 自签 + App 指纹固定。候选只下发私网 IPv4。
 */
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { startGateway } from "./server.ts";
import type { RunningGateway } from "./server.ts";
import type { TlsMaterial } from "./tls.ts";

export interface DirectOptions {
  /** 转发目标 dsh 端口（join 已 spawn 的同一个 dsh；插件形态 = ctx.webServer.port） */
  dshPort: number;
  /** 宿主代持的 dsh 会话 cookie（注入转发） */
  dshAuthCookieHeader?: string | null;
  /** 直连密钥（per-host 随机，自动生成）；ticket 与会话 cookie 用它签名 */
  secret: string;
  /** 访问口令（可选增强层）：非空时直连口额外要求口令（手动访问） */
  accessCode?: string | null;
  /** 一次性直连票校验（R4） */
  consumeTicket?: (ticket: string) => boolean;
  /** 监听地址，默认 0.0.0.0 */
  host?: string;
  /** 监听端口，默认 8442（复用 config.port） */
  port?: number;
  keyDir?: string;
  dshUiCompat?: { trustPairedAsLoopback?: boolean };
  configPath?: string;
  tlsMaterial?: TlsMaterial | null;
}

export interface DirectHandle {
  gateway: RunningGateway;
  actualPort: number;
  /** 本机私网 IPv4 候选（IP + 实际端口） */
  candidates(): { host: string; port: number }[];
  stop(): Promise<void>;
}

export async function startDirect(opts: DirectOptions): Promise<DirectHandle> {
  const gateway = await startGateway({
    host: opts.host ?? "0.0.0.0",
    port: opts.port ?? 8442,
    sessionTtlSeconds: 12 * 3600,
    dshPort: opts.dshPort,
    dshAuthCookieHeader: opts.dshAuthCookieHeader ?? null,
    directSecret: opts.secret,
    accessCode: opts.accessCode ?? null,
    consumeTicket: opts.consumeTicket,
    authMode: "none",
    keyDir: opts.keyDir,
    dshUiCompat: opts.dshUiCompat,
    configPath: opts.configPath,
    tlsMaterial: opts.tlsMaterial ?? null,
  });
  const actualPort = gateway.actualPort;
  return {
    gateway,
    actualPort,
    candidates: () => lanCandidates(actualPort),
    stop: async () => {
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
      gateway.dispose();
    },
  };
}

/** 收集本机私网 IPv4 候选（含 link-local；不含公网与 loopback）。 */
export function lanCandidates(port: number): { host: string; port: number }[] {
  const out: { host: string; port: number }[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of (list ?? []) as NetworkInterfaceInfo[]) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      if (!isPrivateIpv4(ni.address)) continue;
      out.push({ host: ni.address, port });
    }
  }
  return out;
}

/** RFC1918 / link-local 判定（严格校验四段十进制）。 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * 直连 bootstrap 脚本（注入 DSH 首页）：经 E2EE 取候选 + 直连票，挂到 `window.__rdshDirectInfo`（P2 客户端消费）。
 * `pageToken` 为 null 时（未设口令）跳过 raw 授权，直接取候选。
 */
export function directBootstrapScript(pageToken: string | null): string {
  const authorize =
    pageToken === null
      ? "Promise.resolve()"
      : `fetch("/__rdsh/authorize?token=" + encodeURIComponent(${JSON.stringify(pageToken)}), { method: "POST" })`;
  return `(function () {
  if (window.__rdshDirectBootstrapped) return;
  window.__rdshDirectBootstrapped = true;
  try {
    ${authorize}
      .then(function () { return fetch("/__rdsh/direct-candidates"); })
      .then(function (r) { return r.json(); })
      .then(function (info) { window.__rdshDirectInfo = info; })
      .catch(function () {});
  } catch (e) { /* ignore */ }
})();`;
}
