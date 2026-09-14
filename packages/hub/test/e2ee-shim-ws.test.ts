/**
 * E2EE shim 的 WebSocket 门面回归测试（2026-09-14）。
 *
 * 背景（doc/fix/20260914-remote-webui-settings）：DSH 的 API 网关远端流
 * （`@deepseek-ai/dsh-api-gateway/lib/client.js`）用 `addEventListener`/`removeEventListener`
 * 订阅 WebSocket，并用 `readyState === WebSocket.OPEN` 判定状态；而 shim 早期只实现了
 * `on*` 回调 ⇒ E2EE 下远端流通道建不起来（设置页 Models 报
 * "settings are unavailable in this browser"）。
 *
 * 本测试把注入脚本放进假 window 沙箱执行，并做一次**真实密码学往返**
 * （X25519 + HKDF-SHA256 + AES-256-GCM，与 shim 内实现同构）确认消息能派发到监听器。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { encodeFrame, FRAME_TYPE } from "rdsh-tunnel";
import { E2EE_SHIM_HTML } from "../src/e2ee-shim.ts";

const subtle = webcrypto.subtle as SubtleCrypto;
const enc = new TextEncoder();

/** 被 shim 构造出来的假 WebSocket 实例（每个测试开始前清空）。 */
const instances: FakeWS[] = [];

/** 假 WebSocket：记录发送、可注入服务端下行帧；构造后下一微任务自动 open。 */
class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  readonly sent: Uint8Array[] = [];
  constructor(url: string) {
    this.url = url;
    instances.push(this);
    // 真实浏览器在握手完成后触发 open；这里用微任务模拟（onopen 会在同一 tick 内被赋值）
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: unknown): void {
    this.sent.push(typeof data === "string" ? enc.encode(data) : new Uint8Array(data as ArrayBuffer));
  }
  close(): void {
    this.readyState = 3;
  }
  /** 测试用：模拟服务端下发一帧密文。 */
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
}

/** 在假沙箱里执行注入脚本。`pin` 有值 → shim 走 wrap 分支；无值 → 直通。 */
function runShim(opts: { pin?: string }): { window: { WebSocket: unknown } } {
  const script = E2EE_SHIM_HTML.replace(/^<script>/, "").replace(/<\/script>\s*$/, "");
  const win = {
    WebSocket: FakeWS as unknown,
    fetch: () => Promise.reject(new Error("fetch not used in this test")),
  };
  const store = new Map<string, string>();
  if (opts.pin !== undefined) store.set("rdsh_e2ee_pins", JSON.stringify({ "host-1": opts.pin }));
  const names = [
    "window",
    "document",
    "location",
    "localStorage",
    "crypto",
    "TextEncoder",
    "TextDecoder",
    "atob",
    "URL",
    "Response",
    "Uint8Array",
    "DataView",
    "Map",
    "Promise",
    "JSON",
    "Error",
  ];
  const values = [
    win,
    { cookie: opts.pin !== undefined ? "rdsh_host=host-1" : "" },
    {
      href: "https://rdsh.cn/h/host-1/",
      protocol: "https:",
      host: "rdsh.cn",
      origin: "https://rdsh.cn",
      pathname: "/h/host-1/",
    },
    {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    webcrypto,
    TextEncoder,
    TextDecoder,
    atob,
    URL,
    Response,
    Uint8Array,
    DataView,
    Map,
    Promise,
    JSON,
    Error,
  ];
  new Function(...names, script)(...values);
  return { window: win };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成测试用主机 X25519 密钥对（公钥用于 pin，私钥用于推导 r2i）。 */
async function hostKeyPair(): Promise<{ pub: Uint8Array; priv: CryptoKey }> {
  const pair = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { pub: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)), priv: pair.privateKey };
}

test("shim 未 pin 时直通：不替换 window.WebSocket", () => {
  instances.length = 0;
  const sb = runShim({});
  assert.equal(sb.window.WebSocket, FakeWS, "无 pin 时应保持原生 WebSocket");
});

test("门面契约：addEventListener / 静态常量 / 双通道派发 / close 语义", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  const sb = runShim({ pin: b64u(host.pub) });

  const WS = sb.window.WebSocket as {
    new (url: string, protocols?: string | string[]): WrappedLike;
    CONNECTING: number;
    OPEN: number;
    CLOSING: number;
    CLOSED: number;
  };
  assert.notEqual(WS, FakeWS, "有 pin 时应替换为包装类");
  assert.equal(WS.CONNECTING, 0);
  assert.equal(WS.OPEN, 1, "DSH 用 `readyState === WebSocket.OPEN` 判定，常量必须存在且为 1");
  assert.equal(WS.CLOSING, 2);
  assert.equal(WS.CLOSED, 3);

  const ws = new WS("wss://rdsh.cn/api/mux");
  assert.equal(typeof ws.addEventListener, "function", "必须实现 addEventListener（历史缺陷点）");
  assert.equal(typeof ws.removeEventListener, "function");
  assert.equal(ws.url, "wss://rdsh.cn/api/mux");
  assert.equal(ws.binaryType, "blob");
  assert.equal(ws.readyState, 0, "构造后应为 CONNECTING");

  let openOnce = 0;
  let openDirect = 0;
  let removed = 0;
  ws.onopen = () => void openDirect++;
  ws.addEventListener("open", () => void openOnce++, { once: true });
  const removedFn = () => void removed++;
  ws.addEventListener("open", removedFn);
  ws.removeEventListener("open", removedFn);

  await waitFor(() => ws.readyState === 1);
  assert.equal(openOnce, 1, "{ once } 监听器应只被调用一次");
  assert.equal(openDirect, 1, "on* 回调应与 addEventListener 同时派发");
  assert.equal(removed, 0, "removeEventListener 后不应再收到事件");

  let closeOnce = 0;
  let closeDirect = 0;
  ws.onclose = () => void closeDirect++;
  ws.addEventListener("close", () => void closeOnce++);
  ws.close();
  assert.equal(ws.readyState, 3, "close() 后 readyState 必须为 CLOSED");
  assert.equal(closeOnce, 1);
  assert.equal(closeDirect, 1);
  ws.close(); // 幂等
  assert.equal(closeDirect, 1);
});

test("真实密码学往返：加密帧能经 addEventListener('message') 收到", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  const sb = runShim({ pin: b64u(host.pub) });
  const WS = sb.window.WebSocket as { new (url: string): WrappedLike & { addEventListener: (t: string, fn: (ev: { data: string }) => void) => void } };

  const ws = new WS("wss://rdsh.cn/api/mux");
  const received: string[] = [];
  const gotMessage = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 2000);
    (ws as unknown as { addEventListener: (t: string, fn: (ev: { data: string }) => void) => void }).addEventListener(
      "message",
      (ev) => {
        received.push(ev.data);
        clearTimeout(timer);
        resolve();
      },
    );
  });
  await waitFor(() => ws.readyState === 1);

  const inner = instances[0];
  assert.notEqual(inner, undefined, "shim 应通过假 WebSocket 建立内层通道");
  const ephPub = inner?.sent[0];
  assert.equal(ephPub?.length, 32, "shim 应在内层通道 open 后发送 ephemeral 公钥");

  // r2i = HKDF-SHA256(X25519(hostPriv, ephPub), salt=label, info="session") 的后 32 字节
  const ephImp = await subtle.importKey("raw", ephPub as Uint8Array, { name: "X25519" }, false, []);
  const ss = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: ephImp }, host.priv, 256));
  const hkdf = await subtle.importKey("raw", ss, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("rdsh-e2ee-nk-v1"), info: enc.encode("session") },
      hkdf,
      512,
    ),
  );
  const key = await subtle.importKey("raw", okm.slice(32), { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = new Uint8Array(12); // shim 的 Aead 计数器从 0 起 → 首个 nonce 全零
  const frame = encodeFrame(FRAME_TYPE.DATA, 1, enc.encode("hello from host")); // 包装 WS 分到的 streamId = 1
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, frame));
  const packet = new Uint8Array(12 + ct.length);
  packet.set(nonce, 0);
  packet.set(ct, 12);
  inner?.deliver(packet);

  await gotMessage;
  assert.deepEqual(received, ["hello from host"], "应经 addEventListener('message') 收到解密后的文本");
});

/** 包装后 WebSocket 的最小面（测试里只用到这些）。 */
interface WrappedLike {
  readyState: number;
  url: string;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  addEventListener: (type: string, fn: (ev: unknown) => void, options?: { once?: boolean }) => void;
  removeEventListener: (type: string, fn: (ev: unknown) => void) => void;
  close: () => void;
}
