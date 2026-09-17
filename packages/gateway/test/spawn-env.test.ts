/**
 * spawn-dsh 的「远端目录选择器」相关单元测试：
 * - `dshSpawnEnv`：注入 SSH 信号（上游 `resolveDirectoryPickerBackend` 的输入）
 * - `checkRemotePickerGraph`：boot graph 自检（browse 客户端模块在不在）
 *
 * 依据：doc/fix/20260917-remote-workspace-picker/（discussion F2/F4/F8、solution T3/T4）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dshSpawnEnv, checkRemotePickerGraph, remotePickerWarning, RDSH_REMOTE_TTY } from "../src/spawn-dsh.ts";

test("dshSpawnEnv：无 SSH 信号时注入 SSH_TTY", () => {
  const env = dshSpawnEnv({ PATH: "/usr/bin" });
  assert.equal(env.SSH_TTY, RDSH_REMOTE_TTY);
  assert.equal(env.PATH, "/usr/bin");
});

test("dshSpawnEnv：空字符串的 SSH 信号视为未设置", () => {
  const env = dshSpawnEnv({ SSH_TTY: "", SSH_CONNECTION: "" });
  assert.equal(env.SSH_TTY, RDSH_REMOTE_TTY);
});

test("dshSpawnEnv：已有真实 SSH_TTY 时原样保留", () => {
  const env = dshSpawnEnv({ SSH_TTY: "/dev/ttys003" });
  assert.equal(env.SSH_TTY, "/dev/ttys003");
});

test("dshSpawnEnv：已有真实 SSH_CONNECTION 时不注入 SSH_TTY", () => {
  const env = dshSpawnEnv({ SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" });
  assert.equal(env.SSH_TTY, undefined);
  assert.equal(env.SSH_CONNECTION, "10.0.0.2 51000 10.0.0.1 22");
});

test("dshSpawnEnv：不改动传入对象（纯函数）", () => {
  const base = { PATH: "/bin" };
  dshSpawnEnv(base);
  assert.equal(base["SSH_TTY" as keyof typeof base], undefined);
});

/** 起一个只服务首页 HTML 的假 dsh，返回端口与关闭函数。 */
async function withHome(html: string, status = 200): Promise<{ port: number; close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

test("checkRemotePickerGraph：boot graph 含浏览器内选择器 → true", async () => {
  const { port, close } = await withHome(
    `<script src="/plugins/??@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js&rev=abc"></script>`,
  );
  try {
    assert.equal(await checkRemotePickerGraph(port), true);
  } finally {
    close();
  }
});

test("checkRemotePickerGraph：只有 native 选择器 → false", async () => {
  const { port, close } = await withHome(
    `<script src="/plugins/??@deepseek-ai/dsh-client-ui-directory-picker-native/client.js&rev=abc"></script>`,
  );
  try {
    assert.equal(await checkRemotePickerGraph(port), false);
  } finally {
    close();
  }
});

test("checkRemotePickerGraph：非 200 → null（不告警）", async () => {
  const { port, close } = await withHome("unauthorized", 401);
  try {
    assert.equal(await checkRemotePickerGraph(port), null);
  } finally {
    close();
  }
});

test("checkRemotePickerGraph：连接失败 → null（不告警）", async () => {
  assert.equal(await checkRemotePickerGraph(1, null, 300), null);
});

test("remotePickerWarning：文案含后果与动作", () => {
  const warn = remotePickerWarning();
  assert.ok(warn.includes("目录选择器"));
  assert.ok(warn.includes("cordis.patch.yml"));
  assert.ok(warn.includes("remote-dsh@latest"));
});
