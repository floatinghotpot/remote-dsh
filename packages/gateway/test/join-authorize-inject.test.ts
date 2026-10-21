/**
 * pageAuthorizeScript —— raw（E2EE）门禁解锁脚本的回归守卫（feature 24 首版缺陷修复）。
 *
 * 背景：raw 流按设计不向 host 转发任何 cookie，页面只能靠这段**注入脚本**带 token 调
 * `/__rdsh/authorize` 才能把 `rawAuthorized` 置真。首版 feature 24 只在 plain dispatcher
 * 注入它，raw dispatcher 只挂了 `rawGate`，于是"设了口令 + 走 E2EE"的客户端永远无法授权，
 * 被 fail-closed 门禁逐个 CLOSE 403（现场表现为 UI 一直 connecting）。
 *
 * 本测试锁住两条不变量：
 *  ① 设了口令时，脚本内联的 token 必须能通过门禁验签（且绑定当前口令）；
 *  ② 未设口令时不做 raw 授权、只取候选（req R7）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageAuthorizeScript } from "../src/join.ts";
import { verifyGateCookie } from "../src/access-gate.ts";

test("pageAuthorizeScript：未设口令 → 仍取直连候选，但不触发 raw 授权（req R7）", () => {
  const script = pageAuthorizeScript(null);
  assert.ok(script.includes("/__rdsh/direct-candidates"), "应始终取直连候选");
  assert.ok(!script.includes("/__rdsh/authorize"), "无口令时不得调用 authorize");
});

test("pageAuthorizeScript：设了口令 → 内联的 token 能过验签并绑定该口令（raw 唯一解锁路径）", () => {
  const code = "s3cret-code";
  const script = pageAuthorizeScript(code);
  assert.ok(script.includes("/__rdsh/authorize?token="), "必须调用 authorize");
  const m = /encodeURIComponent\("([^"]*)"\)/.exec(script);
  assert.ok(m !== null, "应能从脚本中解析出内联 token 字面量");
  const token = m[1] as string;
  assert.equal(verifyGateCookie(code, token), true, "内联 token 必须能通过门禁验签");
  assert.equal(verifyGateCookie("other-code", token), false, "token 必须绑定当前口令");
});
