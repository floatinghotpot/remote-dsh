/**
 * relay.ts — 数据面：`/h/<hostId>/...` 经隧道透传到对应 host 的 gateway → 本地 dsh。
 *
 * 纯透传：hub 不解析/改写业务报文（仅认证 + 路由）；Host/Origin 重写由
 * gateway join 侧完成（DSH 围栏兼容，M1 转发内核复用）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { writeError } from "./api.ts";
import { parseCookies, HOST_COOKIE } from "./server.ts";
import type { HubRuntime } from "./api.ts";

const wss = new WebSocketServer({ noServer: true });

/**
 * 授权 host 访问：验 HMAC 签名 host cookie（进入 host 时签发，7 天，绑定会话版本）。
 * 不依赖 rdsh_session —— 进入后 DSH 持续可用；改密（ver+1）或吊销后立即失效。
 */
function authorizeHost(req: IncomingMessage, runtime: HubRuntime): { hostId: string; userId: number } | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[HOST_COOKIE];
  if (raw === undefined) return null;
  const v = runtime.auth.verifyHostCookie(raw);
  if (v === null) return null;
  const host = runtime.db.getHostById(v.hostId);
  if (host === null || host.ownerId !== v.userId) return null;
  return { hostId: v.hostId, userId: v.userId };
}

export interface RelayOptions {
  /** 向 text/html 响应注入返回条（host 转发的门户壳，M1 htmlInject 同款）。 */
  injectBackBar?: boolean;
}

/** 返回条：悬浮在 DSH 界面右上角，回 portal。 */
export const BACK_BAR_HTML = `<a href="/portal" style="position:fixed;top:10px;right:14px;z-index:99999;background:rgba(15,23,42,.85);color:#e2e8f0;padding:6px 12px;border-radius:8px;text-decoration:none;font:13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);">← rdsh · 返回</a>`;

/**
 * HTTP/SSE 透传。返回是否已处理（false = 路径不属于数据面）。
 */
export async function handleRelay(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, path: string, opts?: RelayOptions): Promise<boolean> {
  const auth = authorizeHost(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "invalid host session");
    return true;
  }
  const hostId = auth.hostId;
  const conn = runtime.tunnels.get(hostId);
  if (conn === null) {
    writeError(res, 503, "HOST_OFFLINE", "host is offline");
    return true;
  }

  const headers = normalizeHeaders(req.headers);
  let responded = false;
  let streamId = 0;
  // 返回条注入：text/html 响应缓冲（KB 级）后注入；其余流量流式
  let htmlBuf: Buffer[] | null = null;
  streamId = conn.openStream("http", path, req.method ?? "GET", headers, {
    onResponse: (status, _reason, respHeaders) => {
      responded = true;
      const ct = typeof respHeaders["content-type"] === "string" ? (respHeaders["content-type"] as string) : "";
      const canInject =
        opts?.injectBackBar === true &&
        ct.includes("text/html") &&
        respHeaders["content-encoding"] === undefined &&
        respHeaders["transfer-encoding"] === undefined;
      if (canInject) {
        htmlBuf = [];
        // 缓冲注入时去掉 content-length（回写时重算）
        const h: Record<string, string | string[]> = { ...respHeaders };
        delete h["content-length"];
        res.writeHead(status, h);
      } else {
        res.writeHead(status, respHeaders as Record<string, string | string[]>);
      }
    },
    onData: (chunk) => {
      if (res.destroyed) return;
      if (htmlBuf !== null) htmlBuf.push(chunk);
      else res.write(chunk);
    },
    onClose: (_code, _message) => {
      if (res.destroyed) return;
      if (htmlBuf !== null) {
        let html = Buffer.concat(htmlBuf).toString("utf8");
        html = html.replace("</head>", `${BACK_BAR_HTML}</head>`);
        if (!html.includes(BACK_BAR_HTML)) html = `${BACK_BAR_HTML}${html}`;
        res.end(html);
      } else {
        res.end();
      }
    },
    onError: (code, message) => {
      if (!responded) {
        writeError(res, 502, "UPSTREAM_ERROR", `${code}: ${message}`);
      } else if (!res.destroyed) {
        res.end();
      }
    },
  });

  // 请求体流式转发
  req.on("data", (chunk: Buffer) => {
    conn.sendData(streamId, chunk);
  });
  req.on("end", () => {
    // 请求体结束（GET 立即触发）→ 只通知 gateway，保留 handler 等响应
    conn.endRequest(streamId);
  });
  req.on("error", () => {
    conn.abortStream(streamId);
  });
  res.on("close", () => {
    // 客户端中断 → 结束隧道流（含 handler）
    conn.abortStream(streamId);
  });
  return true;
}

function normalizeHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (k === "connection" || k === "upgrade" || k === "host") continue; // hop-by-hop / Host 由 gateway 重写
    out[k] = Array.isArray(v) ? v : String(v);
  }
  return out;
}

/**
 * WebSocket upgrade 透传（DSH 依赖 /api/events.mux、events.host）。
 * 返回是否已处理。
 */
export function handleRelayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, runtime: HubRuntime, path: string): boolean {
  const auth = authorizeHost(req, runtime);
  if (auth === null) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n`);
    socket.destroy();
    return true;
  }
  const hostId = auth.hostId;
  const conn = runtime.tunnels.get(hostId);
  if (conn === null) {
    socket.write(`HTTP/1.1 503 Service Unavailable\r\n\r\n`);
    socket.destroy();
    return true;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const headers = normalizeHeaders(req.headers);
    const streamId = conn.openStream("ws", path, "GET", headers, {
      onData: (chunk) => {
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(chunk, { binary: false }); // DSH WS 为 text(JSON)，转发必须保持文本帧
      },
      onClose: () => {
        try {
          clientWs.terminate();
        } catch {
          /* 已关闭 */
        }
        conn.abortStream(streamId);
      },
      onError: () => {
        try {
          clientWs.terminate();
        } catch {
          /* 已关闭 */
        }
        conn.abortStream(streamId);
      },
    });

    clientWs.on("message", (data, isBinary) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : Buffer.isBuffer(data)
          ? (data as Buffer)
          : Buffer.from(data as ArrayBuffer);
      conn.sendData(streamId, buf);
    });
    const close = (): void => {
      conn.abortStream(streamId);
    };
    clientWs.on("close", close);
    clientWs.on("error", close);
  });
  return true;
}
