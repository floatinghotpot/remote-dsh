/**
 * secure-context-polyfill.ts — 非 secure context 兼容脚本（注入 DSH 首页）。
 *
 * 背景（查档）：DSH 浏览器侧 RPC 用 crypto.randomUUID()；但该 API 仅在 secure context
 * （HTTPS / localhost）可用。局域网模式为 http://<LAN-IP>（非 secure context），故需
 * polyfill：crypto.getRandomValues 是唯一非 secure context 也可用的 WebCrypto API。
 *
 * 另补 `navigator.clipboard`（同样仅 secure context 可用）：`writeText` 用
 * `document.execCommand("copy")` + 隐藏 textarea 实现（execCommand 不受 secure context
 * 限制，只需用户手势）。`readText` 无法安全 polyfill，保留 undefined。
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

/** 剪贴板 polyfill：非 secure context 下补 `navigator.clipboard.writeText`（execCommand('copy') 兜底）。 */
export const CLIPBOARD_POLYFILL = `(function () {
  if (typeof navigator === "undefined") return;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") return;
  function writeText(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = String(text);
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error("copy failed"));
    });
  }
  try {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeText },
      writable: true,
      configurable: true
    });
  } catch (e) { /* ignore */ }
})();`;
