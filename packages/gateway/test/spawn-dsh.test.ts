import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { findDsh, spawnDsh, exchangeDshSessionCookie, detectDshVersion, compareDshVersions, dshVersionWarning, DSH_COMPAT_MIN, DSH_COMPAT_MAX } from "../src/spawn-dsh.ts";
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

test("spawnDsh 解析 0.1.2 就绪行并捕获 launch token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-spawn-"));
  const fake = join(dir, "dsh");
  await writeFile(fake, `#!/bin/sh\nprintf 'dsh web: http://127.0.0.1:38992/?token=abc123_-xyz\\n'\nsleep 30\n`);
  await chmod(fake, 0o755);
  const dsh = await spawnDsh(fake);
  assert.equal(dsh.port, 38992);
  assert.equal(dsh.authToken, "abc123_-xyz");
  await dsh.stop();
});

test("spawnDsh 解析 0.1.1 无 token 就绪行（authToken=undefined）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-spawn-"));
  const fake = join(dir, "dsh");
  await writeFile(fake, `#!/bin/sh\nprintf 'dsh web: http://127.0.0.1:38993\\n'\nsleep 30\n`);
  await chmod(fake, 0o755);
  const dsh = await spawnDsh(fake);
  assert.equal(dsh.port, 38993);
  assert.equal(dsh.authToken, undefined);
  await dsh.stop();
});

test("exchangeDshSessionCookie：换发成功返回 dsh-auth cookie 段", async () => {
  const server = createServer((req, res) => {
    res.writeHead(303, { location: "/", "set-cookie": "dsh-auth-abc=v1.payload.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await exchangeDshSessionCookie(port, "tok"), "dsh-auth-abc=v1.payload.sig");
  } finally {
    server.close();
  }
});

test("exchangeDshSessionCookie：无 dsh-auth cookie → null", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401);
    res.end("unauthorized");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await exchangeDshSessionCookie(port, "tok"), null);
  } finally {
    server.close();
  }
});

test("exchangeDshSessionCookie：连接失败 → null", async () => {
  assert.equal(await exchangeDshSessionCookie(1, "tok", 500), null);
});

test("detectDshVersion：解析标准版本输出", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-ver-"));
  const fake = join(dir, "dsh");
  await writeFile(fake, "#!/bin/sh\nprintf '0.1.2-rc.1\\n'\n");
  await chmod(fake, 0o755);
  assert.equal(await detectDshVersion(fake), "0.1.2-rc.1");
});

test("detectDshVersion：不可解析/失败 → null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-ver-"));
  const fake = join(dir, "dsh");
  await writeFile(fake, "#!/bin/sh\nprintf 'not-a-version\\n'\n");
  await chmod(fake, 0o755);
  assert.equal(await detectDshVersion(fake), null);
  assert.equal(await detectDshVersion("/nonexistent/dsh-bin"), null);
});

test("compareDshVersions：核心版本与 rc 后缀比较", () => {
  assert.ok(compareDshVersions("0.1.2-rc.1", "0.1.1-rc.2") > 0);
  assert.ok(compareDshVersions("0.1.1-rc.2", "0.1.2-rc.1") < 0);
  assert.equal(compareDshVersions("0.1.2-rc.1", "0.1.2-rc.1"), 0);
  assert.ok(compareDshVersions("0.1.2-rc.2", "0.1.2-rc.1") > 0);
  // release 大于同 core 的任何 prerelease
  assert.ok(compareDshVersions("0.1.2", "0.1.2-rc.9") > 0);
  assert.ok(compareDshVersions("0.1.2-rc.1", "0.1.2") < 0);
  // 不可解析排序为更旧
  assert.ok(compareDshVersions("garbage", "0.1.2-rc.1") < 0);
  assert.equal(compareDshVersions("a", "b"), 0);
});

test("dshVersionWarning：窗口内不提示，越界给动作指令", () => {  // 实测窗口 [DSH_COMPAT_MIN, DSH_COMPAT_MAX]：两端与中间版本均不提示
  for (const version of [DSH_COMPAT_MIN, "0.1.2-rc.1", DSH_COMPAT_MAX]) {
    assert.equal(dshVersionWarning(version), null, `${version} 应在窗口内`);
  }
  // 比 MAX 新 → 提示升级 remote-dsh（含同 core 的后续 rc 与正式版）
  for (const version of ["0.1.7-rc.2", "0.1.7", "0.2.0-rc.1"]) {
    const warn = dshVersionWarning(version);
    assert.ok(warn !== null && warn.includes("超出 remote-dsh 已实测范围"), `${version} 应提示超窗`);
  }
  // 比 MIN 旧 → 提示升级 dsh
  const tooOld = dshVersionWarning("0.1.1-rc.1");
  assert.ok(tooOld !== null && tooOld.includes("版本过旧"), "0.1.1-rc.1 应提示过旧");
  // 探测失败 → 不提示
  assert.equal(dshVersionWarning(null), null);
});

test("spawnDsh 给子进程注入 SSH_TTY（让 dsh 解析出浏览器内目录选择器）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-spawn-"));
  const fake = join(dir, "dsh");
  const seen = join(dir, "ssh-tty.txt");
  // 假 dsh：先把继承到的 SSH_TTY 落盘，再打印就绪行并保持运行
  await writeFile(
    fake,
    `#!/bin/sh\nprintf '%s' "\${SSH_TTY:-<unset>}" > "${seen}"\nprintf 'dsh web: http://127.0.0.1:38994\\n'\nsleep 30\n`,
  );
  await chmod(fake, 0o755);

  const savedTty = process.env.SSH_TTY;
  const savedConn = process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  delete process.env.SSH_CONNECTION;
  try {
    const dsh = await spawnDsh(fake);
    await dsh.stop();
    assert.equal(await readFile(seen, "utf8"), "rdsh-remote");
  } finally {
    if (savedTty === undefined) delete process.env.SSH_TTY;
    else process.env.SSH_TTY = savedTty;
    if (savedConn === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = savedConn;
  }
});

test("spawnDsh 不覆盖用户真实的 SSH 信号", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-spawn-"));
  const fake = join(dir, "dsh");
  const seen = join(dir, "ssh-tty.txt");
  await writeFile(
    fake,
    `#!/bin/sh\nprintf '%s' "\${SSH_TTY:-<unset>}" > "${seen}"\nprintf 'dsh web: http://127.0.0.1:38995\\n'\nsleep 30\n`,
  );
  await chmod(fake, 0o755);

  const savedTty = process.env.SSH_TTY;
  process.env.SSH_TTY = "/dev/ttys999";
  try {
    const dsh = await spawnDsh(fake);
    await dsh.stop();
    assert.equal(await readFile(seen, "utf8"), "/dev/ttys999");
  } finally {
    if (savedTty === undefined) delete process.env.SSH_TTY;
    else process.env.SSH_TTY = savedTty;
  }
});
