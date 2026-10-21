import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHolder, dshHome, scanPluginInstalls, uninstallCommand } from "../src/lock-diagnostics.ts";

test("classifyHolder：来源分类", () => {
  assert.equal(classifyHolder(undefined), "unknown");
  assert.equal(classifyHolder(""), "unknown");
  assert.equal(classifyHolder("node /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"), "desktop");
  assert.equal(classifyHolder("electron /path/to/DeepSeek Harness"), "desktop");
  assert.equal(classifyHolder("node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web"), "cli-profile:web");
  assert.equal(classifyHolder("node /usr/local/bin/dsh web --port 0"), "cli");
  assert.equal(classifyHolder("rdsh host serve"), "cli");
  assert.equal(classifyHolder("remote-dsh host serve"), "cli");
  assert.equal(classifyHolder("some unrelated command"), "unknown");
});

test("scanPluginInstalls：扫描 + self 标记（注入 FS）", () => {
  const entries = scanPluginInstalls("/SELF/web", {
    dshHome: "/tmp/fake-dsh",
    readDir: () => ["web", "compat", ".cache"],
    readPkgVersion: (p) => (p.includes("/web/") ? "0.8.1" : p.includes("/compat/") ? "0.9.0" : null),
    samePath: (a) => a.includes("/web/"),
  });
  assert.deepEqual(
    entries.map((e) => [e.profile, e.version, e.self]),
    [
      ["web", "0.8.1", true],
      ["compat", "0.9.0", false],
    ],
  );
});

test("scanPluginInstalls：profiles 目录读不到 → 空", () => {
  const entries = scanPluginInstalls(undefined, {
    dshHome: "/tmp/nonexistent-dsh",
    readDir: () => {
      throw new Error("ENOENT");
    },
  });
  assert.deepEqual(entries, []);
});

test("uninstallCommand：生成 profile 卸载命令", () => {
  assert.equal(uninstallCommand("web"), "dsh plugin --profile web remove dsh-web-remote");
});

test("dshHome：DSH_HOME 优先，否则 ~/.dsh", () => {
  assert.equal(dshHome({ DSH_HOME: "/tmp/x" }), "/tmp/x");
  assert.ok(dshHome({}).endsWith(".dsh"));
});
