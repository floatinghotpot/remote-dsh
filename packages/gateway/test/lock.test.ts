import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { acquireJoinLock, releaseJoinLock, readJoinLock } from "../src/lock.ts";
import { startJoin } from "../src/join.ts";

const LOCK_MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lock.ts");

async function tmpLockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "rdsh-lock-")), "join.lock");
}

test("acquire → read 往返（pid + role）→ release 清空", async () => {
  const path = await tmpLockPath();
  assert.equal(acquireJoinLock("plugin", path).ok, true);
  const held = readJoinLock(path);
  assert.ok(held !== null);
  assert.equal(held.pid, process.pid);
  assert.equal(held.role, "plugin");
  releaseJoinLock(path);
  assert.equal(readJoinLock(path), null);
  assert.equal(existsSync(path), false);
});

test("他人活锁（pid 1）→ 拒绝且不覆盖", async () => {
  const path = await tmpLockPath();
  writeFileSync(path, JSON.stringify({ pid: 1, role: "cli" }));
  const res = acquireJoinLock("plugin", path);
  assert.equal(res.ok, false);
  if (!res.ok && "heldBy" in res) {
    assert.equal(res.heldBy.pid, 1);
    assert.equal(res.heldBy.role, "cli");
  } else {
    assert.fail("应报 heldBy");
  }
  // 未被覆盖
  assert.equal(readJoinLock(path)?.role, "cli");
});

test("stale 锁（已死 pid）→ read 视为无锁，acquire 接管（compare-and-delete + 重试）", async () => {
  const path = await tmpLockPath();
  // 极大 pid（几乎不可能存活）
  writeFileSync(path, JSON.stringify({ pid: 2147483647, role: "cli" }));

  // readJoinLock 是**纯读**：返回 null 但不删文件（删除只发生在 acquire 的清理路径）
  assert.equal(readJoinLock(path), null);
  assert.equal(existsSync(path), true, "read 不得有副作用");

  assert.equal(acquireJoinLock("plugin", path).ok, true);
  assert.equal(readJoinLock(path)?.pid, process.pid);
  releaseJoinLock(path);
});

test("损坏/非法 role → read 返回 null", async () => {
  const path = await tmpLockPath();
  writeFileSync(path, "not json");
  assert.equal(readJoinLock(path), null);
  writeFileSync(path, JSON.stringify({ pid: 1, role: "bogus" }));
  assert.equal(readJoinLock(path), null);
});

test("残锁：新鲜的不回收（可能是并发写入者写到一半）；过期的才回收", async () => {
  const path = await tmpLockPath();

  // ① 新鲜的空/半截文件 = 可能是并发创建者正写到一半 → 不回收、不改动、拒绝获取
  //    （新旧版本混跑时，旧版本 `writeFileSync(...,{flag:"wx"})` 的 open→write 窗口就长这样）
  writeFileSync(path, "{ truncated");
  const fresh = acquireJoinLock("plugin", path);
  assert.equal(fresh.ok, false, "新鲜残锁不得被回收");
  assert.equal(readFileSync(path, "utf8"), "{ truncated", "被拒绝时不得改动该文件");

  // ② 过期的半截残锁（崩溃残留）→ compare-and-delete 回收后重试获取
  const old = Date.now() / 1000 - 60;
  utimesSync(path, old, old);
  assert.equal(acquireJoinLock("plugin", path).ok, true);
  assert.equal(readJoinLock(path)?.pid, process.pid);
  releaseJoinLock(path);

  // ③ 空文件同理（旧版本在"已 open、未 write"窗口崩溃的残留）
  writeFileSync(path, "");
  utimesSync(path, old, old);
  assert.equal(acquireJoinLock("plugin", path).ok, true);
  assert.equal(readJoinLock(path)?.pid, process.pid);
  releaseJoinLock(path);
});

test("release 不误删他人锁；重复 release 不抛", async () => {
  const path = await tmpLockPath();
  writeFileSync(path, JSON.stringify({ pid: 1, role: "cli" }));
  releaseJoinLock(path); // 锁是 pid 1，不是本进程 → 不删
  assert.equal(readJoinLock(path)?.pid, 1);
  releaseJoinLock(path); // 幂等
  assert.equal(readJoinLock(path)?.pid, 1);
});

test("同进程重复获取 → 拒绝；锁文件被删后仍拒绝（heldPaths 记账）；释放后可再获取", async () => {
  const path = await tmpLockPath();
  assert.equal(acquireJoinLock("plugin", path).ok, true);

  // pid 无法区分同进程的两次获取（插件热重载 = 同进程二次 startJoin）
  const again = acquireJoinLock("plugin", path);
  assert.equal(again.ok, false);
  if (!again.ok && "heldBy" in again) assert.equal(again.heldBy.pid, process.pid);

  // heldPaths 的**真实**用例：锁文件被外部删掉时，文件层检查已无从发现，
  // 只有进程内记账能拦住第二次获取
  rmSync(path, { force: true });
  const afterExternalDelete = acquireJoinLock("plugin", path);
  assert.equal(afterExternalDelete.ok, false, "锁文件消失后同进程也不得再次获取");
  assert.equal(existsSync(path), false, "被拒绝时不得写入锁文件");

  releaseJoinLock(path);
  assert.equal(acquireJoinLock("plugin", path).ok, true);
  releaseJoinLock(path);
});

test("跨进程互斥：4 个进程同时抢同一把锁 → 恰好 1 个成功", async () => {
  const path = await tmpLockPath();
  const startAt = Date.now() + 600; // 对齐起跑，制造真实竞争
  const child = `
    const { acquireJoinLock } = await import(process.env.LOCK_MODULE);
    const wait = Number(process.env.START_AT) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = acquireJoinLock("plugin", process.env.LOCK_PATH);
    console.log(res.ok ? "OK" : "NO");
    if (res.ok) await new Promise((r) => process.stdin.on("end", r).resume());
  `;
  // 赢家必须**持锁到所有子进程都尝试完**（等父进程关 stdin）：否则赢家先退出 → 锁变 stale →
  // 后面的子进程会（正确地）接管，测试就会数到多个 OK（实现没错，是测试编排的坑，已在满负载下踩到）。
  // 注意：判定"子进程已尝试"必须用**读到结果行**，不能用 close —— 赢家在等 stdin 关闭，用 close 会死锁。
  const procs: ReturnType<typeof spawn>[] = [];
  try {
    const settled = await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<{ out: string; proc: ReturnType<typeof spawn> }>((resolve, reject) => {
            const proc = spawn(execPath, ["--input-type=module", "-e", child], {
              env: { ...process.env, LOCK_MODULE, LOCK_PATH: path, START_AT: String(startAt) },
              stdio: ["pipe", "pipe", "inherit"],
            });
            procs.push(proc);
            let out = "";
            const timer = setTimeout(() => {
              proc.kill("SIGKILL");
              reject(new Error(`子进程超时未返回（out=${JSON.stringify(out)}）`));
            }, 15000);
            proc.stdout.on("data", (b: Buffer) => {
              out += b.toString();
              if (/^(OK|NO)$/.test(out.trim())) {
                clearTimeout(timer);
                resolve({ out: out.trim(), proc });
              }
            });
            proc.on("error", (err) => {
              clearTimeout(timer);
              reject(err);
            });
          }),
      ),
    );
    // 持锁者应在**释放之前**断言：赢家一收到 stdin end 就退出，锁随即变 stale，之后再读就可能是空的
    const holder = readJoinLock(path);
    assert.ok(holder !== null, "此刻应有子进程持锁");
    assert.ok(
      settled.some((s) => s.proc.pid === holder.pid),
      `持锁者 pid ${holder.pid} 应是某个子进程（${settled.map((s) => s.proc.pid).join(",")}）`,
    );
    const results = settled.map((s) => s.out);
    const winners = results.filter((r) => r === "OK").length;
    assert.equal(winners, 1, `应恰好 1 个进程拿到锁，实际 ${winners}（${JSON.stringify(results)}）`);
  } finally {
    // 任何失败（子进程超时/启动失败）都不能让等 stdin 的赢家把测试进程挂住
    for (const proc of procs) {
      proc.stdin?.end();
      proc.kill("SIGKILL");
    }
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("构造期抛错（非法 WS 协议）→ 锁被释放，同进程可再次获取", async () => {
  const path = await tmpLockPath();
  // `ftp://` 能过 hubUrl 前缀检查，但 `new WebSocket("ftp://…/tunnel")` 会**同步**抛
  // （抛点在锁发布之后）⇒ 专门验证 releaseLockAndRethrow 把锁还回去了
  assert.throws(
    () => {
      startJoin({
        hubUrl: "ftp://127.0.0.1:1",
        token: "t".repeat(43),
        insecure: false,
        target: { host: "127.0.0.1", port: 1 },
        role: "plugin",
        lockPath: path,
      });
    },
    /protocol must be one of/,
  );
  assert.equal(existsSync(path), false, "抛错后不得残留锁文件");
  assert.equal(readJoinLock(path), null);
  assert.equal(acquireJoinLock("plugin", path).ok, true, "抛错后同进程必须还能再获取（heldPaths 已清）");
  releaseJoinLock(path);
});
