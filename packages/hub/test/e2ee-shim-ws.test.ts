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
import { encodeFrame, FRAME_TYPE, FrameParser } from "rdsh-tunnel";
import { E2EE_SHIM_HTML, injectE2eeShim } from "../src/e2ee-shim.ts";

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
  /** 测试用：模拟对端关闭通道（触发 shim 的 ws.onclose → 通道失效处理）。 */
  deliverClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

/** 在假沙箱里执行注入脚本。`pin` 有值 → 走 wrap 分支；`hostId` = hub 注入的 hostId；
 *  `cookie` 模拟 document.cookie（**HttpOnly 场景 = 空**）；`ws` 可换成原生形态的假 WebSocket。 */
function runShim(opts: { pin?: string; hostId?: string; cookie?: string; ws?: unknown }): { window: { WebSocket: unknown } } {
  const script = E2EE_SHIM_HTML.replace(/^<script>/, "").replace(/<\/script>\s*$/, "");
  const win: Record<string, unknown> = {
    WebSocket: opts.ws ?? (FakeWS as unknown),
    fetch: () => Promise.reject(new Error("fetch not used in this test")),
  };
  if (opts.hostId !== undefined) win.__RDSH_HOST_ID__ = opts.hostId;
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
    { cookie: opts.cookie ?? (opts.pin !== undefined ? "rdsh_host=host-1" : "") },
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

test("hostId 由 hub 注入时启用 E2EE（HttpOnly cookie 读不到也能工作）", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  // 关键回归：cookie 为空（模拟 HttpOnly）+ hub 注入 hostId ⇒ shim 必须接管
  const sb = runShim({ pin: b64u(host.pub), hostId: "host-1", cookie: "" });
  assert.notEqual(sb.window.WebSocket, FakeWS, "有注入 hostId + pin 时必须替换 WebSocket（E2EE 生效）");
});

test("既无注入 hostId 又读不到 cookie → 不启用（安全回退，不误连）", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  const sb = runShim({ pin: b64u(host.pub), cookie: "" });
  assert.equal(sb.window.WebSocket, FakeWS, "取不到 hostId 时必须直通明文，不得猜测");
});

test("injectE2eeShim：先注入 hostId bootstrap，再注入 shim，且 JSON 转义", () => {
  const out = injectE2eeShim("<html><head><meta charset='utf-8'></head></html>", 'a"b');
  const idAt = out.indexOf("__RDSH_HOST_ID__");
  const shimAt = out.indexOf("rdsh_e2ee_pins");
  assert.ok(idAt > 0, "应注入 hostId");
  assert.ok(shimAt > idAt, "hostId 必须在 shim 之前（shim 是立即执行的 IIFE）");
  assert.ok(out.includes('window.__RDSH_HOST_ID__="a\\"b"'), "hostId 必须 JSON 转义");
});

test("injectE2eeShim：无 <head> 时仍注入（不得静默失效）", () => {
  const out = injectE2eeShim("<html><body>hi</body></html>", "host-1");
  assert.ok(out.includes("__RDSH_HOST_ID__"), "无 <head> 也要注入 hostId");
  assert.ok(out.startsWith("<script>"), "退化为文档最前注入");
});

/**
 * 真机回归（2026-09-14）：真 WebSocket.prototype 上 url/protocol/readyState 都是**只有 getter**
 * 的访问器，而 shim 是 `"use strict"` ⇒ `this.url = …` 抛
 * "Cannot set property url of #<WebSocket> which has only a getter"，门面根本构造不出来
 * （DSH 侧表现为 `failed to apply loader entry (@deepseek-ai/dsh-api-gateway)`）。
 */
function nativeLikeWS(): { ctor: unknown; instances: Record<string, unknown>[] } {
  const instances: Record<string, unknown>[] = [];
  function NativeLike(this: Record<string, unknown>, url: string) {
    instances.push(this);
    this["__url"] = url;
    queueMicrotask(() => (this["onopen"] as ((ev: unknown) => void) | null)?.({}));
  }
  const proto = Object.create(Object.prototype) as Record<string, unknown>;
  proto["constructor"] = NativeLike;
  for (const name of ["url", "protocol", "extensions", "bufferedAmount", "readyState"] as const) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: Record<string, unknown>) {
        return name === "url" ? this["__url"] : name === "readyState" ? 1 : "";
      },
    });
  }
  (NativeLike as unknown as { prototype: unknown }).prototype = proto;
  const ctor = NativeLike as unknown as Record<string, unknown>;
  ctor["CONNECTING"] = 0;
  ctor["OPEN"] = 1;
  ctor["CLOSING"] = 2;
  ctor["CLOSED"] = 3;
  proto["send"] = (): void => undefined;
  proto["close"] = (): void => undefined;
  return { ctor, instances };
}

test("门面构造：不得给继承来的只读访问器赋值（真 WebSocket 只有 getter）", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  const native = nativeLikeWS();
  const sb = runShim({ pin: b64u(host.pub), hostId: "host-1", ws: native.ctor });
  assert.notEqual(sb.window.WebSocket, native.ctor, "有 pin + hostId 时必须替换 window.WebSocket");
  const Wrapped = sb.window.WebSocket as new (u: string, p?: string) => Record<string, unknown>;
  // 关键断言：真机在这里抛 TypeError；修好后 url/protocol 必须是自有可写属性
  const ws = new Wrapped("ws://rdsh.local/api/remote.mux", "ds-json.v1");
  assert.equal(ws["url"], "ws://rdsh.local/api/remote.mux", "url 必须是自有属性（继承的 getter 覆盖不了）");
  assert.equal(ws["protocol"], "ds-json.v1", "protocol 必须是自有属性");
  for (const name of ["url", "protocol", "extensions", "binaryType", "bufferedAmount", "readyState", "onopen", "onmessage", "onclose", "onerror"]) {
    const d = Object.getOwnPropertyDescriptor(ws, name);
    assert.ok(d !== undefined && d.writable === true, `${name} 必须是自有可写数据属性，实际 ${JSON.stringify(d)}`);
  }
  assert.equal(typeof ws["addEventListener"], "function");
  ws["close"]?.();
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

/** 由 ephPub 推导 shim 的出向密钥 i2r（与 shim 内 HKDF/Aead 同构：前 32 字节，nonce 从 0 起）。 */
async function deriveI2r(hostPriv: CryptoKey, ephPub: Uint8Array): Promise<CryptoKey> {
  const ephImp = await subtle.importKey("raw", ephPub, { name: "X25519" }, false, []);
  const ss = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: ephImp }, hostPriv, 256));
  const hkdf = await subtle.importKey("raw", ss, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("rdsh-e2ee-nk-v1"), info: enc.encode("session") },
      hkdf,
      512,
    ),
  );
  return subtle.importKey("raw", okm.slice(0, 32), { name: "AES-GCM" }, false, ["decrypt"]);
}

/** 解密假 host 收到的全部密文包（sent[0] 是明文临时公钥，跳过），按到达顺序返回内层帧。 */
async function decryptSent(hostPriv: CryptoKey, inner: FakeWS): Promise<{ type: number; payload: Uint8Array }[]> {
  const key = await deriveI2r(hostPriv, inner.sent[0]!);
  const parser = new FrameParser();
  const frames: { type: number; payload: Uint8Array }[] = [];
  for (const packet of inner.sent.slice(1)) {
    const pt = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: packet.slice(0, 12) }, key, packet.slice(12)));
    for (const f of parser.push(Buffer.from(pt))) frames.push({ type: f.type, payload: f.payload });
  }
  return frames;
}

test("fetch 请求体超过分片阈值时必须多帧发送、每帧 ≤ 上限、拼起来字节一致", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  const sb = runShim({ pin: b64u(host.pub), hostId: "host-1" });
  const fetchFn = (sb.window as unknown as { fetch: (input: unknown, init?: unknown) => Promise<unknown> }).fetch;

  const CHUNK = 1 << 20; // shim 内的分片上限（1 MiB）
  const body = new Uint8Array(2 * CHUNK + 1234).fill(7);
  void fetchFn(new URL("http://rdsh.local/api/session/uploadFileBinary"), { method: "POST", body });
  // OPEN + 3×DATA + CLOSE = 5 个包（+1 明文公钥）
  await waitFor(() => (instances[0]?.sent.length ?? 0) >= 6);

  const frames = await decryptSent(host.priv, instances[0]!);
  assert.equal(frames[0]?.type, FRAME_TYPE.OPEN, `首帧应为 OPEN，实际 ${frames[0]?.type}`);
  const dataFrames = frames.filter((f) => f.type === FRAME_TYPE.DATA);
  assert.equal(dataFrames.length, 3, `2 MiB+ 请求体应分成 3 个 DATA 帧（实际 ${dataFrames.length}）`);
  for (const f of dataFrames) assert.ok(f.payload.length <= CHUNK, `每帧不得超过分片上限（实际 ${f.payload.length}）`);
  const joined = Buffer.concat(dataFrames.map((f) => Buffer.from(f.payload)));
  assert.equal(joined.length, body.length, "分片拼起来的总字节数应与请求体一致");
  assert.ok(joined.every((b) => b === 7), "分片内容应与请求体一致");
  assert.equal(frames[frames.length - 1]?.type, FRAME_TYPE.CLOSE, "末帧应为 CLOSE");
});

test("通道被对端关闭：挂起请求立刻报错（不静默挂起），且下次请求重新握手", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  const sb = runShim({ pin: b64u(host.pub), hostId: "host-1" });
  const fetchFn = (sb.window as unknown as { fetch: (input: unknown, init?: unknown) => Promise<unknown> }).fetch;

  const pending = fetchFn(new URL("http://rdsh.local/api/settings/describe"), { method: "POST", body: "{}" });
  await waitFor(() => instances.length === 1 && (instances[0]?.sent.length ?? 0) >= 2);
  instances[0]!.deliverClose();

  // 回归：曾因为通道失效后不复位、不 reject，请求永远不 settle（"no error and no reply"）
  await assert.rejects(pending, /e2ee channel closed/, "通道关闭后挂起请求必须报错");

  // 自愈：通道变量复位，下一个请求重新握手（新建第二条内层连接）
  void fetchFn(new URL("http://rdsh.local/api/settings/describe"), { method: "POST", body: "{}" });
  await waitFor(() => instances.length === 2, 3000);
  assert.equal(instances.length, 2, "通道复位后应重新握手（新建内层连接）");
});

test("fetch 包装：input 为 URL 实例时必须解析出正确路径（DSH 传的是 URL，不是 string）", async () => {
  instances.length = 0;
  const host = await hostKeyPair();
  const sb = runShim({ pin: b64u(host.pub), hostId: "host-1" });
  const fetchFn = (sb.window as unknown as { fetch: (input: unknown, init?: unknown) => Promise<unknown> }).fetch;

  // 不 await：没有假主机回包，promise 会一直挂起（本用例只关心出向请求长什么样）
  void fetchFn(new URL("http://rdsh.local/api/settings/describe"), { method: "POST", body: "{}" });
  await waitFor(() => instances.length > 0 && (instances[0]?.sent.length ?? 0) >= 2);

  const inner = instances[0]!;
  // sent[0] = 明文 ephemeral 公钥；sent[1] = 首个加密包（非零 nonce 前缀）
  const key = await deriveI2r(host.priv, inner.sent[0]!);
  const packet = inner.sent[1]!;
  const pt = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: packet.slice(0, 12) }, key, packet.slice(12)));
  const open = new FrameParser().push(Buffer.from(pt)).find((f) => f.type === FRAME_TYPE.OPEN);
  assert.ok(open !== undefined, "应发出 OPEN 帧");
  const meta = JSON.parse(new TextDecoder().decode(open!.payload)) as { kind: string; method: string; path: string };
  assert.equal(meta.kind, "http");
  assert.equal(meta.method, "POST");
  // 回归：曾因为只认 input.url，URL 实例被解析成 "/undefined"，主机一律回 405
  assert.equal(meta.path, "/api/settings/describe", "URL 实例必须解析成正确路径（回归：曾为 /undefined）");
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
