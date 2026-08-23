/**
 * join.ts — `rdsh join <hub-url>`：出站隧道客户端（公网模式，M3）。
 *
 * 流程：spawn dsh（复用）→ 绑定（配对码轮询 或 --token 直填）→ WSS 隧道（?token=）
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
  /** 直填 host token（跳过配对码绑定流程） */
  token?: string;
  /** 清除持久化 token 并强制重新配对 */
  reset?: boolean;
  dshPath?: string;
  /** 跳过 TLS 证书校验（自签 hub 用；正式证书无需） */
  insecure?: boolean;
}

const PENDING_POLL_MS = 5_000;
const BIND_TIMEOUT_MS = 10 * 60 * 1000; // 配对码 10 分钟
const HEARTBEAT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 绑定流程：POST /api/hosts/pending → 打印配对码 → 轮询取 host token。 */
async function bind(hubUrl: string, insecure: boolean): Promise<string> {
  const pendingRes = await hubRequest(hubUrl, "/api/hosts/pending", { method: "POST", insecure });
  if (!pendingRes.ok) {
    throw new Error(`hub rejected pending request: HTTP ${pendingRes.status}`);
  }
  const pending = pendingRes.body as { pendingId: string; code: string };
  console.log(`rdsh join: pair code: ${pending.code}`);
  console.log(`rdsh join: sign in to ${hubUrl} and enter this code (10 min) to bind this host.`);
  console.log(`rdsh join: waiting for binding...`);
  const deadline = Date.now() + BIND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(PENDING_POLL_MS);
    const res = await hubRequest(hubUrl, `/api/hosts/pending/${pending.pendingId}`, { method: "GET", insecure });
    if (!res.ok) continue;
    const body = res.body as { status: string; token?: string };
    if (body.status === "bound" && typeof body.token === "string") {
      console.log("rdsh join: bound — establishing tunnel...");
      return body.token;
    }
  }
  throw new Error("binding timed out (10 min): re-run rdsh join to get a new code");
}

/** hub HTTP 调用（node:https 支持自签跳过校验 —— undici fetch 不受 NODE_TLS_REJECT_UNAUTHORIZED 影响）。 */
function hubRequest(
  baseUrl: string,
  path: string,
  opts: { method: string; insecure: boolean },
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
    req.end(opts.method === "POST" ? "{}" : undefined);
  });
}

export async function join(opts: JoinOptions): Promise<void> {
  const hubWsBase = opts.hubUrl.replace(/^https/, "wss").replace(/^http/, "ws");
  const foundDsh = findDsh(opts.dshPath);
  if (foundDsh === null) {
    throw new Error("cannot find 'dsh' in PATH. Install DeepSeek Harness first, or pass --dsh <path>.");
  }
  const dsh = await spawnDsh(foundDsh);
  const target: ProxyTarget = { host: "127.0.0.1", port: dsh.port };
  // token 来源优先级：--token 直填 > 持久化复用 > 配对码绑定（绑定成功后落盘）。
  // 进程重启后复用已绑定 token，避免重复配对；被吊销时（401）自动回退重配对。
  let token: string;
  if (opts.token !== undefined) {
    token = opts.token;
  } else {
    if (opts.reset === true) clearPersistedToken(opts.hubUrl);
    const persisted = readPersistedToken(opts.hubUrl);
    if (persisted !== null) {
      token = persisted;
      console.log("rdsh join: reusing persisted host token");
    } else {
      token = await bind(opts.hubUrl, opts.insecure === true);
      persistToken(opts.hubUrl, token);
    }
  }
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

  /** 持久化 token 被 hub 拒绝（吊销/重置）→ 删旧文件 → 重新配对 → 重连。 */
  async function rebindAndReconnect(): Promise<void> {
    clearPersistedToken(opts.hubUrl);
    console.log("rdsh join: host token rejected (revoked?) — re-pairing...");
    try {
      token = await bind(opts.hubUrl, opts.insecure === true);
      persistToken(opts.hubUrl, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`rdsh join: re-pairing failed (${msg}); retrying in ${RECONNECT_BASE_MS / 1000}s...`);
      setTimeout(() => void rebindAndReconnect(), RECONNECT_BASE_MS);
      return;
    }
    reconnectDelay = RECONNECT_BASE_MS;
    connect();
  }

  function connect(): void {
    if (shuttingDown) return;
    const url = `${hubWsBase}/tunnel?token=${encodeURIComponent(token)}`;
    const client = new WebSocket(url, { rejectUnauthorized: opts.insecure !== true });

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
        if (opts.token === undefined) {
          // 持久化 token 被拒 → 删旧文件 + 回退配对码
          void rebindAndReconnect();
          return;
        }
        // 显式 --token 被拒 = 永久失败（token 不会再变有效）→ fail-fast，
        // 让脚本/systemd 拿到非零退出码与明确报错，而非静默无限重连
        console.error("rdsh join: host token rejected by hub (revoked or removed); exiting.");
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
