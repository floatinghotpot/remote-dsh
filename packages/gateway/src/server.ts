/**
 * server.ts — HTTP(S) 服务器 + 认证中间件 + 路由。
 *
 * 认证（优先级从高到低）：
 *   accessCode 门禁（gateway.accessCode 非空）→ challenge 页 + rdsh_gate cookie；
 *   否则 auth.mode=password → /login（用户名/密码）；否则 none → 直接转发。
 *
 * 其余：TLS（node:https）、IP 白名单（allowFrom）、
 * 反代适配（behindProxy：X-Forwarded-For/Proto）、改密版本化会话（auth.version）。
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionManager, sessionTokenFromCookie } from "./session.ts";
import { UserManager } from "./auth.ts";
import { createUpgradeProxy, forwardHttp } from "./proxy.ts";
import { patchLoopbackJs } from "./join.ts";
import type { ProxyTarget } from "./proxy.ts";
import { loginPageHtml } from "./login-page.ts";
import { SECURE_CONTEXT_POLYFILL, CLIPBOARD_POLYFILL } from "./secure-context-polyfill.ts";
import { RDSH_WEBVIEW_API } from "./rdsh-webview-api.ts";
import { loadConfig } from "./config.ts";
import type { AuthMode } from "./config.ts";
import { ipInCidrs } from "./cidr.ts";
import type { TlsMaterial } from "./tls.ts";
import { GATE_COOKIE, GATE_COOKIE_TTL_MS, gateChallengeHtml, gateCookieFromHeader, headerAcceptLanguage, signGateCookie, verifyGateCode, verifyGateCookie, createGateLimiter, directForbiddenHtml } from "./gate.ts";
import type { GateError, GateLimiter } from "./gate.ts";

/** 注入 DSH 首页的脚本：非 secure context polyfill + 剪贴板 polyfill + rdsh WebView API 契约。 */
const HTML_INJECT = SECURE_CONTEXT_POLYFILL + CLIPBOARD_POLYFILL + RDSH_WEBVIEW_API;

export interface GatewayOptions {
  host: string;
  port: number;
  sessionTtlSeconds: number;
  dshPort: number;
  /** 宿主代持的 dsh 浏览器会话 cookie（`dsh-auth-*`，0.1.2+）；有值时注入转发 */
  dshAuthCookieHeader?: string | null;
  /**
   * DSH UI 兼容（LAN 路径）：`trustPairedAsLoopback` 默认 true —— 把已通过本机口令/登录的
   * LAN 会话视同 loopback，使 DSH 的设置与"持久化凭据"界面可用（否则 LAN 用户无法在界面里输入 API key）。
   */
  dshUiCompat?: { trustPairedAsLoopback?: boolean };
  /** true = 启动时重置会话密钥（全部会话失效） */
  reset?: boolean;
  /** 会话密钥目录（默认 ~/.rdsh；测试可注入临时目录） */
  keyDir?: string;
  /** true = 跳过认证（--no-code / auth.mode=none） */
  noCode?: boolean;
  /** 认证模式（password | none）；默认 none */
  authMode?: AuthMode;
  /** 访问口令（gateway.accessCode）；非空时启用 accessCode 门禁（替代 password/none） */
  accessCode?: string | null;
  /** 直连密钥（direct-secret，per-host 随机）：直连口门禁的 cookie 签名密钥（ticket 门禁，方案 B） */
  directSecret?: string;
  /** 一次性直连票校验（R4）：返回 true 表示该票有效且已消费（单次） */
  consumeTicket?: (ticket: string) => boolean;
  /** 改密版本号（会话校验绑定）；默认 1 */
  authVersion?: number;
  /** IP 白名单（CIDR）；空 = 不限制 */
  allowFrom?: string[];
  /** 反代终止 TLS（信任 XFF，允许 password+http） */
  behindProxy?: boolean;
  /** TLS 材料；提供则 https */
  tlsMaterial?: TlsMaterial | null;
  /** password 模式验证用户 */
  userManager?: UserManager;
  /** 配置文件路径（fs.watch 热更新 auth.version/allowFrom） */
  configPath?: string;
}

export interface RunningGateway {
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  sessions: SessionManager;
  /** 实际监听端口（port 0 → OS 分配） */
  actualPort: number;
  /** 关闭 fs.watch 等资源 */
  dispose(): void;
}

interface HttpContext {
  sessions: SessionManager;
  target: ProxyTarget;
  sessionTtlSeconds: number;
  authMode: AuthMode;
  /** 访问口令（null = 门禁关闭） */
  accessCode: string | null;
  /** 直连密钥（null = 非直连口） */
  directSecret: string | null;
  /** 一次性直连票校验（R4） */
  consumeTicket?: (ticket: string) => boolean;
  gateLimiter: GateLimiter;
  behindProxy: boolean;
  dshAuthCookieHeader: string | null;
  /** LAN 会话是否视同 loopback（DSH 设置/凭据界面可用性；默认 true） */
  trustPairedAsLoopback: boolean;
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
  const target: ProxyTarget = { host: "127.0.0.1", port: opts.dshPort };

  const authMode: AuthMode = opts.noCode ? "none" : (opts.authMode ?? "none");
  const accessCode = opts.accessCode ?? null;
  const directSecret = opts.directSecret ?? null;
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
    target,
    sessionTtlSeconds: opts.sessionTtlSeconds,
    authMode,
    accessCode,
    directSecret,
    consumeTicket: opts.consumeTicket,
    gateLimiter: createGateLimiter(),
    behindProxy,
    dshAuthCookieHeader: opts.dshAuthCookieHeader ?? null,
    trustPairedAsLoopback: opts.dshUiCompat?.trustPairedAsLoopback !== false,
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
    if ((ctx.directSecret !== null || ctx.accessCode !== null) && !hasValidGate(req, ctx)) {
      socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (ctx.directSecret === null && ctx.accessCode === null && ctx.authMode !== "none" && !hasValidSession(req, ctx)) {
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
  const upgradeProxy = createUpgradeProxy(target, { authCookie: ctx.dshAuthCookieHeader });

  return {
    server,
    sessions,
    actualPort,
    dispose: () => {
      configWatcher?.close();
    },
  };
}

function pairOrLogin(ctx: HttpContext): string {
  return "/login";
}

function hasValidSession(req: IncomingMessage, ctx: HttpContext): boolean {
  const token = sessionTokenFromCookie(req.headers.cookie);
  return token !== null && ctx.sessions.verify(token, ctx.getVersion()) !== null;
}

/** 门禁签名密钥：直连口用 direct-secret，lan/cloud 用 accessCode。 */
function gateSecret(ctx: HttpContext): string | null {
  return ctx.directSecret ?? ctx.accessCode;
}

/** 门禁 cookie 校验（门禁关闭恒真）。 */
function hasValidGate(req: IncomingMessage, ctx: HttpContext): boolean {
  const secret = gateSecret(ctx);
  if (secret === null) return true;
  return verifyGateCookie(secret, gateCookieFromHeader(req.headers.cookie) ?? "");
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

  // 门禁（直连口 ticket 门禁 / accessCode 门禁）优先于 password/none
  if (ctx.directSecret !== null || ctx.accessCode !== null) {
    await handleGateHttp(req, res, ctx, pathname);
    return;
  }

  const isLoginMode = ctx.authMode === "password";

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
    forwardHttp(req, res, ctx.target, {
      htmlInject: HTML_INJECT,
      authCookie: ctx.dshAuthCookieHeader,
      jsPatch: ctx.trustPairedAsLoopback ? patchLoopbackJs : undefined,
    });
    return;
  }
  if (!hasValidSession(req, ctx)) {
    res.writeHead(307, { location: pairOrLogin(ctx) });
    res.end();
    return;
  }
  forwardHttp(req, res, ctx.target, {
    htmlInject: HTML_INJECT,
    authCookie: ctx.dshAuthCookieHeader,
    // 会话分支同样要打 loopback 补丁：LAN 没有 E2EE shim，设置/API key 唯一依赖这个补丁；
    // 旧实现只在 authMode==="none" 分支传了 jsPatch ⇒ 登录模式下设置页打不开（2026-09-14 复审发现）
    jsPatch: ctx.trustPairedAsLoopback ? patchLoopbackJs : undefined,
  });
}

/** 门禁 HTTP 处理：有效 cookie → 转发；直连票 → 发 cookie；有口令 → challenge；无口令无票 → 403。 */
async function handleGateHttp(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, pathname: string): Promise<void> {
  const secret = gateSecret(ctx);
  // 一次性直连票：?ticket=<t> → 校验通过发门禁 cookie + 303（免重输口令，R4）
  if (ctx.consumeTicket !== undefined && req.method === "GET") {
    const ticket = new URL(req.url ?? "/", "http://rdsh.local").searchParams.get("ticket");
    if (ticket !== null && ticket !== "" && ctx.consumeTicket(ticket)) {
      res.writeHead(303, {
        location: "/",
        "set-cookie": `${GATE_COOKIE}=${signGateCookie(secret as string).value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(GATE_COOKIE_TTL_MS / 1000)}`,
      });
      res.end();
      return;
    }
  }
  if (hasValidGate(req, ctx)) {
    forwardHttp(req, res, ctx.target, {
      htmlInject: HTML_INJECT,
      authCookie: ctx.dshAuthCookieHeader,
      jsPatch: ctx.trustPairedAsLoopback ? patchLoopbackJs : undefined,
    });
    return;
  }
  // 无口令的直连口：无票/无 cookie 一律 403（告知两条手动访问路径）
  if (ctx.accessCode === null) {
    res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(directForbiddenHtml(headerAcceptLanguage(req.headers)));
    return;
  }
  const ip = clientIp(req, ctx);
  if (req.method === "POST") {
    const form = await readFormBody(req);
    const input = form?.get("gate_code") ?? null;
    if (ctx.gateLimiter.blocked(ip)) {
      sendGateChallenge(req, res, pathname, "locked");
      return;
    }
    if (input !== null && verifyGateCode(input, ctx.accessCode)) {
      ctx.gateLimiter.clear(ip);
      res.writeHead(303, {
        location: pathname,
        "set-cookie": `${GATE_COOKIE}=${signGateCookie(secret as string).value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(GATE_COOKIE_TTL_MS / 1000)}`,
      });
      res.end();
      return;
    }
    ctx.gateLimiter.fail(ip);
    sendGateChallenge(req, res, pathname, "wrong");
    return;
  }
  sendGateChallenge(req, res, pathname, null);
}

function sendGateChallenge(req: IncomingMessage, res: ServerResponse, pathname: string, error: GateError): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(gateChallengeHtml("本主机", pathname, error, headerAcceptLanguage(req.headers)));
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
  res.writeHead(303, {
    location: "/",
    "set-cookie": ctx.sessions.cookieHeader(ctx.sessionTtlSeconds, ctx.getVersion()),
  });
  res.end();
}

/** 读 form-urlencoded 请求体（gate challenge 提交用；超限返回 null）。 */
async function readFormBody(req: IncomingMessage): Promise<URLSearchParams | null> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return null;
  }
  try {
    return new URLSearchParams(body);
  } catch {
    return null;
  }
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
