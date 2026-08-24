/**
 * join.ts — `rdsh join <hub-url>`：出站隧道客户端（公网模式，M3）。
 *
 * 流程：spawn dsh（复用）→ 注册（join token → host token）→ WSS 隧道（?token=）
 * → 帧循环（OPEN http/ws → 本地 dsh 转发 → 响应帧回传）→ 断线指数退避重连。
 *
 * 安全：只出站（不监听任何入站端口）；hub 认证在层 1，gateway 侧只认隧道内来源。
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import { FrameParser, FRAME_TYPE, encodeFrame, jsonPayload, parseJsonPayload } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { findDsh, spawnDsh } from "./spawn-dsh.ts";
import { rewriteHeadersForDsh } from "./proxy.ts";
import type { ProxyTarget } from "./proxy.ts";
import { clearPersistedToken, persistToken, readPersistedToken } from "./token-store.ts";

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

/** 注册/接入结果：解析出的 host token + 是否需 insecure。 */
export interface RegisterOutcome {
  token: string;
  insecure: boolean;
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
  let token: string;
  if (opts.token !== undefined) {
    // --token = join token（或旧 host token）→ register 端点换 host token
    const { hostToken } = await register(opts.hubUrl, opts.token, opts.name, insecure);
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
  return { token, insecure };
}

/** 调 register 端点：join token → host token（对旧 host token 幂等返回同一 token）。 */
async function register(
  hubUrl: string,
  joinToken: string,
  name: string | undefined,
  insecure: boolean,
): Promise<{ hostId: string; hostToken: string }> {
  const res = await hubRequest(hubUrl, "/api/hosts/register", { method: "POST", insecure, body: { token: joinToken, name } });
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

export async function join(opts: JoinOptions): Promise<void> {
  const hubWsBase = opts.hubUrl.replace(/^https/, "wss").replace(/^http/, "ws");
  const foundDsh = findDsh(opts.dshPath);
  if (foundDsh === null) {
    throw new Error("cannot find 'dsh' in PATH. Install DeepSeek Harness first, or pass --dsh <path>.");
  }
  const dsh = await spawnDsh(foundDsh);
  const target: ProxyTarget = { host: "127.0.0.1", port: dsh.port };
  // 解析 host token（含证书自动检测 + 持久化）；进程重启后复用，避免重复配对。
  const { token: initialToken, insecure } = await registerJoin(opts);
  let token = initialToken;
  console.log(`rdsh join: dsh web on 127.0.0.1:${dsh.port}`);
  console.log(`rdsh join: connecting to ${opts.hubUrl}...`);

  const parser = new FrameParser();
  /** http 流：streamId → 本地请求（写请求体 / 结束）。 */
  const httpStreams = new Map<number, { up: ReturnType<typeof httpRequest> }>();
  /** ws 流：streamId → 本地 ws 客户端（DATA 帧 → upstream）。 */
  const wsStreams = new Map<number, { upstream: WebSocket; queue: Buffer[] }>();

  let shuttingDown = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  let heartbeat: NodeJS.Timeout | undefined;

  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal !== "") console.log(`\nrdsh: received ${signal}, shutting down...`);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    await dsh.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  // 常驻：进程靠信号退出（shutdown 里 process.exit）；防止函数返回后
  // CLI 的 main().then(exit) 误退出服务进程
  const keepAlive = new Promise<void>(() => {});

  function handleFrame(frame: Frame, client: WebSocket): void {
    switch (frame.type) {
      case FRAME_TYPE.PING: {
        client.send(encodeFrame(FRAME_TYPE.PONG, frame.streamId, frame.payload));
        return;
      }
      case FRAME_TYPE.PONG:
        return;
      case FRAME_TYPE.OPEN: {
        handleOpen(frame, client);
        return;
      }
      case FRAME_TYPE.DATA: {
        const ws = wsStreams.get(frame.streamId);
        if (ws !== undefined) {
          if (ws.upstream.readyState === ws.upstream.OPEN) {
            ws.upstream.send(frame.payload, { binary: false }); // DSH WS 为 text(JSON)，保持文本帧
          } else {
            ws.queue.push(frame.payload);
          }
          return;
        }
        const http = httpStreams.get(frame.streamId);
        if (http !== undefined) http.up.write(frame.payload);
        return;
      }
      case FRAME_TYPE.CLOSE: {
        closeStream(frame.streamId);
        return;
      }
      case FRAME_TYPE.ERROR: {
        closeStream(frame.streamId);
        return;
      }
      default:
        return;
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

  function handleOpen(frame: Frame, client: WebSocket): void {
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
      client.send(encodeFrame(FRAME_TYPE.ERROR, frame.streamId, jsonPayload({ code: "BAD_OPEN", message: "malformed open" })));
      return;
    }

    if (kind === "ws") {
      openWsStream(frame, client, path, headers);
      return;
    }
    if (kind !== "http") {
      client.send(encodeFrame(FRAME_TYPE.ERROR, frame.streamId, jsonPayload({ code: "BAD_OPEN", message: "unknown kind" })));
      return;
    }

    const streamId = frame.streamId;
    // http 转发：本地 dsh（loopback http）
    const up = httpRequest(
      {
        host: target.host,
        port: target.port,
        path,
        method,
        headers: rewriteHeadersForDsh(headers, target),
      },
      (upRes) => {
        client.send(
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
          if (client.readyState === client.OPEN) {
            client.send(encodeFrame(FRAME_TYPE.DATA, streamId, chunk));
          }
        });
        upRes.on("end", () => {
          if (client.readyState === client.OPEN) {
            client.send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
          }
          httpStreams.delete(streamId);
        });
        upRes.on("error", () => {
          if (client.readyState === client.OPEN) {
            client.send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 502, message: "upstream error" })));
          }
          httpStreams.delete(streamId);
        });
      },
    );
    up.on("error", () => {
      if (client.readyState === client.OPEN) {
        client.send(
          encodeFrame(FRAME_TYPE.ERROR, streamId, jsonPayload({ code: "UPSTREAM_UNREACHABLE", message: "dsh not reachable" })),
        );
      }
      httpStreams.delete(streamId);
    });
    httpStreams.set(streamId, { up });
  }

  function openWsStream(frame: Frame, client: WebSocket, path: string, headers: Record<string, string | string[]>): void {
    const streamId = frame.streamId;
    const upstream = new WebSocket(`ws://${target.host}:${target.port}${path}`, {
      headers: rewriteHeadersForDsh(headers, target),
    });
    const queue: Buffer[] = [];
    wsStreams.set(streamId, { upstream, queue });

    upstream.on("open", () => {
      for (const q of queue) upstream.send(q, { binary: false });
      queue.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : Buffer.isBuffer(data)
          ? (data as Buffer)
          : Buffer.from(data as ArrayBuffer);
      if (client.readyState === client.OPEN) {
        client.send(encodeFrame(FRAME_TYPE.DATA, streamId, buf));
      }
    });
    const cleanup = (): void => {
      wsStreams.delete(streamId);
      if (client.readyState === client.OPEN) {
        client.send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
      }
    };
    upstream.on("close", cleanup);
    upstream.on("error", cleanup);
  }

  function connect(): void {
    if (shuttingDown) return;
    const url = `${hubWsBase}/tunnel?token=${encodeURIComponent(token)}`;
    const client = new WebSocket(url, { rejectUnauthorized: !insecure });

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
      console.log("rdsh join: tunnel established (heartbeat 30s)");
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
      for (const frame of frames) handleFrame(frame, client);
    });

    client.on("close", () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
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
      if (shuttingDown) return;
      if (tokenRejected) {
        // token 被拒（吊销/删除）= 永久失败，无法自动恢复（已移除配对码重配）
        // → 删旧 session + fail-fast，让 systemd/脚本拿到非零退出码与明确报错。
        clearPersistedToken(opts.hubUrl);
        console.error("rdsh join: host token rejected by hub (revoked or removed); re-run `rdsh host join <hub>` with a new join token.");
        void shutdown("", 1);
        return;
      }
      console.log(`rdsh join: tunnel lost — reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
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

  await keepAlive;
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
