/**
 * e2ee-shim.ts — 注入到 DSH HTML 的 E2EE 数据面脚本（字符串常量，hub 注入）。
 *
 * 数据面 E2EE：HTML/JS bundle 明文（应用壳，非敏感）；API(fetch) + WS 加密。
 * 脚本在 DSH HTML <head> 最前注入，wrap window.fetch + window.WebSocket，
 * 单上下文共享一条 Noise NK 通道（浏览器发起方，X25519 + HKDF + AES-256-GCM）。
 * 仅当该 host 已被 pin（localStorage 有公钥）才 wrap；否则直通明文（optional 语义）。
 * 内层多路复用复用 tunnel 帧语义：OPEN(响应头/ws 开流) + DATA(体/消息) + CLOSE。
 */
export const E2EE_SHIM_HTML = `<script>
(function () {
  "use strict";
  var MAGIC = new Uint8Array([0x52, 0x44, 0x53, 0x48]);
  var HEADER_LEN = 15;
  var FT = { OPEN: 1, DATA: 2, CLOSE: 3, PING: 4, PONG: 5, ERROR: 6 };
  var LABEL = new TextEncoder().encode("rdsh-e2ee-nk-v1");
  var PINS_KEY = "rdsh_e2ee_pins";

  function fromB64u(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/"); var pad = s.length % 4; if (pad) s += "=".repeat(4 - pad);
    var bin = atob(s); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
  function encodeFrame(type, streamId, payload) {
    var p = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    var out = new Uint8Array(HEADER_LEN + p.length);
    out.set(MAGIC, 0); out[4] = 1; out[5] = 0; out[6] = type;
    new DataView(out.buffer).setUint32(7, streamId >>> 0, false);
    new DataView(out.buffer).setUint32(11, p.length >>> 0, false);
    out.set(p, HEADER_LEN); return out;
  }
  function FrameParser() { this.buf = new Uint8Array(0); }
  FrameParser.prototype.push = function (chunk) {
    var merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0); merged.set(chunk, this.buf.length); this.buf = merged;
    var frames = [];
    for (;;) {
      if (this.buf.length < HEADER_LEN) break;
      for (var i = 0; i < 4; i++) if (this.buf[i] !== MAGIC[i]) throw new Error("bad magic");
      var view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      var len = view.getUint32(11, false); var total = HEADER_LEN + len;
      if (this.buf.length < total) break;
      frames.push({ type: this.buf[6], streamId: view.getUint32(7, false), payload: this.buf.slice(HEADER_LEN, total) });
      this.buf = this.buf.slice(total);
    }
    return frames;
  };

  function getHostId() {
    // 优先用 hub 注入的 hostId：host cookie（rdsh_host）是 HttpOnly，document.cookie 读不到
    //（2026-09-14 实测：读不到 ⇒ 取不到 pin ⇒ 整段 shim 退出 ⇒ E2EE 静默失效）
    var injected = window.__RDSH_HOST_ID__;
    if (typeof injected === "string" && injected !== "") return injected;
    var m = document.cookie.match(/(?:^|; )rdsh_host=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function getPinnedKey() {
    try {
      var hostId = getHostId(); if (!hostId) return null;
      var pins = JSON.parse(localStorage.getItem(PINS_KEY) || "{}");
      return pins[hostId] ? fromB64u(pins[hostId]) : null;
    } catch (e) { return null; }
  }

  var hostPub = getPinnedKey();
  if (!hostPub) return; // 未信任 → 直通明文

  async function deriveKeys(ss) {
    var hkdf = await crypto.subtle.importKey("raw", ss, "HKDF", false, ["deriveBits"]);
    var okm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: LABEL, info: new TextEncoder().encode("session") }, hkdf, 512));
    return { i2r: okm.slice(0, 32), r2i: okm.slice(32) };
  }
  async function handshake() {
    var eph = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
    var ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
    var host = await crypto.subtle.importKey("raw", hostPub, "X25519", false, []);
    var ss = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: host }, eph.privateKey, 256));
    return { ephPub: ephPub, keys: await deriveKeys(ss) };
  }
  function Aead(key) { this.key = key; this.counter = 0n; }
  Aead.prototype.encrypt = async function (pt) {
    var nonce = new Uint8Array(12); new DataView(nonce.buffer).setBigUint64(4, this.counter); this.counter += 1n;
    var k = await crypto.subtle.importKey("raw", this.key, { name: "AES-GCM" }, false, ["encrypt"]);
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, pt));
    var out = new Uint8Array(12 + ct.length); out.set(nonce, 0); out.set(ct, 12); return out;
  };
  Aead.prototype.decrypt = async function (pkt) {
    var nonce = pkt.slice(0, 12); var data = pkt.slice(12);
    var k = await crypto.subtle.importKey("raw", this.key, { name: "AES-GCM" }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, data));
  };

  var NativeWS = window.WebSocket;
  var channel = null;
  // HTTP 请求体分片大小：内层 DATA 帧 → AES-GCM(12B nonce + 16B tag) → 外层 WS 消息，
  // 必须远低于隧道单帧上限 16 MiB（2026-09-14：整包发送曾让 18 MiB 附件变成 25 MB 单条
  // WS 消息，直接把 hub 打挂）。1 MiB 既安全又不产生过多帧。
  var CHUNK = 1 << 20;
  /** 通道失效（对端关闭/出错）：让挂起的请求**立刻报错**、复位通道以便下次重新握手。
   *  历史缺陷：只复位不复位 handlers、且不响应 close ⇒ 请求静默挂起（"no error and no reply"）。 */
  function failChannel(ch, reason) {
    if (ch.dead) return;
    ch.dead = true;
    if (channel === ch) channel = null;
    ch.handlers.forEach(function (h) {
      try { if (h.onError) h.onError(new Error(reason)); else if (h.onClose) h.onClose(); } catch (e) { /* 单个 handler 异常不影响其它 */ }
    });
    ch.handlers.clear();
  }
  async function ensureChannel() {
    if (channel) return channel;
    var hs = await handshake();
    var ws = new NativeWS((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/e2e");
    ws.binaryType = "arraybuffer";
    var enc = new Aead(hs.keys.i2r), dec = new Aead(hs.keys.r2i);
    var parser = new FrameParser(); var handlers = new Map(); var nextId = 1;
    await new Promise(function (resolve, reject) {
      ws.onopen = function () { ws.send(hs.ephPub.buffer); resolve(); };
      ws.onerror = function () { reject(new Error("e2ee ws error")); };
    });
    ws.onmessage = function (ev) {
      dec.decrypt(new Uint8Array(ev.data)).then(function (pt) {
        var frames = parser.push(pt);
        for (var i = 0; i < frames.length; i++) {
          var f = frames[i], h = handlers.get(f.streamId); if (!h) continue;
          if (f.type === FT.OPEN) { if (h.onOpen) h.onOpen(JSON.parse(new TextDecoder().decode(f.payload))); }
          else if (f.type === FT.DATA) { h.onData(f.payload); }
          else if (f.type === FT.CLOSE) { if (h.onClose) h.onClose(f.payload); handlers.delete(f.streamId); }
          else if (f.type === FT.ERROR) {
            // ERROR 帧必须**报错**：旧实现与 CLOSE 同路 ⇒ 上游不可达时 fetch 得到"200 空 body"而非失败
            var em = "upstream error";
            try { var ej = JSON.parse(new TextDecoder().decode(f.payload)); em = (ej && (ej.message || ej.code)) || em; } catch (e) { /* 保留默认文案 */ }
            if (h.onError) h.onError(new Error(em)); else if (h.onClose) h.onClose(f.payload);
            handlers.delete(f.streamId);
          }
        }
      }).catch(function () { try { ws.close(); } catch (e) {} });
    };
    var ch = { ws: ws, enc: enc, handlers: handlers, dead: false, alloc: function () { return nextId++; } };
    ws.onclose = function () { failChannel(ch, "e2ee channel closed"); };
    ws.onerror = function () { failChannel(ch, "e2ee channel error"); };
    channel = ch;
    return ch;
  }
  async function sendFrame(c, type, streamId, payload) {
    if (c.dead) throw new Error("e2ee channel closed");
    var ct = await c.enc.encrypt(encodeFrame(type, streamId, payload));
    if (c.dead) throw new Error("e2ee channel closed");
    c.ws.send(ct.buffer);
  }

  // ---- fetch 包装 ----
  var nativeFetch = window.fetch.bind(window);
  /** 无 body 的状态码：构造 Response 时不能带 body（204/205/304/1xx）。 */
  function isNullBodyStatus(s) { return s === 101 || s === 103 || s === 204 || s === 205 || s === 304; }
  window.fetch = function (input, init) {
    // input 可能是 string / URL / Request —— DSH 的 HTTP carrier 传的是 **URL 实例**
    //（2026-09-14 实测：只认 input.url ⇒ url=undefined ⇒ new URL(undefined, base) = "/undefined"
    //  ⇒ 所有 /api 请求打到错误路径、主机回 405，E2EE 下一片报错）
    var url = typeof input === "string" ? input : (input && (input.url || input.href)) || String(input);
    var u = new URL(url, location.href);
    if (!getHostId() || u.pathname.indexOf("/portal") === 0) return nativeFetch(input, init);
    return (async function () {
      var method = (init && init.method) || "GET";
      // 请求体归一化：**支持的类型必须字节正确，不支持的类型必须明确报错**（不得静默发错）。
      // 历史缺陷：只做 new Uint8Array(body) ⇒ Blob/ReadableStream 变 0 字节、FormData 变 1 个垃圾字节。
      var bodyBytes = null, bodyStream = null, bodyType = null;
      if (init && init.body != null) {
        var b = init.body;
        if (typeof b === "string") bodyBytes = new TextEncoder().encode(b);
        else if (b instanceof ArrayBuffer) bodyBytes = new Uint8Array(b);
        else if (ArrayBuffer.isView(b)) bodyBytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        else if (typeof URLSearchParams !== "undefined" && b instanceof URLSearchParams) {
          bodyBytes = new TextEncoder().encode(b.toString());
          bodyType = "application/x-www-form-urlencoded;charset=UTF-8";
        } else if (typeof FormData !== "undefined" && b instanceof FormData) {
          // 用 Response 编码 multipart（自动生成 boundary 并给出对应 content-type）
          var fd = new Response(b);
          bodyStream = fd.body; bodyType = fd.headers.get("content-type");
        } else if (typeof ReadableStream !== "undefined" && b instanceof ReadableStream) {
          bodyStream = b;
        } else if (typeof Blob !== "undefined" && b instanceof Blob) {
          bodyType = b.type || null;
          if (typeof b.stream === "function") bodyStream = b.stream();
          else bodyBytes = new Uint8Array(await b.arrayBuffer());
        } else {
          throw new TypeError("rdsh E2EE fetch: unsupported request body type: " + Object.prototype.toString.call(b));
        }
      }
      var headers = {};
      if (init && init.headers) {
        if (typeof init.headers.forEach === "function") init.headers.forEach(function (v, k) { headers[k] = v; });
        else Object.keys(init.headers).forEach(function (k) { headers[k] = init.headers[k]; });
      }
      var headerHas = function (name) {
        return Object.keys(headers).some(function (k) { return k.toLowerCase() === name; });
      };
      var headerDrop = function (name) {
        Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === name) delete headers[k]; });
      };
      if (bodyType !== null && !headerHas("content-type")) headers["content-type"] = bodyType;
      // 流式体长度未知：必须去掉可能存在的 content-length，否则上游会等一个永远发不满的体
      if (bodyStream !== null) headerDrop("content-length");
      var signal = init && init.signal;
      var c = await ensureChannel(); var id = c.alloc();
      return await new Promise(function (resolve, reject) {
        var status = 200, statusText = "", respHeaders = {}, ctrl = null, settled = false, aborted = false;
        // 响应体**按字节流式**透传，交给原生 Response 处理 .text()/.json()/.arrayBuffer()。
        // 历史缺陷：整体缓冲到 CLOSE + 一律 TextDecoder 解码 + JSON 走 parse→stringify
        //  ⇒ 二进制（PDF/图片）损坏、response.body.getReader() 拿到的是"一次性全给"、
        //    大响应全量驻留内存（AC2/AC3）。
        var stream = new ReadableStream({
          start: function (controller) { ctrl = controller; },
          cancel: function () {
            // 消费方取消（pdf.js 会放弃 Range 请求）→ 通知 host 中止上游流
            aborted = true;
            c.handlers.delete(id);
            if (!settled) { settled = true; reject(new Error("e2ee response cancelled")); }
            sendFrame(c, FT.CLOSE, id, JSON.stringify({ code: 1, message: "client cancelled" })).catch(function () {});
          }
        });
        /** 响应头一到就 resolve（body 继续流），无 body 状态码则直接收尾。 */
        function settle() {
          if (settled) return;
          settled = true;
          if (isNullBodyStatus(status)) {
            try { ctrl.close(); } catch (e) { /* 已关闭 */ }
            resolve(new Response(null, { status: status, statusText: statusText, headers: respHeaders }));
            return;
          }
          resolve(new Response(stream, { status: status, statusText: statusText, headers: respHeaders }));
        }
        // 先挂 handler 再发帧：否则快响应（如 400）可能早于 handler 注册而丢失
        c.handlers.set(id, {
          onOpen: function (p) {
            if (p.status != null) status = p.status;
            if (p.reason != null) statusText = String(p.reason);
            if (p.headers) respHeaders = p.headers;
            settle();
          },
          onData: function (d) { if (ctrl && !aborted) ctrl.enqueue(new Uint8Array(d)); },
          onClose: function (payload) {
            // CLOSE 带非零 code（如 UPSTREAM_ABORTED）＝响应体被截断，必须**报错**，
            // 否则 chunked 响应（无 content-length）下消费方会把截断的 body 当成功（2026-09-14 复审发现）
            var code = 0, msg = null;
            if (payload && payload.length) {
              try { var m = JSON.parse(new TextDecoder().decode(payload)); if (m && m.code != null && m.code !== 0) { code = m.code; msg = m.message || null; } } catch (e) { /* 无 code 视为干净结束 */ }
            }
            if (code !== 0) {
              var err = new Error(msg || ("upstream error: " + code));
              if (!settled) { settled = true; reject(err); }
              else if (ctrl) { try { ctrl.error(err); } catch (e) { /* 已报错 */ } }
              return;
            }
            if (!settled) settle();
            if (ctrl && !aborted) { try { ctrl.close(); } catch (e) { /* 已关闭 */ } }
          },
          // 通道断了必须**报错**，不能静默挂起（2026-09-14 实测：超大帧被 hub 以 1009 拒绝后
          // 请求永远不 settle，用户看到的是 "no error and no reply"）
          onError: function (err) {
            c.handlers.delete(id);
            if (!settled) { settled = true; reject(err); return; }
            if (ctrl) { try { ctrl.error(err); } catch (e) { /* 已报错 */ } }
          }
        });
        if (signal) {
          if (signal.aborted) {
            c.handlers.delete(id);
            settled = true;
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", function () {
            aborted = true;
            c.handlers.delete(id);
            if (ctrl) { try { ctrl.error(new Error("aborted")); } catch (e) { /* 已报错 */ } }
            sendFrame(c, FT.CLOSE, id, JSON.stringify({ code: 1, message: "client aborted" })).catch(function () {});
          });
        }
        (async function () {
          try {
            await sendFrame(c, FT.OPEN, id, JSON.stringify({ kind: "http", method: method, path: u.pathname + u.search, headers: headers }));
            // 请求体**分片**：gateway 侧对每个 DATA 帧执行 up.write()（join.ts:621），
            // 所以 http 流的多个 DATA 帧会被拼成同一个请求体（2026-09-14 起支持 >16 MiB 上传）
            if (bodyBytes) {
              for (var off = 0; off < bodyBytes.length; off += CHUNK) {
                await sendFrame(c, FT.DATA, id, bodyBytes.subarray(off, Math.min(off + CHUNK, bodyBytes.length)));
              }
            } else if (bodyStream) {
              // 流式体：边读边发（不整体 buffering），每块仍按 CHUNK 上限切分
              var reader = bodyStream.getReader();
              for (;;) {
                if (aborted || c.dead) { try { reader.cancel(); } catch (e) { /* 已取消 */ } break; }
                var step = await reader.read();
                if (step.done) break;
                if (step.value == null) continue;
                var chunk = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value);
                for (var off2 = 0; off2 < chunk.length; off2 += CHUNK) {
                  await sendFrame(c, FT.DATA, id, chunk.subarray(off2, Math.min(off2 + CHUNK, chunk.length)));
                }
              }
              try { reader.releaseLock(); } catch (e) { /* 已释放 */ }
            }
            await sendFrame(c, FT.CLOSE, id, JSON.stringify({ code: 0 }));
          } catch (err) {
            c.handlers.delete(id);
            if (!settled) { settled = true; reject(err); return; }
            if (ctrl) { try { ctrl.error(err); } catch (e) { /* 已报错 */ } }
          }
        })();
      });
    })();
  };

  // ---- WebSocket 包装 ----
  // 门面必须覆盖 DSH 的实际调用面（dsh-api-gateway/lib/client.js）：
  // ① addEventListener/removeEventListener（含 { once: true }）；
  // ② 静态常量 CONNECTING/OPEN/CLOSING/CLOSED（DSH 以 readyState === WebSocket.OPEN 判定）；
  // ③ on* 与 addEventListener 双通道都要派发；④ close() 必须落到 CLOSED 并派发 close。
  // 历史缺陷：只实现了 on* ⇒ 远端流通道建不起来（设置页 Models 报 settings are unavailable）。
  /**
   * 定义**自有**数据属性。
   *
   * 必须这样做：WrappedWS 继承了 native WebSocket.prototype，而 url/protocol/extensions/
   * bufferedAmount/readyState/on* 在那里都是**只有 getter**（或带 brand 校验）的访问器；
   * 本文件是严格模式，直接 this.url = … 会抛
   * "Cannot set property url of #<WebSocket> which has only a getter" ⇒ 构造函数整体失败
   *（2026-09-14 真机实测：dsh-api-gateway 插件 loader entry 报这个错，E2EE 通道建不起来）。
   */
  function own(obj, name, value) {
    Object.defineProperty(obj, name, { value: value, writable: true, configurable: true, enumerable: true });
  }
  function WrappedWS(url, protocols) {
    var self = this;
    var u = new URL(url, location.href);
    var c = null, id = 0, queue = [], closed = false;
    var listeners = { open: [], message: [], close: [], error: [] };
    own(this, "url", u.href);
    own(this, "protocol", typeof protocols === "string" ? protocols : (protocols && protocols[0]) || "");
    own(this, "extensions", "");
    own(this, "binaryType", "blob");
    own(this, "bufferedAmount", 0);
    own(this, "readyState", 0); // CONNECTING
    own(this, "onopen", null);
    own(this, "onmessage", null);
    own(this, "onclose", null);
    own(this, "onerror", null);

    function emit(type, event) {
      var direct = self["on" + type];
      if (typeof direct === "function") { try { direct.call(self, event); } catch (e) { /* 单个监听器异常不影响其它 */ } }
      var list = listeners[type];
      for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        try { entry.fn.call(self, event); } catch (e) { /* 同上 */ }
        if (entry.once) { list.splice(i, 1); i--; }
      }
    }
    /** 关闭统一出口：置 CLOSED 并派发 close（幂等）。 */
    function shutdown() {
      if (self.readyState === 3) return;
      self.readyState = 3;
      emit("close", { type: "close", code: 1000, wasClean: true });
    }

    this.addEventListener = function (type, fn, options) {
      var list = listeners[type];
      if (list === undefined || typeof fn !== "function") return;
      var once = !!(options && options.once);
      for (var i = 0; i < list.length; i++) if (list[i].fn === fn && list[i].once === once) return;
      list.push({ fn: fn, once: once });
    };
    this.removeEventListener = function (type, fn) {
      var list = listeners[type];
      if (list === undefined) return;
      for (var i = 0; i < list.length; i++) if (list[i].fn === fn) { list.splice(i, 1); return; }
    };
    this.send = function (data) {
      if (closed || self.readyState === 3) return; // 已关闭：静默丢弃（贴近原生）
      var bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      if (c && self.readyState === 1) sendFrame(c, FT.DATA, id, bytes).catch(function () { shutdown(); });
      else queue.push(bytes);
    };
    this.close = function () {
      if (closed) return;
      closed = true;
      if (self.readyState < 2) self.readyState = 2; // CLOSING
      if (c) sendFrame(c, FT.CLOSE, id, JSON.stringify({ code: 0 })).catch(function () { /* 通道已断，无需再通知 */ });
      shutdown();
    };
    (async function () {
      try {
        c = await ensureChannel(); id = c.alloc();
        await sendFrame(c, FT.OPEN, id, JSON.stringify({ kind: "ws", path: u.pathname + u.search }));
        if (closed) { sendFrame(c, FT.CLOSE, id, JSON.stringify({ code: 0 })); return; }
        // handlers 必须在派发 open 之前挂好：否则 OPEN 与 open 之间到达的帧会被丢掉
        c.handlers.set(id, {
          onData: function (d) { emit("message", { type: "message", data: new TextDecoder().decode(d) }); },
          onClose: function () { shutdown(); }
        });
        self.readyState = 1; // OPEN
        emit("open", { type: "open" });
        for (var i = 0; i < queue.length; i++) sendFrame(c, FT.DATA, id, queue[i]).catch(function () { shutdown(); });
        queue = [];
      } catch (e) { self.readyState = 3; emit("error", { type: "error" }); }
    })();
  }
  WrappedWS.prototype = Object.create(NativeWS.prototype);
  WrappedWS.CONNECTING = NativeWS.CONNECTING;
  WrappedWS.OPEN = NativeWS.OPEN;
  WrappedWS.CLOSING = NativeWS.CLOSING;
  WrappedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = WrappedWS;
})();
</script>`;

/**
 * 注入 E2EE shim，并把 hostId 一并交给它。
 *
 * 必要性：host cookie（`rdsh_host`）是 **HttpOnly**，页面 JS 读不到（`document.cookie` 里没有），
 * 而 shim 需要 hostId 去 localStorage 的 pin 表里取对端公钥 —— 读不到就直接退出、E2EE 静默失效
 *（2026-09-14 实测：`document.cookie.includes("rdsh_host") === false`）。
 *
 * 顺序：**先 hostId bootstrap，再 shim**（shim 是立即执行的 IIFE，解析到就会跑）。
 */
export function injectE2eeShim(html: string, hostId: string): string {
  const bootstrap = `<script>window.__RDSH_HOST_ID__=${JSON.stringify(hostId)};</script>`;
  const inject = `${bootstrap}${E2EE_SHIM_HTML}`;
  // 函数式替换：避免 hostId 含 `$&`/`$'` 时被 String.replace 当作替换模式展开
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (_m, attrs: string) => `<head${attrs}>${inject}`);
  }
  // 无 <head> 时也必须注入，否则 E2EE 再次静默失效（宁可写在文档最前）
  return inject + html;
}
