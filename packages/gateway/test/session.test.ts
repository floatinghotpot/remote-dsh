import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, sessionTokenFromCookie } from "../src/session.ts";

async function tmpSession(): Promise<{ sm: SessionManager; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-session-"));
  const sm = new SessionManager(dir);
  await sm.init();
  return { sm, dir };
}

test("sign 后 verify 返回有效 payload", async () => {
  const { sm } = await tmpSession();
  const token = sm.sign(3600);
  const payload = sm.verify(token);
  assert.ok(payload, "token 应有效");
  assert.equal(typeof payload.sid, "string");
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test("过期 token 被拒绝", async () => {
  const { sm } = await tmpSession();
  const token = sm.sign(1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(sm.verify(token), null);
});

test("篡改的 token 被拒绝", async () => {
  const { sm } = await tmpSession();
  const token = sm.sign(3600);
  const dot = token.indexOf(".");
  const tampered = `${token.slice(0, dot)}x${token.slice(dot)}`; // 改 mac
  assert.equal(sm.verify(tampered), null);
  // 改 body
  const [, body] = token.split(".");
  const modifiedBody = Buffer.from(JSON.stringify({ sid: "evil", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  assert.equal(sm.verify(`${token.slice(0, dot)}.${modifiedBody}`), null);
});

test("伪造未来过期时间的 token 被拒绝", async () => {
  const { sm } = await tmpSession();
  const token = sm.sign(3600);
  const dot = token.indexOf(".");
  const [, body] = token.split(".");
  const far = Buffer.from(JSON.stringify({ sid: "x", exp: Math.floor(Date.now() / 1000) + 400 * 24 * 3600 })).toString("base64url");
  assert.equal(sm.verify(`${token.slice(0, dot)}.${far}`), null);
});

test("reset 后旧 token 失效、密钥文件重建", async () => {
  const { sm, dir } = await tmpSession();
  const token = sm.sign(3600);
  assert.ok(sm.verify(token));
  await sm.reset();
  assert.equal(sm.verify(token), null);
  // 密钥文件存在且权限 0600
  const st = await stat(join(dir, "secret.key"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("密钥文件权限为 0600", async () => {
  const { dir } = await tmpSession();
  const st = await stat(join(dir, "secret.key"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("cookieHeader 含 HttpOnly/SameSite/Max-Age", async () => {
  const { sm } = await tmpSession();
  const header = sm.cookieHeader(7200);
  assert.ok(header.includes("HttpOnly"));
  assert.ok(header.includes("SameSite=Lax"));
  assert.ok(header.includes("Max-Age=7200"));
  assert.ok(header.startsWith("rdsh_session="));
});

test("sessionTokenFromCookie 解析", () => {
  assert.equal(sessionTokenFromCookie("a=1; rdsh_session=abc; b=2"), "abc");
  assert.equal(sessionTokenFromCookie("a=1"), null);
  assert.equal(sessionTokenFromCookie(undefined), null);
});
