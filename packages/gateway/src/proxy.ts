/**
 * proxy.ts — 转发内核：HTTP/SSE 流式转发 + WebSocket 双向桥接。
 *
 * 关键事实（discussion.md §2）：DSH 的 Host 围栏只信任 loopback/trusted Host，
 * 因此**所有转发请求必须把 Host 重写为 127.0.0.1:<port>**，否则 /api 一律 403。
 */
import { request } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { decodeBody, encodeBody, firstEncoding } from "./http-encoding.ts";
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
  /**
   * 宿主代持的 dsh 浏览器会话 cookie（`dsh-auth-<sha256(authority)>`，0.1.2+）。
   * 提供时合并进每个转发/升级请求的 cookie 头，穿透 dsh 0.1.2 认证层。
   */
  authCookie?: string | null;
  /**
   * JS 响应补丁（LAN 路径；隧道路径见 `join.ts` 的 `patchLoopbackJs`）。
   * 命中 content-type 含 `javascript` 时缓冲后调用；返回 `null` = 原样透传（fail-open）。
   * 用途：把 DSH 前端的 `isLoopback` 判定替换为 `true` —— DSH 的设置/凭据界面只对 loopback 开放。
   */
  jsPatch?: (body: Buffer) => Buffer | null;
}

/**
 * 重写转发头以通过 DSH 围栏（isTrustedApiRequest 要求 Host/Origin 一致且为 loopback）。
 * - Host → 127.0.0.1:<port>（M1 事实：DSH 只信任 loopback/trusted Host）
 * - Origin 同步改写为 http://127.0.0.1:<port>（浏览器视角仍同源，不影响 CORS）
 * - 文档导航请求剥离 accept-encoding：0.1.2 起 dsh 对 HTML 默认 gzip，会使下游
 *   HTML 注入（hub 返回条/E2EE shim、serve polyfill）因 content-encoding 跳过；
 *   剥离后 dsh 返回明文 HTML，压缩交给 hub 的 TLS + E2EE 层。静态 JS/CSS 仍 gzip。
 * - 可选注入宿主 dsh 会话 cookie（合并进既有 cookie 头，保留 rdsh_gate 等，不覆盖）
 * 供 forwardHttp / createUpgradeProxy / join.ts（隧道→本地转发）复用。
 */
export function rewriteHeadersForDsh(
  headers: Record<string, string | string[] | undefined>,
  target: ProxyTarget,
  dshAuthCookie?: string | null,
): Record<string, string | string[] | undefined> {
  const out = { ...headers };
  out.host = `${target.host}:${target.port}`;
  if (out.origin !== undefined) {
    out.origin = `http://${target.host}:${target.port}`;
  }
  if (acceptsHtml(headers)) {
    delete out["accept-encoding"];
  }
  if (dshAuthCookie !== undefined && dshAuthCookie !== null && dshAuthCookie !== "") {
    const existing = out.cookie;
    const current = Array.isArray(existing) ? existing.join("; ") : typeof existing === "string" ? existing : "";
    out.cookie = current === "" ? dshAuthCookie : `${current}; ${dshAuthCookie}`;
  }
  return out;
}

/** 请求是否期望 text/html（文档导航：地址栏/链接）；浏览器 fetch/script 的 Accept 不含它。 */
function acceptsHtml(headers: Record<string, string | string[] | undefined>): boolean {
  const accept = headers["accept"];
  const s = Array.isArray(accept) ? accept.join(",") : typeof accept === "string" ? accept : "";
  return s.toLowerCase().includes("text/html");
}

/** 转发一个 HTTP 请求（含 SSE：响应流式写回，零缓冲）。 */
export function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  opts?: ForwardOptions,
): void {
  const headers = rewriteHeadersForDsh(req.headers, target, opts?.authCookie);
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
      const canPatchJs =
        opts?.jsPatch !== undefined && typeof contentType === "string" && /javascript/i.test(contentType);
      if (canPatchJs) {
        // JS bundle 需缓冲后才能替换目标串；先按 content-encoding 解码（dsh 会 gzip JS），
        // 补丁后按原编码重压（fail-open：未命中/不支持编码 → 原字节原头透传）
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of upstreamRes) chunks.push(chunk as Buffer);
          const raw = Buffer.concat(chunks);
          const encoding = firstEncoding(upstreamRes.headers["content-encoding"]);
          const decoded = decodeBody(raw, encoding);
          const patched = decoded === null ? null : opts!.jsPatch!(decoded);
          const recoded = patched === null ? null : encodeBody(patched, encoding);
          const outBody = recoded ?? raw;
          const outHeaders: Record<string, string | string[] | undefined> = { ...upstreamRes.headers };
          if (recoded !== null) {
            outHeaders["content-length"] = String(outBody.length);
            delete outHeaders["transfer-encoding"];
            // 同 join.ts：补丁后不可沿用 immutable/长 max-age（URL 不变，旧未补丁体可能被长期缓存）
            outHeaders["cache-control"] = "public, max-age=300";
          }
          delete outHeaders.connection;
          res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
          res.end(outBody);
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
export function createUpgradeProxy(target: ProxyTarget, opts?: ForwardOptions) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (clientWs, req) => {
    const headers = rewriteHeadersForDsh(req.headers, target, opts?.authCookie);
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
