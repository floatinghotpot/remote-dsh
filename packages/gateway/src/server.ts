/**
 * server.ts — HTTP(S) 服务器 + 认证中间件 + 路由。
 *
 * 路由：
 *   GET  /pair         → 配对页（auth.mode=pair）
 *   POST /pair         → 校验配对码（成功 Set-Cookie + 302 /；失败 401/429）
 *   GET  /login        → 登录页（auth.mode=password）
 *   POST /login        → 校验用户名/密码（成功 Set-Cookie + 302 /；失败 401/429）
 *   其余路径（含 upgrade）→ 有有效会话转发 dsh；无 → 307 /pair 或 /login
 *
 * M2：TLS（node:https）、auth.mode（pair/password/none）、IP 白名单（allowFrom）、
 * 反代适配（behindProxy：X-Forwarded-For/Proto）、改密版本化会话（auth.version）。
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionManager, sessionTokenFromCookie } from "./session.ts";
import { PairManager } from "./pair.ts";
import { UserManager } from "./auth.ts";
import { createUpgradeProxy, forwardHttp } from "./proxy.ts";
import type { ProxyTarget } from "./proxy.ts";
import { pairPageHtml } from "./pair-page.ts";
import { loginPageHtml } from "./login-page.ts";
import { SECURE_CONTEXT_POLYFILL } from "./secure-context-polyfill.ts";
import { loadConfig } from "./config.ts";
import type { AuthMode } from "./config.ts";
import { ipInCidrs } from "./cidr.ts";
import type { TlsMaterial } from "./tls.ts";

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
  /** true = 跳过认证（--no-code / auth.mode=none） */
  noCode?: boolean;
  /** M2：认证模式（pair | password | none）；默认 noCode? none : pair */
  authMode?: AuthMode;
  /** M2：改密版本号（会话校验绑定）；默认 1 */
  authVersion?: number;
  /** M2：IP 白名单（CIDR）；空 = 不限制 */
  allowFrom?: string[];
  /** M2：反代终止 TLS（信任 XFF，允许 password+http） */
  behindProxy?: boolean;
  /** M2：TLS 材料；提供则 https */
  tlsMaterial?: TlsMaterial | null;
  /** M2：password 模式验证用户 */
  userManager?: UserManager;
  /** M2：配置文件路径（fs.watch 热更新 auth.version/allowFrom） */
  configPath?: string;
}

export interface RunningGateway {
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  sessions: SessionManager;
  pair: PairManager;
  /** 实际监听端口（port 0 → OS 分配） */
  actualPort: number;
  /** 关闭 fs.watch 等资源 */
  dispose(): void;
}

interface HttpContext {
  sessions: SessionManager;
  pair: PairManager;
  target: ProxyTarget;
  sessionTtlSeconds: number;
  authMode: AuthMode;
  behindProxy: boolean;
  getVersion(): number;
  isAllowed(ip: string): boolean;
  userManager?: UserManager;
}

const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

export async function startGateway(opts: GatewayOptions): Promise<RunningGateway> {
  const sessions = new SessionManager(opts.keyDir);
  if (opts.reset) {
    await sessions.reset();
  } else {
    await sessions.init();
  }
  const pair = new PairManager(opts.pairCode);
  const target: ProxyTarget = { host: "127.0.0.1", port: opts.dshPort };

  const authMode: AuthMode = opts.noCode ? "none" : (opts.authMode ?? "pair");
  const behindProxy = opts.behindProxy === true;

  // 安全硬约束：password 模式必须 TLS（反代除外）
  if (authMode === "password" && !behindProxy && (opts.tlsMaterial === undefined || opts.tlsMaterial === null)) {
    throw new Error('auth.mode=password requires TLS. Set tls.cert/key in config, or use behind_proxy with a reverse proxy.');
  }

  // 可变状态：config 热更新（改密版本 / IP 白名单）
  let currentVersion = opts.authVersion ?? 1;
  let currentAllowFrom = opts.allowFrom ?? [];
  let configWatcher: ReturnType<typeof watch> | undefined;
  if (opts.configPath !== undefined) {
    const configPath = opts.configPath;
    const reload = (): void => {
      void loadConfig(configPath).then((cfg) => {
        currentVersion = cfg.auth.version;
        currentAllowFrom = cfg.allowFrom;
      }).catch(() => {
        /* 配置暂不可读，保持旧值 */
      });
    };
    // 监听目录而非文件：`rdsh user passwd` 用 tmp+rename 原子替换 config，
    // 文件级 watch 会跟丢（macOS kqueue 盯的是旧 inode）。目录 vnode 稳定。
    configWatcher = watch(dirname(configPath), (_event, filename) => {
      if (filename === basename(configPath) || filename === null) reload();
    });
  }

  const ctx: HttpContext = {
    sessions,
    pair,
    target,
    sessionTtlSeconds: opts.sessionTtlSeconds,
    authMode,
    behindProxy,
    getVersion: () => currentVersion,
    isAllowed: (ip) => currentAllowFrom.length === 0 || ipInCidrs(ip, currentAllowFrom),
    userManager: opts.userManager,
  };

  const loginLimiter = createLoginLimiter();
  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleHttp(req, res, ctx, loginLimiter).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  const server =
    opts.tlsMaterial === undefined || opts.tlsMaterial === null
      ? createHttpServer(requestHandler)
      : createHttpsServer({ key: opts.tlsMaterial.key, cert: opts.tlsMaterial.cert }, requestHandler);

  server.on("upgrade", (req, socket, head) => {
    if (ctx.authMode !== "none" && !hasValidSession(req, ctx)) {
      socket.write(`HTTP/1.1 307 Temporary Redirect\r\nLocation: ${pairOrLogin(ctx)}\r\n\r\n`);
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
  const upgradeProxy = createUpgradeProxy(target);

  return {
    server,
    sessions,
    pair,
    actualPort,
    dispose: () => {
      configWatcher?.close();
    },
  };
}

function pairOrLogin(ctx: HttpContext): string {
  return ctx.authMode === "password" ? "/login" : "/pair";
}

function hasValidSession(req: IncomingMessage, ctx: HttpContext): boolean {
  const token = sessionTokenFromCookie(req.headers.cookie);
  return token !== null && ctx.sessions.verify(token, ctx.getVersion()) !== null;
}

/** 客户端真实 IP（behindProxy 时取 XFF，仅当连接来自回环 —— 防伪造）。 */
function clientIp(req: IncomingMessage, ctx: HttpContext): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (ctx.behindProxy && (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      return xff.split(",")[0]!.trim();
    }
  }
  return remote;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, loginLimiter: ReturnType<typeof createLoginLimiter>): Promise<void> {
  // IP 白名单（认证前）
  if (!ctx.isAllowed(clientIp(req, ctx))) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "FORBIDDEN", message: "source IP not allowed" } }));
    return;
  }

  const pathname = new URL(req.url ?? "/", "http://rdsh.local").pathname;
  const isLoginMode = ctx.authMode === "password";

  if (req.method === "GET" && pathname === "/pair" && !isLoginMode) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(pairPageHtml());
    return;
  }
  if (req.method === "POST" && pathname === "/pair" && !isLoginMode) {
    await handlePairPost(req, res, ctx);
    return;
  }
  if (req.method === "GET" && pathname === "/login" && isLoginMode) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(loginPageHtml());
    return;
  }
  if (req.method === "POST" && pathname === "/login" && isLoginMode) {
    await handleLoginPost(req, res, ctx, loginLimiter);
    return;
  }

  if (ctx.authMode === "none") {
    forwardHttp(req, res, ctx.target, { htmlInject: SECURE_CONTEXT_POLYFILL });
    return;
  }
  if (!hasValidSession(req, ctx)) {
    res.writeHead(307, { location: pairOrLogin(ctx) });
    res.end();
    return;
  }
  forwardHttp(req, res, ctx.target, { htmlInject: SECURE_CONTEXT_POLYFILL });
}

async function handlePairPost(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";
  const body = await readJsonBody(req);
  if (body === null) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "invalid body" } }));
    return;
  }
  const code = body.code;
  if (typeof code !== "string" || code.length > 16) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "invalid code" } }));
    return;
  }
  const result = ctx.pair.check(code, ip);
  if (result.ok) {
    res.writeHead(302, {
      location: "/",
      "set-cookie": ctx.sessions.cookieHeader(ctx.sessionTtlSeconds, ctx.getVersion()),
    });
    res.end();
    return;
  }
  if (result.locked) {
    const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfter) });
    res.end(JSON.stringify({ error: { code: "RATE_LIMITED", message: "too many attempts" } }));
    return;
  }
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "BAD_CODE", message: "invalid pair code" } }));
}

async function handleLoginPost(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, loginLimiter: ReturnType<typeof createLoginLimiter>): Promise<void> {
  const ip = clientIp(req, ctx);
  const lockedMs = loginLimiter.allow(ip);
  if (lockedMs > 0) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(lockedMs / 1000)) });
    res.end(JSON.stringify({ error: { code: "RATE_LIMITED", message: "too many attempts" } }));
    return;
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body.name !== "string" || typeof body.password !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "invalid body" } }));
    return;
  }
  if (ctx.userManager === undefined) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NO_USERS", message: "no user manager configured" } }));
    return;
  }
  const user = await ctx.userManager.verify(body.name, body.password);
  if (user === null) {
    const locked = loginLimiter.fail(ip);
    if (locked > 0) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(locked / 1000)) });
      res.end(JSON.stringify({ error: { code: "RATE_LIMITED", message: "too many attempts" } }));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_CREDENTIALS", message: "invalid username or password" } }));
    return;
  }
  loginLimiter.clear(ip);
  res.writeHead(302, {
    location: "/",
    "set-cookie": ctx.sessions.cookieHeader(ctx.sessionTtlSeconds, ctx.getVersion()),
  });
  res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 登录失败限流（按 IP，5 次/10 分钟）。 */
function createLoginLimiter() {
  const locks = new Map<string, { fails: number; lockedUntil: number }>();
  return {
    /** 剩余锁定毫秒（0 = 允许）。 */
    allow(ip: string): number {
      const s = locks.get(ip);
      if (s === undefined) return 0;
      const remain = s.lockedUntil - Date.now();
      return remain > 0 ? remain : 0;
    },
    /** 记录失败；返回新锁定毫秒（>0 表示已锁定）。 */
    fail(ip: string): number {
      const s = locks.get(ip) ?? { fails: 0, lockedUntil: 0 };
      s.fails += 1;
      if (s.fails >= MAX_LOGIN_FAILS) {
        s.fails = 0;
        s.lockedUntil = Date.now() + LOGIN_LOCK_MS;
      }
      locks.set(ip, s);
      return s.lockedUntil > Date.now() ? s.lockedUntil - Date.now() : 0;
    },
    clear(ip: string): void {
      locks.delete(ip);
    },
  };
}
