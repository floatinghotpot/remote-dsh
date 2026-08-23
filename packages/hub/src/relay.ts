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
import { authenticate, writeError } from "./api.ts";
import type { HubRuntime } from "./api.ts";

const wss = new WebSocketServer({ noServer: true });

/**
 * HTTP/SSE 透传。返回是否已处理（false = 路径不属于 /h/ 数据面）。
 */
export async function handleRelay(req: IncomingMessage, res: ServerResponse, runtime: HubRuntime, hostId: string, path: string): Promise<boolean> {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    writeError(res, 401, "UNAUTHORIZED", "missing or invalid session");
    return true;
  }
  const host = runtime.db.getHostById(hostId);
  if (host === null || host.ownerId !== auth.userId) {
    writeError(res, 403, "FORBIDDEN", "host not owned by you");
    return true;
  }
  const conn = runtime.tunnels.get(hostId);
  if (conn === null) {
    writeError(res, 503, "HOST_OFFLINE", "host is offline");
    return true;
  }

  const headers = normalizeHeaders(req.headers);
  let responded = false;
  const streamId = conn.openStream("http", path, req.method ?? "GET", headers, {
    onResponse: (status, _reason, respHeaders) => {
      responded = true;
      res.writeHead(status, respHeaders as Record<string, string | string[]>);
    },
    onData: (chunk) => {
      if (!res.destroyed) res.write(chunk);
    },
    onClose: (_code, _message) => {
      if (!res.destroyed) res.end();
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
export function handleRelayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, runtime: HubRuntime, hostId: string, path: string): boolean {
  const auth = authenticate(req, runtime);
  if (auth === null) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n`);
    socket.destroy();
    return true;
  }
  const host = runtime.db.getHostById(hostId);
  if (host === null || host.ownerId !== auth.userId) {
    socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n`);
    socket.destroy();
    return true;
  }
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
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(chunk, { binary: true });
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
