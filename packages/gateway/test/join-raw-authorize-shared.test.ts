/**
 * join-raw-authorize-shared.test.ts — raw 门禁的授权位必须是"一次授权、覆盖后续新建流"。
 *
 * 背景（见 doc/fix/20261004-raw-authorize-per-stream/discussion.md）：
 * `rawAuthorized` 原先声明在 `makeInnerDispatcher()` 内部，而该方法**每条 raw 流都调用一次**
 * （`startRawStream`）⇒ 页面注入脚本的 authorize 只能解锁"承载该请求的那一条流"；
 * 此后任何**新建**的 raw 流都回到未授权态，命中 fail-closed 分支被
 * `CLOSE 403 raw stream not authorized`。真机现象：经服务器转发的 app，切 DSH UI 语言
 * （触发前端重连 / 新建流）后概率性报 `session/prompt failed: raw stream not authorized`。
 *
 * 本测试驱动**真实的 raw（E2EE）路径**：每条流做独立 Noise 握手，内层帧全部加密。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { startJoin } from "../src/join.ts";
import { loadOrCreateE2eeKeyPair } from "../src/e2ee-key-store.ts";
import { Aead as NodeAead } from "../src/e2ee.ts";
import { initiatorHandshake } from "../../portal/src/e2ee.ts";
import { signGateCookie } from "../src/access-gate.ts";
import {
  FrameParser,
  FRAME_TYPE,
  FLAG_E2E,
  encodeFrame,
  jsonPayload,
  parseJsonPayload,
} from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";

const ACCESS_CODE = "secret";

async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 客户端侧的一条 raw 流：完成 Noise 握手后即可收发加密的内层帧。 */
interface RawClient {
  /** 加密一帧内层帧，经 DATA(FLAG_E2E) 发出（与 host 侧 `handleRawData` 对偶）。 */
  sendInner(type: number, payload: unknown): void;
  /** 解密该流收到的所有 DATA(FLAG_E2E)，按序解析出内层帧。 */
  drainInner(): Frame[];
  /** 等某条内层帧出现。 */
  waitInner(pred: (f: Frame) => boolean, what: string): Promise<Frame>;
}

interface Ctx {
  tunnel: WebSocket;
  handle: ReturnType<typeof startJoin>;
  /** 新开一条 raw 流（含独立 Noise 握手）。 */
  openRaw(streamId: number): Promise<RawClient>;
  close(): Promise<void>;
}

/**
 * 起 fake hub（WebSocketServer）+ `startJoin`。
 *
 * `direct` 必须提供 —— raw 门禁只在 `dio.rawGate !== undefined` 时生效，而 rawGate 来自
 * `opts.direct`（24-direct-first）。`target` 指向无监听的端口：**过了门禁**的请求会以
 * `UPSTREAM_UNREACHABLE` 收场，据此区分"被门禁拦下"与"放行但上游不通"。
 */
async function setup(): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-raw-auth-"));
  // 与 startJoin 用同一个 dir ⇒ 拿到同一把 host 静态密钥（测试不碰 ~/.rdsh）
  const hostKeys = loadOrCreateE2eeKeyPair(dir);

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const tunnelP = new Promise<WebSocket>((resolve) => wss.on("connection", (ws) => resolve(ws)));

  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 },
    role: "plugin",
    lockPath: join(dir, "join.lock"),
    e2eeKeyDir: dir,
    gateway: { accessCode: ACCESS_CODE },
    direct: { candidates: () => [], mintTicket: () => "test-ticket" },
  });

  const tunnel = await tunnelP;
  const parser = new FrameParser();
  const frames: Frame[] = [];
  tunnel.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    for (const f of parser.push(buf)) frames.push(f);
  });

  async function openRaw(streamId: number): Promise<RawClient> {
    const init = await initiatorHandshake(hostKeys.publicRaw);
    const enc = new NodeAead(Buffer.from(init.keys.initiatorToResponder));
    const dec = new NodeAead(Buffer.from(init.keys.responderToInitiator));

    // ① raw 流外壳（明文帧）+ ② 32B 发起方临时公钥（host 据此派生密钥）
    tunnel.send(encodeFrame(FRAME_TYPE.OPEN, streamId, jsonPayload({ kind: "raw" })));
    tunnel.send(encodeFrame(FRAME_TYPE.DATA, streamId, Buffer.from(init.ephemeralPublicRaw), FLAG_E2E));

    const drainInner = (): Frame[] => {
      const out: Frame[] = [];
      const p = new FrameParser();
      for (const f of frames) {
        if (f.streamId !== streamId || f.type !== FRAME_TYPE.DATA) continue;
        if ((f.flags & FLAG_E2E) === 0) continue;
        try {
          for (const inner of p.push(dec.decrypt(f.payload, Buffer.alloc(0)))) out.push(inner);
        } catch {
          /* 该分片尚未完整 —— 跳过 */
        }
      }
      return out;
    };

    const client: RawClient = {
      sendInner(type, payload) {
        const ct = enc.encrypt(encodeFrame(type, streamId, jsonPayload(payload)), Buffer.alloc(0));
        tunnel.send(encodeFrame(FRAME_TYPE.DATA, streamId, ct, FLAG_E2E));
      },
      drainInner,
      async waitInner(pred, what) {
        let found: Frame | undefined;
        await waitFor(() => {
          found = drainInner().find(pred);
          return found !== undefined;
        }, 3000, what);
        return found as Frame;
      },
    };
    return client;
  }

  return {
    tunnel,
    handle,
    openRaw,
    async close() {
      handle.stop();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

/** 内层 HTTP 请求（与 `handleOpen` 读的 jsonPayload 形状一致）。 */
function httpOpen(kind: "http", method: string, path: string): unknown {
  return { kind, method, path, headers: {} };
}

/** 内层 CLOSE 是否是 raw 门禁的 403。 */
function isRawGateBlocked(f: Frame): boolean {
  if (f.type !== FRAME_TYPE.CLOSE) return false;
  try {
    return (parseJsonPayload(f) as { message?: string }).message === "raw stream not authorized";
  } catch {
    return false;
  }
}

/** 发一条 GET /（上游必然连不上）—— 用来区分"被门禁拦"与"放行"。 */
const PROBE_PATH = "/__probe";

test("AC1：raw 流 A 授权后，**新建的** raw 流 B 不再被 raw 门禁拦截（本次修复的回归点）", async () => {
  const ctx = await setup();
  try {
    // ---- 流 A：带正确 token 完成 raw 授权 ----
    const a = await ctx.openRaw(1);
    const token = encodeURIComponent(signGateCookie(ACCESS_CODE).value);
    a.sendInner(FRAME_TYPE.OPEN, httpOpen("http", "POST", `/__rdsh/authorize?token=${token}`));
    const ok = await a.waitInner(
      (f) => f.type === FRAME_TYPE.OPEN && (parseJsonPayload(f) as { status?: number }).status === 204,
      "流 A 收到 authorize 204",
    );
    assert.ok(ok, "authorize 应返回 204");

    // ---- 流 B：**新建**的 raw 流，自己不授权 ----
    const b = await ctx.openRaw(2);
    b.sendInner(FRAME_TYPE.OPEN, httpOpen("http", "GET", PROBE_PATH));

    // 修复前：流 B 会收到 CLOSE 403 raw stream not authorized
    // 修复后：放行 → 上游连不上（target 指向无监听端口）→ ERROR UPSTREAM_UNREACHABLE
    const probe = await b.waitInner(
      (f) => f.type === FRAME_TYPE.CLOSE || f.type === FRAME_TYPE.ERROR,
      "流 B 收到结论帧",
    );
    assert.equal(isRawGateBlocked(probe), false, "新建流不得再被 raw 门禁拦截（回归）");
    assert.equal(probe.type, FRAME_TYPE.ERROR, "应是放行后的上游失败");
    assert.equal((parseJsonPayload(probe) as { code?: string }).code, "UPSTREAM_UNREACHABLE");
  } finally {
    await ctx.close();
  }
});

test("AC2：另一台网关实例（未授权）的 raw 流仍必须被 403 拦下 —— 授权不得变成模块级全局", async () => {
  const ctx = await setup();
  try {
    const a = await ctx.openRaw(1);
    a.sendInner(FRAME_TYPE.OPEN, httpOpen("http", "GET", PROBE_PATH));
    const blocked = await a.waitInner(isRawGateBlocked, "未授权 raw 流被门禁拦下");
    assert.equal((parseJsonPayload(blocked) as { code?: number }).code, 403);
  } finally {
    await ctx.close();
  }
});

test("AC3：错误 token 不解锁门禁（授权路径本身仍严格）", async () => {
  const ctx = await setup();
  try {
    const a = await ctx.openRaw(1);
    a.sendInner(
      FRAME_TYPE.OPEN,
      httpOpen("http", "POST", "/__rdsh/authorize?token=bogus"),
    );
    const blocked = await a.waitInner(isRawGateBlocked, "错误 token 被门禁拦下");
    assert.equal((parseJsonPayload(blocked) as { code?: number }).code, 403);
  } finally {
    await ctx.close();
  }
});
