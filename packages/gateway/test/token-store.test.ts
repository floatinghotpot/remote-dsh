import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenFilePath, readPersistedToken, persistToken, clearPersistedToken } from "../src/token-store.ts";

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "rdsh-token-"));
}

test("tokenFilePath 按 host（非默认端口带端口）区分", () => {
  assert.equal(tokenFilePath("https://hub.example.com", "/tmp/rdsh"), "/tmp/rdsh/join-hub.example.com.token");
  assert.equal(tokenFilePath("https://hub.example.com:8443", "/tmp/rdsh"), "/tmp/rdsh/join-hub.example.com-8443.token");
  assert.equal(tokenFilePath("http://127.0.0.1:8080", "/tmp/rdsh"), "/tmp/rdsh/join-127.0.0.1-8080.token");
});

test("persist → read 往返", async () => {
  const dir = await tmpDir();
  const hub = "https://hub.example.com";
  const token = "a".repeat(43); // randomToken(32 bytes) base64url 长度
  persistToken(hub, token, dir);
  assert.equal(readPersistedToken(hub, dir), token);
});

test("文件 0600、目录 0700（persist 递归创建）", async () => {
  const base = await tmpDir();
  const dir = join(base, "a", "b"); // 不存在，由 persist 递归创建
  const hub = "https://hub.example.com";
  persistToken(hub, "t".repeat(43), dir);
  const p = tokenFilePath(hub, dir);
  assert.equal((await stat(p)).mode & 0o777, 0o600);
  assert.equal((await stat(join(base, "a"))).mode & 0o777, 0o700);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("无文件 → null；过短 token → null", async () => {
  const dir = await tmpDir();
  const hub = "https://hub.example.com";
  assert.equal(readPersistedToken(hub, dir), null);
  persistToken(hub, "short", dir); // < 16 字符，视为无效
  assert.equal(readPersistedToken(hub, dir), null);
});

test("clear 删除文件（幂等）", async () => {
  const dir = await tmpDir();
  const hub = "https://hub.example.com";
  persistToken(hub, "a".repeat(43), dir);
  clearPersistedToken(hub, dir);
  assert.equal(readPersistedToken(hub, dir), null);
  // 对不存在的文件调用也不抛错
  clearPersistedToken(hub, dir);
});
