/**
 * secure-context-polyfill.ts — 非 secure context 兼容脚本（注入 DSH 首页）。
 *
 * 背景（查档）：DSH 浏览器侧 RPC（dsh-client-connection/lib/client.js）用
 * crypto.randomUUID() 生成 MessageId/RpcId；但该 API 仅在 secure context
 * （HTTPS / localhost）可用。局域网模式为 http://<LAN-IP>（非 secure
 * context），故需 polyfill：crypto.getRandomValues 是唯一非 secure context
 * 也可用的 WebCrypto API，用它实现 UUID v4。
 */
export const SECURE_CONTEXT_POLYFILL = `(function () {
  if (typeof crypto === "undefined") return;
  if (typeof crypto.randomUUID === "function") return;
  try {
    Object.defineProperty(crypto, "randomUUID", {
      value: function () {
        var b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = "";
        for (var i = 0; i < 16; i++) {
          if (i === 4 || i === 6 || i === 8 || i === 10) h += "-";
          h += b[i].toString(16).padStart(2, "0");
        }
        return h;
      },
      writable: true
    });
  } catch (e) { /* ignore */ }
})();`;
