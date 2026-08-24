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
      hubUrl: "Hub 地址",
      joinToken: "授权令牌",
      name: "主机名",
      hubPlaceholder: "https://hub.example.com",
      tokenPlaceholder: "一次性授权令牌",
      namePlaceholder: "my-mac",
      connect: "接入",
      disconnect: "断开",
      revoke: "注销",
      confirmOverwrite: "将覆盖现有 host 配置，再次点击接入确认",
      tip_unconfigured: "在 hub 门户「添加主机」获取授权令牌，粘贴到下方后点击接入。",
      tip_connecting: "正在注册并建立隧道…",
      tip_connected_pre: "现在可从任何地方，使用浏览器访问：",
      tip_connected_post: "登录 hub 门户，在主机列表中，找到这台主机，即可访问它。",
      tip_reconnecting: "隧道断开，正在自动重连，无需操作。",
      tip_disconnected: "已断开，配置与授权已保留，点击接入即可恢复。",
      tip_external: "该主机由 rdsh CLI / 服务托管，请用 rdsh 命令管理。",
    };

    const en = {
      nav: "Remote Access",
      status_unconfigured: "Not joined",
      status_disconnected: "Disconnected (config kept)",
      status_connecting: "Connecting…",
      status_connected: "Connected",
      status_reconnecting: "Reconnecting…",
      status_external: "Managed by rdsh CLI/service",
      hubUrl: "Hub URL",
      joinToken: "Auth Token",
      name: "Name",
      hubPlaceholder: "https://hub.example.com",
      tokenPlaceholder: "One-time auth token",
      namePlaceholder: "my-mac",
      connect: "Connect",
      disconnect: "Disconnect",
      revoke: "Revoke",
      confirmOverwrite: "Will overwrite existing host config — click Connect again to confirm",
      tip_unconfigured: "Get an auth token from the hub portal (Add host), paste it below, then click Connect.",
      tip_connecting: "Registering and establishing the tunnel…",
      tip_connected_pre: "You can now access it from anywhere via your browser:",
      tip_connected_post: "Sign in to the hub portal, find this host in the host list, and open it.",
      tip_reconnecting: "The tunnel dropped; it is reconnecting automatically — no action needed.",
      tip_disconnected: "Disconnected — config and auth are kept. Click Connect to resume.",
      tip_external: "This host is managed by the rdsh CLI/service; manage it with rdsh commands.",
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
      .dsh-web-remote-tip{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
      .dsh-web-remote-tip-url{color:var(--dsw-alias-brand-primary);word-break:break-all;text-decoration:none}
      .dsh-web-remote-tip-url:hover{text-decoration:underline}
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

    function Field({ label, value, disabled, placeholder, onChange, onFocus }) {
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
      );
    }

    function Panel({ rpc, t }) {
      const [status, setStatus] = React.useState("unconfigured");
      const [hub, setHub] = React.useState("");
      const [name, setName] = React.useState("");
      const [token, setToken] = React.useState("");
      const [message, setMessage] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [confirmOverwrite, setConfirmOverwrite] = React.useState(false);
      const [savedToken, setSavedToken] = React.useState(false);

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

      const connect = async () => {
        setBusy(true);
        try {
          const res = await rpc.call("/remote-access", "connect", {
            args: { hub, token, name, confirmOverwrite: confirmOverwrite || undefined },
          });
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
          await rpc.call("/remote-access", "disconnect", { args: {} });
        } finally {
          setBusy(false);
        }
      };

      const revoke = async () => {
        setBusy(true);
        try {
          await rpc.call("/remote-access", "revoke", { args: {} });
          setHub("");
          setName("");
        } finally {
          setBusy(false);
        }
      };

      const disabled = busy || external;
      // 未接入态需要令牌；断开态可留空（复用已保存授权）
      const canConnect = !disabled && hub.trim() !== "" && (status !== "unconfigured" || token.trim() !== "");

      const statusLine = React.createElement(
        "div",
        { className: "dsh-web-remote-status" },
        React.createElement("span", { className: "dsh-web-remote-dot " + status }),
        React.createElement("span", null, t("status_" + status)),
      );

      const form = showForm
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(Field, {
              label: t("hubUrl"),
              value: hub,
              disabled,
              placeholder: t("hubPlaceholder"),
              onChange: setHub,
            }),
            React.createElement(Field, {
              label: t("joinToken"),
              value: token !== "" ? token : savedToken ? "••••••••" : "",
              disabled,
              placeholder: t("tokenPlaceholder"),
              onFocus: (e) => {
                if (token === "" && savedToken) e.target.select();
              },
              onChange: setToken,
            }),
            React.createElement(Field, {
              label: t("name"),
              value: name,
              disabled,
              placeholder: t("namePlaceholder"),
              onChange: setName,
            }),
          )
        : null;

      const actions = external
        ? null
        : React.createElement(
            "div",
            { className: "dsh-web-remote-actions" },
            showForm
              ? React.createElement(
                  "button",
                  { className: "dsh-web-remote-btn dsh-web-remote-btn-primary", disabled: !canConnect, onClick: connect },
                  busy ? "…" : t("connect"),
                )
              : null,
            showDisconnect
              ? React.createElement(
                  "button",
                  { className: "dsh-web-remote-btn", disabled, onClick: disconnect },
                  t("disconnect"),
                )
              : null,
            showRevoke
              ? React.createElement(
                  "button",
                  { className: "dsh-web-remote-btn dsh-web-remote-btn-danger", disabled, onClick: revoke },
                  t("revoke"),
                )
              : null,
          );

      const tip =
        status === "connected"
          ? React.createElement(
              "p",
              { className: "dsh-web-remote-tip" },
              t("tip_connected_pre"),
              " ",
              React.createElement(
                "a",
                { className: "dsh-web-remote-tip-url", href: hub, target: "_blank", rel: "noreferrer" },
                hub,
              ),
              " ",
              t("tip_connected_post"),
            )
          : React.createElement("p", { className: "dsh-web-remote-tip" }, t("tip_" + status));

      return React.createElement(
        "div",
        { className: "dsh-web-remote" },
        statusLine,
        tip,
        message ? React.createElement("p", { className: "dsh-web-remote-msg" }, message) : null,
        form,
        actions,
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
