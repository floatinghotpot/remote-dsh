/**
 * proxy.ts — 转发内核：HTTP/SSE 流式转发 + WebSocket 双向桥接。
 *
 * 关键事实（discussion.md §2）：DSH 的 Host 围栏只信任 loopback/trusted Host，
 * 因此**所有转发请求必须把 Host 重写为 127.0.0.1:<port>**，否则 /api 一律 403。
 */
import { request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export interface ProxyTarget {
  host: string;
  port: number;
}

export interface ForwardOptions {
  /**
   * 注入到 text/html 响应的 <head> 的脚本。
   * 用途：http://局域网IP 非 secure context 下，浏览器不提供 crypto.randomUUID
   * （DSH 浏览器侧 RPC 依赖它），用非 secure context 也可用的 getRandomValues polyfill。
   */
  htmlInject?: string;
}

/** 转发一个 HTTP 请求（含 SSE：响应流式写回，零缓冲）。 */
export function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  opts?: ForwardOptions,
): void {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  headers.host = `${target.host}:${target.port}`;
  // DSH 围栏（isTrustedApiRequest）要求 Origin.host === Host.host。
  // 浏览器 Origin 是网关的 LAN 地址（如 http://192.168.x.x:8443），而 Host 已被
  // 重写为 loopback —— 不一致会 403。改写 Origin 使其与 Host 一致；浏览器视角
  // 请求仍是发往网关的同源请求，不影响 CORS。
  if (headers.origin !== undefined) {
    headers.origin = `http://${target.host}:${target.port}`;
  }
  const upstream = request(
    {
      host: target.host,
      port: target.port,
      path: req.url ?? "/",
      method: req.method ?? "GET",
      headers,
    },
    (upstreamRes) => {
      const contentType = upstreamRes.headers["content-type"];
      const canInject =
        opts?.htmlInject !== undefined &&
        typeof contentType === "string" &&
        contentType.includes("text/html") &&
        upstreamRes.headers["content-encoding"] === undefined;
      if (canInject) {
        // 页面 HTML 很小（KB 级），缓冲注入后转发；其余流量仍走流式
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of upstreamRes) chunks.push(chunk as Buffer);
          let html = Buffer.concat(chunks).toString("utf8");
          const script = `<script>${opts!.htmlInject}</script>`;
          if (html.includes("</head>")) html = html.replace("</head>", `${script}</head>`);
          else html = `${script}${html}`;
          const outHeaders: Record<string, string | string[] | undefined> = { ...upstreamRes.headers };
          outHeaders["content-length"] = String(Buffer.byteLength(html));
          // 拷贝上游头时剔除 Node 自行管理的编码/连接头，避免与 content-length 冲突
          delete outHeaders["transfer-encoding"];
          delete outHeaders["content-encoding"];
          delete outHeaders.connection;
          res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
          res.end(html);
        })().catch(() => {
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
          res.end("bad gateway");
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad gateway");
  });
  // 客户端断开 → 取消上游请求
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

interface QueuedMessage {
  data: Buffer;
  binary: boolean;
}

/**
 * WebSocket 转发：服务端完成客户端握手后，桥接客户端连接与上游 ws 客户端。
 * - 服务端握手用 ws 的 noServer WebSocketServer（帧编码正确）；
 * - handleUpgrade 成功后 ws 库会自动 emit 'connection'，这里不再手动 emit；
 * - 客户端消息立即入队，upstream open 后按序发送（避免握手竞态丢消息）。
 */
export function createUpgradeProxy(target: ProxyTarget) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (clientWs, req) => {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    headers.host = `${target.host}:${target.port}`;
    // 同 forwardHttp：改写 Origin 使其与重写后的 Host 一致，通过 DSH 围栏校验
    if (headers.origin !== undefined) {
      headers.origin = `http://${target.host}:${target.port}`;
    }
    const upstreamUrl = `ws://${target.host}:${target.port}${req.url ?? "/"}`;
    const upstream = new WebSocket(upstreamUrl, { headers });

    const queue: QueuedMessage[] = [];
    clientWs.on("message", (data, isBinary) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(buf, { binary: isBinary });
      } else {
        queue.push({ data: buf, binary: isBinary });
      }
    });

    upstream.on("open", () => {
      for (const m of queue) upstream.send(m.data, { binary: m.binary });
      queue.length = 0;
      // 上游 → 客户端
      upstream.on("message", (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
      });
      // 任一端断开 → 另一端强制销毁（优雅 close 会等对端回帧，可能悬挂）
      const close = () => {
        try {
          clientWs.terminate();
        } catch {
          /* 已关闭 */
        }
        try {
          upstream.terminate();
        } catch {
          /* 已关闭 */
        }
      };
      clientWs.on("close", close);
      upstream.on("close", close);
      clientWs.on("error", close);
      upstream.on("error", close);
    });
    upstream.on("error", () => {
      try {
        clientWs.terminate();
      } catch {
        /* 已关闭 */
      }
    });
  });
  return {
    /** 完成客户端 upgrade 握手并桥接（转发前必须已通过认证）。 */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(req, socket, head, (ws) => {
        // handleUpgrade 不会自动 emit 'connection'，需手动触发桥接逻辑
        wss.emit("connection", ws, req);
      });
    },
  };
}
