/**
 * dsh-web-remote — client half (browser settings section).
 *
 * module-loader factory format (mirrors dsh-client-ui-settings-plugins).
 * Registers a "settings.section" slot rendering the Remote Access panel:
 * status point + join form (hub/token/name) + Connect/Disconnect/Revoke.
 * Talks to the server half over the `/remote-access` RPC channel.
 *
 * i18n: registers zh/en dictionaries under NS and reads via ctx.locale.bind(NS);
 * falls back to English when the locale service is absent.
 */
window.__ModuleLoader__.load({
  id: "dsh-web-remote",
  factory: (require) => {
    const React = require("react");

    const inject = ["connection", "slots", "locale"];
    const NS = "settings.remote-access";

    const zh = {
      nav: "远程访问",
      status_unconfigured: "未接入",
      status_disconnected: "未接入（已断开，配置保留）",
      status_connecting: "连接中…",
      status_connected: "已连接",
      status_reconnecting: "断线重连…",
      status_external: "已接入（由 rdsh CLI / 服务托管）",
      hubUrl: "云端中转服务器",
      joinToken: "授权令牌",
      name: "这台主机的名称",
      hubHint: "这台主机要接入的服务器地址，接入后即可在任意设备访问；默认已填好，无需修改；只有自己部署服务器时才需改。",
      nameHint: "给这台主机起的名称，方便在主机列表里认出它；默认取本机名称，可改。",
      scanConnect: "扫码接入",
      tokenConnect: "令牌接入",
      scanWaiting: "等待手机确认",
      scanTip: "打开「鲸语通」App，用「地址列表」右上角的扫码，扫描下方二维码。",
      scanExpiresIn: "有效期剩余 {s}",
      scanRefresh: "刷新二维码",
      scanExpired: "二维码已过期",
      scanSwitchToken: "改用令牌接入",
      tokenHint: "用浏览器打开上面的服务器地址，在「添加主机」里复制「授权令牌」，粘贴到上方后点「令牌接入」。",
      hubPlaceholder: "https://hub.example.com",
      tokenPlaceholder: "一次性授权令牌",
      namePlaceholder: "my-mac",
      connect: "接入",
      disconnect: "断开",
      revoke: "注销",
      confirmOverwrite: "将覆盖现有 host 配置，再次点击接入确认",
      rpcTimeout: "请求超时，请重试",
      pluginLabel: "插件",
      directLabel: "内网直连",
      directOn: "已开启 · 端口 {port}",
      directOff: "未开启",
      directHintSame: "同一网络下，自动优先走内网直连：延迟更低、速度更快。",
      directHintOther: "不在同一网络时，自动回落到云端中转。",
      tip_unconfigured: "在 hub 门户「添加主机」获取授权令牌，粘贴到下方后点击接入。",
      tip_connecting: "正在注册并建立隧道…",
      accessBrowserLabel: "浏览器登录",
      accessBrowserHint: "，在主机列表中点击进入",
      accessAppLabel: "登录「鲸语通」App",
      accessAppHint: "，在主机列表里点击进入",
      tip_reconnecting: "隧道断开，正在自动重连，无需操作。",
      tip_disconnected: "已断开，配置与授权已保留，点击接入即可恢复。如需更换服务器或主机名，请先注销。",
      tip_external: "该主机由 rdsh CLI / 服务托管，请用 rdsh 命令管理。",
      uiCompatLabel: "端到端加密时，信任为本地访问（兼容模式）",
      securityTitle: "安全保护",
      accessCodeLabel: "访问密码",
      accessCodeBadgeSet: "已设置",
      accessCodeBadgeUnset: "未设置",
      accessCodePlaceholder: "新密码（≥4 位）",
      accessCodeSet: "设置",
      accessCodeClear: "清除",
      pickerLabel: "目录选择",
      pickerOkText: "浏览器内（browse）",
      pickerBadText: "宿主原生对话框（native）——远端浏览器无法操作",
      pickerHint: "插件已把目录选择器固定为浏览器内形态；若显示 native，通常是被其它 patch 层覆盖（目录选择器只允许一个 pin 通道）。",
      pickerUnknownText: "未知",
    };

    const en = {
      nav: "Remote Access",
      status_unconfigured: "Not joined",
      status_disconnected: "Disconnected (config kept)",
      status_connecting: "Connecting…",
      status_connected: "Connected",
      status_reconnecting: "Reconnecting…",
      status_external: "Managed by rdsh CLI/service",
      hubUrl: "Cloud relay server",
      joinToken: "Auth Token",
      name: "This host's name",
      hubHint: "The server this host connects to, so you can reach it from anywhere. Already filled in — change it only if you run your own server.",
      nameHint: "A name for this host, shown in the host list. Defaults to the machine name.",
      scanConnect: "Scan to connect",
      tokenConnect: "Token connect",
      scanWaiting: "Waiting for phone",
      scanTip: "Open the WhaleLink app and scan this QR with the scanner at the top-right of the host list.",
      scanExpiresIn: "expires in {s}",
      scanRefresh: "Refresh QR",
      scanExpired: "QR code expired",
      scanSwitchToken: "Use token instead",
      tokenHint: "Open the server URL above in a browser, copy the auth token from \"Add host\", paste it above, then click Token connect.",
      hubPlaceholder: "https://hub.example.com",
      tokenPlaceholder: "One-time auth token",
      namePlaceholder: "my-mac",
      connect: "Connect",
      disconnect: "Disconnect",
      revoke: "Revoke",
      confirmOverwrite: "Will overwrite existing host config — click Connect again to confirm",
      rpcTimeout: "Request timed out — please retry",
      pluginLabel: "Plugin",
      directLabel: "LAN direct",
      directOn: "enabled · port {port}",
      directOff: "disabled",
      directHintSame: "On the same network, access automatically prefers the LAN direct path for lower latency and higher speed.",
      directHintOther: "On a different network, it falls back to the cloud relay.",
      tip_unconfigured: "Get an auth token from the hub portal (Add host), paste it below, then click Connect.",
      tip_connecting: "Registering and establishing the tunnel…",
      accessBrowserLabel: "Browser:",
      accessBrowserHint: " — sign in, then tap this host in the host list",
      accessAppLabel: "App:",
      accessAppHint: " sign in to the WhaleLink app, then tap this host in the host list",
      tip_reconnecting: "The tunnel dropped; it is reconnecting automatically — no action needed.",
      tip_disconnected: "Disconnected — config and auth are kept. Click Connect to resume. To change the server or host name, revoke first.",
      tip_external: "This host is managed by the rdsh CLI/service; manage it with rdsh commands.",
      uiCompatLabel: "Trust as local access when E2EE (compatibility)",
      securityTitle: "Security",
      accessCodeLabel: "Access code",
      accessCodeBadgeSet: "Set",
      accessCodeBadgeUnset: "Not set",
      accessCodePlaceholder: "New code (≥4)",
      accessCodeSet: "Set",
      accessCodeClear: "Clear",
      pickerLabel: "Directory picker",
      pickerOkText: "In-app browser (browse)",
      pickerBadText: "Host OS dialog (native) — unusable from a remote browser",
      pickerHint: "The plugin pins the picker to the in-app browser. Seeing native usually means another patch layer overrode it (only one pin channel is allowed).",
      pickerUnknownText: "Unknown",
    };

    const CSS = `
      .dsh-web-remote{display:flex;flex-direction:column;gap:12px;max-width:560px}
      .dsh-web-remote-status{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:1.5}
      .dsh-web-remote-dot{width:8px;height:8px;border-radius:9999px;flex:0 0 auto;background:var(--dsw-alias-label-tertiary)}
      .dsh-web-remote-dot.connecting{background:var(--dsw-alias-state-warn-primary);animation:dwr-pulse 1s ease-in-out infinite}
      .dsh-web-remote-dot.connected{background:var(--dsw-alias-state-success-primary)}
      .dsh-web-remote-dot.reconnecting{background:var(--dsw-alias-state-error-primary);animation:dwr-pulse 1s ease-in-out infinite}
      @keyframes dwr-pulse{0%,100%{opacity:1}50%{opacity:.35}}
      .dsh-web-remote-msg{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
      .dsh-web-remote-access-list{display:flex;flex-direction:column;gap:4px}
      .dsh-web-remote-tip{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
      .dsh-web-remote-tip-url{color:var(--dsw-alias-brand-primary);word-break:break-all;text-decoration:none}
      .dsh-web-remote-tip-url:hover{text-decoration:underline}
      .dsh-web-remote-direct-block{display:flex;flex-direction:column;gap:4px}
      .dsh-web-remote-direct{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
      .dsh-web-remote-direct.on{color:var(--dsw-alias-label-secondary)}
      .dsh-web-remote-direct.on .dsh-web-remote-dot{background:var(--dsw-alias-state-success-primary)}
      .dsh-web-remote-footer{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
      .dsh-web-remote-section{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
      .dsh-web-remote-section-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}
      .dsh-web-remote-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
      .dsh-web-remote-field+.dsh-web-remote-field{border-top:1px solid var(--dsw-alias-border-l2)}
      .dsh-web-remote-field label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
      .dsh-web-remote-field input{width:100%;box-sizing:border-box;height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font:inherit;font-size:13px;line-height:1.5}
      .dsh-web-remote-field input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
      .dsh-web-remote-field input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
      .dsh-web-remote-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .dsh-web-remote-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:18px;cursor:pointer;font:inherit;font-size:14px;line-height:22px;padding:0 14px;color:var(--dsw-alias-label-primary);background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}
      .dsh-web-remote-btn:hover:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill)}
      .dsh-web-remote-btn:disabled{cursor:not-allowed;opacity:.4}
      .dsh-web-remote-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);box-shadow:none}
      .dsh-web-remote-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
      .dsh-web-remote-btn-danger{color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-error-primary)}
      .dsh-web-remote-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
      .dsh-web-remote-accesscode{display:flex;align-items:center;gap:8px}
      /* 访问密码：短口令而已，固定窄宽度（16 位绰绰有余），不占满整行 */
      .dsh-web-remote-accesscode input{flex:0 0 auto;width:170px;min-width:0}
      .dsh-web-remote-accesscode-badge{flex:0 0 auto;font-size:12px;line-height:22px;padding:0 10px;border-radius:11px;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
      .dsh-web-remote-scan{display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 0}
      .dsh-web-remote-qr{width:180px;height:180px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.15)}
      .dsh-web-remote-accesscode-badge.set{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
      /* iOS（Safari / WKWebView，含微信等 App 内浏览器）对 computed font-size < 16px 的
         输入框，聚焦时会自动放大整页。面板里的字号是 13px，所以在窄屏/触屏下提到 16px；
         桌面观感保持不变。改这里请同步 test/client-input-font-size.test.ts 的断言。 */
      @media (max-width: 640px),(pointer: coarse){
        .dsh-web-remote input,.dsh-web-remote select,.dsh-web-remote textarea{font-size:16px}
      }
    `;

    let styleInjected = false;
    function injectStyle() {
      if (styleInjected || typeof document === "undefined") return;
      styleInjected = true;
      const el = document.createElement("style");
      el.setAttribute("data-plugin-css", "dsh-web-remote");
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    const DEFAULT_HUB = "https://rdsh.cn"; // R10④：构建期常量，自建分发时替换

    function Field({ label, value, disabled, placeholder, onChange, onFocus, hint }) {
      return React.createElement(
        "div",
        { className: "dsh-web-remote-field" },
        React.createElement("label", null, label),
        React.createElement("input", {
          value,
          disabled,
          placeholder,
          onChange: (e) => onChange(e.target.value),
          onFocus,
        }),
        hint ? React.createElement("span", { className: "dsh-web-remote-tip" }, hint) : null,
      );
    }

    function Panel({ rpc, t }) {
      const [status, setStatus] = React.useState("unconfigured");
      const [hub, setHub] = React.useState(DEFAULT_HUB);
      const [name, setName] = React.useState("");
      const [token, setToken] = React.useState("");
      const [message, setMessage] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [confirmOverwrite, setConfirmOverwrite] = React.useState(false);
      const [savedToken, setSavedToken] = React.useState(false);
      const [uiCompat, setUiCompat] = React.useState(true);
      const [hasAccessCode, setHasAccessCode] = React.useState(false);
      const [codeInput, setCodeInput] = React.useState("");
      const [codeBusy, setCodeBusy] = React.useState(false);
      const [pickerKind, setPickerKind] = React.useState(undefined);
      const [pickerOk, setPickerOk] = React.useState(undefined);
      const [pluginVersion, setPluginVersion] = React.useState(undefined);
      const [pluginName, setPluginName] = React.useState(undefined);
      const [direct, setDirect] = React.useState(undefined);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await rpc.call("/remote-access", "state", { args: {} });
            if (!alive || !res.ok) return;
            const v = res.value || {};
            setStatus(v.status || "unconfigured");
            if (typeof v.hub === "string") setHub(v.hub);
            if (typeof v.name === "string") setName(v.name);
            if (typeof v.message === "string" && v.message !== "") setMessage(v.message);
            setSavedToken(v.hasToken === true);
            if (typeof v.uiCompat === "boolean") setUiCompat(v.uiCompat);
            if (typeof v.hasAccessCode === "boolean") setHasAccessCode(v.hasAccessCode);
            if (typeof v.pickerKind === "string") setPickerKind(v.pickerKind);
            if (typeof v.pluginVersion === "string") setPluginVersion(v.pluginVersion);
            if (typeof v.pluginName === "string") setPluginName(v.pluginName);
            if (v.direct !== null && typeof v.direct === "object") setDirect(v.direct);
            if (typeof v.pickerOk === "boolean") setPickerOk(v.pickerOk);
          } catch {
            /* 瞬时错误忽略，下一轮重试 */
          }
        };
        void tick();
        const id = setInterval(() => void tick(), 1000);
        return () => {
          alive = false;
          clearInterval(id);
        };
      }, [rpc]);

      const external = status === "external";
      const showForm = status === "unconfigured" || status === "disconnected";
      const showDisconnect = status === "connecting" || status === "connected" || status === "reconnecting";
      const showRevoke = status === "disconnected" || showDisconnect;

      // 带超时的 RPC：服务端偶发不回包时，按钮也不会永久卡在 loading（15s 后按失败处理）。
      const callRpc = async (endpoint, args = {}, ms = 15000) => {
        let timer;
        try {
          return await Promise.race([
            rpc.call("/remote-access", endpoint, { args }),
            new Promise((resolve) => {
              timer = setTimeout(
                () => resolve({ ok: false, error: { code: "timeout", message: t("rpcTimeout") } }),
                ms,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };

      const connect = async () => {
        setBusy(true);
        try {
          const res = await callRpc("connect", { hub, token, name, confirmOverwrite: confirmOverwrite || undefined });
          if (!res.ok) {
            if (res.error && res.error.code === "mode-conflict") {
              setConfirmOverwrite(true);
              setMessage(t("confirmOverwrite"));
            } else {
              setMessage(res.error ? res.error.message : "connect failed");
            }
          } else {
            setToken("");
            setConfirmOverwrite(false);
            setMessage(undefined);
          }
        } finally {
          setBusy(false);
        }
      };

      const disconnect = async () => {
        setBusy(true);
        try {
          await callRpc("disconnect");
        } finally {
          setBusy(false);
        }
      };

      const revoke = async () => {
        setBusy(true);
        try {
          await callRpc("revoke");
          // 保留服务器地址/主机名，方便直接重新绑定（清空会导致"缺少服务器地址"）
          setHub((h) => (h.trim() === "" ? DEFAULT_HUB : h));
        } finally {
          setBusy(false);
        }
      };

      const setCode = async () => {
        setCodeBusy(true);
        try {
          const res = await rpc.call("/remote-access", "set-access-code", { args: { code: codeInput } });
          if (!res.ok) {
            setMessage(res.error ? res.error.message : "set-access-code failed");
          } else {
            setCodeInput("");
            setHasAccessCode(res.value?.hasAccessCode === true);
            setMessage(undefined);
          }
        } finally {
          setCodeBusy(false);
        }
      };

      const clearCode = async () => {
        setCodeBusy(true);
        try {
          const res = await rpc.call("/remote-access", "set-access-code", { args: { code: null } });
          if (!res.ok) {
            setMessage(res.error ? res.error.message : "clear-access-code failed");
          } else {
            setCodeInput("");
            setHasAccessCode(false);
            setMessage(undefined);
          }
        } finally {
          setCodeBusy(false);
        }
      };

      const [scan, setScan] = React.useState(undefined); // { bindId, qrDataUri, expiresAt }
      const [scanStatus, setScanStatus] = React.useState("idle"); // idle | showing | expired
      const [tokenMode, setTokenMode] = React.useState(false); // 令牌接入是否展开
      const [remaining, setRemaining] = React.useState(0);

      const beginScan = async () => {
        setBusy(true);
        setMessage(undefined);
        setTokenMode(false);
        try {
          const res = await rpc.call("/remote-access", "begin-scan", { args: { hub, name } });
          if (!res.ok) {
            setMessage(res.error ? res.error.message : "begin-scan failed");
            return;
          }
          const v = res.value || {};
          setScan(v);
          setScanStatus("showing");
          setRemaining(Math.max(0, Math.round(((v.expiresAt ?? 0) - Date.now()) / 1000)));
        } finally {
          setBusy(false);
        }
      };

      const resetScan = () => {
        setScan(undefined);
        setScanStatus("idle");
        setRemaining(0);
        setMessage(undefined);
      };

      // 显示二维码期间：每 2s 轮询 scan-state，每秒倒计时
      React.useEffect(() => {
        if (scanStatus !== "showing") return;
        let alive = true;
        const tick = async () => {
          try {
            const res = await rpc.call("/remote-access", "scan-state", { args: {} });
            if (!alive || !res.ok) return;
            const st = res.value && res.value.status;
            if (st === "expired") {
              setScanStatus("expired");
            } else if (st === "connecting" || st === "connected") {
              resetScan();
            }
          } catch {
            /* 瞬时错误忽略 */
          }
        };
        void tick();
        const poll = setInterval(() => void tick(), 2000);
        const countdown = setInterval(() => {
          setRemaining((r) => {
            if (r <= 1) {
              setScanStatus("expired");
              return 0;
            }
            return r - 1;
          });
        }, 1000);
        return () => {
          alive = false;
          clearInterval(poll);
          clearInterval(countdown);
        };
      }, [scanStatus]);

      const disabled = busy || external;
      // 未接入态需要令牌；断开态可留空（复用已保存授权）
      const canConnect = !disabled && hub.trim() !== "" && (status !== "unconfigured" || token.trim() !== "");
      const isUnconfigured = status === "unconfigured";
      // 断开且配置保留：地址/主机名已由持久化 host token 绑定，改动会导致接入失败 → 锁成只读
      const fieldsLocked = status === "disconnected";

      const statusLine = React.createElement(
        "div",
        { className: "dsh-web-remote-status" },
        React.createElement("span", { className: "dsh-web-remote-dot " + status }),
        React.createElement("span", null, t("status_" + status)),
      );

      const scanning = showForm && (scanStatus === "showing" || scanStatus === "expired");

      const form = showForm && !scanning
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(Field, {
              label: t("hubUrl"),
              value: hub,
              disabled: disabled || fieldsLocked,
              placeholder: t("hubPlaceholder"),
              hint: t("hubHint"),
              onChange: setHub,
            }),
            React.createElement(Field, {
              label: t("name"),
              value: name,
              disabled: disabled || fieldsLocked,
              placeholder: t("namePlaceholder"),
              hint: t("nameHint"),
              onChange: setName,
            }),
            tokenMode
              ? React.createElement(Field, {
                  label: t("joinToken"),
                  value: token !== "" ? token : savedToken ? "••••••••" : "",
                  disabled,
                  placeholder: t("tokenPlaceholder"),
                  hint: t("tokenHint"),
                  onFocus: (e) => {
                    if (token === "" && savedToken) e.target.select();
                  },
                  onChange: setToken,
                })
              : null,
          )
        : null;

      const scanScreen = scanning
        ? React.createElement(
            "div",
            { className: "dsh-web-remote-scan" },
            React.createElement("p", { className: "dsh-web-remote-tip" }, scanStatus === "expired" ? t("scanExpired") : t("scanTip")),
            scan && scan.qrDataUri
              ? React.createElement("img", { className: "dsh-web-remote-qr", src: scan.qrDataUri, alt: "QR" })
              : scan && scan.bindId
                ? React.createElement("p", { className: "dsh-web-remote-tip" }, "rdsh://bind?code=" + scan.bindId)
                : null,
            scanStatus === "showing"
              ? React.createElement("p", { className: "dsh-web-remote-tip" }, t("scanExpiresIn").replace("{s}", String(remaining)))
              : null,
            React.createElement(
              "div",
              { className: "dsh-web-remote-actions" },
              React.createElement("button", { className: "dsh-web-remote-btn dsh-web-remote-btn-primary", onClick: beginScan }, t("scanRefresh")),
              React.createElement(
                "button",
                { className: "dsh-web-remote-btn", onClick: () => { resetScan(); setTokenMode(true); } },
                t("scanSwitchToken"),
              ),
            ),
          )
        : null;

      // 未配置 → 扫码/令牌两条绑定通路；已配置但断开 → 接入（复用已存令牌）+ 注销。
      const actions = external
        ? null
        : scanning
          ? null // 扫码屏自带按钮
          : isUnconfigured
            ? tokenMode
              ? React.createElement(
                  "div",
                  { className: "dsh-web-remote-actions" },
                  React.createElement("button", { className: "dsh-web-remote-btn dsh-web-remote-btn-primary", disabled: !canConnect, onClick: connect }, busy ? "…" : t("tokenConnect")),
                  React.createElement("button", { className: "dsh-web-remote-btn", onClick: () => setTokenMode(false) }, t("scanConnect")),
                )
              : React.createElement(
                  "div",
                  { className: "dsh-web-remote-actions" },
                  React.createElement("button", { className: "dsh-web-remote-btn dsh-web-remote-btn-primary", disabled, onClick: beginScan }, busy ? "…" : t("scanConnect")),
                  React.createElement("button", { className: "dsh-web-remote-btn", onClick: () => setTokenMode(true) }, t("tokenConnect")),
                )
            : React.createElement(
                "div",
                { className: "dsh-web-remote-actions" },
                showForm
                  ? React.createElement("button", { className: "dsh-web-remote-btn dsh-web-remote-btn-primary", disabled: !canConnect, onClick: connect }, busy ? "…" : t("connect"))
                  : null,
                showDisconnect
                  ? React.createElement("button", { className: "dsh-web-remote-btn", disabled, onClick: disconnect }, t("disconnect"))
                  : null,
                showRevoke
                  ? React.createElement("button", { className: "dsh-web-remote-btn dsh-web-remote-btn-danger", disabled, onClick: revoke }, t("revoke"))
                  : null,
              );

      const tip =
        status === "connected"
          ? React.createElement(
              "div",
              { className: "dsh-web-remote-access-list" },
              React.createElement(
                "p",
                { className: "dsh-web-remote-tip" },
                "1. " + t("accessBrowserLabel") + " ",
                React.createElement(
                  "a",
                  { className: "dsh-web-remote-tip-url", href: hub, target: "_blank", rel: "noreferrer" },
                  hub,
                ),
                t("accessBrowserHint"),
              ),
              React.createElement(
                "p",
                { className: "dsh-web-remote-tip" },
                "2. " + t("accessAppLabel") + t("accessAppHint"),
              ),
            )
          : React.createElement("p", { className: "dsh-web-remote-tip" }, t("tip_" + status));

      const compatToggle = external
        ? null
        : React.createElement(
            "label",
            { className: "dsh-web-remote-compat" },
            React.createElement("input", {
              type: "checkbox",
              checked: uiCompat,
              disabled,
              onChange: (e) => {
                const v = e.target.checked;
                setUiCompat(v);
                void rpc.call("/remote-access", "set-ui-compat", { args: { enabled: v } });
              },
            }),
            " ",
            t("uiCompatLabel"),
          );

      const accessCodeRow = external
        ? null
        : React.createElement(
            "div",
            { className: "dsh-web-remote-field" },
            React.createElement("label", null, t("accessCodeLabel")),
            React.createElement(
              "div",
              { className: "dsh-web-remote-accesscode" },
              React.createElement(
                "span",
                { className: "dsh-web-remote-accesscode-badge" + (hasAccessCode ? " set" : "") },
                hasAccessCode ? t("accessCodeBadgeSet") : t("accessCodeBadgeUnset"),
              ),
              React.createElement("input", {
                type: "password",
                value: codeInput,
                disabled: disabled || codeBusy,
                placeholder: t("accessCodePlaceholder"),
                onChange: (e) => setCodeInput(e.target.value),
              }),
              React.createElement(
                "button",
                {
                  className: "dsh-web-remote-btn dsh-web-remote-btn-primary",
                  disabled: disabled || codeBusy || codeInput.length < 4,
                  onClick: setCode,
                },
                t("accessCodeSet"),
              ),
              hasAccessCode
                ? React.createElement(
                    "button",
                    { className: "dsh-web-remote-btn dsh-web-remote-btn-danger", disabled: disabled || codeBusy, onClick: clearCode },
                    t("accessCodeClear"),
                  )
                : null,
            ),
          );

      // 只读诊断：目录选择器形态（插件把它钉成 browse；不是 browse 就要能看见）
      const pickerText =
        pickerKind === undefined
          ? t("pickerUnknownText")
          : pickerOk === true
            ? t("pickerOkText")
            : pickerKind === "unknown" || pickerKind === "none"
              ? t("pickerUnknownText")
              : t("pickerBadText");
      const pickerRow = React.createElement(
        "div",
        { className: "dsh-web-remote-field" },
        React.createElement("label", null, t("pickerLabel")),
        React.createElement(
          "div",
          { className: "dsh-web-remote-accesscode" },
          React.createElement(
            "span",
            { className: "dsh-web-remote-accesscode-badge" + (pickerOk === true ? " set" : "") },
            pickerText,
          ),
        ),
        pickerOk === false
          ? React.createElement("span", { className: "dsh-web-remote-compat-desc" }, " ", t("pickerHint"))
          : null,
      );

      // 内网直连：放在「可从何处访问」那句之后，并自带优势说明（自动优先、延迟更低）。
      const directOn = direct !== null && typeof direct === "object" && direct.active === true;
      const directBlock =
        scanning === true
          ? null
          : React.createElement(
              "div",
              { className: "dsh-web-remote-direct-block" },
              React.createElement(
                "div",
                { className: "dsh-web-remote-direct" + (directOn ? " on" : "") },
                React.createElement("span", { className: "dsh-web-remote-dot" }),
                React.createElement(
                  "span",
                  null,
                  t("directLabel") +
                    " · " +
                    (directOn ? t("directOn").replace("{port}", String(direct.port)) : t("directOff")),
                ),
              ),
              React.createElement("p", { className: "dsh-web-remote-tip" }, t("directHintSame")),
              React.createElement("p", { className: "dsh-web-remote-tip" }, t("directHintOther")),
            );

      // 页脚：插件身份（包名 + 版本）—— 让用户知道"远程访问"由哪个插件提供。
      const footerRow = React.createElement(
        "div",
        { className: "dsh-web-remote-footer" },
        t("pluginLabel") + " " + (pluginName || "dsh-web-remote") + (pluginVersion ? " v" + pluginVersion : ""),
      );

      // 安全保护分组：端到端加密兼容 + 访问密码（都是安全相关，统一加小标题）
      const securitySection =
        external === true
          ? null
          : React.createElement(
              "div",
              { className: "dsh-web-remote-section" },
              React.createElement("div", { className: "dsh-web-remote-section-title" }, t("securityTitle")),
              compatToggle,
              accessCodeRow,
            );

      return React.createElement(
        "div",
        { className: "dsh-web-remote" },
        statusLine,
        scanning ? null : tip,
        directBlock,
        // 目录选择器诊断：只在异常（宿主原生对话框 → 远程不可用）时显示，正常态不打扰用户
        pickerOk === false ? pickerRow : null,
        message ? React.createElement("p", { className: "dsh-web-remote-msg" }, message) : null,
        scanScreen,
        form,
        securitySection,
        actions,
        footerRow,
      );
    }

    function apply(ctx) {
      injectStyle();
      const locale = ctx.locale;
      const t = locale && typeof locale.bind === "function" ? locale.bind(NS) : (k) => en[k] ?? k;
      if (locale && typeof locale.register === "function") {
        ctx.effect(() => locale.register(NS, { zh, en }), "dsh-web-remote: locale");
      }
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "remote-access",
            order: 99,
            label: () => t("nav"),
            inject: () => ({ rpc: ctx.get("connection").rpc, t }),
          },
          Panel,
        ),
      );
    }

    return { apply, inject };
  },
});
