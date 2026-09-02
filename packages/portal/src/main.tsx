import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./pages.tsx";
import { REFRESH_KEY } from "./api.ts";

// 微信登录 302 回调后：后端把 refresh token 放进短效非 HttpOnly cookie 交接，
// 这里搬进 sessionStorage（供 401 静默续期）并清掉交接 cookie。
(function consumeWechatRefreshHandoff(): void {
  const m = /(?:^|;\s*)rdsh_wechat_refresh=([^;]*)/.exec(document.cookie);
  if (m !== null && m[1] !== undefined && m[1] !== "") {
    try {
      sessionStorage.setItem(REFRESH_KEY, decodeURIComponent(m[1]));
    } catch {
      // 非法值忽略
    }
    document.cookie = "rdsh_wechat_refresh=; Path=/; Max-Age=0";
  }
})();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
