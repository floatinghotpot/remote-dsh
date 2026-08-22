import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { forwardHttp, createUpgradeProxy } from "../src/proxy.ts";

/** 起一个 mock 上游（模拟 dsh）：断言 Host 重写、回显路径与体。 */
async function startUpstream() {
  const seen = { host: "" as string, paths: [] as string[] };
  const server = createServer((req, res) => {
    seen.host = req.headers.host ?? "";
    seen.paths.push(req.url ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "x-upstream": "ok" });
      res.end(`up:${req.method}:${req.url}:${body}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, port, seen };
}

async function startUpstreamWs() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      ws.send(data, { binary: isBinary }); // 回环
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/** 强制关闭 http server（含 keep-alive/undici 连接），避免测试进程挂起。 */
function closeServer(server: ReturnType<typeof createServer>): void {
  server.closeAllConnections?.();
  server.close();
}

test("forwardHttp 转发并重写 Host 为 127.0.0.1:<port>", async () => {
  const upstream = await startUpstream();
  try {
    await new Promise<void>((resolve, reject) => {
      const client = createServer((req, res) => forwardHttp(req, res, { host: "127.0.0.1", port: upstream.port }));
      client.listen(0, "127.0.0.1", () => {
        const { port } = client.address() as AddressInfo;
        const req = fetch(`http://127.0.0.1:${port}/api/test`, { method: "POST", body: "hello" });
        req.then(async (res) => {
          assert.equal(res.status, 200);
          assert.equal(res.headers.get("x-upstream"), "ok");
          assert.equal(await res.text(), "up:POST:/api/test:hello");
          assert.equal(upstream.seen.host, `127.0.0.1:${upstream.port}`);
          assert.ok(upstream.seen.paths.includes("/api/test"));
          closeServer(client);
          resolve();
        }).catch(reject);
      });
    });
  } finally {
    closeServer(upstream.server);
  }
});

test("SSE 流式响应逐步到达（不整体缓冲）", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    setTimeout(() => res.write("data: 2\n\n"), 30);
    setTimeout(() => res.end("data: 3\n\n"), 60);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await new Promise<void>((resolve, reject) => {
      const client = createServer((req, res) => forwardHttp(req, res, { host: "127.0.0.1", port }));
      client.listen(0, "127.0.0.1", () => {
        const cport = (client.address() as AddressInfo).port;
        void (async () => {
          const res = await fetch(`http://127.0.0.1:${cport}/events`);
          const reader = res.body!.getReader();
          const chunks: string[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value).toString("utf8"));
          }
          const all = chunks.join("");
          assert.ok(all.includes("data: 1"));
          assert.ok(all.includes("data: 2"));
          assert.ok(all.includes("data: 3"));
          assert.ok(chunks.length >= 2, `应流式到达（实际 ${chunks.length} 块）`);
          closeServer(client);
          resolve();
        })().catch(reject);
      });
    });
  } finally {
    closeServer(server);
  }
});

test("转发时改写 Origin 与 Host 一致（DSH 围栏要求）", async () => {
  const seen = { origin: "" as string };
  const upstream = createServer((req, res) => {
    seen.origin = req.headers.origin ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const { port } = upstream.address() as AddressInfo;
  try {
    await new Promise<void>((resolve, reject) => {
      const client = createServer((req, res) => forwardHttp(req, res, { host: "127.0.0.1", port }));
      client.listen(0, "127.0.0.1", () => {
        const cport = (client.address() as AddressInfo).port;
        void (async () => {
          const res = await fetch(`http://127.0.0.1:${cport}/api/host.pickDirectory`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: `http://192.168.1.100:${cport}` },
            body: "{}",
          });
          assert.equal(res.status, 200);
          // 上游收到的 Origin 应与重写后的 Host（127.0.0.1:<port>）一致
          assert.equal(seen.origin, `http://127.0.0.1:${port}`);
          closeServer(client);
          resolve();
        })().catch(reject);
      });
    });
  } finally {
    closeServer(upstream);
  }
});

test("htmlInject 注入 text/html 响应（非 html 不注入）", async () => {
  const upstream = createServer((req, res) => {
    if (req.url === "/html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><title>x</title></head><body>hi</body></html>");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"a":1}');
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const { port } = upstream.address() as AddressInfo;
  const inject = "globalThis.__POLYFILLED__=true";
  try {
    await new Promise<void>((resolve, reject) => {
      const client = createServer((req, res) =>
        forwardHttp(req, res, { host: "127.0.0.1", port }, { htmlInject: inject }),
      );
      client.listen(0, "127.0.0.1", () => {
        const cport = (client.address() as AddressInfo).port;
        void (async () => {
          const html = await (await fetch(`http://127.0.0.1:${cport}/html`)).text();
          assert.ok(html.includes(`<script>${inject}</script>`), "HTML 应注入脚本");
          assert.ok(html.includes("</head>"), "注入位置应在 head 内");
          const json = await (await fetch(`http://127.0.0.1:${cport}/json`)).text();
          assert.ok(!json.includes(inject), "非 HTML 响应不应注入");
          closeServer(client);
          resolve();
        })().catch(reject);
      });
    });
  } finally {
    closeServer(upstream);
  }
});

test("WS 双向桥接：客户端 → 上游 → 回环返回", async () => {
  const upstream = await startUpstreamWs();
  try {
    // 代理侧：http server 的 upgrade 交给 createUpgradeProxy
    const proxy = createUpgradeProxy({ host: "127.0.0.1", port: upstream.port });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => proxy.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`);
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws 超时")), 3000);
      client.on("message", (data) => {
        clearTimeout(timer);
        resolve(String(data));
      });
      client.on("error", reject);
      client.on("open", () => client.send("ping-frame"));
    });
    assert.equal(reply, "ping-frame");
    client.terminate();
    closeServer(server);
  } finally {
    closeServer(upstream.server);
  }
});
