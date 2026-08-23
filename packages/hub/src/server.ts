/**
 * server.ts — hub HTTP(S) 服务器：路由 + 隧道 upgrade + events upgrade + portal 静态。
 *
 * 路由：
 *   /api/*            → 层 1 API（handleApi）
 *   /h/<hostId>/*     → 数据面透传（handleRelay / handleRelayUpgrade）
 *   /tunnel?token=    → gateway 出站隧道（层 2）
 *   /api/events       → WSS 在线推送（登录态）
 *   其余              → portal 静态
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
import { authenticate, handleApi, writeError } from "./api.ts";
import type { HubRuntime } from "./api.ts";
import { TunnelConn, TunnelRegistry } from "./tunnel.ts";
import { EventHub, createEventsServer } from "./events.ts";
import { handleRelay, handleRelayUpgrade } from "./relay.ts";
import { servePortal } from "./portal.ts";

export interface HubServerOptions {
  host: string;
  port: number;
  tls?: { cert: string; key: string };
  db: HubDb;
  auth: HubAuth;
  tunnels: TunnelRegistry;
  events: EventHub;
  portalDir: string;
}

export interface RunningHub {
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  actualPort: number;
}

const TUNNEL_PATH = "/tunnel";

export async function startHubServer(opts: HubServerOptions): Promise<RunningHub> {
  const runtime: HubRuntime = {
    config: {
      host: opts.host,
      port: opts.port,
      tls: opts.tls,
      dbPath: "",
      jwtKeyPath: "",
    },
    db: opts.db,
    auth: opts.auth,
    tunnels: opts.tunnels,
    events: opts.events,
  };

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res, runtime, opts.portalDir).catch(() => {
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
      if (url.pathname === TUNNEL_PATH) {
        handleTunnelUpgrade(req, socket, head, runtime, url);
        return;
      }
      if (url.pathname === "/api/events") {
        handleEventsUpgrade(req, socket, head, runtime, eventsServer);
        return;
      }
      const h = /^\/h\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (h !== null) {
        const hostId = decodeURIComponent(h[1]!);
        const rest = h[2] ?? "/";
        handleRelayUpgrade(req, socket, head, runtime, hostId, `${rest}${url.search}`);
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

  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, runtime);
    return;
  }
  const h = /^\/h\/([^/]+)(\/.*)?$/.exec(pathname);
  if (h !== null) {
    const hostId = decodeURIComponent(h[1]!);
    const rest = h[2] ?? "/";
    await handleRelay(req, res, runtime, hostId, `${rest}${url.search}`);
    return;
  }
  const handled = await servePortal(req, res, portalDir);
  if (!handled) writeError(res, 404, "NOT_FOUND", "not found");
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
