/**
 * join.ts — `rdsh join <hub-url>`：出站隧道客户端（公网模式，M3）。
 *
 * 流程：spawn dsh（复用）→ 注册（join token → host token）→ WSS 隧道（?token=）
 * → 帧循环（OPEN http/ws → 本地 dsh 转发 → 响应帧回传）→ 断线指数退避重连。
 *
 * 安全：只出站（不监听任何入站端口）；hub 认证在层 1，gateway 侧只认隧道内来源。
 *
 * 06-dsh-plugin 重构（D13 钩子落地）：`join()`（CLI 形态，spawn dsh + 信号退出）
 * 拆出 `startJoin()`（no-spawn、外部 target、可停止、onState/onLog）——插件复用。
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname as osHostname } from "node:os";
import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import { FrameParser, FRAME_TYPE, encodeFrame, jsonPayload, parseJsonPayload, FLAG_E2E, MAX_PAYLOAD_LENGTH } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { findDsh, spawnDsh, exchangeDshSessionCookie, detectDshVersion, dshVersionWarning } from "./spawn-dsh.ts";
import { rewriteHeadersForDsh } from "./proxy.ts";
import type { ProxyTarget } from "./proxy.ts";
import { clearPersistedToken, persistToken, readPersistedToken } from "./token-store.ts";
import { decodeBody, encodeBody, firstEncoding } from "./http-encoding.ts";
import { acquireJoinLock, releaseJoinLock } from "./lock.ts";
import type { JoinLockRole } from "./lock.ts";
import { responderHandshake, Aead } from "./e2ee.ts";
import type { KeyPair, E2eeKeys } from "./e2ee.ts";
import { loadOrCreateE2eeKeyPair } from "./e2ee-key-store.ts";
import { GATE_COOKIE, signGateCookie, verifyGateCookie, verifyGateCode } from "./access-gate.ts";

export interface JoinOptions {
  hubUrl: string;
  /** join token（用户级，register 换 host token） */
  token?: string;
  /** 清除持久化 token 并强制重新配对 */
  reset?: boolean;
  dshPath?: string;
  /** 跳过 TLS 证书校验（自签 hub 用；正式证书无需，缺省自动检测） */
  insecure?: boolean;
  /** 主机名（注册命名 / host.json） */
  name?: string;
  /** DSH UI 兼容（透传 host.json dshUiCompat；缺省 true） */
  dshUiCompat?: { trustE2EEAsLoopback?: boolean };
  /** 网关访问口令（feature 15；accessCode null = 关闭） */
  gateway?: { accessCode?: string | null };
}

/** 注册/接入结果：解析出的 host token + 是否需 insecure + 生效的主机名（缺省=机器 hostname）。 */
export interface RegisterOutcome {
  token: string;
  insecure: boolean;
  name: string;
}

/** 隧道状态机（onState 事件值）。 */
export type JoinState = "connecting" | "connected" | "reconnecting" | "rejected" | "stopped";

/** join 核心事件钩子（插件面板实时状态 + 日志预留）。 */
export interface JoinHooks {
  onState?(state: JoinState, detail?: { message?: string; delayMs?: number }): void;
  onLog?(level: "info" | "warn" | "error", message: string): void;
}

/** no-spawn、外部 target 的 join 隧道启动参数（CLI 与插件共用）。 */
export interface StartJoinOptions {
  hubUrl: string;
  /** 已解析的 host token（registerJoin 结果） */
  token: string;
  insecure: boolean;
  /** 转发目标（no-spawn：外部 dsh 的 loopback 地址） */
  target: ProxyTarget;
  /** pid 锁 role：cli / plugin */
  role: JoinLockRole;
  /** 锁文件路径（缺省 ~/.rdsh/join.lock；测试可注入临时路径） */
  lockPath?: string;
  hooks?: JoinHooks;
  /** DSH UI 兼容（缺省 trustE2EEAsLoopback=true；false 关闭 JS patch） */
  dshUiCompat?: { trustE2EEAsLoopback?: boolean };
  /** 网关访问口令（feature 15；accessCode null = 关闭） */
  gateway?: { accessCode?: string | null };
  /** 主机名（challenge 页展示；缺省「本主机」） */
  name?: string;
  /** 宿主代持的 dsh 浏览器会话 cookie（`dsh-auth-*`，0.1.2+）；有值时注入隧道→本地转发 */
  dshAuthCookieHeader?: string | null;
  /**
   * 心跳间隔（缺省 30s，协议 PROTOCOL.md「心跳与重连」）。
   * 测试可注入毫秒级小值以快速验证超时判定。
   */
  heartbeatMs?: number;
  /**
   * 发出 PING 后等待对端任何帧的上限（缺省 10s）；超时即判连接已死并主动断开。
   * 测试可注入小值。
   */
  pongTimeoutMs?: number;
}

/** 可停止的 join 隧道句柄。 */
export interface JoinHandle {
  stop(): Promise<void>;
  /** 运行中切换 DSH UI 兼容（trustE2EEAsLoopback）；下一个请求即生效。 */
  setUiCompat(trustE2EEAsLoopback: boolean): void;
  /** 运行中设置/清除访问口令（null = 关闭 gate）；下一个请求即生效。 */
  setAccessCode(code: string | null): void;
}

/** 判断错误是否为 TLS 证书类错误（自签/过期/域名不匹配）。 */
function isCertError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  return (
    code.includes("CERT_") ||
    code.includes("TLS") ||
    code.includes("SELF_SIGNED") ||
    code.includes("UNABLE_TO_VERIFY") ||
    code.includes("DEPTH_ZERO")
  );
}

/** 探测 hub 是否需 insecure：以严格校验握手一次；证书错误 → true（需 insecure）。 */
export async function detectInsecure(hubUrl: string): Promise<boolean> {
  try {
    await hubRequest(hubUrl, "/api/auth/login", { method: "GET", insecure: false });
    return false; // TLS 握手成功
  } catch (err) {
    return isCertError(err);
  }
}

const HEARTBEAT_MS = 30_000;
/** 发出 PING 后等待对端任何帧的上限：超时即判连接已死并主动断开（协议 PROTOCOL.md）。 */
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/** hub HTTP 调用（node:https 支持自签跳过校验 —— undici fetch 不受 NODE_TLS_REJECT_UNAUTHORIZED 影响）。 */
function hubRequest(
  baseUrl: string,
  path: string,
  opts: { method: string; insecure: boolean; body?: unknown },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const url = new URL(baseUrl + path);
  const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(
      {
        host: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: url.pathname + url.search,
        method: opts.method,
        headers: { "content-type": "application/json" },
        rejectUnauthorized: !opts.insecure,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            /* 非 JSON */
          }
          resolve({ ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode ?? 0, body });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined);
  });
}

/** 调用 hub self-revoke 注销本机（host 持自己的 host token）。`rdsh host leave` 使用。 */
export async function selfRevoke(hubUrl: string, token: string, insecure: boolean): Promise<void> {
  const res = await hubRequest(hubUrl, "/api/hosts/self-revoke", { method: "POST", insecure, body: { token } });
  if (!res.ok) {
    const msg = (res.body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
    throw new Error(`hub rejected self-revoke: ${msg}`);
  }
}

/** 解析 host token（--token 注册 > 持久化复用）+ 自动检测证书；供 CLI 配置命令与 join() 复用。 */
export async function registerJoin(opts: JoinOptions): Promise<RegisterOutcome> {
  const insecure = opts.insecure === true || (await detectInsecure(opts.hubUrl));
  // 主机名缺省 = 机器 hostname（CLI / service install / 插件三条路径统一；--name 可覆盖）
  const name = opts.name !== undefined && opts.name.trim() !== "" ? opts.name.trim() : osHostname();
  let token: string;
  if (opts.token !== undefined) {
    // --token = join token（或旧 host token）→ register 端点换 host token
    const e2eeKeyPair = loadOrCreateE2eeKeyPair();
    const { hostToken } = await register(opts.hubUrl, opts.token, name, insecure, e2eeKeyPair.publicRaw.toString("base64url"));
    token = hostToken;
    persistToken(opts.hubUrl, token);
  } else {
    if (opts.reset === true) clearPersistedToken(opts.hubUrl);
    const persisted = readPersistedToken(opts.hubUrl);
    if (persisted !== null) {
      token = persisted;
      console.log("rdsh join: reusing persisted host token");
    } else {
      throw new Error("未接入：无持久化 session 且未提供 --token；先 `rdsh host join <hub>` 生成/粘贴 join token");
    }
  }
  return { token, insecure, name };
}

/** 调 register 端点：join token → host token（对旧 host token 幂等返回同一 token）。 */
async function register(
  hubUrl: string,
  joinToken: string,
  name: string | undefined,
  insecure: boolean,
  e2eePublicKey?: string,
): Promise<{ hostId: string; hostToken: string }> {
  const body: Record<string, unknown> = { token: joinToken, name };
  if (e2eePublicKey !== undefined) body.e2eePublicKey = e2eePublicKey;
  const res = await hubRequest(hubUrl, "/api/hosts/register", { method: "POST", insecure, body });
  if (!res.ok) {
    const msg = (res.body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
    throw new Error(`hub rejected register: ${msg}`);
  }
  const b = res.body as { hostId?: string; hostToken?: string };
  if (typeof b.hostId !== "string" || typeof b.hostToken !== "string") {
    throw new Error("hub register returned malformed response");
  }
  return { hostId: b.hostId, hostToken: b.hostToken };
}

/**
 * 启动 join 隧道（no-spawn）：转发到外部 `opts.target`，不 spawn dsh、不 process.exit。
 * 获取 pid 锁（opts.role）；返回 `JoinHandle`，`stop()` 干净停止（关 WS/清 heartbeat/释放锁）。
 */
/**
 * 上游失败分类。
 *
 * 旧实现把所有 `up.on("error")` 都报成 `UPSTREAM_UNREACHABLE: dsh not reachable`，
 * 于是"dsh 已接受连接、但在读请求体阶段就断开（常见于 401/413）"被伪装成部署故障，
 * 掩盖真实原因（2026-09-14 实测：上传大文件得到 502 "dsh not reachable"，与事实不符）。
 */
export function classifyUpstreamFailure(
  code: string | undefined,
  responded: boolean,
  message?: string,
): { kind: "error" | "close"; code: string; message: string } {
  const reason = code !== undefined && code !== "" ? code : (message ?? "unknown");
  if (responded) {
    // 客户端已拿到状态头/部分 body：此时只能发 CLOSE 表示"响应体被截断"
    return { kind: "close", code: "UPSTREAM_ABORTED", message: `upstream aborted mid-response (${reason})` };
  }
  const unreachable =
    code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH";
  if (unreachable) {
    return { kind: "error", code: "UPSTREAM_UNREACHABLE", message: `dsh not reachable (${reason})` };
  }
  return { kind: "error", code: "UPSTREAM_ABORTED", message: `upstream closed before responding (${reason})` };
}

/** JS 响应判定（content-type 含 javascript）。 */
export function isJsContentType(headers: IncomingHttpHeaders): boolean {
  const ct = headers["content-type"];
  const s = Array.isArray(ct) ? ct.join(";") : (ct ?? "");
  return /javascript/i.test(s);
}

/**
 * 最小 patch：把 DSH 客户端 bundle 里的前端 isLoopback 判定替换为 true
 * （持久设置/API key 输入只对 loopback 开放；E2EE 流上信任基础等同 loopback）。
 * fail-open：未命中目标串 → 返回 null，调用方原样透传（DSH 升级不炸）。
 */
export function patchLoopbackJs(body: Buffer): Buffer | null {
  const src = body.toString("utf8");
  const target = "isLoopbackHostname(pageLocation.hostname)";
  if (!src.includes(target)) return null;
  return Buffer.from(src.split(target).join("true"), "utf8");
}

/** gate challenge 错误态（语言中立 key，gateChallengeHtml 内本地化）。 */
type GateError = "wrong" | "locked" | null;

/** 从转发头里取 Accept-Language（数组取首个，缺失 undefined）。 */
function headerAcceptLanguage(headers: Record<string, string | string[]>): string | undefined {
  const al = headers["accept-language"];
  return Array.isArray(al) ? al.join(",") : typeof al === "string" ? al : undefined;
}

/** HTML 转义（challenge 页内插 hostName/actionPath 防注入；actionPath 经 hub URL 解析已 percent-encoded，此处为纵深防御）。 */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 访问口令 challenge 页（内联，零外部依赖；经隧道在 hub 域名下展示；Accept-Language 含 zh → 中文，否则英文兜底）。 */
function gateChallengeHtml(hostName: string, actionPath: string, error: GateError, acceptLanguage?: string): string {
  const safeHost = escapeHtml(hostName);
  const safePath = escapeHtml(actionPath);
  const zh = typeof acceptLanguage === "string" && /zh/i.test(acceptLanguage);
  const t = zh
    ? { title: "访问密码", heading: `主机「${safeHost}」受访问密码保护`, note: "此密码由主机所有者设置，hub 无法绕过。", placeholder: "请输入访问密码", submit: "进入", wrong: "访问密码错误", locked: "尝试次数过多，请稍后再试" }
    : { title: "Access code", heading: `Host "${safeHost}" is protected by an access code`, note: "This code is set by the host owner; the hub cannot bypass it.", placeholder: "Enter access code", submit: "Enter", wrong: "Incorrect access code", locked: "Too many attempts — please try again later" };
  const errHtml = error === null ? "" : `<p style="color:#dc2626;font-size:13px;margin:10px 0 0">${error === "wrong" ? t.wrong : t.locked}</p>`;
  return (
    `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${t.title}</title>` +
    `<body style="font-family:system-ui,sans-serif;background:#f6f7f9;margin:0">` +
    `<div style="max-width:360px;margin:64px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
    `<h1 style="font-size:18px;margin:0 0 8px">${t.heading}</h1>` +
    `<p style="font-size:13px;color:#6b7280;margin:0 0 16px">${t.note}</p>` +
    `<form method="POST" action="${safePath}">` +
    `<input name="gate_code" type="password" autocomplete="off" autofocus placeholder="${t.placeholder}" style="width:100%;box-sizing:border-box;height:38px;border:1px solid #d1d5db;border-radius:8px;padding:0 12px;font-size:14px">` +
    `<button type="submit" style="width:100%;margin-top:12px;height:38px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer">${t.submit}</button>` +
    `</form>${errHtml}</div></body></html>`
  );
}

/** http 响应体的分片发送上限：单帧超过隧道 16 MiB 会让 `encodeFrame` 抛 `ProtocolError`，
 *  抛点在响应回调里未捕获 ⇒ 打死 host（gateway）进程（P1，2026-09-14 复审发现）。1 MiB 远低于上限，
 *  且给 E2EE 方向（密文 = 内层帧 + 28 B nonce/tag）也留足余量。 */
const DATA_FRAME_CHUNK = 1 << 20;

/**
 * E2EE 包装的固定开销：内层帧 15 B 头（MAGIC4+ver1+flags1+type1+streamId4+len4）+ AEAD
 * nonce 12 B + GCM tag 16 B = **43 B**。WS 消息判界必须预留它，否则"明文 ≤16 MiB"的 WS 消息
 * 经 E2EE 加密后刚好超出隧道上限，`encodeFrame` 在加密发送器里抛 `ProtocolError` 打死 host
 *（2026-09-14 第三审发现的 28 B 窗口，加上内层帧头实为 43 B）。
 */
export const E2EE_FRAME_OVERHEAD = 15 + 12 + 16;

/** 按 DATA_FRAME_CHUNK 分片发送响应体（多 DATA 帧在 hub/浏览器侧天然拼回同一个 body）。 */
function sendChunkedBody(send: (frame: Buffer) => void, streamId: number, body: Buffer): void {
  if (body.length === 0) return;
  for (let off = 0; off < body.length; off += DATA_FRAME_CHUNK) {
    send(encodeFrame(FRAME_TYPE.DATA, streamId, body.subarray(off, Math.min(off + DATA_FRAME_CHUNK, body.length))));
  }
}

/**
 * WS 消息转发：**一条消息 = 一帧，不能分片**（分片会破坏 host 侧的消息边界）。
 * 超限（>16 MiB − E2EE_FRAME_OVERHEAD）时发 CLOSE(1009) 给客户端并返回 false，由调用方关掉上游
 * —— 绝不让 `encodeFrame` 的 `ProtocolError` 逃逸到 ws 回调打死 host 进程。
 */
function sendWsData(send: (frame: Buffer) => void, streamId: number, buf: Buffer): boolean {
  if (buf.length > MAX_PAYLOAD_LENGTH - E2EE_FRAME_OVERHEAD) {
    send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 1009, message: "upstream ws message too large" })));
    return false;
  }
  send(encodeFrame(FRAME_TYPE.DATA, streamId, buf));
  return true;
}

/** 发送合成的 HTTP 响应帧（gateway 不触达 dsh）。 */
function sendSyntheticHttp(send: (frame: Buffer) => void, streamId: number, status: number, headers: Record<string, string>, body: Buffer): void {
  send(encodeFrame(FRAME_TYPE.OPEN, streamId, jsonPayload({ kind: "http", status, reason: undefined, headers })));
  sendChunkedBody(send, streamId, body);
  send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
}

export function startJoin(opts: StartJoinOptions): JoinHandle {
  const hubWsBase = opts.hubUrl.replace(/^https/, "wss").replace(/^http/, "ws");
  const hooks = opts.hooks ?? {};
  // 宿主代持的 dsh 会话 cookie（0.1.2+）；null = 无认证（0.1.1）或换发失败
  const dshAuthCookie = opts.dshAuthCookieHeader ?? null;
  // DSH UI 兼容开关：缺省 true（跟随 E2EE）；可变引用 → 运行中可切换（插件面板即时生效）
  const uiCompat = { trustE2EEAsLoopback: opts.dshUiCompat?.trustE2EEAsLoopback !== false };
  // 访问口令（feature 15）：可变引用 → setAccessCode 运行中切换；null = gate off
  const gate = { accessCode: opts.gateway?.accessCode ?? null };
  const hostName = opts.name ?? "本主机";
  const gateFailures = { count: 0, lockedUntil: 0 };
  const log = (level: "info" | "warn" | "error", message: string): void => {
    hooks.onLog?.(level, message);
  };
  const setState = (state: JoinState, detail?: { message?: string; delayMs?: number }): void => {
    hooks.onState?.(state, detail);
  };

  const lock = acquireJoinLock(opts.role, opts.lockPath);
  if (!lock.ok) {
    // 「同机单隧道」铁律：任何活锁都拒绝（含本进程自己的 pid —— 那是热重载时的同进程重复获取）
    throw new Error(
      "contended" in lock
        ? "join lock is contended by another instance; retry"
        : lock.heldBy.pid === process.pid
          ? "another tunnel is already running in this process"
          : `join lock held by ${lock.heldBy.role} (pid ${lock.heldBy.pid}); stop it first`,
    );
  }

  /**
   * 构造期同步抛错必须把锁还回去（否则本进程再也起不来隧道，还谎报「本进程已有隧道」）。
   * 现实抛点：E2EE 密钥生成/序列化（`loadOrCreateE2eeKeyPair`）与 `connect()` 里的
   * `new WebSocket(非法 URL)`、以及 embedder 的 onState 钩子。
   */
  const releaseLockAndRethrow = (err: unknown): never => {
    releaseJoinLock(opts.lockPath);
    throw err;
  };

  const parser = new FrameParser();

  let shuttingDown = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  let heartbeat: NodeJS.Timeout | undefined;
  /** 发出 PING 后的存活死线：期间收到**任何**入站帧即撤销（PROTOCOL.md 心跳与重连）。 */
  let livenessDeadline: NodeJS.Timeout | undefined;
  let currentClient: WebSocket | undefined;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
  /** 日志用人类可读单位：生产 30000ms → "30s"；测试注入的毫秒值原样显示。 */
  const heartbeatLabel = heartbeatMs % 1000 === 0 ? `${heartbeatMs / 1000}s` : `${heartbeatMs}ms`;

  /** 发送一个隧道帧（走当前隧道 WS；flags 由调用方在 encodeFrame 时给定）。 */
  function sendTunnelFrame(frame: Buffer): void {
    if (currentClient !== undefined && currentClient.readyState === currentClient.OPEN) {
      currentClient.send(frame);
    }
  }

  /** 内层帧分发器（plain 与 raw 共用）：OPEN http/ws + DATA → DSH 转发，响应帧经 `send` 回传。 */
  function makeInnerDispatcher(send: (frame: Buffer) => void, dio?: { jsPatch?: () => boolean; gate?: boolean }) {
    const httpStreams = new Map<number, { up: ReturnType<typeof httpRequest> }>();
    const wsStreams = new Map<number, { upstream: WebSocket; queue: Buffer[] }>();
    // gate 未过、等待 code 提交的 http 流（OPEN 后缓冲 DATA，CLOSE 时校验）
    const gatedHttp = new Map<number, { method: string; path: string; body: Buffer[]; size: number; acceptLanguage?: string }>();
    /** 已报告过"loopback 补丁未命中"的路径（每个路径只报一次，避免日志刷屏）。 */
    const patchMissReported = new Set<string>();

    /** 从转发头里取 rdsh_gate cookie（hub D12 白名单透传）。 */
    function gateCookie(headers: Record<string, string | string[]>): string | null {
      const ck = headers["cookie"];
      const s = Array.isArray(ck) ? ck.join(";") : typeof ck === "string" ? ck : "";
      for (const part of s.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) continue;
        if (part.slice(0, idx).trim() === GATE_COOKIE) return part.slice(idx + 1).trim();
      }
      return null;
    }

    /** gate 开启时的失败计数：全局封顶，达限短时锁定（隧道流量无真实客户端 IP）。 */
    function gateBlocked(): boolean {
      if (gateFailures.lockedUntil > Date.now()) return true;
      if (gateFailures.lockedUntil !== 0) gateFailures.lockedUntil = 0;
      return false;
    }

    /** 发送 challenge 页（或带错误）响应。 */
    function sendChallenge(streamId: number, path: string, error: GateError, acceptLanguage?: string): void {
      const html = gateChallengeHtml(hostName, path, error, acceptLanguage);
      sendSyntheticHttp(send, streamId, 200, { "content-type": "text/html; charset=utf-8" }, Buffer.from(html));
    }

    /** 校验 code 提交（POST gate_code）→ 302 回跳 + 发 cookie，或回 challenge 错误。 */
    function handleGateSubmit(streamId: number, state: { method: string; path: string; body: Buffer[]; acceptLanguage?: string }): void {
      const code = gate.accessCode;
      if (code === null) {
        sendSyntheticHttp(send, streamId, 302, { location: state.path }, Buffer.alloc(0));
        return;
      }
      if (gateBlocked()) {
        sendChallenge(streamId, state.path, "locked", state.acceptLanguage);
        return;
      }
      const raw = Buffer.concat(state.body).toString("utf8");
      let input: string | null = null;
      try {
        const params = new URLSearchParams(raw);
        input = params.get("gate_code");
      } catch {
        input = null;
      }
      if (input !== null && verifyGateCode(input, code)) {
        gateFailures.count = 0;
        const { value } = signGateCookie(code);
        sendSyntheticHttp(send, streamId, 302, { location: state.path, "set-cookie": `${GATE_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}` }, Buffer.alloc(0));
      } else {
        gateFailures.count += 1;
        if (gateFailures.count >= 10) gateFailures.lockedUntil = Date.now() + 60_000;
        sendChallenge(streamId, state.path, "wrong", state.acceptLanguage);
      }
    }

    function closeStream(streamId: number): void {
      const ws = wsStreams.get(streamId);
      if (ws !== undefined) {
        wsStreams.delete(streamId);
        try {
          ws.upstream.terminate();
        } catch {
          /* 已关闭 */
        }
        return;
      }
      const http = httpStreams.get(streamId);
      if (http !== undefined) {
        httpStreams.delete(streamId);
        http.up.end();
      }
    }

    function openWsStream(streamId: number, path: string, headers: Record<string, string | string[]>): void {
      const upstream = new WebSocket(`ws://${opts.target.host}:${opts.target.port}${path}`, {
        headers: rewriteHeadersForDsh(headers, opts.target, dshAuthCookie),
      });
      const queue: Buffer[] = [];
      wsStreams.set(streamId, { upstream, queue });

      upstream.on("open", () => {
        for (const q of queue) upstream.send(q, { binary: false });
        queue.length = 0;
      });
      upstream.on("message", (data) => {
        const buf = Array.isArray(data)
          ? Buffer.concat(data as Buffer[])
          : Buffer.isBuffer(data)
            ? (data as Buffer)
            : Buffer.from(data as ArrayBuffer);
        if (!sendWsData(send, streamId, buf)) {
          // 超限：已发 CLOSE(1009) 给客户端，这里关掉上游 dsh 连接，绝不让异常逃逸
          console.error(`[join] upstream ws message too large (${buf.length}B), closing stream ${streamId}`);
          try {
            upstream.close(1009, "message too big");
          } catch {
            /* 已关闭 */
          }
        }
      });
      const cleanup = (): void => {
        wsStreams.delete(streamId);
        send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
      };
      upstream.on("close", cleanup);
      upstream.on("error", cleanup);
    }

    function handleOpen(frame: Frame): void {
      let kind: string | undefined;
      let method = "GET";
      let path = "/";
      let headers: Record<string, string | string[]> = {};
      try {
        const p = parseJsonPayload(frame);
        kind = p.kind as string;
        if (typeof p.method === "string") method = p.method;
        if (typeof p.path === "string") path = p.path;
        if (typeof p.headers === "object" && p.headers !== null) headers = p.headers as Record<string, string | string[]>;
      } catch {
        send(encodeFrame(FRAME_TYPE.ERROR, frame.streamId, jsonPayload({ code: "BAD_OPEN", message: "malformed open" })));
        return;
      }

      // ---- 访问口令 gate（仅 plain dispatcher：dio.gate=true 且已设 accessCode）----
      if (dio?.gate === true && gate.accessCode !== null) {
        const code = gate.accessCode;
        const authed = verifyGateCookie(code, gateCookie(headers) ?? "");
        if (kind === "ws") {
          if (!authed) {
            send(encodeFrame(FRAME_TYPE.CLOSE, frame.streamId, jsonPayload({ code: 403, message: "access code required" })));
            return;
          }
          openWsStream(frame.streamId, path, headers);
          return;
        }
        if (!authed) {
          if (method === "POST") {
            // 可能是 code 提交：缓冲 body，CLOSE 时校验（见 handleFrame）
            gatedHttp.set(frame.streamId, { method, path, body: [], size: 0, acceptLanguage: headerAcceptLanguage(headers) });
            return;
          }
          sendChallenge(frame.streamId, path, null, headerAcceptLanguage(headers));
          return;
        }
      }

      if (kind === "ws") {
        openWsStream(frame.streamId, path, headers);
        return;
      }
      if (kind !== "http") {
        send(encodeFrame(FRAME_TYPE.ERROR, frame.streamId, jsonPayload({ code: "BAD_OPEN", message: "unknown kind" })));
        return;
      }

      const streamId = frame.streamId;
      /** 响应头是否已发给客户端（决定失败时能回 ERROR 还是只能用 CLOSE 表示截断）。 */
      let responded = false;
      const up = httpRequest(
        {
          host: opts.target.host,
          port: opts.target.port,
          path,
          method,
          headers: rewriteHeadersForDsh(headers, opts.target, dshAuthCookie),
        },
        (upRes) => {
          responded = true;
          const status = upRes.statusCode ?? 502;
          const baseHeaders = normalizeRespHeaders(upRes.headers);
          const wantsPatch = dio?.jsPatch?.() === true && isJsContentType(upRes.headers);

          // 非 JS / 未开补丁：保持原流式路径（OPEN 立即发，body 边到边发）
          if (!wantsPatch) {
            send(
              encodeFrame(
                FRAME_TYPE.OPEN,
                streamId,
                jsonPayload({ kind: "http", status, reason: upRes.statusMessage, headers: baseHeaders }),
              ),
            );
            upRes.on("data", (chunk: Buffer) => {
              sendChunkedBody(send, streamId, chunk);
            });
            upRes.on("end", () => {
              send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
              httpStreams.delete(streamId);
            });
            upRes.on("error", () => {
              send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 502, message: "upstream error" })));
              httpStreams.delete(streamId);
            });
            return;
          }

          // JS + 补丁：**必须先缓冲/处理再发 OPEN** —— patch 与"按原编码重压"都会改变 body 长度，
          // 而 OPEN 帧里的 content-length 必须与实际字节一致（否则浏览器截断或一直等）。
          // dsh 会按 accept-encoding 压缩 JS（gzip 等），所以这里必须先解码再补丁、再按原编码重压。
          const chunks: Buffer[] = [];
          upRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          upRes.on("end", () => {
            const raw = Buffer.concat(chunks);
            const encoding = firstEncoding(upRes.headers["content-encoding"]);
            const decoded = decodeBody(raw, encoding);
            let body: Buffer = raw;
            let outHeaders = baseHeaders;
            let hit = false;
            if (decoded !== null) {
              const patched = patchLoopbackJs(decoded);
              const recoded = patched === null ? null : encodeBody(patched, encoding);
              if (recoded !== null) {
                body = recoded;
                hit = true;
                outHeaders = { ...baseHeaders, "content-length": String(body.length) };
                delete outHeaders["transfer-encoding"];
                // 不能沿用上游的 `immutable` / 长 max-age：补丁改了 body 但 URL(rev) 由上游内容决定，
                // 浏览器会把"旧的未补丁 bundle"缓存很久 ⇒ 修复无法生效（2026-09-14 实测踩到）。
                outHeaders["cache-control"] = "public, max-age=300";
              }
            }
            // 未命中必须留痕（每个路径一次）：fail-open 是刻意设计，但"补丁从未生效"不能静默
            //（2026-09-14 gzip 事故正是因为没有这条日志而排查了很久）
            if (!hit) {
              const key = (path.split("?")[0] ?? path).slice(0, 120);
              if (!patchMissReported.has(key)) {
                patchMissReported.add(key);
                console.log(`[patch] miss: ${key} (${raw.length}B, content-encoding=${encoding === "" ? "identity" : encoding})`);
              }
            } else if (process.env.RDSH_DEBUG_PATCH === "1") {
              console.log(`[patch] hit: ${path.slice(0, 120)} (${raw.length}B → ${body.length}B, ${encoding === "" ? "identity" : encoding})`);
            }
            send(
              encodeFrame(
                FRAME_TYPE.OPEN,
                streamId,
                jsonPayload({ kind: "http", status, reason: upRes.statusMessage, headers: outHeaders }),
              ),
            );
            sendChunkedBody(send, streamId, body);
            send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
            httpStreams.delete(streamId);
          });
          upRes.on("error", () => {
            send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 502, message: "upstream error" })));
            httpStreams.delete(streamId);
          });
        },
      );
      up.on("error", (err: NodeJS.ErrnoException) => {
        const outcome = classifyUpstreamFailure(err.code, responded, err.message);
        const type = outcome.kind === "close" ? FRAME_TYPE.CLOSE : FRAME_TYPE.ERROR;
        send(encodeFrame(type, streamId, jsonPayload({ code: outcome.code, message: outcome.message })));
        httpStreams.delete(streamId);
      });
      httpStreams.set(streamId, { up });
    }

    function handleFrame(frame: Frame): void {
      switch (frame.type) {
        case FRAME_TYPE.OPEN: {
          handleOpen(frame);
          return;
        }
        case FRAME_TYPE.DATA: {
          const gated = gatedHttp.get(frame.streamId);
          if (gated !== undefined) {
            gated.body.push(frame.payload);
            gated.size += frame.payload.length;
            if (gated.size > 64 * 1024) {
              gatedHttp.delete(frame.streamId);
              send(encodeFrame(FRAME_TYPE.CLOSE, frame.streamId, jsonPayload({ code: 413, message: "body too large" })));
            }
            return;
          }
          const ws = wsStreams.get(frame.streamId);
          if (ws !== undefined) {
            if (ws.upstream.readyState === ws.upstream.OPEN) ws.upstream.send(frame.payload, { binary: false }); // DSH WS 为 text(JSON)
            else ws.queue.push(frame.payload);
            return;
          }
          const http = httpStreams.get(frame.streamId);
          if (http !== undefined) http.up.write(frame.payload);
          return;
        }
        case FRAME_TYPE.CLOSE:
        case FRAME_TYPE.ERROR: {
          const gated = gatedHttp.get(frame.streamId);
          if (gated !== undefined) {
            gatedHttp.delete(frame.streamId);
            if (frame.type === FRAME_TYPE.CLOSE) handleGateSubmit(frame.streamId, gated);
            return;
          }
          closeStream(frame.streamId);
          return;
        }
        default:
          return;
      }
    }

    function cleanup(): void {
      for (const s of httpStreams.values()) {
        try {
          s.up.destroy();
        } catch {
          /* 已断 */
        }
      }
      httpStreams.clear();
      for (const s of wsStreams.values()) {
        try {
          s.upstream.terminate();
        } catch {
          /* 已断 */
        }
      }
      wsStreams.clear();
      gatedHttp.clear();
    }

    return { handleFrame, cleanup };
  }

  const plainDispatcher = makeInnerDispatcher(sendTunnelFrame, { jsPatch: () => uiCompat.trustE2EEAsLoopback, gate: true });

  // host 端 E2EE 静态密钥对（持久化 ~/.rdsh/e2ee-key.json；join 注册时上送指纹）
  let hostE2eeKeypair: KeyPair;
  try {
    hostE2eeKeypair = loadOrCreateE2eeKeyPair();
  } catch (err) {
    releaseLockAndRethrow(err);
  }

  /** E2EE raw 流状态（Noise 响应方 + 内层分发）。 */
  interface RawStreamState {
    handshakeBuf: Buffer;
    keys: E2eeKeys | null;
    decryptor: Aead | null;
    encryptor: Aead | null;
    innerParser: FrameParser;
    inner: ReturnType<typeof makeInnerDispatcher>;
  }
  const rawStreams = new Map<number, RawStreamState>();

  function startRawStream(streamId: number): void {
    const inner = makeInnerDispatcher(
      (frame) => {
        const raw = rawStreams.get(streamId);
        if (raw?.encryptor === null || raw?.encryptor === undefined) return;
        try {
          const ct = raw.encryptor.encrypt(frame, Buffer.alloc(0));
          if (ct.length > MAX_PAYLOAD_LENGTH) {
            // 结构兜底：内层帧经 E2EE 包装（+43 B）后超限。绝不能让 encodeFrame 的 ProtocolError
            // 逃逸；给该内层流回一个 ERROR（小帧，加密后必然放得下），消费方据此干净报错。
            const innerId = frame.length >= 11 ? frame.readUInt32BE(7) : 0;
            const errCt = raw.encryptor.encrypt(
              encodeFrame(FRAME_TYPE.ERROR, innerId, jsonPayload({ code: "FRAME_TOO_LARGE", message: "e2ee frame too large" })),
              Buffer.alloc(0),
            );
            console.error(`[join] e2ee frame too large (${ct.length}B) for inner stream ${innerId}`);
            sendTunnelFrame(encodeFrame(FRAME_TYPE.DATA, streamId, errCt, FLAG_E2E));
            return;
          }
          sendTunnelFrame(encodeFrame(FRAME_TYPE.DATA, streamId, ct, FLAG_E2E));
        } catch (err) {
          // 最后一道：任何加密/封帧异常只记录，绝不重抛打死 host
          console.error(`[join] e2ee send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      { jsPatch: () => uiCompat.trustE2EEAsLoopback },
    );
    rawStreams.set(streamId, {
      handshakeBuf: Buffer.alloc(0),
      keys: null,
      decryptor: null,
      encryptor: null,
      innerParser: new FrameParser(),
      inner,
    });
  }

  function handleRawData(streamId: number, state: RawStreamState, chunk: Buffer): void {
    try {
      if (state.keys === null) {
        // Noise 握手：缓冲到 32B（发起方临时公钥）→ 派生密钥
        state.handshakeBuf = Buffer.concat([state.handshakeBuf, chunk]);
        if (state.handshakeBuf.length < 32) return;
        const ephPub = state.handshakeBuf.subarray(0, 32);
        state.handshakeBuf = state.handshakeBuf.subarray(32);
        state.keys = responderHandshake(hostE2eeKeypair, ephPub);
        state.decryptor = new Aead(state.keys.initiatorToResponder);
        state.encryptor = new Aead(state.keys.responderToInitiator);
        if (state.handshakeBuf.length === 0) return;
        chunk = state.handshakeBuf; // 剩余 = 首个密文分片
        state.handshakeBuf = Buffer.alloc(0);
      }
      const dec = state.decryptor!.decrypt(chunk, Buffer.alloc(0));
      for (const f of state.innerParser.push(dec)) state.inner.handleFrame(f);
    } catch {
      // 解密失败（篡改/错序）→ 结束该 raw 流
      rawStreams.delete(streamId);
      sendTunnelFrame(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 1, message: "e2ee decrypt failed" })));
    }
  }

  /** 隧道级帧分发：PING/PONG + OPEN（http/ws/raw）+ DATA/CLOSE/ERROR（plain 或 raw 路由）。 */
  function handleFrame(frame: Frame): void {
    switch (frame.type) {
      case FRAME_TYPE.PING: {
        sendTunnelFrame(encodeFrame(FRAME_TYPE.PONG, frame.streamId, frame.payload));
        return;
      }
      case FRAME_TYPE.PONG:
        return;
      case FRAME_TYPE.OPEN: {
        let kind: string | undefined;
        try {
          const p = parseJsonPayload(frame);
          kind = typeof p.kind === "string" ? p.kind : undefined;
        } catch {
          /* 交给 plain dispatcher 报 BAD_OPEN */
        }
        if (kind === "raw") {
          startRawStream(frame.streamId);
          return;
        }
        plainDispatcher.handleFrame(frame);
        return;
      }
      case FRAME_TYPE.DATA: {
        const raw = rawStreams.get(frame.streamId);
        if (raw !== undefined) {
          handleRawData(frame.streamId, raw, frame.payload);
          return;
        }
        plainDispatcher.handleFrame(frame);
        return;
      }
      case FRAME_TYPE.CLOSE:
      case FRAME_TYPE.ERROR: {
        if (rawStreams.has(frame.streamId)) {
          rawStreams.delete(frame.streamId);
          return;
        }
        plainDispatcher.handleFrame(frame);
        return;
      }
      default:
        return;
    }
  }

  /** 清空本地 http/ws/raw 流 + heartbeat（断线/停止时）。 */
  function cleanupStreams(): void {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (livenessDeadline !== undefined) {
      clearTimeout(livenessDeadline);
      livenessDeadline = undefined;
    }
    plainDispatcher.cleanup();
    for (const raw of rawStreams.values()) raw.inner.cleanup();
    rawStreams.clear();
  }

  function connect(): void {
    if (shuttingDown) return;
    // 认证走 Authorization 头（不入 URL，避免 token 进日志）
    const url = `${hubWsBase}/tunnel`;
    const client = new WebSocket(url, { headers: { authorization: `Bearer ${opts.token}` }, rejectUnauthorized: !opts.insecure });
    currentClient = client;

    // 401/403 = token 被拒（吊销/不存在）。监听此事件后 ws 不再自动 abort，
    // 需手动 terminate → 触发 close → 决定「重配对」还是「普通重连」。
    let tokenRejected = false;
    client.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) tokenRejected = true;
      try {
        client.terminate();
      } catch {
        /* 已关闭 */
      }
    });

    client.on("open", () => {
      reconnectDelay = RECONNECT_BASE_MS;
      setState("connected");
      log("info", `tunnel established (heartbeat ${heartbeatLabel})`);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (client.readyState === client.OPEN) {
          client.send(encodeFrame(FRAME_TYPE.PING, 0, jsonPayload({ ts: Date.now() })));
          // 发出 PING 后武装死线：pongTimeoutMs 内收到任何入站帧即撤销（下方 message 处理）。
          // 只在**没有未决死线**时武装——上一发 PING 未获回应时原死线继续计时，不重置。
          if (livenessDeadline === undefined) {
            livenessDeadline = setTimeout(() => {
              livenessDeadline = undefined;
              log("info", `heartbeat timeout — no frame from hub within ${pongTimeoutMs}ms; reconnecting`);
              try {
                client.terminate();
              } catch {
                /* 已关闭 */
              }
            }, pongTimeoutMs);
            livenessDeadline.unref?.();
          }
        }
      }, heartbeatMs);
    });

    client.on("message", (data, isBinary) => {
      if (!isBinary) return;
      // 任何入站帧都是存活证据 → 撤销死线（不限于 PONG）
      if (livenessDeadline !== undefined) {
        clearTimeout(livenessDeadline);
        livenessDeadline = undefined;
      }
      const chunk = Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : Buffer.isBuffer(data)
          ? (data as Buffer)
          : Buffer.from(data as ArrayBuffer);
      let frames: Frame[];
      try {
        frames = parser.push(chunk);
      } catch {
        client.terminate();
        return;
      }
      for (const frame of frames) handleFrame(frame);
    });

    client.on("close", () => {
      cleanupStreams();
      if (shuttingDown) return;
      if (tokenRejected) {
        // token 被拒（吊销/删除）= 永久失败，无法自动恢复
        // → 删旧 session + 释放锁 + 停（fail-fast），不重连。
        clearPersistedToken(opts.hubUrl);
        const msg = "host token rejected by hub (revoked or removed); re-join with a new join token";
        log("error", msg);
        setState("rejected", { message: msg });
        shuttingDown = true;
        releaseJoinLock(opts.lockPath);
        return;
      }
      setState("reconnecting", { delayMs: reconnectDelay });
      log("info", `tunnel lost — reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
      setTimeout(connect, reconnectDelay + Math.random() * 500);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });
    client.on("error", () => {
      try {
        client.terminate();
      } catch {
        /* 已关闭 */
      }
    });

    // 状态回调放在所有监听器挂好**之后**：embedder 的 onState 若抛错，异常会向上抛并被
    // releaseLockAndRethrow 处理；此时 socket 已有 error 监听，不会因后续连接失败变成未捕获 error 崩进程。
    setState("connecting", { message: `connecting to ${opts.hubUrl}` });
  }

  try {
    connect();
  } catch (err) {
    releaseLockAndRethrow(err);
  }

  return {
    setUiCompat(trustE2EEAsLoopback: boolean): void {
      uiCompat.trustE2EEAsLoopback = trustE2EEAsLoopback;
      console.log(`rdsh join: dshUiCompat.trustE2EEAsLoopback = ${trustE2EEAsLoopback}（运行中生效）`);
    },
    setAccessCode(code: string | null): void {
      gate.accessCode = code;
      gateFailures.count = 0;
      gateFailures.lockedUntil = 0;
      console.log(`rdsh join: accessCode = ${code === null ? "(off)" : "***"}（运行中生效）`);
    },
    async stop(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      cleanupStreams();
      if (currentClient !== undefined) {
        try {
          currentClient.terminate();
        } catch {
          /* 已关闭 */
        }
      }
      releaseJoinLock(opts.lockPath);
      setState("stopped");
    },
  };
}

/** `rdsh host serve`（join 模式）的 CLI 封装：spawn dsh + 信号退出 + startJoin(role:cli)。 */
export async function join(opts: JoinOptions): Promise<void> {
  const foundDsh = findDsh(opts.dshPath);
  if (foundDsh === null) {
    throw new Error("cannot find 'dsh' in PATH. Install DeepSeek Harness first, or pass --dsh <path>.");
  }

  // 版本窗口外 → warn（不硬拒）
  const dshVersion = await detectDshVersion(foundDsh);
  const versionWarn = dshVersionWarning(dshVersion);
  if (versionWarn !== null) console.warn(`\n⚠  ${versionWarn}\n`);

  const dsh = await spawnDsh(foundDsh);
  const target: ProxyTarget = { host: "127.0.0.1", port: dsh.port };

  // 0.1.2+：换发浏览器会话 cookie 并代持注入隧道→本地转发
  let dshAuthCookieHeader: string | null = null;
  if (dsh.authToken !== undefined) {
    dshAuthCookieHeader = await exchangeDshSessionCookie(dsh.port, dsh.authToken);
    if (dshAuthCookieHeader === null) {
      console.warn("rdsh join: dsh 0.1.2+ 会话 cookie 换发失败——远程访问将返回 401。");
    }
  }

  // 解析 host token（含证书自动检测 + 持久化）；进程重启后复用，避免重复配对。
  const { token, insecure, name } = await registerJoin(opts);

  console.log(`rdsh join: dsh web on 127.0.0.1:${dsh.port}`);
  console.log(`rdsh join: connecting to ${opts.hubUrl}...`);

  const handle = startJoin({
    hubUrl: opts.hubUrl,
    token,
    insecure,
    target,
    role: "cli",
    dshUiCompat: opts.dshUiCompat,
    gateway: opts.gateway,
    dshAuthCookieHeader,
    name,
    hooks: {
      onLog: (level, message) => {
        (level === "error" ? console.error : console.log)(`rdsh join: ${message}`);
      },
      onState: (state, detail) => {
        if (state === "rejected") {
          console.error(`rdsh join: ${detail?.message ?? "rejected"}`);
        }
      },
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal !== "") console.log(`\nrdsh: received ${signal}, shutting down...`);
    await handle.stop();
    await dsh.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  // 常驻：进程靠信号退出（shutdown 里 process.exit）；防止函数返回后
  // CLI 的 main().then(exit) 误退出服务进程
  await new Promise<void>(() => {});
}

function normalizeRespHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    // hop-by-hop 头由各自连接管理，不透传
    if (k === "transfer-encoding" || k === "connection" || k === "keep-alive" || k === "upgrade") continue;
    out[k] = Array.isArray(v) ? v : String(v);
  }
  return out;
}
