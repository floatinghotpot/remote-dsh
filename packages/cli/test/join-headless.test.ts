/**
 * join-headless.test.ts — `rdsh join --headless`（63-bind-agent-box / req R16–R18）。
 *
 * 起一个假 hub（bind-sessions 四个端点 + hosts/register），用隔离的 HOME 跑真实 CLI，
 * 断言：不需要 TTY、stdout 恰好一行 `RDSH_BIND {...}`、bindId 与会话一致、退出码 0。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

const BIND_ID = "bind-1234-5678";
const CONSUME_TOKEN = "consume-token-0123456789";
const HOST_ID = "host-abc";
const HOST_TOKEN = "host-token-0123456789abcd";

interface Hub {
  base: string;
  paths: string[];
  close: () => Promise<void>;
}

/** 假 hub：bind 会话立刻视为「已批准」，consume 返回固定 host 凭据。 */
async function fakeHub(): Promise<Hub> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(`${req.method ?? "?"} ${req.url ?? ""}`);
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      const url = req.url ?? "";
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url === "/api/bind-sessions" && req.method === "POST") {
        json(200, { bindId: BIND_ID, consumeToken: CONSUME_TOKEN, expiresAt: Date.now() + 60_000 });
        return;
      }
      if (url === `/api/bind-sessions/${BIND_ID}` && req.method === "GET") {
        json(200, { status: "approved", name: "test-box" });
        return;
      }
      if (url === `/api/bind-sessions/${BIND_ID}/consume` && req.method === "POST") {
        json(200, { hostId: HOST_ID, hostToken: HOST_TOKEN, hostCookiePubKey: "" });
        return;
      }
      if (url === "/api/hosts/register" && req.method === "POST") {
        // bindByQr 已持久化 token；registerJoin 读它做幂等返回
        json(200, { hostId: HOST_ID, hostToken: HOST_TOKEN, hostCookiePubKey: "" });
        return;
      }
      json(404, { error: { code: "NOT_FOUND", message: "no such endpoint" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    paths,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("join --headless：不需要 TTY，stdout 一行 RDSH_BIND，退出 0", async () => {
  assert.ok(existsSync(bin), "dist/bin.js missing — run `pnpm build` first");
  const hub = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), "rdsh-headless-"));
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [bin, "join", hub.base, "--headless", "--name", "test-box"],
      {
        encoding: "utf8",
        timeout: 20_000,
        // 隔离 HOME：token / join-meta / e2ee key / lock 全部落在临时目录
        env: { ...process.env, HOME: home, RDSH_CONFIG: join(home, "host.json") },
        // 显式不提供 stdin TTY：execFile 默认就是管道（非 TTY）
      },
    );

    const lines = stdout.trim().split(/\r?\n/);
    const bindLines = lines.filter((l) => l.startsWith("RDSH_BIND "));
    assert.equal(bindLines.length, 1, `stdout 应恰好一行 RDSH_BIND，实际：${stdout}`);
    const payload = JSON.parse(bindLines[0]!.slice("RDSH_BIND ".length)) as { bindId?: string; expiresAt?: number };
    assert.equal(payload.bindId, BIND_ID);
    assert.ok(typeof payload.expiresAt === "number" && payload.expiresAt > Date.now());

    // 走完整链路：建会话 → 轮询 → 消费（registerJoin 复用消费得到的 host token，不再打 register）
    assert.ok(hub.paths.some((p) => p.startsWith("POST /api/bind-sessions")), hub.paths.join("\n"));
    assert.ok(hub.paths.some((p) => p.startsWith(`GET /api/bind-sessions/${BIND_ID}`)), hub.paths.join("\n"));
    assert.ok(hub.paths.some((p) => p === `POST /api/bind-sessions/${BIND_ID}/consume`), hub.paths.join("\n"));

    // 落地：隔离 HOME 下写出了 join 模式的 host.json
    const cfg = JSON.parse(readFileSync(join(home, "host.json"), "utf8")) as { mode?: string; hub?: string };
    assert.equal(cfg.mode, "join");
    assert.equal(cfg.hub, hub.base);
  } finally {
    await hub.close();
  }
});

test("已有持久化 session 时 --headless 明确报错（不静默复用旧 token）", async () => {
  assert.ok(existsSync(bin));
  const home = mkdtempSync(join(tmpdir(), "rdsh-headless-"));
  const env = { ...process.env, HOME: home, RDSH_CONFIG: join(home, "host.json") };
  const hub = await fakeHub();
  try {
    // 第一次：正常绑定，留下持久化 token
    await execFileP(process.execPath, [bin, "join", hub.base, "--headless", "--name", "first"], {
      encoding: "utf8",
      timeout: 20_000,
      env,
    });
    // 第二次：同一 HOME，--headless 必须拒绝
    await assert.rejects(
      execFileP(process.execPath, [bin, "join", hub.base, "--headless", "--name", "second"], {
        encoding: "utf8",
        timeout: 20_000,
        env,
      }),
      (err: unknown) => {
        const e = err as { stderr?: string; code?: number };
        assert.notEqual(e.code, 0);
        assert.match(e.stderr ?? "", /已存在持久化 session/);
        return true;
      },
    );
  } finally {
    await hub.close();
  }
});

test("join 无 --headless 且无 token / 非 TTY → 明确报错（不 hang）", async () => {
  assert.ok(existsSync(bin));
  const hub = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), "rdsh-headless-"));
  try {
    await assert.rejects(
      execFileP(process.execPath, [bin, "join", hub.base], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, HOME: home, RDSH_CONFIG: join(home, "host.json") },
      }),
      (err: unknown) => {
        const e = err as { stderr?: string; code?: number };
        assert.notEqual(e.code, 0);
        assert.match(e.stderr ?? "", /--headless/);
        return true;
      },
    );
  } finally {
    await hub.close();
  }
});
