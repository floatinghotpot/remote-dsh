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
import { FrameParser, FRAME_TYPE, encodeFrame, jsonPayload, parseJsonPayload, FLAG_E2E } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { findDsh, spawnDsh } from "./spawn-dsh.ts";
import { rewriteHeadersForDsh } from "./proxy.ts";
import type { ProxyTarget } from "./proxy.ts";
import { clearPersistedToken, persistToken, readPersistedToken } from "./token-store.ts";
import { acquireJoinLock, releaseJoinLock } from "./lock.ts";
import type { JoinLockRole } from "./lock.ts";
import { responderHandshake, Aead } from "./e2ee.ts";
import type { KeyPair, E2eeKeys } from "./e2ee.ts";
import { loadOrCreateE2eeKeyPair } from "./e2ee-key-store.ts";

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
}

/** 可停止的 join 隧道句柄。 */
export interface JoinHandle {
  stop(): Promise<void>;
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
export function startJoin(opts: StartJoinOptions): JoinHandle {
  const hubWsBase = opts.hubUrl.replace(/^https/, "wss").replace(/^http/, "ws");
  const hooks = opts.hooks ?? {};
  const log = (level: "info" | "warn" | "error", message: string): void => {
    hooks.onLog?.(level, message);
  };
  const setState = (state: JoinState, detail?: { message?: string; delayMs?: number }): void => {
    hooks.onState?.(state, detail);
  };

  const lock = acquireJoinLock(opts.role, opts.lockPath);
  if (!lock.ok) {
    throw new Error(`join lock held by ${lock.heldBy.role} (pid ${lock.heldBy.pid}); stop it first`);
  }

  const parser = new FrameParser();

  let shuttingDown = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  let heartbeat: NodeJS.Timeout | undefined;
  let currentClient: WebSocket | undefined;

  /** 发送一个隧道帧（走当前隧道 WS；flags 由调用方在 encodeFrame 时给定）。 */
  function sendTunnelFrame(frame: Buffer): void {
    if (currentClient !== undefined && currentClient.readyState === currentClient.OPEN) {
      currentClient.send(frame);
    }
  }

  /** 内层帧分发器（plain 与 raw 共用）：OPEN http/ws + DATA → DSH 转发，响应帧经 `send` 回传。 */
  function makeInnerDispatcher(send: (frame: Buffer) => void) {
    const httpStreams = new Map<number, { up: ReturnType<typeof httpRequest> }>();
    const wsStreams = new Map<number, { upstream: WebSocket; queue: Buffer[] }>();

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
        headers: rewriteHeadersForDsh(headers, opts.target),
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
        send(encodeFrame(FRAME_TYPE.DATA, streamId, buf));
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

      if (kind === "ws") {
        openWsStream(frame.streamId, path, headers);
        return;
      }
      if (kind !== "http") {
        send(encodeFrame(FRAME_TYPE.ERROR, frame.streamId, jsonPayload({ code: "BAD_OPEN", message: "unknown kind" })));
        return;
      }

      const streamId = frame.streamId;
      const up = httpRequest(
        {
          host: opts.target.host,
          port: opts.target.port,
          path,
          method,
          headers: rewriteHeadersForDsh(headers, opts.target),
        },
        (upRes) => {
          send(
            encodeFrame(
              FRAME_TYPE.OPEN,
              streamId,
              jsonPayload({
                kind: "http",
                status: upRes.statusCode ?? 502,
                reason: upRes.statusMessage,
                headers: normalizeRespHeaders(upRes.headers),
              }),
            ),
          );
          upRes.on("data", (chunk: Buffer) => {
            send(encodeFrame(FRAME_TYPE.DATA, streamId, chunk));
          });
          upRes.on("end", () => {
            send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
            httpStreams.delete(streamId);
          });
          upRes.on("error", () => {
            send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 502, message: "upstream error" })));
            httpStreams.delete(streamId);
          });
        },
      );
      up.on("error", () => {
        send(encodeFrame(FRAME_TYPE.ERROR, streamId, jsonPayload({ code: "UPSTREAM_UNREACHABLE", message: "dsh not reachable" })));
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
    }

    return { handleFrame, cleanup };
  }

  const plainDispatcher = makeInnerDispatcher(sendTunnelFrame);

  // host 端 E2EE 静态密钥对（持久化 ~/.rdsh/e2ee-key.json；join 注册时上送指纹）
  const hostE2eeKeypair: KeyPair = loadOrCreateE2eeKeyPair();

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
    const inner = makeInnerDispatcher((frame) => {
      const raw = rawStreams.get(streamId);
      if (raw?.encryptor !== null && raw?.encryptor !== undefined) {
        const ct = raw.encryptor.encrypt(frame, Buffer.alloc(0));
        sendTunnelFrame(encodeFrame(FRAME_TYPE.DATA, streamId, ct, FLAG_E2E));
      }
    });
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
    plainDispatcher.cleanup();
    for (const raw of rawStreams.values()) raw.inner.cleanup();
    rawStreams.clear();
  }

  function connect(): void {
    if (shuttingDown) return;
    const url = `${hubWsBase}/tunnel?token=${encodeURIComponent(opts.token)}`;
    const client = new WebSocket(url, { rejectUnauthorized: !opts.insecure });
    currentClient = client;
    setState("connecting", { message: `connecting to ${opts.hubUrl}` });

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
      log("info", "tunnel established (heartbeat 30s)");
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (client.readyState === client.OPEN) {
          client.send(encodeFrame(FRAME_TYPE.PING, 0, jsonPayload({ ts: Date.now() })));
        }
      }, HEARTBEAT_MS);
    });

    client.on("message", (data, isBinary) => {
      if (!isBinary) return;
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
  }

  connect();

  return {
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
  const dsh = await spawnDsh(foundDsh);
  const target: ProxyTarget = { host: "127.0.0.1", port: dsh.port };
  // 解析 host token（含证书自动检测 + 持久化）；进程重启后复用，避免重复配对。
  const { token, insecure } = await registerJoin(opts);

  console.log(`rdsh join: dsh web on 127.0.0.1:${dsh.port}`);
  console.log(`rdsh join: connecting to ${opts.hubUrl}...`);

  const handle = startJoin({
    hubUrl: opts.hubUrl,
    token,
    insecure,
    target,
    role: "cli",
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
