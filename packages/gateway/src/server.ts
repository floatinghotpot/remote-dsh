/**
 * server.ts — HTTP 服务器 + 认证中间件 + 路由。
 *
 * 路由：
 *   GET  /pair        → 配对页
 *   POST /pair        → 校验配对码（成功 Set-Cookie + 302 /；失败 401/429）
 *   其余路径（含 upgrade）→ 有有效会话转发 dsh；无 → 307 /pair
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionManager, sessionTokenFromCookie } from "./session.ts";
import { PairManager } from "./pair.ts";
import { createUpgradeProxy, forwardHttp } from "./proxy.ts";
import type { ProxyTarget } from "./proxy.ts";
import { pairPageHtml } from "./pair-page.ts";
import { SECURE_CONTEXT_POLYFILL } from "./secure-context-polyfill.ts";

export interface GatewayOptions {
  host: string;
  port: number;
  pairCode?: string;
  sessionTtlSeconds: number;
  dshPort: number;
  /** true = 启动时重置会话密钥（全部会话失效） */
  reset?: boolean;
  /** 会话密钥目录（默认 ~/.rdsh；测试可注入临时目录） */
  keyDir?: string;
  /** true = 跳过配对码认证（仅限完全可信网络！启动会打印警告） */
  noCode?: boolean;
}

export interface RunningGateway {
  server: ReturnType<typeof createServer>;
  sessions: SessionManager;
  pair: PairManager;
  /** 实际监听端口（port 0 → OS 分配） */
  actualPort: number;
}

interface HttpContext {
  sessions: SessionManager;
  pair: PairManager;
  target: ProxyTarget;
  sessionTtlSeconds: number;
  noCode: boolean;
}

export async function startGateway(opts: GatewayOptions): Promise<RunningGateway> {
  const sessions = new SessionManager(opts.keyDir);
  if (opts.reset) {
    await sessions.reset();
  } else {
    await sessions.init();
  }
  const pair = new PairManager(opts.pairCode);
  const target: ProxyTarget = { host: "127.0.0.1", port: opts.dshPort };
  const upgradeProxy = createUpgradeProxy(target);
  const ctx: HttpContext = {
    sessions,
    pair,
    target,
    sessionTtlSeconds: opts.sessionTtlSeconds,
    noCode: opts.noCode === true,
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res, ctx).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (!ctx.noCode && !hasValidSession(req, sessions)) {
      socket.write("HTTP/1.1 307 Temporary Redirect\r\nLocation: /pair\r\n\r\n");
      socket.destroy();
      return;
    }
    upgradeProxy.handleUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : opts.port;
  return { server, sessions, pair, actualPort };
}

function hasValidSession(req: IncomingMessage, sessions: SessionManager): boolean {
  const token = sessionTokenFromCookie(req.headers.cookie);
  return token !== null && sessions.verify(token) !== null;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://rdsh.local").pathname;

  if (req.method === "GET" && pathname === "/pair") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(pairPageHtml());
    return;
  }
  if (req.method === "POST" && pathname === "/pair") {
    await handlePairPost(req, res, ctx);
    return;
  }
  if (!ctx.noCode && !hasValidSession(req, ctx.sessions)) {
    res.writeHead(307, { location: "/pair" });
    res.end();
    return;
  }
  forwardHttp(req, res, ctx.target, { htmlInject: SECURE_CONTEXT_POLYFILL });
}

async function handlePairPost(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "TOO_LARGE", message: "body too large" } }));
      return;
    }
  }
  let code: unknown;
  try {
    code = (JSON.parse(body) as { code?: unknown }).code;
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "invalid body" } }));
    return;
  }
  if (typeof code !== "string" || code.length > 16) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "invalid code" } }));
    return;
  }
  const result = ctx.pair.check(code, ip);
  if (result.ok) {
    res.writeHead(302, {
      location: "/",
      "set-cookie": ctx.sessions.cookieHeader(ctx.sessionTtlSeconds),
    });
    res.end();
    return;
  }
  if (result.locked) {
    const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(retryAfter),
    });
    res.end(JSON.stringify({ error: { code: "RATE_LIMITED", message: "too many attempts" } }));
    return;
  }
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "BAD_CODE", message: "invalid pair code" } }));
}
