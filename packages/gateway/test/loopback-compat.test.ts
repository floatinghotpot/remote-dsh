/**
 * loopback-compat.test.ts — DSH UI loopback 兼容 patch（trustE2EEAsLoopback）。
 * 防 DSH 前端升级后正则/目标串失效的回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { patchLoopbackJs, isJsContentType } from "../src/join.ts";

test("patchLoopbackJs：命中目标串 → 替换为 true（isLoopback 恒真）", () => {
  const src = "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),";
  const patched = patchLoopbackJs(Buffer.from(src, "utf8"));
  assert.notEqual(patched, null);
  const out = patched!.toString("utf8");
  assert.ok(!out.includes("isLoopbackHostname"));
  assert.ok(out.includes("pageLocation === void 0 || true,"));
});

test("patchLoopbackJs：未命中 → null（fail-open，不误伤）", () => {
  assert.equal(patchLoopbackJs(Buffer.from("console.log('hello');", "utf8")), null);
  // DSH 若改名/改形（近似但不相同的串）→ 不误 patch，原样透传
  assert.equal(patchLoopbackJs(Buffer.from("isLoopbackHostname(location.hostname)", "utf8")), null);
  assert.equal(patchLoopbackJs(Buffer.from("isLoopbackHostname(pageLocation.host)", "utf8")), null);
});

test("isJsContentType：仅 javascript 命中", () => {
  assert.equal(isJsContentType({ "content-type": "application/javascript" }), true);
  assert.equal(isJsContentType({ "content-type": "text/javascript" }), true);
  assert.equal(isJsContentType({ "content-type": "application/json" }), false);
  assert.equal(isJsContentType({ "content-type": "text/html" }), false);
  assert.equal(isJsContentType({}), false);
});
