import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDsh, spawnDsh } from "../src/spawn-dsh.ts";

test("findDsh 找不到时返回 null", () => {
  const oldPath = process.env.PATH;
  process.env.PATH = "/nonexistent-dir";
  try {
    assert.equal(findDsh(), null);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("findDsh 优先使用 override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-dsh-"));
  const fake = join(dir, "dsh");
  await writeFile(fake, "#!/bin/sh\n");
  await chmod(fake, 0o755);
  assert.equal(findDsh(fake), fake);
});

test("spawnDsh 解析 dsh 输出的实际端口并可停止", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-spawn-"));
  const fake = join(dir, "dsh");
  // 模拟 `dsh web --port 0`：打印 URL 行后保持运行
  await writeFile(fake, `#!/bin/sh\nprintf 'dsh web: http://127.0.0.1:38991\\n'\nsleep 30\n`);
  await chmod(fake, 0o755);

  const dsh = await spawnDsh(fake);
  assert.equal(dsh.port, 38991);
  const code = await dsh.stop();
  assert.ok(typeof code === "number");
});

test("spawnDsh 对不存在的可执行文件报错", async () => {
  await assert.rejects(() => spawnDsh("/nonexistent/dsh-bin"), /failed to launch dsh/);
});
