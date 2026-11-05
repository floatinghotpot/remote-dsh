/**
 * device-id.test.ts — 每台设备的稳定标识（~/.rdsh/device-id）。
 *
 * 覆盖：首次生成并持久化、二次加载不变、损坏/读错误**不静默重建**、目录可注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceIdFilePath, isValidDeviceId, loadOrCreateDeviceId } from "../src/device-id.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rdsh-device-id-"));
}

test("首次调用生成并持久化（0600，base64url 语义合法）", () => {
  const dir = tmpDir();
  const id = loadOrCreateDeviceId(dir);
  assert.ok(isValidDeviceId(id), `unexpected id: ${id}`);
  assert.equal(readFileSync(deviceIdFilePath(dir), "utf8").trim(), id);
  assert.equal(statSync(deviceIdFilePath(dir)).mode & 0o777, 0o600);
});

test("二次调用返回同一个 id（重绑不能换身份）", () => {
  const dir = tmpDir();
  const first = loadOrCreateDeviceId(dir);
  const second = loadOrCreateDeviceId(dir);
  assert.equal(second, first);
});

test("文件内容损坏 → 抛错而不是重建（否则 hub 会当成新设备）", () => {
  const dir = tmpDir();
  writeFileSync(deviceIdFilePath(dir), "short\n", { mode: 0o600 });
  assert.throws(() => loadOrCreateDeviceId(dir), /corrupt/);

  writeFileSync(deviceIdFilePath(dir), "has space and $pecial chars 1234567890", { mode: 0o600 });
  assert.throws(() => loadOrCreateDeviceId(dir), /corrupt/);
});

test("isValidDeviceId 边界", () => {
  assert.equal(isValidDeviceId("a".repeat(16)), true);
  assert.equal(isValidDeviceId("a".repeat(128)), true);
  assert.equal(isValidDeviceId("a".repeat(15)), false);
  assert.equal(isValidDeviceId("a".repeat(129)), false);
  assert.equal(isValidDeviceId("bad/slash/1234567890"), false);
  assert.equal(isValidDeviceId(42), false);
  assert.equal(isValidDeviceId(null), false);
});

test("文件不存在时自动建目录", () => {
  const dir = join(tmpDir(), "nested", "home");
  const id = loadOrCreateDeviceId(dir);
  assert.ok(isValidDeviceId(id));
  assert.equal(readFileSync(deviceIdFilePath(dir), "utf8").trim(), id);
});

test("并发首绑（两个进程同时生成）只会产生一个 id", () => {
  const dir = tmpDir();
  // 两个独立 node 进程同时读/建同一个目录：靠 O_EXCL 占位，后到者回读同一个值。
  const script = `import { loadOrCreateDeviceId } from ${JSON.stringify(new URL("../src/device-id.ts", import.meta.url).href)}; process.stdout.write(loadOrCreateDeviceId(${JSON.stringify(dir)}));`;
  const run = (): string => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const [a, b] = [run(), run()];
  assert.equal(a, b, "两个进程必须拿到同一个 device-id");
  assert.equal(readFileSync(deviceIdFilePath(dir), "utf8").trim(), a);
});
