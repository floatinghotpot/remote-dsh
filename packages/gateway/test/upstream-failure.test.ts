/**
 * 上游失败分类回归（F14）：不得把"上游已接受但中途断开"报成"dsh not reachable"。
 *
 * 2026-09-14 实测：E2EE 页面里 XHR 上传得到
 * `502 {"code":"UPSTREAM_ERROR","message":"UPSTREAM_UNREACHABLE: dsh not reachable"}`，
 * 而真实情况是 dsh 已接受连接、在读体阶段就断开 ⇒ 排障被误导。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUpstreamFailure } from "../src/join.ts";

test("连不上（ECONNREFUSED/ENOTFOUND/EAI_AGAIN）⇒ UPSTREAM_UNREACHABLE", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
    const out = classifyUpstreamFailure(code, false);
    assert.equal(out.kind, "error", code);
    assert.equal(out.code, "UPSTREAM_UNREACHABLE", code);
    assert.match(out.message, /dsh not reachable/, code);
    assert.match(out.message, new RegExp(code), `${code} 必须出现在消息里便于排障`);
  }
});

test("连接已建立但上游提前关闭（ECONNRESET）⇒ UPSTREAM_ABORTED（不得说成不可达）", () => {
  const out = classifyUpstreamFailure("ECONNRESET", false);
  assert.equal(out.kind, "error");
  assert.equal(out.code, "UPSTREAM_ABORTED");
  assert.match(out.message, /ECONNRESET/);
  assert.doesNotMatch(out.message, /not reachable/);
});

test("已发出响应头后中断 ⇒ 用 CLOSE(code 502) 表示响应体截断", () => {
  const out = classifyUpstreamFailure("ECONNRESET", true);
  assert.equal(out.kind, "close", "已发过头就不能再发 ERROR（客户端已有状态码）");
  assert.equal(out.code, "UPSTREAM_ABORTED");
  assert.match(out.message, /mid-response/);
});

test("无 error.code 时退回 message 文本，仍不误报不可达", () => {
  const out = classifyUpstreamFailure(undefined, false, "socket hang up");
  assert.equal(out.kind, "error");
  assert.equal(out.code, "UPSTREAM_ABORTED");
  assert.match(out.message, /socket hang up/);
});
