/**
 * portal 静态服务的健壮性：目录路径必须返回 404，绝不能 createReadStream 触发
 * 未捕获的 EISDIR error → 崩掉整个 hub（2026-10-12 生产事故：GET /portal/assets）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { servePortal } from "../src/portal.ts";

interface Captured {
  code: number;
  body: string;
}

function call(portalDir: string, url: string): Promise<Captured> {
  const req = { url, headers: {} } as unknown as IncomingMessage;
  const out: Captured = { code: 0, body: "" };
  const res = {
    writeHead: (code: number) => {
      out.code = code;
      return res as unknown as ServerResponse;
    },
    end: (b?: string | Buffer) => {
      if (b !== undefined) out.body = String(b);
    },
  } as unknown as ServerResponse;
  return servePortal(req, res, portalDir).then(() => out);
}

test("目录路径返回 404，不崩溃（EISDIR 回归）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-test-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");

  const r = await call(dir, "/portal/assets");
  assert.equal(r.code, 404);
});

test("不存在的路径回落 SPA index.html（200）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-test-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");

  const r = await call(dir, "/portal/login");
  assert.equal(r.code, 200);
  assert.equal(r.body, "<!doctype html>");
});
