/**
 * server.ts — hub HTTP(S) 服务器：路由 + 隧道 upgrade + events upgrade + portal 静态。
 *
 * 路由（2026-08-23 架构修订：host 访问用"根路径 + cookie 选 host"，DSH 零改动）：
 *   /api/*            → 无 rdsh_host cookie 时为层 1 API；有则为当前 host 的 DSH API
 *   /portal*          → portal 静态（进入 portal 即清除 rdsh_host）
 *   /h/<hostId>/*     → 进入该 host：校验归属 → Set-Cookie rdsh_host → 302 到根路径
 *   其余（/、/assets/* 等）→ 有 rdsh_host 转发该 host；无 → portal
 *   /tunnel?token=    → gateway 出站隧道（层 2）
 *   /api/events       → portal 在线推送（无 rdsh_host 时）
 *
 * 安全：无 TLS 证书 → 拒绝启动（公网 hub 必须 TLS，req R1/R10）。
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { sha256 } from "./jwt.ts";
import { HubDb } from "./db.ts";
import { HubAuth } from "./auth.ts";
import { authenticate, clientIp, handleApi, writeError, sweepBilling } from "./api.ts";
import type { HubRuntime } from "./api.ts";
import type { EmailConfig } from "./email/types.ts";
import type { SmsConfig } from "./sms/types.ts";
import type { CaptchaConfig, SecurityConfig, BillingConfig, BeianConfig } from "./config.ts";
import { TunnelConn, TunnelRegistry } from "./tunnel.ts";
import { EventHub, createEventsServer } from "./events.ts";
import { handleRelay, handleRelayUpgrade } from "./relay.ts";
import { servePortal } from "./portal.ts";

export interface HubServerOptions {
  host: string;
  port: number;
  tls?: { cert: string; key: string };
  /** 反代终止 TLS：信任回环连接的 X-Forwarded-For（限流按真实 IP） */
  behindProxy?: boolean;
  db: HubDb;
  auth: HubAuth;
  tunnels: TunnelRegistry;
  events: EventHub;
  portalDir: string;
  /** 邮件/验证码/安全配置（serve.ts 从 hub.json 传入）。 */
  email?: EmailConfig;
  captcha?: CaptchaConfig;
  security?: SecurityConfig;
  /** 短信/注册/计费（08-saas，serve.ts 从 hub.json 传入）。 */
  sms?: SmsConfig;
  registration?: "open" | "closed";
  billing?: BillingConfig;
  /** 备案信息（portal 页脚，serve.ts 从 hub.json 传入）。 */
  beian?: BeianConfig;
}

export interface RunningHub {
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  actualPort: number;
}

const TUNNEL_PATH = "/tunnel";
/** 选中 host 的 cookie：DSH 在根路径运行，由该 cookie 路由到对应隧道。 */
export const HOST_COOKIE = "rdsh_host";
/** portal 根路径前缀。 */
export const PORTAL_PREFIX = "/portal";
const HOST_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 天（签名 host cookie，含会话版本）

function hostCookie(hostId: string, userId: number, auth: HubAuth): string {
  const token = auth.signHostCookie(hostId, userId);
  return `${HOST_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${HOST_COOKIE_MAX_AGE}`;
}

function clearHostCookie(): string {
  return `${HOST_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** 解析 Cookie 头（relay 复用）。 */
export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}



export async function startHubServer(opts: HubServerOptions): Promise<RunningHub> {
  const runtime: HubRuntime = {
    config: {
      host: opts.host,
      port: opts.port,
      tls: opts.tls,
      dbPath: "",
      jwtKeyPath: "",
      behindProxy: opts.behindProxy === true,
      email: opts.email,
      captcha: opts.captcha,
      security: opts.security,
      sms: opts.sms,
      registration: opts.registration,
      billing: opts.billing,
      beian: opts.beian,
    },
    db: opts.db,
    auth: opts.auth,
    tunnels: opts.tunnels,
    events: opts.events,
  };

  // 计费状态机定时扫描（每分钟）：trial/subscribed 到期 → grace → free
  sweepBilling(runtime);
  setInterval(() => sweepBilling(runtime), 60 * 1000).unref();

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res, runtime, opts.portalDir).catch((err) => {
      // 打真实错误到日志（journalctl 可见），而不是只回通用 500
      console.error(`[hub] request error ${req.method} ${req.url}:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) writeError(res, 500, "INTERNAL", "internal error");
      else res.end();
    });
  };

  const server =
    opts.tls === undefined
      ? createHttpServer(requestHandler)
      : createHttpsServer({ key: opts.tls.key, cert: opts.tls.cert }, requestHandler);

  const eventsServer = createEventsServer(runtime.events);

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://rdsh.local");
    try {
      const pathname = url.pathname;
      const cookies = parseCookies(req.headers.cookie);
      const hostId = cookies[HOST_COOKIE];

      if (pathname === TUNNEL_PATH) {
        handleTunnelUpgrade(req, socket, head, runtime, url);
        return;
      }
      // portal 的在线推送（无 host 上下文时）
      if (pathname === "/api/events" && hostId === undefined) {
        handleEventsUpgrade(req, socket, head, runtime, eventsServer);
        return;
      }
      // 有 host 上下文：根路径 WS（DSH 的 events.mux / events.host）
      if (hostId !== undefined) {
        handleRelayUpgrade(req, socket, head, runtime, pathname + url.search);
        return;
      }
      // /h/<hostId>/ 的 WS：进入瞬间（罕见）——校验后转发（cookie 由进入的 HTTP 请求已设）
      const h = /^\/h\/([^/]+)(\/.*)?$/.exec(pathname);
      if (h !== null) {
        const auth = authenticate(req, runtime);
        if (auth !== null) {
          const hid = decodeURIComponent(h[1]!);
          const host = runtime.db.getHostById(hid);
          if (host !== null && host.ownerId === auth.userId) {
            handleRelayUpgrade(req, socket, head, runtime, `${h[2] ?? "/"}${url.search}`);
            return;
          }
        }
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : opts.port;
  return { server, actualPort };
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, portalDir: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://rdsh.local");
  const pathname = url.pathname;
  const cookies = parseCookies(req.headers.cookie);
  const hostId = cookies[HOST_COOKIE];

  // portal 区域：进入 portal 即退出 host 上下文（清 cookie）
  if (pathname === PORTAL_PREFIX || pathname.startsWith(PORTAL_PREFIX + "/")) {
    if (hostId !== undefined) res.setHeader("set-cookie", clearHostCookie());
    const handled = await servePortal(req, res, portalDir);
    if (!handled) writeError(res, 404, "NOT_FOUND", "not found");
    return;
  }

  // 进入 host：/h/<hostId>/... → 校验归属 → Set-Cookie + 302 根路径
  const h = /^\/h\/([^/]+)(\/.*)?$/.exec(pathname);
  if (h !== null) {
    await handleEnterHost(req, res, runtime, decodeURIComponent(h[1]!), h[2] ?? "/", url.search);
    return;
  }

  // 有 host 上下文：根路径全部转发给该 host（DSH 无感知，绝对路径 /assets /api 原样）
  if (hostId !== undefined) {
    await handleRelay(req, res, runtime, pathname + url.search, { injectBackBar: true });
    return;
  }

  // hub API（无 host 上下文）
  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, runtime);
    return;
  }

  // 无上下文：portal（历史路径兼容 /login /hosts）
  const handled = await servePortal(req, res, portalDir);
  if (!handled) writeError(res, 404, "NOT_FOUND", "not found");
}

async function handleEnterHost(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: HubRuntime,
  hostId: string,
  rest: string,
  search: string,
): Promise<void> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return;
  }
  const host = runtime.db.getHostById(hostId);
  if (host === null) {
    writeError(res, 404, "NOT_FOUND", "host not found");
    return;
  }
  const isOwner = host.ownerId === auth.userId;
  const isMember = isOwner || runtime.db.getShare(hostId, auth.userId) !== null;
  if (!isMember) {
    writeError(res, 403, "FORBIDDEN", "host not owned by you or shared with you");
    return;
  }
  runtime.db.recordAudit(auth.userId, "host.enter", { hostId, role: isOwner ? "owner" : "member" }, clientIp(req, runtime));
  // Set-Cookie（HMAC 签名 host cookie）+ 302：DSH 在根路径运行；
  // 后续 relay 只验签名 cookie（不受 access 1h 过期影响，改密即时失效）
  res.writeHead(302, { location: `${rest}${search}`, "set-cookie": hostCookie(hostId, auth.userId, runtime.auth) });
  res.end();
}

function handleTunnelUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, runtime: HubRuntime, url: URL): void {
  const token = url.searchParams.get("token");
  if (token === null || token.length < 16) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const host = runtime.db.findHostByTokenHash(sha256(token));
  if (host === null) {
    // 吊销后重连被拒
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const wss = new WebSocketServer({ noServer: true });
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = new TunnelConn(ws, host.id, (hostId) => {
      runtime.tunnels.unregister(hostId);
      runtime.events.pushToUser(host.ownerId, { type: "host.offline", hostId });
    });
    runtime.tunnels.register(conn);
    runtime.events.pushToUser(host.ownerId, { type: "host.online", hostId: host.id });
  });
}

function handleEventsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, runtime: HubRuntime, eventsServer: ReturnType<typeof createEventsServer>): void {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  eventsServer.handleUpgrade(req, socket, head, (ws) => {
    (ws as WebSocket & { rdshUserId?: number }).rdshUserId = auth.userId;
    eventsServer.emit("connection", ws, req);
  });
}

/** TLS 材料加载（hub 专用：无证书 → 报错，公网必须 TLS）。 */
export async function loadHubTls(tls?: { cert: string; key: string }): Promise<{ cert: string; key: string }> {
  if (tls === undefined) {
    throw new Error("hub requires TLS. Set tls.cert/key in ~/.rdsh/hub.json (Let's Encrypt / cloud cert).");
  }
  const [cert, key] = await Promise.all([readFile(tls.cert, "utf8"), readFile(tls.key, "utf8")]);
  return { cert, key };
}
