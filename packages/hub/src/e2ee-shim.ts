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
          else if (f.type === FT.CLOSE || f.type === FT.ERROR) { if (h.onClose) h.onClose(); handlers.delete(f.streamId); }
        }
      }).catch(function () { try { ws.close(); } catch (e) {} });
    };
    channel = { ws: ws, enc: enc, handlers: handlers, alloc: function () { return nextId++; } };
    return channel;
  }
  async function sendFrame(c, type, streamId, payload) {
    var ct = await c.enc.encrypt(encodeFrame(type, streamId, payload));
    c.ws.send(ct.buffer);
  }

  // ---- fetch 包装 ----
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url);
    var u = new URL(url, location.href);
    if (!getHostId() || u.pathname.indexOf("/portal") === 0) return nativeFetch(input, init);
    return (async function () {
      var c = await ensureChannel(); var id = c.alloc();
      var method = (init && init.method) || "GET";
      var body = null;
      if (init && init.body != null) body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : new Uint8Array(init.body);
      var headers = {};
      if (init && init.headers) {
        if (typeof init.headers.forEach === "function") init.headers.forEach(function (v, k) { headers[k] = v; });
        else Object.keys(init.headers).forEach(function (k) { headers[k] = init.headers[k]; });
      }
      await sendFrame(c, FT.OPEN, id, JSON.stringify({ kind: "http", method: method, path: u.pathname + u.search, headers: headers }));
      if (body) await sendFrame(c, FT.DATA, id, body);
      await sendFrame(c, FT.CLOSE, id, JSON.stringify({ code: 0 }));

      return await new Promise(function (resolve, reject) {
        var status = 200, respHeaders = {}, chunks = [];
        c.handlers.set(id, {
          onOpen: function (p) { if (p.status != null) status = p.status; if (p.headers) respHeaders = p.headers; },
          onData: function (d) { chunks.push(d); },
          onClose: function () {
            var len = 0; chunks.forEach(function (d) { len += d.length; });
            var body = new Uint8Array(len); var off = 0;
            chunks.forEach(function (d) { body.set(d, off); off += d.length; });
            var text = new TextDecoder().decode(body);
            var ct = (respHeaders["content-type"] || "");
            var isJson = ct.indexOf("json") >= 0;
            var payload = isJson ? (text ? JSON.parse(text) : null) : text;
            resolve(new Response(isJson ? JSON.stringify(payload) : text, { status: status, headers: respHeaders }));
          }
        });
      });
    })();
  };

  // ---- WebSocket 包装 ----
  function WrappedWS(url, protocols) {
    var self = this;
    var u = new URL(url, location.href);
    var c = null, id = 0, queue = [];
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.send = function (data) {
      var bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      if (c && self.readyState === 1) sendFrame(c, FT.DATA, id, bytes);
      else queue.push(bytes);
    };
    this.close = function () { if (c) sendFrame(c, FT.CLOSE, id, JSON.stringify({ code: 0 })); };
    (async function () {
      try {
        c = await ensureChannel(); id = c.alloc();
        await sendFrame(c, FT.OPEN, id, JSON.stringify({ kind: "ws", path: u.pathname + u.search }));
        self.readyState = 1; if (self.onopen) self.onopen({});
        queue.forEach(function (b) { sendFrame(c, FT.DATA, id, b); }); queue = [];
        c.handlers.set(id, {
          onData: function (d) { if (self.onmessage) self.onmessage({ data: new TextDecoder().decode(d) }); },
          onClose: function () { self.readyState = 3; if (self.onclose) self.onclose({}); }
        });
      } catch (e) { self.readyState = 3; if (self.onerror) self.onerror({}); }
    })();
  }
  WrappedWS.prototype = Object.create(NativeWS.prototype);
  window.WebSocket = WrappedWS;
})();
</script>`;
