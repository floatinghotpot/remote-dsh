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
import { E2EE_SHIM_HTML } from "./e2ee-shim.ts";

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

/** 返回按钮：悬浮于 DSH 界面右上角（top:64px 位于 DSH 顶栏/Session Log 下方，避免遮挡）。 */
export const BACK_BAR_HTML = `<a href="/portal" style="position:fixed;top:40px;right:30px;z-index:99999;background:rgba(30,30,30,.88);color:#e2e8f0;padding:6px 14px;border-radius:16px;border:1px solid rgba(255,255,255,.4);text-decoration:none;font:13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);">← rdsh · 返回</a>`;

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
    // 浏览器导航（Accept text/html）→ 友好页面 + 清 host cookie 引导回 portal；API 调用仍返回 JSON
    if ((req.headers.accept ?? "").includes("text/html")) {
      const clearCookie = `${HOST_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "set-cookie": clearCookie });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#1f2937">` +
          `<h1 style="font-size:20px">主机离线</h1>` +
          `<p style="color:#6b7280">这台主机当前未接入（join 隧道未运行），或已重新绑定。请回到门户重新选择主机。</p>` +
          `<a href="/portal" style="color:#2563eb">← 返回 rdsh 门户</a></body>`,
      );
      return true;
    }
    writeError(res, 503, "HOST_OFFLINE", "host is offline");
    return true;
  }

  const headers = normalizeHeaders(req.headers);
  let responded = false;
  let streamId = 0;
  // 返回按钮注入：text/html 响应缓冲（KB 级）后注入；其余流量流式
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
        // E2EE shim 注入到 <head> 最前（须先于 DSH 脚本 wrap fetch/WebSocket；off 时不注入）
        if ((runtime.config.e2ee?.mode ?? "optional") !== "off") {
          html = html.replace(/<head([^>]*)>/i, `<head$1>${E2EE_SHIM_HTML}`);
        }
        // 返回按钮注入到 </head> 前（固定定位悬浮，不改动 DSH 文档流/布局）
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

/**
 * E2EE raw 流透传：浏览器 WS ↔ 隧道 raw 流字节互转（内层 Noise 握手 + 密文，hub 不解析内容）。
 * 返回是否已处理。受 `config.e2ee.mode` 控制：off 拒绝。
 */
export function handleRawUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, runtime: HubRuntime): boolean {
  if ((runtime.config.e2ee?.mode ?? "optional") === "off") {
    socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n`);
    socket.destroy();
    return true;
  }
  const auth = authorizeHost(req, runtime);
  if (auth === null) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\n\r\n`);
    socket.destroy();
    return true;
  }
  const conn = runtime.tunnels.get(auth.hostId);
  if (conn === null) {
    socket.write(`HTTP/1.1 503 Service Unavailable\r\n\r\n`);
    socket.destroy();
    return true;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const streamId = conn.openRawStream({
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

    clientWs.on("message", (data) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data as Buffer[])
        : Buffer.isBuffer(data)
          ? (data as Buffer)
          : Buffer.from(data as ArrayBuffer);
      conn.sendRawData(streamId, buf);
    });
    const close = (): void => {
      conn.abortStream(streamId);
    };
    clientWs.on("close", close);
    clientWs.on("error", close);
  });
  return true;
}
