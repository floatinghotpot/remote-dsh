/**
 * LAN 路径的 loopback 补丁（因素③，doc/fix/20260914-remote-webui-settings）+ 压缩回归。
 *
 * `forwardHttp(..., { jsPatch: patchLoopbackJs })` 必须：
 *  - 命中：identity / gzip / br 都要替换为 `true`，并保持原编码、重算 content-length；
 *  - 未命中 / 未知编码 / 非 JS：原样透传（fail-open）；
 *  - 开关关闭（严格模式）：完全不动（保持 DSH 原样）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { forwardHttp } from "../src/proxy.ts";
import { patchLoopbackJs } from "../src/join.ts";

const TARGET = "isLoopbackHostname(pageLocation.hostname)";
const JS = `var loop = ${TARGET};\n`;
const JSON_BODY = `{"k":"${TARGET}"}`;
const HTML_BODY = `<html><head></head><body>${TARGET}</body></html>`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  return addr.port;
}

async function startUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/js/gzip.js")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(JS)));
      return;
    }
    if (url.startsWith("/js/br.js")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-encoding": "br" });
      res.end(brotliCompressSync(Buffer.from(JS)));
      return;
    }
    if (url.startsWith("/js/")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(JS);
      return;
    }
    if (url.startsWith("/html/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML_BODY);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON_BODY);
  });
  return { server, port: await listen(server) };
}

async function startGateway(
  upstreamPort: number,
  jsPatch: typeof patchLoopbackJs | undefined,
): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    forwardHttp(req, res, { host: "127.0.0.1", port: upstreamPort }, {
      htmlInject: "/*polyfill*/",
      authCookie: null,
      jsPatch,
    });
  });
  return { server, base: `http://127.0.0.1:${await listen(server)}` };
}

test("LAN 路径：identity / gzip / br 的 JS 都被替换，编码与长度正确；非 JS 与 HTML 不受影响", async () => {
  const upstream = await startUpstream();
  const gw = await startGateway(upstream.port, patchLoopbackJs);
  try {
    const plain = await (await fetch(`${gw.base}/js/plain.js`)).text();
    assert.ok(plain.includes("var loop = true;"), "identity JS 应被替换");

    const gzRes = await fetch(`${gw.base}/js/gzip.js`);
    assert.equal(gzRes.headers.get("content-encoding"), "gzip", "应保留原编码");
    const gz = await gzRes.text();
    assert.ok(gz.includes("var loop = true;"), "gzip JS 解压后应已被替换");
    assert.ok(!gz.includes(TARGET), "不应残留原始判定");

    const br = await (await fetch(`${gw.base}/js/br.js`)).text();
    assert.ok(br.includes("var loop = true;"), "br JS 解压后应已被替换");

    const json = await (await fetch(`${gw.base}/api/data.json`)).text();
    assert.ok(json.includes(TARGET), "非 JS 响应不得改动");

    const html = await (await fetch(`${gw.base}/html/page`)).text();
    assert.ok(html.includes("/*polyfill*/"), "HTML 注入应仍然生效");
    assert.ok(html.includes(TARGET), "HTML 不走 JS 补丁");
  } finally {
    await new Promise<void>((r) => gw.server.close(() => r()));
    await new Promise<void>((r) => upstream.server.close(() => r()));
  }
});

test("LAN 路径：未启用 jsPatch（严格模式）→ 原样透传", async () => {
  const upstream = await startUpstream();
  const gw = await startGateway(upstream.port, undefined);
  try {
    const js = await (await fetch(`${gw.base}/js/plain.js`)).text();
    assert.ok(js.includes(TARGET), "关闭开关时必须保持 DSH 原样（fail-safe）");
  } finally {
    await new Promise<void>((r) => gw.server.close(() => r()));
    await new Promise<void>((r) => upstream.server.close(() => r()));
  }
});
