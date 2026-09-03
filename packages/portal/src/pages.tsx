/**
 * portal 页面 + 手写路由（零依赖：不引 react-router）。
 *
 * 会话：httpOnly Cookie（fetch credentials include）；refreshToken 存 sessionStorage
 * 供登出吊销（hub 门户自身代码，无第三方脚本）。
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError, subscribeEvents, REFRESH_KEY, adminApi } from "./api.ts";
import type { HostInfo, JoinTokenInfo, CaptchaPayload, AccountInfo, Capabilities, WechatPayInfo, AdminMe, AdminUserRow, AdminHostRow, AdminOrderRow, AdminPaymentRow, AdminAuditRow, AdminSubscriptionRow, AdminUserDetail, AdminDashboard, AdminConfig } from "./api.ts";
import { fingerprint } from "./e2ee.ts";
import { useT, getLang } from "./i18n.ts";
import type { T } from "./i18n.ts";
import { TermsPage, PrivacyPage, ProductPage, LegalContent, LEGAL } from "./legal.tsx";

/** portal 部署在 /portal 前缀下（host 转发的 DSH 占用根路径）。 */
const BASE = "/portal";

function navigate(path: string): void {
  window.history.pushState({}, "", `${BASE}${path}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ---- E2EE pin（localStorage 首次信任/变更告警）----
const E2EE_PINS_KEY = "rdsh_e2ee_pins";
function fromBase64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4;
  const bin = atob(pad ? b + "=".repeat(4 - pad) : b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function readE2eePin(hostId: string): string | null {
  try {
    const pins = JSON.parse(localStorage.getItem(E2EE_PINS_KEY) ?? "{}") as Record<string, string>;
    return typeof pins[hostId] === "string" ? pins[hostId] : null;
  } catch {
    return null;
  }
}
function writeE2eePin(hostId: string, publicKey: string): void {
  try {
    const pins = JSON.parse(localStorage.getItem(E2EE_PINS_KEY) ?? "{}") as Record<string, string>;
    pins[hostId] = publicKey;
    localStorage.setItem(E2EE_PINS_KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
}

export function useRoute(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return path;
}

export function App(): React.JSX.Element {
  const full = useRoute();
  const path = full.startsWith(BASE) ? full.slice(BASE.length) || "/" : "/";
  if (path.startsWith("/admin")) return <AppShell><AdminApp path={path.slice("/admin".length) || "/"} /></AppShell>;
  if (path === "/login") return <Login />;
  if (path === "/register") return <RegisterPage />;
  if (path === "/terms") return <TermsPage />;
  if (path === "/privacy") return <PrivacyPage />;
  if (path === "/product") return <ProductPage />;
  if (path === "/verify") return <VerifyPage />;
  if (path === "/reset-password") return <ResetPasswordPage />;
  if (path === "/") return <LandingPage />;
  const page =
    path === "/billing" ? (
      <BillingPage />
    ) : path === "/settings/password" ? (
      <PasswordPage />
    ) : path === "/settings/account" ? (
      <AccountPage />
    ) : path === "/settings/email" ? (
      <EmailSettingsPage />
    ) : path === "/settings/phone" ? (
      <PhoneSettingsPage />
    ) : path === "/settings/2fa" ? (
      <TwoFaSettingsPage />
    ) : path === "/settings/danger" ? (
      <DangerZonePage />
    ) : path === "/add-host" ? (
      <AddHostPage />
    ) : path === "/hosts" ? (
      <HostsPage />
    ) : (
      <HostsPage /> // 未知路径兜底 host 列表
    );
  return <AppShell>{page}</AppShell>;
}

/** 语言切换（中 / EN），顶部右侧常驻。 */
function LangToggle(): React.JSX.Element {
  const { lang, setLang: changeLang } = useT();
  const style = (active: boolean): React.CSSProperties => ({
    padding: "2px 8px",
    borderRadius: 6,
    border: "1px solid #ccc",
    cursor: "pointer",
    fontSize: 12,
    background: active ? "#2563eb" : "#fff",
    color: active ? "#fff" : "#333",
  });
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <button onClick={() => changeLang("zh")} style={style(lang === "zh")}>中</button>
      <button onClick={() => changeLang("en")} style={style(lang === "en")}>EN</button>
    </div>
  );
}

/** 页面内容容器：可选的标题头 + 内容（宽度由 AppShell 统一，避免双重 padding）。 */
function Shell({ title, children }: { title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      {title !== undefined && <h1 style={{ fontSize: 18, margin: "0 0 20px" }}>{title}</h1>}
      {children}
    </div>
  );
}

/** 登录后应用壳：顶栏（用户名·角色 | 语言·齿轮·登出）+ 标签（我的主机/添加主机/管理后台）。 */
function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useT();
  const full = useRoute();
  const rel = full.startsWith(BASE) ? full.slice(BASE.length) : "/";
  const [me, setMe] = useState<{ name: string; role: string } | null>(null);
  useEffect(() => {
    // probe：尽力而为取用户名/角色，不触发 401 跳登录（页面自身的鉴权调用负责处理）
    void api.accountInfo({ probe: true }).then((a) => setMe({ name: a.name, role: a.role })).catch(() => undefined);
  }, []);
  const tabs = [
    { p: "/settings/account", label: t("账户与安全") },
    { p: "/hosts", label: t("我的主机") },
    ...(me !== null && me.role !== "user" ? [{ p: "/admin", label: t("管理后台") }] : []),
  ];
  const active = tabs.find((x) => rel === x.p || rel.startsWith(x.p + "/"))?.p;
  const logoutAll = (): void => {
    // 管理角色才有管理会话 → 仅此时调 admin 登出；普通用户直接门户登出
    if (me !== null && me.role !== "user") void adminApi.logout().catch(() => undefined);
    logout();
  };
  return (
    <div style={{ maxWidth: 720, margin: "16px auto 32px", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{me === null ? "" : `${me.name} · ${adminRoleLabel(t, me.role)}`}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <LangToggle />
          <button onClick={logoutAll} style={btnStyle()}>{t("登出")}</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {tabs.map((x) => (
          <button key={x.p} onClick={() => navigate(x.p)} style={{ ...btnStyle("ghost"), fontWeight: active === x.p ? 700 : 400, background: active === x.p ? "#eef2ff" : "#fff" }}>{x.label}</button>
        ))}
      </div>
      {children}
    </div>
  );
}

function btnStyle(variant: "primary" | "danger" | "ghost" = "primary"): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #ccc",
    cursor: "pointer",
    fontSize: 14,
  };
  if (variant === "primary") return { ...base, background: "#2563eb", color: "#fff", borderColor: "#2563eb" };
  if (variant === "danger") return { ...base, background: "#dc2626", color: "#fff", borderColor: "#dc2626" };
  return { ...base, background: "#fff" };
}

function inputStyle(): React.CSSProperties {
  return { padding: "8px 10px", borderRadius: 6, border: "1px solid #ccc", fontSize: 14, width: "100%", boxSizing: "border-box" };
}

function menuItemStyle(danger = false): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "10px 12px",
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 14,
    borderRadius: 6,
    color: danger ? "#dc2626" : "#111",
  };
}

function field(label: string, value: string, onChange: (v: string) => void, type = "text", opts?: { numeric?: boolean }): React.JSX.Element {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ display: "block", marginBottom: 4, fontSize: 13 }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={opts?.numeric === true ? "numeric" : undefined}
        autoComplete={opts?.numeric === true ? "one-time-code" : "off"}
        maxLength={opts?.numeric === true ? 6 : undefined}
        style={inputStyle()}
      />
    </label>
  );
}

/** hub 错误码 → 中文文案（显示层本地化；未知码回退后端 message）。i18n 扩展时在此加 en 字典。 */
const ERROR_ZH: Record<string, string> = {
  BAD_REQUEST: "请求参数不正确",
  UNAUTHORIZED: "未登录或会话已失效",
  BAD_CREDENTIALS: "用户名或密码错误",
  RATE_LIMITED: "操作过于频繁，请稍后再试",
  ACCOUNT_LOCKED: "登录失败次数过多，账户已临时锁定",
  NOT_FOUND: "请求的资源不存在",
  REGISTRATION_DISABLED: "注册未开放",
  REGISTRATION_LIMIT_REACHED: "注册名额已满，暂不接受新用户",
  REGISTRATION_DAILY_LIMIT: "今日注册名额已满，请明天再试",
  ALREADY_EXISTS: "该邮箱/手机号已被注册",
  EMAIL_DISABLED: "邮件服务未配置，邮箱通道不可用",
  SMS_DISABLED: "短信服务未配置，手机号通道不可用",
  BAD_CAPTCHA: "验证码校验失败，请重试",
  BAD_CODE: "验证码错误或已过期",
  BAD_RESET: "重置码错误或已过期",
  BAD_TOTP: "两步验证码错误",
  UNBIND_COOLDOWN: "解绑后 24 小时内不能重新绑定",
  QUOTA_EXCEEDED: "当前套餐的主机配额已满",
  FORBIDDEN: "没有权限执行此操作",
  HOST_OFFLINE: "主机当前离线",
  UPSTREAM_ERROR: "主机端处理出错",
  SEND_FAILED: "发送失败，请稍后再试",
  INVALID_REFRESH: "登录状态已失效，请重新登录",
  REFRESH_FAILED: "会话续期失败（网络异常），请稍后重试",
  NOT_ELIGIBLE: "当前操作不可用",
  INTERNAL: "服务器内部错误",
  BAD_SIGNATURE: "签名校验失败",
};

/** 按错误码取本地化文案：en 用户直接看后端英文 message（准确）；zh 走 ERROR_ZH，未知码回退 message。 */
function tError(code: string, fallback: string): string {
  if (getLang() === "en") return fallback;
  return ERROR_ZH[code] ?? fallback;
}

function useError(): { err: string; clear: () => void; run: (fn: () => Promise<void>) => Promise<boolean> } {
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      setErr("");
      await fn();
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? tError(e.code, e.message) : e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  return { err, clear: () => setErr(""), run };
}

// ---- 验证码（arithmetic 零依赖 / aliyun 2.0 前端 SDK / none）----

declare global {
  interface Window {
    initAliyunCaptcha?: (config: Record<string, unknown>) => void;
    /** V3 架构（Web/H5）：必须在加载 SDK 前设置的全局变量（region + 身份标 prefix）。 */
    AliyunCaptchaConfig?: { region: string; prefix: string };
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) !== null) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

const ALIYUN_CAPTCHA_SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

/** 按后端 /api/captcha/config 渲染对应验证码；完成后回调 captcha 载荷（arithmetic → token+answer；aliyun → captchaVerifyParam；none → {}）。 */
function CaptchaGate({ onCaptcha }: { onCaptcha: (captcha: CaptchaPayload) => void }): React.JSX.Element | null {
  const { t } = useT();
  const [mode, setMode] = useState<"loading" | "none" | "arithmetic" | "aliyun">("loading");
  const [challenge, setChallenge] = useState<{ token: string; question: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [captchaFail, setCaptchaFail] = useState("");
  const { err, run } = useError();

  useEffect(() => {
    void run(async () => {
      const cfg = await api.captchaConfig();
      if (cfg.provider === "none") {
        setMode("none");
        onCaptcha({});
      } else if (cfg.provider === "aliyun") {
        setMode("aliyun");
        // V3 架构（Web/H5）：必须在加载 SDK 之前设置全局 AliyunCaptchaConfig（region + 身份标 prefix），
        // 否则初始化请求签名不匹配（401 "Specified signature is not matched with our calculation!"）。
        window.AliyunCaptchaConfig = { region: "cn", prefix: cfg.prefix ?? "" };
        await loadScript(ALIYUN_CAPTCHA_SDK);
        const init = window.initAliyunCaptcha;
        if (init === undefined) throw new Error("aliyun captcha SDK not loaded");
        // V3：mode/element/button/success 均必填；验证通过回调直接透出 captchaVerifyParam（后端 VerifyCaptcha 验签）
        init({
          SceneId: cfg.sceneId ?? "",
          mode: "popup",
          element: "#rdsh-captcha-element",
          button: "#rdsh-captcha-btn",
          success: (param: string) => {
            onCaptcha({ captchaVerifyParam: param });
            setMode("none");
          },
          fail: (result: unknown) => {
            const msg =
              typeof result === "object" && result !== null && "message" in result
                ? String((result as { message?: unknown }).message)
                : "captcha verification failed";
            setCaptchaFail(msg);
          },
        });
      } else {
        setMode("arithmetic");
        setChallenge(await api.captchaChallenge());
      }
    });
  }, []);

  if (mode === "loading" || mode === "none") return null;
  if (mode === "aliyun") {
    return (
      <div style={{ marginBottom: 12 }}>
        <div id="rdsh-captcha-element" />
        <button id="rdsh-captcha-btn" type="button" style={btnStyle("ghost")}>{t("完成滑块验证")}</button>
        {captchaFail !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{captchaFail}</p>}
        {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      </div>
    );
  }
  if (challenge === null) return null;
  return (
    <>
      <p style={{ fontSize: 13, color: "#666" }}>{t("防机器人验证：{question}", { params: { question: challenge.question } })}</p>
      {field(t("答案"), answer, setAnswer)}
      <button type="button" onClick={() => onCaptcha({ captchaToken: challenge.token, captchaAnswer: answer.trim() })} style={btnStyle()}>{t("确认验证")}</button>
    </>
  );
}

/** 页脚：备案信息（ICP/公安），来自 hub.json `beian` 配置（公开 /api/capabilities 下发）。 */
/** 法务链接：配置外部 URL 则新标签外链，否则站内 navigate（内置文档页）。 */
function legalLink(url: string | undefined, internal: string, label: string, style: React.CSSProperties): React.JSX.Element {
  if (url !== undefined && url !== "") {
    return <a href={url} target="_blank" rel="noreferrer" style={style}>{label}</a>;
  }
  return <a href="#" onClick={(e) => { e.preventDefault(); navigate(internal); }} style={style}>{label}</a>;
}

function SiteFooter(): React.JSX.Element | null {
  const { t } = useT();
  const [cap, setCap] = useState<Capabilities | null>(null);
  useEffect(() => {
    void api.capabilities().then(setCap).catch(() => undefined);
  }, []);
  if (cap === null) return null;

  const site = cap.site;
  const link: React.CSSProperties = { color: "#999", textDecoration: "none" };
  const nav: React.ReactNode[] = [];
  if (site?.name !== undefined) {
    nav.push(site.url !== undefined ? <a href={site.url} target="_blank" rel="noreferrer" style={link}>{site.name}</a> : <span>{site.name}</span>);
  }
  nav.push(legalLink(site?.productUrl, "/product", t("产品介绍"), link));
  nav.push(legalLink(site?.termsUrl, "/terms", t("用户协议"), link));
  nav.push(legalLink(site?.privacyUrl, "/privacy", t("隐私政策"), link));

  return (
    <footer style={{ textAlign: "center", marginTop: 24, fontSize: 12, color: "#999", lineHeight: 1.8 }}>
      <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap" }}>
        {nav.map((node, i) => (
          <span key={i} style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center" }}>
            {i > 0 && <span style={{ margin: "0 8px", color: "#999" }}>|</span>}
            {node}
          </span>
        ))}
      </div>
      {(site?.footer ?? []).map((f, i) => (
        <div key={i}>
          {f.href !== undefined
            ? <a href={f.href} target="_blank" rel="noreferrer" style={link}>{f.text}</a>
            : f.text}
        </div>
      ))}
    </footer>
  );
}

/** 落地页：产品介绍 + 注册/登录 CTA（新用户入口；已登录则显示「进入控制台」）。 */
function LandingPage(): React.JSX.Element {
  const { t } = useT();
  const [authed, setAuthed] = useState(false);
  const [brand, setBrand] = useState("RDSH.CN");
  useEffect(() => {
    void api.accountInfo({ probe: true }).then(() => setAuthed(true)).catch(() => setAuthed(false));
    void api.capabilities().then((c) => { if (c.site?.brand !== undefined && c.site.brand !== "") setBrand(c.site.brand); }).catch(() => undefined);
  }, []);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 0" }}>
        <strong style={{ fontSize: 17 }}>{brand}</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <LangToggle />
          {authed ? (
            <button onClick={() => navigate("/hosts")} style={btnStyle()}>{t("进入控制台")}</button>
          ) : (
            <>
              <button onClick={() => navigate("/login")} style={btnStyle("ghost")}>{t("登录")}</button>
              <button onClick={() => navigate("/register")} style={btnStyle()}>{t("注册")}</button>
            </>
          )}
        </div>
      </div>

      <div style={{ textAlign: "center", padding: "48px 0 40px" }}>
        <h1 style={{ fontSize: 22, margin: "0 0 10px" }}>{t("你的 AI 智能体，随处安全可达")}</h1>
        <p style={{ color: "#666", fontSize: 15, margin: "0 0 28px" }}>{t("免公网 IP · 免装客户端")}</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          {authed ? (
            <button onClick={() => navigate("/hosts")} style={{ ...btnStyle(), fontSize: 16, padding: "10px 26px" }}>{t("进入控制台")}</button>
          ) : (
            <>
              <button onClick={() => navigate("/register")} style={{ ...btnStyle(), fontSize: 16, padding: "10px 26px" }}>{t("立即注册")}</button>
              <button onClick={() => navigate("/login")} style={{ ...btnStyle("ghost"), fontSize: 16, padding: "10px 26px" }}>{t("登录")}</button>
            </>
          )}
        </div>
      </div>

      <LegalContent html={LEGAL.product} />

      <SiteFooter />
    </div>
  );
}

// ---- 登录 / 首次设密 ----

function Login(): React.JSX.Element {
  const { t } = useT();
  const next = new URLSearchParams(window.location.search).get("next");
  const home = next !== null && next.startsWith("/") && !next.startsWith("//") ? next : "/hosts";
  const wechatNew = new URLSearchParams(window.location.search).get("wechat-new");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totpPending, setTotpPending] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [brand, setBrand] = useState("RDSH.CN");
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const [wechatGuide, setWechatGuide] = useState(false);
  const [copied, setCopied] = useState(false);
  const { err, run } = useError();

  useEffect(() => {
    void api.capabilities().then((c) => { if (c.site?.brand !== undefined && c.site.brand !== "") setBrand(c.site.brand); if (c.wechatLoginEnabled === true) setWechatEnabled(true); }).catch(() => undefined);
  }, []);

  const wechatLogin = (): void => {
    if (isWechatWebview() || !isMobileBrowser()) {
      // 微信内（一键确认）或 PC（扫码）→ 同页跳 qrconnect（保留回跳 next）
      window.location.href = `/api/wechat/login/authorize?next=${encodeURIComponent(home)}`;
    } else {
      // 移动非微信：引导「在微信中打开」+ 保留账号密码登录
      setWechatGuide(true);
    }
  };

  const copyLoginLink = (): void => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  };

  const confirmWechatCreate = (): void => {
    void run(async () => {
      if (wechatNew === null || wechatNew === "") return;
      const r = await api.wechatConfirm(wechatNew);
      sessionStorage.setItem(REFRESH_KEY, r.refreshToken);
      navigate(home);
    });
  };

  // 微信登录但未找到已绑定账号 → 确认是否新建（不静默建号）
  if (wechatNew !== null && wechatNew !== "") {
    return (
      <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}><LangToggle /></div>
        <p style={{ fontSize: 22, fontWeight: 700, color: "#111", letterSpacing: 0.5, margin: "0 0 8px" }}>{brand}</p>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>{t("微信登录")}</h1>
        <p style={{ color: "#666", fontSize: 13, marginBottom: 20 }}>{t("未找到已绑定的账号，是否创建新账号？")}</p>
        {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
        <button onClick={confirmWechatCreate} style={{ ...btnStyle(), width: "100%" }}>{t("创建新账号")}</button>
        <button onClick={() => navigate("/login")} style={{ ...btnStyle("ghost"), width: "100%", marginTop: 8 }}>{t("已有账号，去登录")}</button>
        <p style={{ marginTop: 12, fontSize: 12, color: "#6b7280" }}>{t("已有邮箱/手机号账号？先用账号密码登录，再在设置里绑定微信")}</p>
        <SiteFooter />
      </div>
    );
  }

  const submit = (): void => {
    void run(async () => {
      if (totpPending !== null) {
        const r = await api.totpLogin(totpPending, totpCode, trustDevice);
        sessionStorage.setItem(REFRESH_KEY, r.refreshToken);
        navigate(home);
      } else {
        const r = await api.login(name, password);
        if (r.requiresTotp === true && r.pendingToken !== undefined) {
          setTotpPending(r.pendingToken);
        } else {
          sessionStorage.setItem(REFRESH_KEY, r.refreshToken ?? "");
          navigate(home);
        }
      }
    });
  };

  useEffect(() => {
    // TOTP 输满 6 位自动提交（数字键盘连点 6 下即登录）
    if (totpPending !== null && totpCode.length === 6) {
      submit();
    }
  }, [totpCode]);

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <p style={{ fontSize: 22, fontWeight: 700, color: "#111", letterSpacing: 0.5, margin: "0 0 8px" }}>{brand}</p>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{t("你的 AI 智能体，随处安全可达")}</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 24 }}>
        {totpPending !== null ? t("输入你的两步验证码（TOTP）") : t("远程指挥你的 DeepSeek Harness 智能体，仅需浏览器，任意设备、随时随地，端到端加密")}
      </p>
      {totpPending !== null ? (
        <div>
          <label style={{ display: "block", marginBottom: 4, fontSize: 13 }}>
            <span style={{ display: "block", marginBottom: 4 }}>{t("验证码")}</span>
            <input
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              style={{ ...inputStyle(), fontSize: 20, letterSpacing: 6, textAlign: "center" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 12, fontSize: 13 }}>
            <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} /> {t("记住此设备 30 天（下次登录免输动态码）")}
          </label>
        </div>
      ) : (
        <>
          {field(t("邮箱 / 手机号 / 用户名"), name, setName)}
          {field(t("密码"), password, setPassword, "password")}
        </>
      )}
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ ...btnStyle(), width: "100%", marginTop: 8 }}>
        {totpPending !== null ? t("验证并登录") : t("登录")}
      </button>
      {wechatEnabled && totpPending === null && (
        <>
          <p style={{ margin: "14px 0 0", textAlign: "center", color: "#9ca3af", fontSize: 12 }}>{t("或")}</p>
          <button
            onClick={wechatLogin}
            style={{ ...btnStyle(), width: "100%", marginTop: 8, background: "#07C160", borderColor: "#07C160", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          >
            <WechatIcon size={18} />
            {t("微信登录")}
          </button>
          <p style={{ marginTop: 6, fontSize: 12, color: "#9ca3af", textAlign: "center" }}>{t("已有邮箱/手机号账号？先用账号密码登录，再在设置里绑定微信")}</p>
          {wechatGuide && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
              <p style={{ margin: 0 }}>{t("在微信中打开以一键登录")}</p>
              <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                <input
                  readOnly
                  value={window.location.href}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ flex: 1, fontSize: 12, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 6, color: "#374151", minWidth: 0 }}
                />
                <button onClick={copyLoginLink} style={{ ...btnStyle("ghost"), whiteSpace: "nowrap" }}>{copied ? t("已复制") : t("复制链接")}</button>
              </div>
            </div>
          )}
        </>
      )}
      {totpPending === null && (
        <p style={{ marginTop: 12, textAlign: "center" }}>
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/reset-password"); }} style={{ color: "#2563eb", fontSize: 13 }}>{t("忘记密码？")}</a>
          {" · "}
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/register"); }} style={{ color: "#2563eb", fontSize: 13 }}>{t("注册")}</a>
        </p>
      )}
      <SiteFooter />
    </div>
  );
}

// ---- 账户与安全（邮箱 / 手机号 / 2FA / 套餐与账号）----

/** 邮箱脱敏显示：a***@example.com。 */
function maskEmail(e: string): string {
  const at = e.indexOf("@");
  return at > 1 ? `${e.slice(0, 1)}***${e.slice(at)}` : e;
}

/** 手机号脱敏显示：+86 138****8000。 */
function maskPhone(p: string): string {
  const m = /^(\+86)?(\d{3})\d{4}(\d{4})$/.exec(p);
  return m !== null ? `${m[1] ?? ""}${m[2]}****${m[3]}` : p;
}

/** 顶部提示条（成功/错误），4 秒后自动消失。 */
function Toast({ toast }: { toast: { kind: "ok" | "err"; text: string } | null }): React.JSX.Element | null {
  if (toast === null) return null;
  const ok = toast.kind === "ok";
  return (
    <div
      style={{
        background: ok ? "#ecfdf5" : "#fef2f2",
        color: ok ? "#047857" : "#dc2626",
        border: `1px solid ${ok ? "#10b981" : "#f87171"}55`,
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 12,
        fontSize: 13,
      }}
    >
      {toast.text}
    </div>
  );
}

/** 分组卡片：标题 + 右侧状态徽标 + 内容。 */
function Card({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px", marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2>
        {badge}
      </div>
      {children}
    </div>
  );
}

/** 绑定状态徽标。 */
function Badge({ ok, text }: { ok: boolean; text: string }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 12,
        padding: "2px 10px",
        borderRadius: 999,
        background: ok ? "#ecfdf5" : "#f3f4f6",
        color: ok ? "#047857" : "#6b7280",
      }}
    >
      {ok ? "✓ " : ""}
      {text}
    </span>
  );
}

/** 发送验证码按钮（点击后 60s 倒计时禁用，防重发轰炸）。 */
function SendCodeButton({ label, seconds, onClick, disabled }: { label: string; seconds: number; onClick: () => void; disabled?: boolean }): React.JSX.Element {
  const { t } = useT();
  return (
    <button onClick={onClick} disabled={disabled === true || seconds > 0} style={btnStyle()}>
      {seconds > 0 ? t("重新发送 {s}s", { params: { s: seconds } }) : label}
    </button>
  );
}

/** 顶部提示（成功/错误）+ 4 秒自动消失。 */
function useToast(): { toast: { kind: "ok" | "err"; text: string } | null; show: (kind: "ok" | "err", text: string) => void } {
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const show = (kind: "ok" | "err", text: string): void => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4000);
  };
  return { toast, show };
}

/** 60s 重发倒计时（返回 [秒数, 启动]）。 */
function useCountdown(): [number, () => void] {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const t = window.setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [seconds]);
  return [seconds, () => setSeconds(60)];
}

/** 设置项行（账户总览页入口）。 */
function SettingRow({ label, desc, badge, onClick, danger }: { label: string; desc?: string; badge?: React.ReactNode; onClick: () => void; danger?: boolean }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        background: "#fff",
        cursor: "pointer",
        marginBottom: 8,
        textAlign: "left",
        font: "inherit",
      }}
    >
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: danger === true ? "#dc2626" : "#111827" }}>{label}</span>
        {desc !== undefined && <span style={{ display: "block", fontSize: 12, color: "#6b7280", marginTop: 2 }}>{desc}</span>}
      </span>
      {badge}
      <span style={{ color: "#9ca3af", fontSize: 18 }}>›</span>
    </button>
  );
}

/** 设置项外链（账户总览页：微信客服等跳转外部，新开标签）。 */
function SettingLink({ label, desc, href }: { label: string; desc?: string; href: string }): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        background: "#fff",
        cursor: "pointer",
        marginBottom: 8,
        textAlign: "left",
        font: "inherit",
        textDecoration: "none",
        boxSizing: "border-box",
      }}
    >
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#111827" }}>{label}</span>
        {desc !== undefined && <span style={{ display: "block", fontSize: 12, color: "#6b7280", marginTop: 2 }}>{desc}</span>}
      </span>
      <span style={{ color: "#9ca3af", fontSize: 18 }}>↗</span>
    </a>
  );
}

/** 子设置页顶部：返回账户总览。 */
function BackToAccount(): React.JSX.Element {
  const { t } = useT();
  return (
    <div style={{ marginBottom: 16 }}>
      <button onClick={() => navigate("/settings/account")} style={btnStyle("ghost")}>{t("← 返回账户与安全")}</button>
    </div>
  );
}

/** 账户与安全：总览 + 各设置入口（一次专注一件事 → 独立子页）。 */
/** 订阅信息（GET /api/billing/subscription 返回）。 */
interface SubInfo {
  planStatus: string | null;
  planId: string | null;
  planExpiresAt: number | null;
  hostQuota: number | null;
  hostsInUse: number;
}

/** 剩余时长文案（天/小时）。 */
function remainingText(expiresAt: number, t: T): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return t("已到期");
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return days > 0 ? t("{days} 天 {hours} 小时", { params: { days, hours } }) : t("{hours} 小时", { params: { hours } });
}

/** 当前订阅状态卡：账户总览可点击进入套餐页；套餐页内静态展示（不传 onClick）。 */
function CurrentPlanCard({ sub, onClick }: { sub: SubInfo | null; onClick?: () => void }): React.JSX.Element {
  const { t } = useT();
  const status = sub?.planStatus ?? null;
  const used = sub?.hostsInUse ?? 0;
  const quota = sub?.hostQuota ?? null;
  let title: string;
  let detail: string;
  let warn = false;
  if (status === null) {
    title = t("🏠 自托管模式");
    detail = t("host 数量不限 · 无需订阅 · 开源免费");
  } else if (status === "trial") {
    title = t("● 试用中");
    detail =
      sub!.planExpiresAt !== null
        ? t("剩余 {x} · 配额 {used}/{quota} 台", { params: { x: remainingText(sub!.planExpiresAt, t), used, quota: quota ?? "∞" } })
        : t("配额 {used}/{quota} 台", { params: { used, quota: quota ?? "∞" } });
  } else if (status === "subscribed") {
    title = t("● 已订阅 {plan}", { params: { plan: sub!.planId ?? t("套餐") } });
    detail =
      sub!.planExpiresAt !== null
        ? t("到期 {date} · 配额 {used}/{quota} 台", {
            params: { date: new Date(sub!.planExpiresAt).toLocaleDateString(), used, quota: quota ?? "∞" },
          })
        : t("配额 {used}/{quota} 台", { params: { used, quota: quota ?? "∞" } });
  } else if (status === "grace") {
    title = t("⚠ 宽限期");
    detail =
      sub!.planExpiresAt !== null
        ? t("剩余 {x} · 隧道保留 · 到期后降级免费档", { params: { x: remainingText(sub!.planExpiresAt, t) } })
        : t("隧道保留 · 到期后降级免费档");
    warn = true;
  } else {
    title = t("○ 免费档");
    detail = t("0 台配额 · host 数据保留 30 天");
  }
  const action = status === null ? t("查看详情") : status === "trial" || status === "free" ? t("升级套餐") : t("管理");
  const style: React.CSSProperties = {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: 10,
    padding: "14px 16px",
    border: `1px solid ${warn ? "#f59e0b" : "#e5e7eb"}`,
    borderRadius: 10,
    background: warn ? "#fffbeb" : "#fff",
    cursor: onClick !== undefined ? "pointer" : "default",
    marginBottom: 12,
    textAlign: "left",
    font: "inherit",
  };
  const content = (
    <>
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: warn ? "#b45309" : "#111827" }}>{title}</span>
        <span style={{ display: "block", fontSize: 12, color: "#6b7280", marginTop: 2 }}>{detail}</span>
      </span>
      {onClick !== undefined && <span style={{ color: "#2563eb", fontSize: 13 }}>{action} ›</span>}
    </>
  );
  return onClick !== undefined ? (
    <button onClick={onClick} style={style}>{content}</button>
  ) : (
    <div style={style}>{content}</div>
  );
}

function AccountPage(): React.JSX.Element {
  const { t } = useT();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [sub, setSub] = useState<SubInfo | null>(null);
  const [customerServiceUrl, setCustomerServiceUrl] = useState<string | undefined>(undefined);
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const { err, run } = useError();
  useEffect(() => {
    void run(async () => {
      const [acc, subInfo] = await Promise.all([api.accountInfo(), api.subscription()]);
      setInfo(acc);
      setSub(subInfo);
    });
  }, []);
  useEffect(() => {
    void api.capabilities().then((c) => { setCustomerServiceUrl(c.site?.customerServiceUrl); if (c.wechatLoginEnabled === true) setWechatEnabled(true); }).catch(() => undefined);
  }, []);
  return (
    <Shell title={t("账户与安全")}>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <CurrentPlanCard sub={sub} onClick={() => navigate("/billing")} />
      <SettingRow
        label={t("邮箱")}
        desc={info?.emailVerified === true ? t("已绑定 {x}", { params: { x: maskEmail(info.email ?? "") } }) : t("绑定邮箱后可自助找回密码")}
        badge={<Badge ok={info?.emailVerified === true} text={info?.emailVerified ? t("已验证") : t("未绑定")} />}
        onClick={() => navigate("/settings/email")}
      />
      {info === null || info.smsEnabled ? (
        <SettingRow
          label={t("手机号")}
          desc={info?.phoneVerified === true ? t("已绑定 {x}", { params: { x: maskPhone(info.phone ?? "") } }) : t("绑定手机号后可用短信验证码找回密码")}
          badge={<Badge ok={info?.phoneVerified === true} text={info?.phoneVerified ? t("已验证") : t("未绑定")} />}
          onClick={() => navigate("/settings/phone")}
        />
      ) : null}
      <SettingRow
        label={t("修改密码")}
        desc={t("定期更换密码，保障账号安全")}
        onClick={() => navigate("/settings/password")}
      />
      <SettingRow
        label={t("两步验证（TOTP）")}
        desc={info?.totpEnabled === true ? t("已开启，登录需输入动态验证码") : t("开启后登录需输入动态验证码")}
        badge={<Badge ok={info?.totpEnabled === true} text={info?.totpEnabled ? t("已开启") : t("未开启")} />}
        onClick={() => navigate("/settings/2fa")}
      />
      {wechatEnabled ? (
        <SettingRow
          label={t("绑定微信")}
          desc={info?.wechatBound === true ? t("该微信可免密登录本账号：{x}", { params: { x: info.wechatNickname ?? "" } }) : t("绑定微信后，该微信可免密登录本账号")}
          badge={<Badge ok={info?.wechatBound === true} text={info?.wechatBound ? t("已绑定") : t("未绑定")} />}
          onClick={() => { if (info?.wechatBound !== true) window.location.href = "/api/wechat/bind/authorize"; }}
        />
      ) : null}
      {customerServiceUrl !== undefined && customerServiceUrl !== "" ? (
        <SettingLink label={t("微信客服")} desc={t("遇到问题？联系在线客服")} href={customerServiceUrl} />
      ) : null}
      <SettingRow label={t("删除账号")} desc={t("立即断开全部主机并清除个人数据，不可恢复")} danger onClick={() => navigate("/settings/danger")} />
    </Shell>
  );
}

/** 邮箱设置（独立页，专注一件事）。 */
function EmailSettingsPage(): React.JSX.Element {
  const { t } = useT();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [seconds, startCountdown] = useCountdown();
  const { toast, show } = useToast();
  const { err, run } = useError();
  useEffect(() => {
    void run(async () => setInfo(await api.accountInfo()));
  }, []);
  const refresh = async (): Promise<void> => setInfo(await api.accountInfo());
  const bound = info?.emailVerified === true;

  return (
    <Shell title={t("邮箱设置")}>
      <BackToAccount />
      <Toast toast={toast} />
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <Card title={t("邮箱")} badge={<Badge ok={bound} text={bound ? t("已验证") : t("未绑定")} />}>
        {info?.email !== null && info !== null && (
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 0 }}>
            {t("当前绑定：{x}", { params: { x: maskEmail(info.email!) } })}　
            <button
              onClick={() => void run(async () => { await api.unbindEmail(); show("ok", t("邮箱已解绑")); await refresh(); })}
              style={btnStyle("ghost")}
            >{t("解绑")}</button>
          </p>
        )}
        {field(t("邮箱地址（换绑需重新验证）"), email, setEmail)}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <SendCodeButton
            label={t("发送验证码")}
            seconds={seconds}
            disabled={info === null}
            onClick={() => void run(async () => { await api.bindEmail(email.trim()); startCountdown(); show("ok", t("验证码已发送到邮箱，请查收（10 分钟内有效）")); })}
          />
        </div>
        {field(t("验证码"), code, setCode)}
        <button onClick={() => void run(async () => { await api.verifyEmail(email.trim(), code.trim()); setCode(""); show("ok", t("邮箱已验证 ✓")); await refresh(); })} style={btnStyle()}>{t("验证邮箱")}</button>
      </Card>
    </Shell>
  );
}

/** 手机号设置（独立页）。 */
function PhoneSettingsPage(): React.JSX.Element {
  const { t } = useT();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [seconds, startCountdown] = useCountdown();
  const { toast, show } = useToast();
  const { err, run } = useError();
  useEffect(() => {
    void run(async () => setInfo(await api.accountInfo()));
  }, []);
  const refresh = async (): Promise<void> => setInfo(await api.accountInfo());
  const bound = info?.phoneVerified === true;

  return (
    <Shell title={t("手机号设置")}>
      <BackToAccount />
      <Toast toast={toast} />
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <Card title={t("手机号")} badge={<Badge ok={bound} text={bound ? t("已验证") : t("未绑定")} />}>
        {info?.phone !== null && info !== null && (
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 0 }}>
            {t("当前绑定：{x}", { params: { x: maskPhone(info.phone!) } })}　
            <button
              onClick={() => void run(async () => { await api.unbindPhone(); show("ok", t("手机号已解绑")); await refresh(); })}
              style={btnStyle("ghost")}
            >{t("解绑")}</button>
          </p>
        )}
        {field(t("手机号（+86，11 位）"), phone, setPhone)}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <SendCodeButton
            label={t("发送验证码")}
            seconds={seconds}
            disabled={info === null}
            onClick={() => void run(async () => { await api.bindPhone(phone.trim()); startCountdown(); show("ok", t("短信验证码已发送，请查收（10 分钟内有效）")); })}
          />
        </div>
        {field(t("验证码"), code, setCode)}
        <button onClick={() => void run(async () => { await api.verifyPhone(phone.trim(), code.trim()); setCode(""); show("ok", t("手机号已验证 ✓")); await refresh(); })} style={btnStyle()}>{t("验证手机号")}</button>
      </Card>
    </Shell>
  );
}

/** 两步验证（独立页；开启与关闭按当前状态二选一显示）。 */
function TwoFaSettingsPage(): React.JSX.Element {
  const { t } = useT();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [twofa, setTwofa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [twofaCode, setTwofaCode] = useState("");
  const { toast, show } = useToast();
  const { err, run } = useError();
  useEffect(() => {
    void run(async () => setInfo(await api.accountInfo()));
  }, []);
  const refresh = async (): Promise<void> => setInfo(await api.accountInfo());
  const enabled = info?.totpEnabled === true;

  return (
    <Shell title={t("两步验证")}>
      <BackToAccount />
      <Toast toast={toast} />
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <Card title={t("两步验证（TOTP）")} badge={<Badge ok={enabled} text={enabled ? t("已开启") : t("未开启")} />}>
        {!enabled ? (
          twofa === null ? (
            <button
              onClick={() => void run(async () => {
                const r = await api.enable2fa();
                setTwofa({ secret: r.secret, otpauthUrl: r.otpauthUrl });
                setQrDataUrl(await QRCode.toDataURL(r.otpauthUrl, { width: 220, margin: 1 }));
              })}
              style={btnStyle()}
            >{t("开启 2FA")}</button>
          ) : (
            <div>
              <p style={{ fontSize: 13, marginTop: 0 }}>{t("用 Authenticator App 扫描二维码，或手动输入密钥：")}</p>
              {qrDataUrl !== "" && <img src={qrDataUrl} alt="TOTP QR" style={{ width: 200, height: 200, borderRadius: 6, border: "1px solid #eee", marginBottom: 8 }} />}
              <p style={{ fontSize: 13 }}>{t("密钥（复制到 Google Authenticator / Microsoft Authenticator / 1Password 等）：")}</p>
              <code style={{ wordBreak: "break-all" }}>{twofa.secret}</code>
              <div style={{ background: "#f8fafc", border: "1px solid #eee", borderRadius: 8, padding: 12, margin: "12px 0", fontSize: 12, color: "#444" }}>
                <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{t("设置步骤：")}</p>
                <p style={{ margin: "2px 0" }}>1. {t("打开 Authenticator App（微软 / Google / 1Password 均可）")}</p>
                <p style={{ margin: "2px 0" }}>2. {t("添加账号 → 扫码绑定；无法扫码时选「手动输入」，粘贴下方密钥")}</p>
                <p style={{ margin: "2px 0" }}>3. {t("App 生成 6 位动态码（每 30 秒轮换）")}</p>
                <p style={{ margin: "2px 0" }}>4. {t("把动态码填回本页输入框（输满 6 位自动提交）→ 点「确认开启」")}</p>
                <p style={{ margin: "8px 0 4px", fontWeight: 600 }}>{t("提示：")}</p>
                <p style={{ margin: "2px 0" }}>· {t("密钥仅在此展示，开启后不再显示 —— 请确保 App 已成功绑定；建议保存密钥截图作备份")}</p>
                <p style={{ margin: "2px 0" }}>· {t("绑定后每次登录需输入动态码；可选「记住此设备 30 天」免重复输入")}</p>
                <p style={{ margin: "2px 0" }}>· {t("若换机/丢失 Authenticator，需联系管理员重置 2FA")}</p>
              </div>
              {field(t("当前 TOTP 验证码"), twofaCode, setTwofaCode, "text", { numeric: true })}
              <button
                onClick={() => void run(async () => { await api.activate2fa(twofa.secret, twofaCode.trim()); setTwofa(null); setTwofaCode(""); show("ok", t("2FA 已开启 ✓")); await refresh(); })}
                style={btnStyle()}
              >{t("确认开启")}</button>
            </div>
          )
        ) : (
          <div>
            <p style={{ fontSize: 13, color: "#6b7280", marginTop: 0 }}>{t("已开启两步验证，登录时需输入 TOTP 动态验证码。")}</p>
            {field(t("输入当前验证码以关闭"), twofaCode, setTwofaCode, "text", { numeric: true })}
            <button
              onClick={() => void run(async () => { await api.disable2fa(twofaCode.trim()); setTwofaCode(""); show("ok", t("2FA 已关闭")); await refresh(); })}
              style={btnStyle("danger")}
            >{t("关闭 2FA")}</button>
          </div>
        )}
      </Card>
    </Shell>
  );
}

/** 危险操作（删除账号）。 */
function DangerZonePage(): React.JSX.Element {
  const { t } = useT();
  const [deletePw, setDeletePw] = useState("");
  const { err, run } = useError();
  return (
    <Shell title={t("删除账号")}>
      <BackToAccount />
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <Card title={t("删除账号（不可恢复）")}>
        <p style={{ fontSize: 13, color: "#6b7280", marginTop: 0 }}>
          {t("删除后将立即断开全部主机并清除个人数据（账务记录保留），且不可恢复。请谨慎操作。")}
        </p>
        {field(t("输入密码以确认"), deletePw, setDeletePw, "password")}
        <button
          onClick={() => void run(async () => { if (!window.confirm(t("确认永久删除账号？此操作不可恢复。"))) return; await api.deleteAccount(deletePw); navigate("/login"); })}
          style={btnStyle("danger")}
        >{t("永久删除账号")}</button>
      </Card>
    </Shell>
  );
}

// ---- 找回密码 ----

function ResetPasswordPage(): React.JSX.Element {
  const { t } = useT();
  const [channel, setChannel] = useState<"email" | "phone">("email");
  const [identifier, setIdentifier] = useState("");
  const [captchaPayload, setCaptchaPayload] = useState<CaptchaPayload>({});
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [cap, setCap] = useState<Capabilities | null>(null);
  const { err, run } = useError();

  // sms 未配置 → 隐藏手机号通道（未登录，走公开 /api/capabilities）
  useEffect(() => {
    void api.capabilities().then((c) => {
      setCap(c);
      if (c.smsEnabled === false) setChannel("email");
    }).catch(() => undefined);
  }, []);

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <h1 style={{ fontSize: 20 }}>{t("找回密码")}</h1>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <button onClick={() => setChannel("email")} style={channel === "email" ? btnStyle() : btnStyle("ghost")}>{t("邮箱")}</button>
        {cap?.smsEnabled !== false && (
          <button onClick={() => setChannel("phone")} style={channel === "phone" ? btnStyle() : btnStyle("ghost")}>{t("手机号")}</button>
        )}
      </div>
      {!sent ? (
        <>
          {field(channel === "email" ? t("注册邮箱") : t("手机号（+86）"), identifier, setIdentifier)}
          <CaptchaGate onCaptcha={setCaptchaPayload} />
          {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
          <button onClick={() => void run(async () => { await api.resetRequest(channel, identifier.trim(), captchaPayload); setSent(true); })} style={{ ...btnStyle(), width: "100%" }}>{t("发送重置码")}</button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "#666" }}>{t("若该{channel}已注册，重置码已发送（10 分钟内有效）。", { params: { channel: channel === "email" ? t("邮箱") : t("手机号") } })}</p>
          {field(t("重置码"), code, setCode)}
          {field(t("新密码（至少 8 位）"), newPassword, setNewPassword, "password")}
          {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
          <button onClick={() => void run(async () => { await api.resetConfirm(channel, identifier.trim(), code.trim(), newPassword); navigate("/login"); })} style={{ ...btnStyle(), width: "100%" }}>{t("重置密码")}</button>
        </>
      )}
    </div>
  );
}

// ---- host 列表 ----

/** 端到端加密标识：盾牌 + 对勾（绿色，安全/已验证语义）。 */
function ShieldIcon(): React.JSX.Element {
  const { t } = useT();
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#16a34a"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ marginRight: 5, verticalAlign: -1.5, flexShrink: 0 }}
    >
      <title>{t("端到端加密")}</title>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** 菜单项图标：继承 currentColor（随普通/危险文字变色），stroke 风格与全站一致。 */
function MenuIcon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

function HostsPage(): React.JSX.Element {
  const { t } = useT();
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [menuHostId, setMenuHostId] = useState<string | null>(null);
  const [shareHostId, setShareHostId] = useState<string | null>(null);
  const [shareName, setShareName] = useState("");
  const [shares, setShares] = useState<Array<{ userId: number; name: string; role: string }>>([]);
  const [pendingTrust, setPendingTrust] = useState<{ hostId: string; name: string; publicKey: string; fingerprint: string; changed: boolean } | null>(null);
  const { err, run } = useError();

  const openShare = (hostId: string): void => {
    setShareHostId(hostId);
    void run(async () => setShares((await api.listShares(hostId)).shares));
  };

  const requestEnter = (h: HostInfo): void => {
    void run(async () => {
      const pub = h.e2eePublicKey;
      if (pub === undefined || pub === null || pub === "") {
        enterHost(h.id); // 无 E2EE 公钥 → 直连（明文）
        return;
      }
      const fp = await fingerprint(fromBase64url(pub));
      const pinned = readE2eePin(h.id);
      if (pinned === pub) {
        enterHost(h.id);
        return;
      }
      setPendingTrust({ hostId: h.id, name: h.name, publicKey: pub, fingerprint: fp, changed: pinned !== null });
    });
  };

  const trustAndEnter = (): void => {
    if (pendingTrust !== null) {
      writeE2eePin(pendingTrust.hostId, pendingTrust.publicKey);
      const hostId = pendingTrust.hostId;
      setPendingTrust(null);
      enterHost(hostId);
    }
  };
  const doShare = (): void => {
    if (shareHostId === null) return;
    void run(async () => {
      await api.shareHost(shareHostId, shareName.trim());
      setShareName("");
      openShare(shareHostId);
    });
  };
  const doRevokeShare = (userId: number): void => {
    if (shareHostId === null) return;
    void run(async () => {
      await api.revokeShare(shareHostId, userId);
      openShare(shareHostId);
    });
  };

  const load = (): void => {
    void run(async () => {
      const r = await api.listHosts();
      setHosts(r.hosts);
      setLoading(false);
    });
  };

  useEffect(() => {
    load();
    const unsub = subscribeEvents((e) => {
      setHosts((prev) => prev.map((h) => (h.id === e.hostId ? { ...h, online: e.type === "host.online" } : h)));
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (menuHostId === null) return;
    const close = (): void => setMenuHostId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuHostId]);

  const revoke = (hostId: string): void => {
    if (!window.confirm(t("吊销该 host？其隧道立即断开，需重新接入。"))) return;
    void run(async () => {
      await api.revokeHost(hostId);
      load();
    });
  };

  const rename = (hostId: string): void => {
    void run(async () => {
      await api.renameHost(hostId, renameName.trim());
      setRenameId(null);
      load();
    });
  };

  const shareHostName = shareHostId !== null ? hosts.find((h) => h.id === shareHostId)?.name : undefined;

  return (
    <Shell>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate("/add-host")} style={btnStyle()}>{t("添加主机接入")}</button>
      </div>

      {loading ? (
        <p style={{ color: "#666" }}>{t("加载中…")}</p>
      ) : hosts.length === 0 ? (
        <p style={{ color: "#666" }}>{t("还没有接入主机 —— 用上面的「添加主机」接入你的第一台 DSH。")}</p>
      ) : (
        <div>
          {hosts.map((h) => {
            const isOwner = h.role !== "member";
            const menuOpen = menuHostId === h.id;
            return (
              <div key={h.id} style={{ border: "1px solid #eee", borderRadius: 8, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                  <span style={{ fontWeight: 500 }}>
                    {h.e2eePublicKey !== undefined && h.e2eePublicKey !== null && h.e2eePublicKey !== "" && <ShieldIcon />}
                    {h.name}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ color: h.online ? "#16a34a" : "#999", fontSize: 14 }}>{h.online ? "●" : "○"}</span>
                    <span style={{ color: "#666", fontSize: 12 }}>{h.online ? t("在线") : t("离线")}</span>
                  </span>
                  {!isOwner && <span style={{ color: "#999", fontSize: 12, border: "1px solid #eee", borderRadius: 4, padding: "1px 6px" }}>{t("共享", { en: "Shared" })}</span>}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6, position: "relative" }}>
                    <button onClick={() => requestEnter(h)} style={btnStyle()}>{t("进入")}</button>
                    {isOwner && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuHostId(menuOpen ? null : h.id); }}
                        style={btnStyle("ghost")}
                        title={t("更多操作")}
                      >⋯</button>
                    )}
                    {menuOpen && (
                      <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "#fff", border: "1px solid #eee", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,.1)", zIndex: 20, minWidth: 140, padding: 4 }} onClick={(e) => e.stopPropagation()}>
                        <button style={menuItemStyle()} onClick={() => { setMenuHostId(null); setRenameId(h.id); setRenameName(h.name); }}>
                          <MenuIcon><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></MenuIcon>
                          {t("改名")}
                        </button>
                        <button style={menuItemStyle()} onClick={() => { setMenuHostId(null); openShare(h.id); }}>
                          <MenuIcon>
                            <circle cx="18" cy="5" r="3" />
                            <circle cx="6" cy="12" r="3" />
                            <circle cx="18" cy="19" r="3" />
                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                          </MenuIcon>
                          {t("共享主机")}
                        </button>
                        <button style={menuItemStyle(true)} onClick={() => { setMenuHostId(null); revoke(h.id); }}>
                          <MenuIcon>
                            <circle cx="12" cy="12" r="10" />
                            <path d="m4.9 4.9 14.2 14.2" />
                          </MenuIcon>
                          {t("吊销")}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {renameId === h.id && (
                  <div style={{ display: "flex", gap: 6, padding: "0 12px 10px" }}>
                    <input value={renameName} onChange={(e) => setRenameName(e.target.value)} style={{ ...inputStyle(), width: 220 }} autoFocus />
                    <button onClick={() => rename(h.id)} style={btnStyle()}>{t("保存")}</button>
                  </div>
                )}
              </div>
            );
          })}
          {shareHostId !== null && (
            <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <p style={{ fontWeight: 500, margin: 0 }}>{t("共享管理")}{shareHostName !== undefined ? ` · ${shareHostName}` : ""}</p>
                <button onClick={() => { setShareHostId(null); setShareName(""); }} style={btnStyle("ghost")}>{t("关闭")}</button>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder={t("成员用户名")} style={{ ...inputStyle(), width: 180 }} />
                <button onClick={doShare} style={btnStyle()}>{t("共享", { en: "Share" })}</button>
              </div>
              {shares.length === 0 ? (
                <p style={{ color: "#666", fontSize: 13 }}>{t("尚未共享给任何人")}</p>
              ) : (
                shares.map((s) => (
                  <div key={s.userId} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14 }}>{s.name}</span>
                    <button onClick={() => doRevokeShare(s.userId)} style={btnStyle("danger")}>{t("移除")}</button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {pendingTrust !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setPendingTrust(null)}>
          <div style={{ background: "#fff", padding: 20, borderRadius: 12, maxWidth: 400, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 600 }}>{pendingTrust.changed ? t("主机的安全指纹已改变") : t("首次连接这台主机")}</p>
            <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>{t("主机")}: {pendingTrust.name}</p>
            <p style={{ fontFamily: "monospace", fontSize: 16, letterSpacing: 1, margin: "10px 0" }}>{pendingTrust.fingerprint}</p>
            <p style={{ color: "#999", fontSize: 12, margin: "0 0 12px" }}>
              {pendingTrust.changed ? t("可能原因：主机重装 / 重建，或连接被劫持。请确认后重新信任。") : t("信任后，与这台主机的数据将端到端加密（hub 不可读）。")}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={trustAndEnter} style={btnStyle()}>{t("信任并进入")}</button>
              <button onClick={() => setPendingTrust(null)} style={btnStyle("ghost")}>{t("取消")}</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function logout(): void {
  const refresh = sessionStorage.getItem(REFRESH_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  const done = (): void => navigate("/login");
  if (refresh === null) {
    done();
    return;
  }
  // 等服务端清 cookie 完成再跳转（httpOnly cookie 客户端无法删除）；失败也先本地登出。
  void api.logout(refresh).catch(() => undefined).finally(done);
}

// ---- 进入 host：整页跳转 /h/<hostId>/（hub 校验归属 → Set-Cookie → 302 根路径，DSH 在根路径运行） ----

function enterHost(hostId: string): void {
  window.location.href = `/h/${encodeURIComponent(hostId)}/`;
}

// ---- 添加主机：生成用户级 join token + 接入命令（明文只显示一次）----

/** ISO 时间 → yyyyMMddhhmmss（本地时区；令牌无备注时的默认显示名）。 */
function compactTimestamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function AddHostPage(): React.JSX.Element {
  const { t } = useT();
  const [tokens, setTokens] = useState<JoinTokenInfo[]>([]);
  const [note, setNote] = useState("");
  const [ttl, setTtl] = useState(30 * 24 * 3600);
  const [generated, setGenerated] = useState<{ token: string; hub: string; command: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyErr, setCopyErr] = useState("");
  const { err, run } = useError();

  const load = (): void => {
    void run(async () => {
      const r = await api.listJoinTokens();
      setTokens(r.tokens.filter((t) => !t.revoked));
    });
  };

  useEffect(() => {
    load();
  }, []);

  const generate = (): void => {
    void run(async () => {
      const r = await api.createJoinToken(note.trim() || null, ttl);
      const hub = `https://${window.location.host}`;
      setGenerated({ token: r.token, hub, command: `rdsh host join ${hub} --token ${r.token}` });
      load();
    });
  };

  const revoke = (id: string): void => {
    if (!window.confirm(t("吊销该 join token？已注册主机不受影响，仅阻止未来注册。"))) return;
    void run(async () => {
      await api.revokeJoinToken(id);
      load();
    });
  };

  const copy = (key: string, text: string): void => {
    setCopyErr("");
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
      },
      () => {
        // 兜底：旧浏览器/权限拒绝 → textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        document.body.removeChild(ta);
        if (ok) {
          setCopiedKey(key);
          setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
        } else {
          setCopyErr(t("复制失败，请手动选择复制"));
        }
      },
    );
  };

  return (
    <Shell title={t("添加主机接入")}>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>{t("生成接入令牌")}</h2>
        <p style={{ fontSize: 14, color: "#111", margin: "0 0 8px" }}>{t("用于将主机接入 Hub，并绑定到用户的账号。")}</p>
        <div style={{ fontSize: 12, color: "#666", paddingLeft: 16 }}>
          <p style={{ margin: "2px 0" }}>· {t("明文只在生成时显示一次——刷新或离开本页后无法再次查看，请立即复制")}</p>
          <p style={{ margin: "2px 0" }}>· {t("令牌在有效期内可重复使用，可接入多台主机")}</p>
          <p style={{ margin: "2px 0" }}>· {t("接入后主机保持连接，不依赖此令牌——吊销它不影响已接入主机")}</p>
          <p style={{ margin: "2px 0" }}>· {t("遗忘或泄露，请立即吊销并重新生成，旧令牌即刻失效")}</p>
        </div>
      </div>
      <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, marginBottom: 16 }}>
        {field(t("令牌备注（可选）"), note, setNote)}
        <label style={{ display: "block", marginBottom: 16, fontSize: 13 }}>
          <span style={{ display: "block", marginBottom: 4 }}>{t("有效期")}</span>
          <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} style={inputStyle()}>
            <option value={86400}>{t("1 天")}</option>
            <option value={7 * 86400}>{t("7 天")}</option>
            <option value={30 * 86400}>{t("30 天（默认）")}</option>
            <option value={90 * 86400}>{t("90 天")}</option>
            <option value={365 * 86400}>{t("1 年")}</option>
          </select>
        </label>
        <button onClick={generate} style={btnStyle()}>{t("生成接入令牌")}</button>
      </div>

      {generated !== null && (
        <div style={{ marginBottom: 16 }}>
          <p style={{ color: "#dc2626", fontSize: 13, fontWeight: 600, margin: "0 0 8px" }}>{t("接入令牌明文只显示这一次，请立即复制")}</p>
          <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 16, marginBottom: 12 }}>
            <p style={{ margin: "0 0 10px", fontWeight: 600, fontSize: 14 }}>{t("方式一：DSH 插件（界面操作，免装 CLI）")}</p>
            <p style={{ color: "#666", fontSize: 12, margin: 0 }}>{t("未装插件？在主机终端执行：")}</p>
            <pre style={{ background: "#f8fafc", border: "1px solid #eee", borderRadius: 6, padding: 8, fontSize: 12, margin: "4px 0 6px", overflowX: "auto" }}>dsh plugin --profile web add dsh-web-remote</pre>
            <p style={{ color: "#666", fontSize: 12, margin: "0 0 10px" }}>{t("然后重启 dsh web（插件 boot 时加载）")}</p>
            <p style={{ color: "#666", fontSize: 13, margin: "0 0 8px" }}>{t("在 DSH 设置 →「远程访问」面板填入：")}</p>
            <div style={{ marginBottom: 10 }}>
              <code style={{ display: "block", fontSize: 12, color: "#666", background: "#f3f4f6", padding: "6px 8px", borderRadius: 4, wordBreak: "break-all" }}>{generated.hub}</code>
              <button onClick={() => copy("hub", generated.hub)} style={{ ...btnStyle(), marginTop: 6 }}>{copiedKey === "hub" ? `${t("已复制")} ✓` : t("复制 Hub 地址")}</button>
            </div>
            <div style={{ marginBottom: 0 }}>
              <code style={{ display: "block", fontSize: 12, color: "#111", background: "#f3f4f6", padding: "6px 8px", borderRadius: 4, wordBreak: "break-all" }}>{generated.token}</code>
              <button onClick={() => copy("token", generated.token)} style={{ ...btnStyle(), marginTop: 6 }}>{copiedKey === "token" ? `${t("已复制")} ✓` : t("复制令牌")}</button>
            </div>
          </div>
          <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 10px", fontWeight: 600, fontSize: 14 }}>{t("方式二：rdsh-gateway（命令行）")}</p>
            <p style={{ color: "#666", fontSize: 12, margin: 0 }}>{t("未装 CLI？终端执行：")}</p>
            <pre style={{ background: "#f8fafc", border: "1px solid #eee", borderRadius: 6, padding: 8, fontSize: 12, margin: "4px 0 10px", overflowX: "auto" }}>npm i -g remote-dsh</pre>
            <p style={{ color: "#666", fontSize: 13, margin: "0 0 6px" }}>{t("在主机终端执行：")}</p>
            <pre style={{ background: "#f8fafc", border: "1px solid #eee", borderRadius: 6, padding: 8, fontSize: 12, margin: "0 0 8px", overflowX: "auto" }}>{generated.command}</pre>
            <button onClick={() => copy("command", generated.command)} style={btnStyle()}>{copiedKey === "command" ? `${t("已复制")} ✓` : t("复制命令")}</button>
            {copyErr !== "" && <p style={{ color: "#dc2626", fontSize: 13, margin: "8px 0 0" }}>{copyErr}</p>}
            <p style={{ color: "#666", fontSize: 12, margin: "10px 0 2px" }}>{t("接入后运行隧道：")}</p>
            <p style={{ color: "#666", fontSize: 12, margin: "2px 0" }}>· {t("前台运行：rdsh host serve")}</p>
            <p style={{ color: "#666", fontSize: 12, margin: "2px 0" }}>· {t("常驻服务（服务器 7×24）：rdsh host service install")}</p>
            <p style={{ color: "#666", fontSize: 12, margin: "10px 0 0" }}>{t("主机名默认取机器 hostname，可追加 --name 覆盖")}</p>
          </div>
        </div>
      )}

      <p style={{ fontSize: 13, color: "#666", fontWeight: 600, marginBottom: 6 }}>{t("接入令牌")}</p>
      {tokens.length === 0 ? (
        <p style={{ color: "#999", fontSize: 13 }}>{t("（无）")}</p>
      ) : (
        <div>
          {tokens.map((tok) => (
            <div key={tok.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid #eee", borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 500 }}>{tok.label ?? compactTimestamp(tok.createdAt)}</span>
              <code style={{ fontSize: 12, color: "#666", background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>{tok.fingerprint}</code>
              <span style={{ color: "#666", fontSize: 12 }}>{t("到期 {date}", { params: { date: new Date(tok.expiresAt).toLocaleDateString() } })}</span>
              <button onClick={() => revoke(tok.id)} style={{ ...btnStyle("danger"), marginLeft: "auto" }}>{t("吊销")}</button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

// ---- 修改密码 ----

function PasswordPage(): React.JSX.Element {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const { err, run } = useError();

  const submit = (): void => {
    if (next.length < 8) {
      setDone(false);
      return;
    }
    if (next !== again) return;
    void run(async () => {
      await api.changePassword(current, next);
      setDone(true);
      sessionStorage.removeItem(REFRESH_KEY);
      setTimeout(() => navigate("/login"), 1500);
    });
  };

  return (
    <Shell title={t("修改密码")}>
      {done && <p style={{ color: "#16a34a", fontSize: 14 }}>{t("密码已修改，全部会话已失效 —— 即将跳转登录…")}</p>}
      {!done && (
        <>
          {field(t("当前密码"), current, setCurrent, "password")}
          {field(t("新密码（至少 8 位）"), next, setNext, "password")}
          {field(t("确认新密码"), again, setAgain, "password")}
          {next !== again && next !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{t("两次输入不一致")}</p>}
          {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
          <button onClick={submit} style={btnStyle()}>{t("保存")}</button>
        </>
      )}
    </Shell>
  );
}

// ---- 08-saas：注册 / 验证 / 套餐订阅 ----

function RegisterPage(): React.JSX.Element {
  const { t } = useT();
  const [channel, setChannel] = useState<"email" | "phone">("email");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [captchaPayload, setCaptchaPayload] = useState<CaptchaPayload>({});
  const [cap, setCap] = useState<Capabilities | null>(null);
  const [agreed, setAgreed] = useState(false);
  const { err, run } = useError();

  // sms 未配置 → 隐藏手机号 tab（注册页未登录，走公开 /api/capabilities）
  useEffect(() => {
    void api.capabilities().then((c) => {
      setCap(c);
      if (c.smsEnabled === false) setChannel("email");
    }).catch(() => undefined);
  }, []);

  const submit = (): void => {
    if (!agreed) return;
    void run(async () => {
      await api.register(channel, identifier.trim(), password, captchaPayload);
      navigate(`/verify?channel=${channel}&identifier=${encodeURIComponent(identifier.trim())}`);
    });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{t("注册 rdsh")}</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 24 }}>{t("注册即享 7 天试用（1 台主机），随时随地浏览器访问你的 DSH。")}</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setChannel("email")} style={channel === "email" ? btnStyle() : btnStyle("ghost")}>{t("邮箱")}</button>
        {cap?.smsEnabled !== false && (
          <button onClick={() => setChannel("phone")} style={channel === "phone" ? btnStyle() : btnStyle("ghost")}>{t("手机号")}</button>
        )}
      </div>
      {field(channel === "email" ? t("邮箱地址") : t("手机号（+86，11 位）"), identifier, setIdentifier)}
      {field(t("密码（至少 8 位）"), password, setPassword, "password")}
      <CaptchaGate onCaptcha={setCaptchaPayload} />
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, marginBottom: 12, lineHeight: 1.6 }}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          {t("我已阅读并同意")}
          {legalLink(cap?.site?.termsUrl, "/terms", t("《用户协议》"), { color: "#2563eb" })}
          {t("与")}
          {legalLink(cap?.site?.privacyUrl, "/privacy", t("《隐私政策》"), { color: "#2563eb" })}
        </span>
      </label>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} disabled={!agreed} style={{ ...btnStyle(), width: "100%", marginTop: 8, opacity: agreed ? 1 : 0.5 }}>{t("获取验证码并注册")}</button>
      <p style={{ marginTop: 12, textAlign: "center" }}>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate("/login"); }} style={{ color: "#2563eb", fontSize: 13 }}>{t("已有账号？登录")}</a>
      </p>
      <SiteFooter />
    </div>
  );
}

function VerifyPage(): React.JSX.Element {
  const { t } = useT();
  const q = new URLSearchParams(window.location.search);
  const channel = (q.get("channel") === "phone" ? "phone" : "email") as "email" | "phone";
  const identifier = q.get("identifier") ?? "";
  const [code, setCode] = useState("");
  const { err, run } = useError();

  const submit = (): void => {
    void run(async () => {
      const r = await api.verifyAccount(channel, identifier, code.trim());
      sessionStorage.setItem(REFRESH_KEY, r.refreshToken ?? "");
      navigate("/hosts");
    });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <h1 style={{ fontSize: 20 }}>{t("验证{channel}", { params: { channel: channel === "email" ? t("邮箱") : t("手机号") } })}</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 24 }}>{t("验证码已发送至 {identifier}（10 分钟内有效）。", { params: { identifier } })}</p>
      {field(t("6 位验证码"), code, setCode)}
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ ...btnStyle(), width: "100%" }}>{t("验证并登录")}</button>
    </div>
  );
}

interface PlanInfo {
  id: string;
  name: string;
  hosts: number;
  priceCny: number;
  intervalDays: number;
}

/** 是否微信内置浏览器。 */
function isWechatWebview(): boolean {
  return /MicroMessenger/i.test(navigator.userAgent);
}

/** 是否移动端浏览器（非微信）。 */
function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** 微信官方 logo（白色版，用于绿底「微信登录」按钮；商标 © Tencent）。 */
function WechatIcon({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={Math.round((size * 310) / 384)} viewBox="0 0 384 310" aria-hidden="true">
      <path
        d="M343.37 275.112c24.333-17.635 39.886-43.726 39.886-72.71 0-53.132-51.685-96.198-115.439-96.198-63.754 0-115.435 43.066-115.435 96.198 0 53.129 51.681 96.194 115.435 96.194 13.174 0 25.89-1.88 37.68-5.272a11.59 11.59 0 0 1 3.397-.505c2.212 0 4.23.673 6.126 1.774l25.272 14.587c.706.408 1.387.719 2.224.719a3.847 3.847 0 0 0 3.847-3.852c0-.946-.378-1.9-.618-2.808-.147-.543-3.263-12.157-5.201-19.406-.223-.811-.404-1.598-.404-2.451a7.687 7.687 0 0 1 3.23-6.27m-114.036-88.1c-8.493 0-15.385-6.89-15.385-15.393 0-8.502 6.892-15.394 15.385-15.394 8.507 0 15.394 6.892 15.394 15.394 0 8.502-6.887 15.394-15.394 15.394m76.961 0c-8.498 0-15.39-6.892-15.39-15.394 0-8.502 6.892-15.394 15.39-15.394 8.503 0 15.39 6.892 15.39 15.394 0 8.502-6.887 15.394-15.39 15.394zM138.524 0c69.11 0 126.385 42.174 136.817 97.32a153.735 153.735 0 0 0-7.523-.201c-69.775 0-126.338 47.14-126.338 105.28 0 9.806 1.644 19.292 4.655 28.295-2.523.113-5.055.18-7.611.18-15.806 0-31.065-2.262-45.215-6.328a13.889 13.889 0 0 0-4.074-.61c-2.658 0-5.071.812-7.354 2.128l-30.326 17.51c-.845.487-1.669.861-2.67.861a4.614 4.614 0 0 1-4.617-4.617c0-1.143.455-2.283.745-3.376l6.24-23.282c.265-.98.487-1.922.487-2.944a9.23 9.23 0 0 0-3.876-7.526C18.657 181.53 0 150.222 0 115.44 0 51.685 62.017 0 138.524 0zM92.346 96.968c10.206 0 18.472-8.267 18.472-18.472 0-10.201-8.266-18.468-18.472-18.468-10.196 0-18.467 8.267-18.467 18.468 0 10.205 8.27 18.472 18.467 18.472zm92.355 0c10.201 0 18.472-8.267 18.472-18.472 0-10.201-8.27-18.468-18.472-18.468-10.205 0-18.471 8.267-18.471 18.468 0 10.205 8.266 18.472 18.471 18.472z"
        fill="#FFF"
        fillRule="evenodd"
      />
    </svg>
  );
}

/** 支付形态按运行环境探测：微信内 → jsapi；移动非微信 → h5；桌面 → native。 */
function detectPayForm(): "native" | "h5" | "jsapi" {
  if (isWechatWebview()) return "jsapi";
  if (isMobileBrowser()) return "h5";
  return "native";
}

/** 微信内 JSAPI 调起收银台（WeixinJSBridge.getBrandWCPayRequest）。 */
function invokeWechatJsapi(payInfo: WechatPayInfo): void {
  const w = window as unknown as { WeixinJSBridge?: { invoke: (api: string, params: Record<string, unknown>, cb: (res: { err_msg?: string }) => void) => void } };
  const call = (): void => {
    if (w.WeixinJSBridge === undefined) return;
    w.WeixinJSBridge.invoke(
      "getBrandWCPayRequest",
      {
        appId: payInfo.appId,
        timeStamp: payInfo.timeStamp,
        nonceStr: payInfo.nonceStr,
        package: payInfo.package,
        signType: payInfo.signType,
        paySign: payInfo.paySign,
      },
      () => {
        // 支付结果由订阅状态轮询兜底，此处不处理 err_msg
      },
    );
  };
  if (w.WeixinJSBridge === undefined) {
    document.addEventListener("WeixinJSBridgeReady", call, { once: true });
  } else {
    call();
  }
}

function BillingPage(): React.JSX.Element {
  const { t } = useT();
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [sub, setSub] = useState<SubInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const { toast, show } = useToast();
  const { err, run } = useError();

  const load = (): void => {
    void run(async () => {
      const [p, s] = await Promise.all([api.listPlans(), api.subscription()]);
      setPlans(p.plans);
      setSub(s);
    });
  };
  useEffect(load, []);

  /** 轮询订阅状态直至支付成功（上限 5 分钟）。 */
  const pollUntilPaid = (): void => {
    const timer = window.setInterval(() => {
      void api
        .subscription()
        .then((s) => {
          if (s.planStatus === "subscribed") {
            window.clearInterval(timer);
            setQrDataUrl(null);
            show("ok", t("订阅成功，配额已升级"));
            load();
          }
        })
        .catch(() => {});
    }, 2000);
    window.setTimeout(() => window.clearInterval(timer), 5 * 60 * 1000);
  };

  const doSubscribe = async (planId: string, form: "native" | "h5" | "jsapi"): Promise<void> => {
    const ok = await run(async () => {
      const r = await api.subscribe(planId, form);
      if (r.paid) {
        show("ok", t("订阅成功，配额已升级"));
        load();
        return;
      }
      const payInfo = r.payInfo;
      if (form === "native" && typeof payInfo?.codeUrl === "string") {
        const dataUrl = await QRCode.toDataURL(payInfo.codeUrl, { width: 220, margin: 1 });
        setQrDataUrl(dataUrl);
        pollUntilPaid();
      } else if (form === "h5" && typeof payInfo?.h5Url === "string") {
        window.location.href = payInfo.h5Url;
      } else if (form === "jsapi" && typeof payInfo?.appId === "string") {
        invokeWechatJsapi(payInfo);
        pollUntilPaid();
      } else {
        show("err", t("支付已取消或失败"));
      }
    });
    if (!ok) load();
  };

  // jsapi OAuth 回跳：/billing?subscribe=<planId> → 直接发起 jsapi 订阅
  useEffect(() => {
    const planId = new URLSearchParams(window.location.search).get("subscribe");
    if (planId !== null) {
      window.history.replaceState({}, "", `${BASE}/billing`);
      void doSubscribe(planId, "jsapi");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = (planId: string): void => {
    const form = detectPayForm();
    if (form === "jsapi") {
      // 微信内先 OAuth 授权拿 openid，再回跳发起支付
      window.location.href = `/api/wechat/oauth/authorize?redirect=${encodeURIComponent(`/billing?subscribe=${planId}`)}`;
      return;
    }
    void doSubscribe(planId, form);
  };

  const hasPlans = plans.length > 0;
  const currentPlanId = sub?.planId ?? null;
  const hasStatus = sub !== null && (hasPlans || sub.planStatus !== null);

  return (
    <>
      <Shell title={t("套餐与订阅")}>
        <Toast toast={toast} />
        {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
        {hasStatus && <CurrentPlanCard sub={sub} />}
        {hasPlans ? (
          <Card title={t("选择套餐")}>
            {plans.map((p) => {
              const current = p.id === currentPlanId;
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", border: "1px solid #e5e7eb", borderRadius: 10, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                      {current && <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, background: "#ecfdf5", color: "#047857" }}>{t("当前套餐")}</span>}
                    </div>
                    <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{t("{hosts} 台 host · ¥{price}/{interval} 天", { params: { hosts: p.hosts, price: p.priceCny, interval: p.intervalDays } })}</div>
                  </div>
                  <button disabled={current} onClick={() => subscribe(p.id)} style={btnStyle()}>
                    {current ? t("当前套餐") : t("订阅")}
                  </button>
                </div>
              );
            })}
          </Card>
        ) : (
          <Card title={t("自托管模式")}>
            <p style={{ fontSize: 13, margin: 0 }}>{t("你正在自托管运行 remote-dsh（开源免费）：host 数量不限 · 无需订阅 · 无到期限制。")}</p>
            <p style={{ fontSize: 13, color: "#6b7280", margin: "8px 0 0" }}>{t("完整功能：多用户 / 2FA / 审计 / 共享。")}</p>
            <p style={{ fontSize: 12, color: "#9ca3af", margin: "8px 0 0" }}>{t("运营方在 hub.json 配置 billing.plans 后，此处将展示套餐与订阅入口。")}</p>
          </Card>
        )}
        <Card title={t("计费说明")}>
          <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>
            {t("订阅/试用到期后进入 3 天宽限期（隧道保留），之后降级免费档（0 台在线，host 数据保留 30 天）。")}
          </p>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "8px 0 0" }}>
            {t("支付：微信支付（上线后支持）· MVP 暂不提供发票。")}
          </p>
        </Card>
      </Shell>
      {qrDataUrl !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setQrDataUrl(null)}>
          <div style={{ background: "#fff", padding: 20, borderRadius: 12, textAlign: "center", maxWidth: 280 }} onClick={(e) => e.stopPropagation()}>
            <img src={qrDataUrl} width={220} height={220} alt="qr" />
            <p style={{ margin: "12px 0 8px", fontSize: 14 }}>{t("请用微信扫一扫完成支付")}</p>
            <button onClick={() => setQrDataUrl(null)} style={btnStyle("ghost")}>{t("取消")}</button>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================
// 管理后台 /admin（独立管理面：三档 RBAC + 强制 2FA + 审计；移动端响应式）
// ============================================================

/** 响应式表格 CSS：<640px 时表格变卡片（label 在左、值在右、操作行右对齐）。 */
const ADMIN_CSS = `
  @media (max-width: 640px) {
    .admintbl thead { display: none; }
    .admintbl, .admintbl tbody, .admintbl tr, .admintbl td { display: block !important; width: 100% !important; box-sizing: border-box; }
    .admintbl tr { margin-bottom: 10px; border: 1px solid #e5e7eb !important; border-radius: 10px; padding: 8px 12px !important; background: #fff; }
    .admintbl td { border: none !important; padding: 5px 0 !important; display: flex !important; justify-content: space-between; align-items: center; gap: 12px; text-align: left !important; }
    .admintbl td::before { content: attr(data-label); font-weight: 600; color: #6b7280; flex-shrink: 0; }
    .admintbl td.act { justify-content: flex-end !important; }
  }
`;

function adminRoleLabel(t: T, role: string): string {
  if (role === "admin") return t("管理员", { en: "Admin" });
  if (role === "operator") return t("运营");
  if (role === "readonly") return t("只读");
  return t("普通用户");
}

function adminBtnStyle(variant: "primary" | "danger" | "ghost" = "primary"): React.CSSProperties {
  const base: React.CSSProperties = { padding: "6px 12px", borderRadius: 6, border: "1px solid #ccc", cursor: "pointer", fontSize: 13 };
  if (variant === "primary") return { ...base, background: "#2563eb", color: "#fff", borderColor: "#2563eb" };
  if (variant === "danger") return { ...base, background: "#dc2626", color: "#fff", borderColor: "#dc2626" };
  return { ...base, background: "#fff" };
}

function adminTableStyle(): React.CSSProperties {
  return { width: "100%", borderCollapse: "collapse", fontSize: 13 };
}

/** 单元格：数据格带 label（移动端卡片左标签）、操作格右对齐。 */
function adminTd(label: string | null, children: React.ReactNode): React.JSX.Element {
  if (label === null) return <td className="act" style={{ padding: "6px 8px" }}>{children}</td>;
  return <td data-label={label} style={{ padding: "6px 8px" }}>{children}</td>;
}
function adminTh(label: string): React.JSX.Element {
  return <th key={label} style={{ padding: "6px 8px", textAlign: "left" }}>{label}</th>;
}

/** 分页控件：上一页/下一页 + 当前页/总条数。 */
function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }): React.JSX.Element | null {
  const { t } = useT();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 13 }}>
      <button disabled={page === 0} onClick={() => onPage(page - 1)} style={{ ...adminBtnStyle("ghost"), opacity: page === 0 ? 0.4 : 1 }}>{t("上一页")}</button>
      <span style={{ color: "#6b7280" }}>{page + 1} / {totalPages} · {total} {t("条")}</span>
      <button disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)} style={{ ...adminBtnStyle("ghost"), opacity: page >= totalPages - 1 ? 0.4 : 1 }}>{t("下一页")}</button>
    </div>
  );
}

interface ActionField {
  key: string;
  label: string;
  placeholder?: string;
  /** 提供后渲染为下拉选择（免手输枚举值）。 */
  options?: Array<{ value: string; label: string }>;
  /** 下拉初始值（预选当前值）。 */
  value?: string;
}
interface DialogSpec {
  title: string;
  fields: ActionField[];
  danger?: boolean;
  submit: (reason: string, values: Record<string, string>) => void | Promise<void>;
}

/** 危险操作模态框：字段 + 必填原因 + 确认/取消（req R10）。 */
function ActionDialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }): React.JSX.Element {
  const { t } = useT();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.filter((f) => f.value !== undefined).map((f) => [f.key, f.value as string])),
  );
  const [reason, setReason] = useState("");
  const [reasonErr, setReasonErr] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = (): void => {
    if (reason.trim() === "") {
      setReasonErr(t("请填写操作原因"));
      return;
    }
    setReasonErr("");
    setBusy(true);
    void Promise.resolve(spec.submit(reason.trim(), values)).finally(() => setBusy(false));
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16, boxSizing: "border-box" }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 20, width: 440, maxWidth: "100%", fontFamily: "system-ui, sans-serif" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>{spec.title}</h3>
        {spec.fields.map((f) => (
          <div key={f.key} style={{ marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 12, color: "#6b7280", marginBottom: 4 }}>{f.label}</label>
            {f.options !== undefined ? (
              <select
                value={values[f.key] ?? f.value ?? f.options[0]?.value ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box", fontSize: 14, background: "#fff" }}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box", fontSize: 14 }}
              />
            )}
          </div>
        ))}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 12, color: "#6b7280", marginBottom: 4 }}>{t("原因（必填）")}</label>
          <textarea value={reason} onChange={(e) => { setReason(e.target.value); if (reasonErr !== "") setReasonErr(""); }} rows={2} placeholder={t("请填写操作原因")} style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box", fontSize: 14 }} />
          {reasonErr !== "" && <p style={{ color: "#dc2626", fontSize: 12, margin: "4px 0 0" }}>{reasonErr}</p>}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={{ ...adminBtnStyle("ghost"), opacity: busy ? 0.5 : 1 }}>{t("取消")}</button>
          <button disabled={busy} onClick={confirm} style={{ ...adminBtnStyle(spec.danger === true ? "danger" : "primary"), opacity: busy ? 0.5 : 1 }}>{t("确认")}</button>
        </div>
      </div>
    </div>
  );
}

/** 用户详情：账号信息 + 配额 + 订阅/订单/支付历史 + 审计轨迹（req R5 详情）。 */
function AdminUserDetail({ userId }: { userId: number }): React.JSX.Element {
  const { t } = useT();
  const [d, setD] = useState<AdminUserDetail | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    adminApi.userDetail(userId).then(setD).catch((e: unknown) => setErr(e instanceof Error ? e.message : "load failed"));
  }, [userId]);
  if (err !== "") return <p style={{ color: "#dc2626" }}>{err}</p>;
  if (d === null) return <p>{t("加载中…")}</p>;
  const u = d.user;
  const ts = (ms: number | null): string => (ms === null ? "—" : new Date(ms).toLocaleString());
  const section = (title: string): React.JSX.Element => <h3 style={{ fontSize: 14, margin: "16px 0 6px", color: "#111827" }}>{title}</h3>;
  return (
    <div>
      <button onClick={() => navigate("/admin/users")} style={adminBtnStyle("ghost")}>{t("← 返回用户列表")}</button>
      <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>{u.name}</h2>
      <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px" }}>{t("ID")} {u.id} · {adminRoleLabel(t, u.role)} · {u.accountStatus}</p>

      {section(t("账号信息"))}
      <table className="admintbl" style={adminTableStyle()}>
        <tbody>
          <tr>{adminTd(t("邮箱"), u.email ?? "—")}{adminTd(t("手机号"), u.phone ?? "—")}</tr>
          <tr>{adminTd(t("状态"), u.accountStatus)}{adminTd(t("套餐"), u.planStatus ?? "—")}</tr>
          <tr>{adminTd(t("主机"), d.quota !== null ? `${d.hostCount} / ${d.quota}` : String(d.hostCount))}{adminTd(t("注册时间"), ts(u.createdAt === "" ? null : Date.parse(u.createdAt)))}</tr>
        </tbody>
      </table>

      {section(t("订阅历史"))}
      {d.subscriptions.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("套餐"), t("状态"), t("开始"), t("到期")].map(adminTh)}</tr></thead>
          <tbody>{d.subscriptions.map((s) => (
            <tr key={s.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("套餐"), s.planId)}{adminTd(t("状态"), s.status)}{adminTd(t("开始"), ts(s.startedAt))}{adminTd(t("到期"), ts(s.expiresAt))}
            </tr>
          ))}</tbody>
        </table>
      )}

      {section(t("订单"))}
      {d.orders.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("订单号"), t("套餐"), t("金额"), t("状态"), t("时间")].map(adminTh)}</tr></thead>
          <tbody>{d.orders.map((o) => (
            <tr key={o.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("订单号"), o.id)}{adminTd(t("套餐"), o.planId)}{adminTd(t("金额"), `¥${o.amountCny}`)}{adminTd(t("状态"), o.status)}{adminTd(t("时间"), ts(o.createdAt))}
            </tr>
          ))}</tbody>
        </table>
      )}

      {section(t("支付流水"))}
      {d.payments.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("渠道"), t("渠道单号"), t("金额"), t("时间")].map(adminTh)}</tr></thead>
          <tbody>{d.payments.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("渠道"), p.channel)}{adminTd(t("渠道单号"), p.channelOrderId)}{adminTd(t("金额"), `¥${p.amountCny}`)}{adminTd(t("时间"), ts(p.paidAt))}
            </tr>
          ))}</tbody>
        </table>
      )}

      {section(t("审计轨迹"))}
      {d.audit.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("时间"), t("事件"), t("来源"), t("IP")].map(adminTh)}</tr></thead>
          <tbody>{d.audit.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("时间"), ts(a.createdAt))}{adminTd(t("事件"), a.event)}{adminTd(t("来源"), a.source)}{adminTd(t("IP"), a.ip)}
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

/** 管理后台总入口：无 admin 会话 → 登录页；有 → 导航 + 页面。 */
function AdminApp({ path }: { path: string }): React.JSX.Element {  const { t } = useT();
  const [me, setMe] = useState<AdminMe | null | undefined>(undefined);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    adminApi
      .me()
      .then((m) => alive && setMe(m))
      .catch(() => alive && setMe(null));
    return () => {
      alive = false;
    };
  }, [reload]);
  if (me === undefined) return <div style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>{t("加载中…")}</div>;
  if (me === null) return <AdminLogin onSuccess={() => setReload((r) => r + 1)} />;

  const nav: Array<{ p: string; label: string; adminOnly?: boolean }> = [
    { p: "/", label: t("总览") },
    { p: "/users", label: t("用户") },
    { p: "/hosts", label: t("主机") },
    { p: "/billing", label: t("账单") },
    { p: "/audit", label: t("审计") },
    { p: "/health", label: t("健康") },
    { p: "/config", label: t("配置") },
    { p: "/admins", label: t("管理员"), adminOnly: true },
  ];
  const isAdmin = me.role === "admin";
  const isWrite = me.role === "admin" || me.role === "operator";

  return (
    <div>
      <style>{ADMIN_CSS}</style>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {nav
          .filter((n) => !n.adminOnly || isAdmin)
          .map((n) => (
            <button key={n.p} onClick={() => navigate(n.p === "/" ? "/admin" : `/admin${n.p}`)} style={{ ...adminBtnStyle("ghost"), fontWeight: path === n.p || path.startsWith(n.p + "/") ? 700 : 400, background: path === n.p || path.startsWith(n.p + "/") ? "#eef2ff" : "#fff" }}>
              {n.label}
            </button>
          ))}
      </div>
      {path === "/" || path === "" ? (
        <AdminDashboard />
      ) : path.startsWith("/users/") ? (
        <AdminUserDetail userId={Number(path.slice("/users/".length))} />
      ) : path === "/users" ? (
        <AdminUsers isWrite={isWrite} isAdmin={isAdmin} />
      ) : path === "/hosts" ? (
        <AdminHosts isWrite={isWrite} />
      ) : path === "/billing" ? (
        <AdminBilling isWrite={isWrite} isAdmin={isAdmin} />
      ) : path === "/audit" ? (
        <AdminAudit />
      ) : path === "/health" ? (
        <AdminHealth />
      ) : path === "/config" ? (
        <AdminConfigPage />
      ) : path === "/admins" ? (
        <AdminAdmins isAdmin={isAdmin} meId={me.userId} />
      ) : (
        <AdminDashboard />
      )}
    </div>
  );
}

function AdminLogin({ onSuccess }: { onSuccess: () => void }): React.JSX.Element {
  const { t } = useT();
  const [totp, setTotp] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [err, setErr] = useState("");
  const [portalInfo, setPortalInfo] = useState<AccountInfo | null | undefined>(undefined); // undefined=检查中
  useEffect(() => {
    // 管理台登录依赖门户会话：未登录门户 → 直接跳门户登录
    void api.accountInfo({ probe: true }).then(setPortalInfo).catch(() => {
      window.location.assign("/portal/login");
    });
  }, []);
  // 门户会话 30 分钟内验证过 2FA（或可信设备）→ 自动免二次输入；否则落到 TOTP 表单
  useEffect(() => {
    if (portalInfo === undefined || portalInfo === null || portalInfo.totpEnabled !== true) return;
    let alive = true;
    adminApi
      .login("")
      .then(() => alive && onSuccess())
      .catch(() => undefined); // TOTP_REQUIRED → 显示表单让用户输入
    return () => {
      alive = false;
    };
  }, [portalInfo]);
  const submit = (): void => {
    setErr("");
    adminApi
      .login(totp, trustDevice)
      .then(onSuccess)
      .catch((e: unknown) => setErr(e instanceof ApiError ? e.message : "login failed"));
  };
  useEffect(() => {
    if (totp.length === 6) submit();
  }, [totp]);
  if (portalInfo === undefined) return <div style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>{t("加载中…")}</div>;
  if (portalInfo.totpEnabled !== true) {
    return (
      <div style={{ maxWidth: 360, margin: "40px auto", padding: "24px", border: "1px solid #e5e7eb", borderRadius: 12, fontFamily: "system-ui, sans-serif" }}>
        <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>{t("进入管理后台")}</h2>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 16px" }}>{t("管理后台需要两步验证（TOTP）才能使用，请先开启 2FA。")}</p>
        <button onClick={() => navigate("/settings/2fa")} style={{ ...adminBtnStyle(), width: "100%", padding: "10px", fontSize: 15 }}>{t("去开启 2FA")}</button>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 360, margin: "40px auto", padding: "24px", border: "1px solid #e5e7eb", borderRadius: 12, fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>{t("进入管理后台")}</h2>
      <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 16px" }}>{t("管理后台需两步验证（TOTP）。未开启 2FA 的账号请先在「账户与安全」开启。")}</p>
      <input
        value={totp}
        onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        placeholder={t("动态验证码")}
        style={{ width: "100%", padding: "10px", fontSize: 20, letterSpacing: 6, textAlign: "center", marginBottom: 8, boxSizing: "border-box", border: "1px solid #ccc", borderRadius: 6 }}
      />
      <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} /> {t("记住此设备 30 天（下次登录免输动态码）")}
      </label>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ ...adminBtnStyle(), width: "100%", padding: "10px", fontSize: 15 }}>{t("进入")}</button>
    </div>
  );
}

function AdminDashboard(): React.JSX.Element {
  const { t } = useT();
  const [d, setD] = useState<AdminDashboard | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    adminApi.dashboard().then(setD).catch((e: unknown) => setErr(e instanceof Error ? e.message : "load failed"));
  }, []);
  if (err !== "") return <p style={{ color: "#dc2626" }}>{err}</p>;
  if (d === null) return <p>{t("加载中…")}</p>;
  const stats: Array<[string, string | number]> = [
    [t("注册用户"), d.totalUsers],
    [t("主机总数"), d.totalHosts],
    [t("在线主机"), d.onlineHosts],
    [t("隧道连接"), d.tunnelCount],
    [t("付费订阅"), d.subscribed],
    [t("DB 大小"), d.dbSize < 0 ? "—" : `${(d.dbSize / 1024 / 1024).toFixed(1)} MB`],
    [t("uptime"), `${Math.floor(d.uptimeSeconds / 3600)}h ${Math.floor((d.uptimeSeconds % 3600) / 60)}m`],
    [t("版本"), d.version],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
      {stats.map(([k, v]) => (
        <div key={k} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "#6b7280" }}>{k}</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function AdminUsers({ isWrite, isAdmin }: { isWrite: boolean; isAdmin: boolean }): React.JSX.Element {
  const { t } = useT();
  const PAGE = 50;
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [menuUserId, setMenuUserId] = useState<number | null>(null);
  const fetch = (query: string, p: number): void => {
    adminApi
      .users({ q: query !== "" ? query : undefined, limit: PAGE, offset: p * PAGE })
      .then((r) => { setUsers(r.users); setTotal(r.total); })
      .catch(() => { setUsers([]); setTotal(0); });
  };
  const reload = (): void => fetch(q, page);
  useEffect(() => {
    const timer = setTimeout(() => fetch(q, page), 300);
    return () => clearTimeout(timer);
  }, [q, page]);
  useEffect(() => {
    if (menuUserId === null) return;
    const close = (): void => setMenuUserId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuUserId]);
  const open = (u: AdminUserRow, title: string, action: string, fields: ActionField[] = [], danger = false): void => {
    setDialog({
      title,
      fields,
      danger,
      submit: (reason, values) =>
        adminApi
          .userAction(u.id, action, { reason, ...(action === "reset-password" ? { password: values.password ?? "" } : {}), ...(action === "plan" ? { planStatus: values.planStatus ?? "" } : {}), ...(action === "set-role" ? { role: values.role ?? "" } : {}) })
          .then(() => {
            setMsg("ok");
            setDialog(null);
            reload();
          })
          .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  const list = users ?? [];
  return (
    <div>
      <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={t("搜索 用户名/邮箱/手机号")} style={{ padding: "8px 10px", marginBottom: 10, width: "100%", maxWidth: 300, boxSizing: "border-box" }} />
      {msg !== "" && <p style={{ fontSize: 12, color: "#2563eb" }}>{msg}</p>}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("用户"), t("角色"), t("状态"), t("主机"), t("套餐"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("用户"), u.name)}
              {adminTd(t("角色"), <span style={{ color: "#6b7280" }}>{adminRoleLabel(t, u.role)}</span>)}
              {adminTd(t("状态"), u.accountStatus)}
              {adminTd(t("主机"), u.hostCount)}
              {adminTd(t("套餐"), u.planStatus ?? "—")}
              {adminTd(null, (isWrite || isAdmin) && (
                <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuUserId(menuUserId === u.id ? null : u.id); }}
                    style={adminBtnStyle("ghost")}
                    title={t("更多操作")}
                  >⋯</button>
                  {menuUserId === u.id && (
                    <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,.1)", zIndex: 20, minWidth: 130, padding: 4 }} onClick={(e) => e.stopPropagation()}>
                      <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); navigate(`/admin/users/${u.id}`); }}>{t("详情")}</button>
                      {isWrite && u.accountStatus !== "banned" && <button style={menuItemStyle(true)} onClick={() => { setMenuUserId(null); open(u, t("封禁"), "ban", [], true); }}>{t("封禁")}</button>}
                      {isWrite && u.accountStatus === "banned" && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("解封"), "unban"); }}>{t("解封")}</button>}
                      {isWrite && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("重置密码"), "reset-password", [{ key: "password", label: t("新密码（≥8 位）") }]); }}>{t("重置密码")}</button>}
                      {isWrite && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("重置2FA"), "reset-2fa", [], true); }}>{t("重置2FA")}</button>}
                      {isWrite && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("改套餐"), "plan", [{ key: "planStatus", label: t("套餐状态"), options: [{ value: "subscribed", label: "subscribed" }, { value: "grace", label: "grace" }, { value: "free", label: "free" }, { value: "null", label: "null" }] }]); }}>{t("改套餐")}</button>}
                      {isAdmin && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("改角色"), "set-role", [{ key: "role", label: t("角色"), value: u.role, options: [{ value: "user", label: t("普通用户") }, { value: "readonly", label: t("只读") }, { value: "operator", label: t("运营") }, { value: "admin", label: t("管理员", { en: "Admin" }) }] }]); }}>{t("改角色")}</button>}
                      {isAdmin && <button style={menuItemStyle(true)} onClick={() => { setMenuUserId(null); open(u, t("删除"), "delete", [], true); }}>{t("删除")}</button>}
                    </div>
                  )}
                </div>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} total={total} pageSize={PAGE} onPage={setPage} />
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function AdminHosts({ isWrite }: { isWrite: boolean }): React.JSX.Element {
  const { t } = useT();
  const PAGE = 50;
  const [hosts, setHosts] = useState<AdminHostRow[] | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const fetch = (query: string, p: number): void => {
    adminApi
      .hosts({ q: query !== "" ? query : undefined, limit: PAGE, offset: p * PAGE })
      .then((r) => { setHosts(r.hosts); setTotal(r.total); })
      .catch(() => { setHosts([]); setTotal(0); });
  };
  const reload = (): void => fetch(q, page);
  useEffect(() => {
    const timer = setTimeout(() => fetch(q, page), 300);
    return () => clearTimeout(timer);
  }, [q, page]);
  const revoke = (h: AdminHostRow): void => {
    setDialog({
      title: `${t("吊销")} · ${h.name}`,
      fields: [],
      danger: true,
      submit: (reason) =>
        adminApi.revokeHost(h.id, reason).then(() => { setMsg("ok"); setDialog(null); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  return (
    <div>
      <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={t("搜索 主机名/归属用户")} style={{ padding: "8px 10px", marginBottom: 10, width: "100%", maxWidth: 300, boxSizing: "border-box" }} />
      {msg !== "" && <p style={{ fontSize: 12, color: "#2563eb" }}>{msg}</p>}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("主机名"), t("归属"), t("在线"), t("E2EE"), t("加入时间"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(hosts ?? []).map((h) => (
            <tr key={h.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("主机名"), h.name)}
              {adminTd(t("归属"), <span style={{ color: "#6b7280" }}>{h.ownerName}</span>)}
              {adminTd(t("在线"), h.online ? "●" : "○")}
              {adminTd(t("E2EE"), h.e2eePublicKey != null ? "🛡" : "—")}
              {adminTd(t("加入时间"), new Date(h.createdAt).toLocaleDateString())}
              {adminTd(null, isWrite && <button onClick={() => revoke(h)} style={adminBtnStyle("danger")}>{t("吊销")}</button>)}
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} total={total} pageSize={PAGE} onPage={setPage} />
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function AdminBilling({ isWrite, isAdmin }: { isWrite: boolean; isAdmin: boolean }): React.JSX.Element {
  const { t } = useT();
  const [orders, setOrders] = useState<AdminOrderRow[] | null>(null);
  const [payments, setPayments] = useState<AdminPaymentRow[] | null>(null);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const reload = (): void => {
    adminApi.orders().then((r) => setOrders(r.orders)).catch(() => setOrders([]));
    adminApi.payments().then((r) => setPayments(r.payments)).catch(() => setPayments([]));
  };
  useEffect(reload, []);
  const refund = (o: AdminOrderRow): void => {
    setDialog({
      title: `${t("退款")} ¥${o.amountCny}`,
      fields: [],
      danger: true,
      submit: (reason) =>
        adminApi.refundOrder(o.id, reason).then(() => { setMsg("ok"); setDialog(null); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  const credit = (): void => {
    setDialog({
      title: t("补单"),
      fields: [
        { key: "userId", label: t("用户 ID") },
        { key: "planId", label: t("套餐 ID") },
        { key: "amountCny", label: t("金额（元）") },
        { key: "expiresAtMs", label: t("到期时间戳（ms）") },
      ],
      submit: (reason, values) =>
        adminApi
          .credit({ userId: Number(values.userId), planId: values.planId ?? "", amountCny: Number(values.amountCny), expiresAtMs: Number(values.expiresAtMs), reason })
          .then(() => { setMsg("ok"); setDialog(null); reload(); })
          .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  return (
    <div>
      {msg !== "" && <p style={{ fontSize: 12, color: "#2563eb" }}>{msg}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>{t("订单")}</h3>
        {isAdmin && <button onClick={credit} style={adminBtnStyle("primary")}>{t("补单")}</button>}
      </div>
      <table className="admintbl" style={{ ...adminTableStyle(), marginTop: 8 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("订单号"), t("用户"), t("套餐"), t("金额"), t("状态"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(orders ?? []).map((o) => (
            <tr key={o.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("订单号"), o.id)}
              {adminTd(t("用户"), o.userId)}
              {adminTd(t("套餐"), o.planId)}
              {adminTd(t("金额"), `¥${o.amountCny}`)}
              {adminTd(t("状态"), o.status)}
              {adminTd(null, isWrite && o.status === "paid" && <button onClick={() => refund(o)} style={adminBtnStyle("danger")}>{t("退款")}</button>)}
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ fontSize: 14, marginTop: 16 }}>{t("支付流水")}</h3>
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("流水号"), t("订单号"), t("渠道"), t("渠道单号"), t("金额"), t("支付时间")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(payments ?? []).map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("流水号"), p.id)}
              {adminTd(t("订单号"), p.orderId)}
              {adminTd(t("渠道"), p.channel)}
              {adminTd(t("渠道单号"), p.channelOrderId)}
              {adminTd(t("金额"), `¥${p.amountCny}`)}
              {adminTd(t("支付时间"), new Date(p.paidAt).toLocaleString())}
            </tr>
          ))}
        </tbody>
      </table>
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function AdminAudit(): React.JSX.Element {
  const { t } = useT();
  const [events, setEvents] = useState<AdminAuditRow[] | null>(null);
  const [source, setSource] = useState("");
  useEffect(() => {
    adminApi.audit(source === "" ? undefined : { source }).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [source]);
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <select value={source} onChange={(e) => setSource(e.target.value)} style={{ padding: "8px" }}>
          <option value="">{t("全部来源")}</option>
          <option value="user">{t("用户")}</option>
          <option value="admin">{t("管理员")}</option>
        </select>
        <a href="/api/admin/audit.csv" target="_blank" rel="noreferrer" style={{ ...adminBtnStyle("ghost"), textDecoration: "none" }}>{t("导出 CSV")}</a>
      </div>
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("时间"), t("用户"), t("事件"), t("来源"), t("操作者")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(events ?? []).map((e) => (
            <tr key={e.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("时间"), new Date(e.createdAt).toLocaleString())}
              {adminTd(t("用户"), e.userId ?? "—")}
              {adminTd(t("事件"), e.event)}
              {adminTd(t("来源"), e.source)}
              {adminTd(t("操作者"), <span style={{ color: "#6b7280" }}>{e.actorUserId ?? "—"}</span>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminHealth(): React.JSX.Element {
  const { t } = useT();
  const [h, setH] = useState<{ uptimeSeconds: number; tunnelCount: number; onlineHosts: number; dbSize: number; version: string; lastBackupAt: number | null } | null>(null);
  useEffect(() => {
    adminApi.health().then(setH).catch(() => undefined);
  }, []);
  if (h === null) return <p>{t("加载中…")}</p>;
  const rows: Array<[string, string]> = [
    [t("uptime"), `${Math.floor(h.uptimeSeconds / 3600)}h ${Math.floor((h.uptimeSeconds % 3600) / 60)}m`],
    [t("隧道连接"), String(h.tunnelCount)],
    [t("在线主机"), String(h.onlineHosts)],
    [t("DB 大小"), h.dbSize < 0 ? "—" : `${(h.dbSize / 1024 / 1024).toFixed(1)} MB`],
    [t("版本"), h.version],
    [t("最近备份"), h.lastBackupAt === null ? t("未配置") : new Date(h.lastBackupAt).toLocaleString()],
  ];
  return (
    <div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}>
          <span style={{ color: "#6b7280" }}>{k}</span>
          <span style={{ fontWeight: 500 }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function AdminConfigPage(): React.JSX.Element {
  const { t } = useT();
  const [c, setC] = useState<AdminConfig | null>(null);
  useEffect(() => {
    adminApi.config().then(setC).catch(() => undefined);
  }, []);
  if (c === null) return <p>{t("加载中…")}</p>;
  return <pre style={{ fontSize: 12, background: "#f9fafb", padding: 16, borderRadius: 10, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{JSON.stringify(c, null, 2)}</pre>;
}

function AdminAdmins({ isAdmin, meId }: { isAdmin: boolean; meId: number }): React.JSX.Element {
  const { t } = useT();
  const [admins, setAdmins] = useState<Array<{ id: number; name: string; email: string | null; role: string }> | null>(null);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const reload = (): void => {
    adminApi.admins().then((r) => setAdmins(r.admins)).catch(() => setAdmins([]));
  };
  useEffect(reload, []);
  const setRole = (a: { id: number; name: string; role: string }): void => {
    setDialog({
      title: `${t("改角色")} · ${a.name}`,
      fields: [
        {
          key: "role",
          label: t("角色"),
          value: a.role,
          options: [
            { value: "user", label: t("普通用户") },
            { value: "readonly", label: t("只读") },
            { value: "operator", label: t("运营") },
            { value: "admin", label: t("管理员", { en: "Admin" }) },
          ],
        },
      ],
      submit: (reason, values) =>
        adminApi.setRole(a.id, values.role ?? "", reason).then(() => { setMsg("ok"); setDialog(null); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  const remove = (a: { id: number; name: string }): void => {
    setDialog({
      title: `${t("移除")} · ${a.name}`,
      fields: [],
      danger: true,
      submit: (reason) =>
        adminApi.removeAdmin(a.id, reason).then(() => { setMsg("ok"); setDialog(null); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  return (
    <div>
      {msg !== "" && <p style={{ fontSize: 12, color: "#2563eb" }}>{msg}</p>}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e5e7eb" }}>{[t("账号"), t("邮箱"), t("角色"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(admins ?? []).map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
              {adminTd(t("账号"), a.name)}
              {adminTd(t("邮箱"), <span style={{ color: "#6b7280" }}>{a.email ?? "—"}</span>)}
              {adminTd(t("角色"), adminRoleLabel(t, a.role))}
              {adminTd(null, isAdmin && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    onClick={() => setRole(a)}
                    disabled={a.id === meId}
                    title={a.id === meId ? t("不能操作自己的账号") : undefined}
                    style={{ ...adminBtnStyle("ghost"), opacity: a.id === meId ? 0.4 : 1 }}
                  >{t("改角色")}</button>
                  <button
                    onClick={() => remove(a)}
                    disabled={a.id === meId}
                    title={a.id === meId ? t("不能操作自己的账号") : undefined}
                    style={{ ...adminBtnStyle("danger"), opacity: a.id === meId ? 0.4 : 1 }}
                  >{t("移除")}</button>
                </div>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
