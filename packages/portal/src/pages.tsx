/**
 * portal 页面 + 手写路由（零依赖：不引 react-router）。
 *
 * 会话：httpOnly Cookie（fetch credentials include）；续期令牌由 hub 下发 HttpOnly cookie 承载，
 * 登出由服务端读 cookie 吊销（门户不再经手任何令牌）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError, subscribeEvents, adminApi } from "./api.ts";
import type { HostInfo, JoinTokenInfo, CaptchaPayload, AccountInfo, Capabilities, UsageDay, WechatPayInfo, AdminMe, AdminUserRow, AdminHostRow, AdminNodeRow, AdminOrderRow, AdminPaymentRow, AdminAuditRow, AdminSubscriptionRow, AdminUserDetail, AdminDashboard, AdminConfig } from "./api.ts";
import { fingerprint } from "./e2ee.ts";
import { useT, getLang } from "./i18n.ts";
import type { T } from "./i18n.ts";
import {
  COMPARABLE_TIERS,
  DISPLAY_ORDER,
  entitlementLabel,
  has,
  relayHostsFor,
  tierOf,
  tierShortName,
  type Entitlement,
  type PlanTier,
} from "./entitlements.ts";

/** portal 部署在 /portal 前缀下（host 转发的 DSH 占用根路径）。 */
const BASE = "/portal";

function navigate(path: string): void {
  window.history.pushState({}, "", `${BASE}${path}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// ---- E2EE pin（localStorage 首次信任/变更告警）----
const E2EE_PINS_KEY = "rdsh_e2ee_pins";
// 返回类型显式收窄到 ArrayBuffer 背书（e2ee.ts 的 Bytes 同款）：TS 5.9 起 lib.dom 的 BufferSource 只收这种
function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
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
  if (path === "/captcha") return <CaptchaPage />;
  if (path === "/verify") return <VerifyPage />;
  if (path === "/reset-password") return <ResetPasswordPage />;
  if (path === "/change-password") return <PasswordPage />;
  if (path === "/") return <Login />;
  const page =
    path === "/billing" ? (
      <BillingPage />
    ) : path === "/credits/pricing" ? (
      <CreditsPricingPage />
    ) : path === "/credits" ? (
      <CreditsPage />
    ) : path === "/settings/password" ? (
      <PasswordPage />
    ) : path === "/usage" ? (
      <UsagePage />
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
    border: "1px solid var(--rdsh-border)",
    cursor: "pointer",
    fontSize: 12,
    background: active ? "var(--rdsh-primary)" : "var(--rdsh-bg-surface)",
    color: active ? "var(--rdsh-fg-on-fill)" : "var(--rdsh-fg)",
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
    { p: "/billing", label: t("套餐与订阅") },
    { p: "/usage", label: t("用量统计") },
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
          <button key={x.p} onClick={() => navigate(x.p)} style={{ ...btnStyle("ghost"), fontWeight: active === x.p ? 700 : 400, background: active === x.p ? "var(--rdsh-bg-active)" : "var(--rdsh-bg-surface)" }}>{x.label}</button>
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
    border: "1px solid var(--rdsh-border)",
    cursor: "pointer",
    fontSize: 14,
  };
  if (variant === "primary") return { ...base, background: "var(--rdsh-primary)", color: "var(--rdsh-fg-on-fill)", borderColor: "var(--rdsh-primary)" };
  if (variant === "danger") return { ...base, background: "var(--rdsh-danger-fill)", color: "var(--rdsh-fg-on-fill)", borderColor: "var(--rdsh-danger-fill)" };
  return { ...base, background: "var(--rdsh-bg-surface)" };
}

function inputStyle(): React.CSSProperties {
  // 字号由 theme.css 统一声明（窄屏 16px，避免 iOS 聚焦输入框时自动放大整页）
  return { padding: "8px 10px", borderRadius: 6, border: "1px solid var(--rdsh-border)", width: "100%", boxSizing: "border-box" };
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
    color: danger ? "var(--rdsh-danger)" : "var(--rdsh-fg)",
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

function useError(): { err: string; pending: boolean; clear: () => void; run: (fn: () => Promise<void>) => Promise<boolean> } {
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      setErr("");
      setPending(true);
      await fn();
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? tError(e.code, e.message) : e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { err, pending, clear: () => setErr(""), run };
}

// ---- 验证码（arithmetic 零依赖 / aliyun 2.0 前端 SDK / none）----

declare global {
  interface Window {
    initAliyunCaptcha?: (config: Record<string, unknown>) => void;
    /** V3 架构（Web/H5）：必须在加载 SDK 前设置的全局变量（region + 身份标 prefix）。 */
    AliyunCaptchaConfig?: { region: string; prefix: string };
    /** App WebView 注入的 JS bridge（验证码结果回传）。 */
    CaptchaResult?: { postMessage?: (message: string) => void };
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

/** 按后端 /api/captcha/config 渲染对应验证码；完成后回调 captcha 载荷（arithmetic → token+answer；aliyun → captchaVerifyParam；none → {}）。
 *
 * 票据是**一次性**的（阿里云 captchaVerifyParam 验一次即失效；算术题 token 命中即删），因此：
 *  - 票据由父组件持有，父组件消费/失败后清空 → 这里自动回到"待验证"，杜绝重放旧票；
 *  - 阿里云 SDK 官方要求**不要重复调用 initAliyunCaptcha**（重复初始化会多次注册事件，
 *    表现为"滑块第一次总失败、第二次才通过"），所以验证成功后也不卸载组件、不重新初始化；
 *    滑块没过时 SDK 会自行刷新，用户再点一次按钮即可拿到新票据。 */
function CaptchaGate({ captcha, onCaptcha }: { captcha: CaptchaPayload; onCaptcha: (captcha: CaptchaPayload) => void }): React.JSX.Element | null {
  const { t } = useT();
  const [mode, setMode] = useState<"loading" | "none" | "arithmetic" | "aliyun">("loading");
  const [challenge, setChallenge] = useState<{ token: string; question: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [captchaFail, setCaptchaFail] = useState("");
  const { err, run } = useError();
  const hasTicket = Object.keys(captcha).length > 0;

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
        // V3：mode=popup（弹出式）+ button 触发。
        // 曾改为 embed（嵌入式，省去点按钮、无遮罩），但在本项目的 SceneId 下初始化后
        // #rdsh-captcha-element 始终为空、验证码不渲染，控制台报 AliyunCaptcha
        // "Error: timeout" / "Network Error"，FeiLin 指纹模块报错 —— 已回退 popup。
        // 尺寸问题另在 theme.css / CaptchaPage 中修复（见 2026-10-12 记录）。
        init({
          SceneId: cfg.sceneId ?? "",
          mode: "popup",
          element: "#rdsh-captcha-element",
          button: "#rdsh-captcha-btn",
          success: (param: string) => {
            onCaptcha({ captchaVerifyParam: param });
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
        setMode("arithmetic"); // 题目由下面的 effect 取（清票后它也会换一道）
      }
    });
  }, []);

  // 算术验证码：题目 token 一次性，票据被清空（已消费/失败）后换一道新题
  useEffect(() => {
    if (mode !== "arithmetic" || hasTicket) return;
    void run(async () => setChallenge(await api.captchaChallenge()));
  }, [mode, hasTicket]);

  if (mode === "loading" || mode === "none") return null;
  if (mode === "aliyun") {
    return (
      <div style={{ marginBottom: 12 }}>
        <div id="rdsh-captcha-element" />
        <button id="rdsh-captcha-btn" type="button" style={btnStyle("ghost")}>{t("完成滑块验证")}</button>
        {hasTicket && <p style={{ color: "var(--rdsh-success)", fontSize: 13 }}>{t("人机验证已完成")}</p>}
        {captchaFail !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{captchaFail}</p>}
        {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      </div>
    );
  }
  // 成功态同样零文字：绿色对勾表意，避免内嵌页引入待翻译文案。
  if (hasTicket) {
    return (
      <div style={{ display: "flex", justifyContent: "center", color: "var(--rdsh-success)", padding: "4px 0" }}>
        <CheckIcon size={28} />
      </div>
    );
  }
  if (challenge === null) return null;
  // 零文字设计：算式本身（阿拉伯数字 + 运算符）跨语言通用，无需翻译任何文案，
  // 因此内嵌验证码不必维护多语言。外层「人机验证」标题由宿主 App 本地化提供。
  // 一行放完（App 内嵌高度固定约 120px）：题目在上，输入框 + 打勾按钮在下。
  return (
    <>
      <p style={{ fontSize: 18, fontWeight: 600, letterSpacing: 1, margin: "0 0 8px", textAlign: "center" }}>{challenge.question}</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-label={t("答案")}
          style={{ ...inputStyle(), width: "auto", flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          aria-label={t("确认验证")}
          onClick={() => onCaptcha({ captchaToken: challenge.token, captchaAnswer: answer.trim() })}
          style={{ ...btnStyle(), flexShrink: 0, width: 44, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <CheckIcon />
        </button>
      </div>
    </>
  );
}

/** 打勾图标：验证码确认按钮与成功态用。图标而非文字，避免内嵌页引入待翻译文案。 */
function CheckIcon({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * 阿里云滑块内部固定 360px 宽，而 App 内嵌 WebView 的视口通常只有 ~312px：
 * 不缩放的话滑块会被挤出视口（左侧被裁、按不到也拖不动）。
 * 这里按实际可用宽度等比缩放，写进 CSS 变量供 theme.css 消费。
 */
function useCaptchaZoom(): void {
  useEffect(() => {
    const apply = (): void => {
      const w = document.documentElement.clientWidth;
      const z = w >= 372 ? 1 : Math.max(0.6, w / 372);
      document.documentElement.style.setProperty("--rdsh-captcha-zoom", String(z));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}

/**
 * 验证码独立页（App WebView 内嵌用）：渲染验证码，通过后经 JS bridge 回传**完整载荷**。
 *
 * 载荷为 JSON 字符串，内容随 provider 而异：
 *  - arithmetic → {"captchaToken":"...","captchaAnswer":"..."}
 *  - aliyun     → {"captchaVerifyParam":"..."}
 * App 侧（AliyunCaptchaView）解析后按同样的键提交给 hub。
 */
function CaptchaPage(): React.JSX.Element {
  const [payload, setPayload] = useState<CaptchaPayload>({});
  useCaptchaZoom();
  // 内嵌在 App 里时让底色透明，与宿主背景无缝衔接；否则 WebView 会出现一块
  // 与 App 主题无关的底色（浅色 App 里浮着深色方块）。浏览器直访时无需透明，
  // 卸载时还原，避免影响同页其他路由的观感。
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);
  return (
    // 横向不留 padding：内嵌视口本就窄，任何左右留白都会进一步压缩验证码可用宽度。
    <div style={{ padding: "8px 0", maxWidth: "100%", margin: 0 }}>
      <CaptchaGate
        captcha={payload}
        onCaptcha={(p) => {
          setPayload(p);
          // 回传完整载荷而非单个 captchaVerifyParam：算术题没有该字段，
          // 只回传它会让 App 永远拿不到验证结果（见 2026-10-12 记录）。
          if (Object.keys(p).length > 0) {
            window.CaptchaResult?.postMessage?.(JSON.stringify(p));
          }
        }}
      />
    </div>
  );
}

/** 法务链接：仅外链（条款/隐私/产品介绍已迁静态站；未配置 URL 时渲染为纯文本占位）。 */
function legalLink(url: string | undefined, label: string, style: React.CSSProperties): React.JSX.Element {
  if (url === undefined || url === "") return <span style={style}>{label}</span>;
  return <a href={url} target="_blank" rel="noreferrer" style={style}>{label}</a>;
}

// ---- 登录 / 首次设密 ----

function Login(): React.JSX.Element {
  const { t, lang } = useT();
  const rawNext = new URLSearchParams(window.location.search).get("next");
  const next = rawNext !== null && rawNext.startsWith("/portal") ? rawNext.slice("/portal".length) || "/" : rawNext;
  const home = next !== null && next.startsWith("/") && !next.startsWith("//") && next !== "/" ? next : "/hosts";
  const wechatNew = new URLSearchParams(window.location.search).get("wechat-new");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totpPending, setTotpPending] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [brand, setBrand] = useState<{ zh?: string; en?: string } | null>(null);
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const { err, run } = useError();

  useEffect(() => {
    void api.capabilities().then((c) => { if (c.site?.brand !== undefined) setBrand(c.site.brand); if (c.wechatLoginEnabled === true) setWechatEnabled(true); }).catch(() => undefined);
  }, []);

  // 眉标：按界面语言取品牌名；未配置/缺 zh/en 用内置兜底（与服务端邮件渲染一致）
  const brandText = lang === "en" ? (brand?.en ?? "WhaleLink") : (brand?.zh ?? "鲸语通");

  // ③：已登录访问 /login 时跳回主机页（避免历史栈/收藏夹里的登录页造成"假掉线"）。
  // accountInfo 走 probe 模式：401 不触发 redirectToLogin，而是抛 ApiError(401) → 留在登录页。
  useEffect(() => {
    let cancelled = false;
    void api.accountInfo({ probe: true })
      .then(() => { if (!cancelled) navigate(home); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wechatLogin = (): void => {
    // 微信登录统一跳 qrconnect authorize（全端一致，不做自制二维码）：
    // open.weixin.qq.com 页面始终渲染它自己的登录二维码并轮询 —— PC 用户手机微信扫 → 登录落在本页面；
    // 手机用户可把该二维码转发到电脑/另一台设备显示后扫码确认（本页面轮询 → 本设备登录）。
    // 注：微信网站应用无「微信内免扫码一键」形态；自制 URL 二维码被扫只会套娃出 qrconnect 页。
    window.location.href = `/api/wechat/login/authorize?next=${encodeURIComponent("/portal" + home)}`;
  };

  const confirmWechatCreate = (): void => {
    void run(async () => {
      if (wechatNew === null || wechatNew === "") return;
      const r = await api.wechatConfirm(wechatNew);
      navigate(home);
    });
  };

  // 微信登录但未找到已绑定账号 → 确认是否新建（不静默建号）
  if (wechatNew !== null && wechatNew !== "") {
    return (
      <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}><LangToggle /></div>
        <p style={{ fontSize: 22, fontWeight: 700, color: "var(--rdsh-fg)", letterSpacing: 0.5, margin: "0 0 8px" }}>{brandText}</p>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>{t("微信登录")}</h1>
        <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, marginBottom: 20 }}>{t("未找到已绑定的账号，是否创建新账号？")}</p>
        {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
        <button onClick={confirmWechatCreate} style={{ ...btnStyle(), width: "100%" }}>{t("创建新账号")}</button>
        <button onClick={() => navigate("/login")} style={{ ...btnStyle("ghost"), width: "100%", marginTop: 8 }}>{t("已有账号，去登录")}</button>
        <p style={{ marginTop: 12, fontSize: 12, color: "var(--rdsh-fg-muted)" }}>{t("已有邮箱/手机号账号？先用账号密码登录，再在设置里绑定微信")}</p>
      </div>
    );
  }

  const submit = (): void => {
    void run(async () => {
      if (totpPending !== null) {
        const r = await api.totpLogin(totpPending, totpCode, trustDevice);
        navigate(r.mustChangePassword === true ? "/change-password" : home);
      } else {
        const r = await api.login(name, password);
        if (r.requiresTotp === true && r.pendingToken !== undefined) {
          setTotpPending(r.pendingToken);
        } else {
          navigate(r.mustChangePassword === true ? "/change-password" : home);
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
      <p style={{ fontSize: 22, fontWeight: 700, color: "var(--rdsh-fg)", letterSpacing: 0.5, margin: "0 0 8px" }}>{brandText}</p>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{t("你的 AI 智能体，随处安全可达")}</h1>
      <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, marginBottom: 24 }}>
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
          <p style={{ margin: "-6px 0 12px", fontSize: 12, color: "var(--rdsh-fg-subtle)" }}>{t("（自己的常用设备可勾选；公用或他人的设备请勿勾选）")}</p>
        </div>
      ) : (
        <>
          {field(t("邮箱 / 手机号 / 用户名"), name, setName)}
          {field(t("密码"), password, setPassword, "password")}
        </>
      )}
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ ...btnStyle(), width: "100%", marginTop: 8 }}>
        {totpPending !== null ? t("验证并登录") : t("登录")}
      </button>
      {wechatEnabled && totpPending === null && (
        <>
          <p style={{ margin: "14px 0 0", textAlign: "center", color: "var(--rdsh-fg-subtle)", fontSize: 12 }}>{t("或")}</p>
          <button
            onClick={wechatLogin}
            style={{ ...btnStyle(), width: "100%", marginTop: 8, background: "var(--rdsh-wechat-bg)", borderColor: "var(--rdsh-wechat)", color: "var(--rdsh-wechat-fg)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          >
            <WechatIcon size={18} />
            {t("微信登录")}
          </button>
          <p style={{ marginTop: 6, fontSize: 12, color: "var(--rdsh-fg-subtle)", textAlign: "center" }}>{t("已有邮箱/手机号账号？先用账号密码登录，再在设置里绑定微信")}</p>
        </>
      )}
      {totpPending === null && (
        <p style={{ marginTop: 12, textAlign: "center" }}>
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/reset-password"); }} style={{ color: "var(--rdsh-link)", fontSize: 13 }}>{t("忘记密码？")}</a>
          {" · "}
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/register"); }} style={{ color: "var(--rdsh-link)", fontSize: 13 }}>{t("注册")}</a>
        </p>
      )}
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
        background: ok ? "var(--rdsh-success-soft)" : "var(--rdsh-danger-soft)",
        color: ok ? "var(--rdsh-success-strong)" : "var(--rdsh-danger-on-soft)",
        border: `1px solid ${ok ? "var(--rdsh-success-border)" : "var(--rdsh-danger-border)"}`,
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
    <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: "14px 16px", marginBottom: 12 }}>
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
        background: ok ? "var(--rdsh-success-soft)" : "var(--rdsh-bg-subtle)",
        color: ok ? "var(--rdsh-success-strong)" : "var(--rdsh-fg-muted)",
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
        border: "1px solid var(--rdsh-border)",
        borderRadius: 10,
        background: "var(--rdsh-bg-surface)",
        cursor: "pointer",
        marginBottom: 8,
        textAlign: "left",
        font: "inherit",
      }}
    >
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: danger === true ? "var(--rdsh-danger)" : "var(--rdsh-fg)" }}>{label}</span>
        {desc !== undefined && <span style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginTop: 2 }}>{desc}</span>}
      </span>
      {badge}
      <span style={{ color: "var(--rdsh-fg-subtle)", fontSize: 18 }}>›</span>
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
        border: "1px solid var(--rdsh-border)",
        borderRadius: 10,
        background: "var(--rdsh-bg-surface)",
        cursor: "pointer",
        marginBottom: 8,
        textAlign: "left",
        font: "inherit",
        textDecoration: "none",
        boxSizing: "border-box",
      }}
    >
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: "var(--rdsh-fg)" }}>{label}</span>
        {desc !== undefined && <span style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginTop: 2 }}>{desc}</span>}
      </span>
      <span style={{ color: "var(--rdsh-fg-subtle)", fontSize: 18 }}>↗</span>
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

/**
 * 订阅状态卡。
 *
 * - **简版**（`compact`，账户总览用）：只显示身份 + 时间一行，点击进套餐页；
 * - **完整版**（套餐页用）：身份 + 时间 + 「我的权益」清单（全集逐项 ✅/❌）。
 *
 * 档位判定一律委托 `entitlements.ts`（唯一口径，契约见 `packages/hub/API.md` §13）。
 * 权益文案也取自该模块 —— **不要在本文件另写权益文案**。
 */
function CurrentPlanCard({
  sub,
  plans = [],
  compact = false,
  onClick,
}: {
  sub: SubInfo | null;
  plans?: ReadonlyArray<{ id: string; vipTier?: number; hosts?: number }>;
  compact?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const { t } = useT();
  const vipTier = sub?.planId != null ? plans.find((p) => p.id === sub.planId)?.vipTier ?? null : null;
  // ⚠️ 必须区分「无数据」与「plan_status 为空」：接口失败/未登录传 hasEntitlement=false，
  // 显示中性提示，**不得**显示为专属账号（API.md §13.1）。
  const tier = tierOf({ hasEntitlement: sub !== null, planStatus: sub?.planStatus ?? null, vipTier });
  const exp = sub?.planExpiresAt ?? null;
  const dateText = exp === null ? "" : new Date(exp).toLocaleDateString();
  const warn = tier === "grace";

  let title: string;
  let detail: string;
  if (tier === null) {
    title = t("订阅状态暂不可用");
    detail = "";
  } else if (tier === "internal") {
    title = `🏠 ${t(tierShortName(tier))}`;
    // 有真实到期日就显示日期；否则说明由管理员设定（与 App 同构）
    detail = dateText === "" ? t("由管理员创建 · 无需订阅 · 有效期以管理员设置为准") : t("有效期至 {date}", { params: { date: dateText } });
  } else if (tier === "trial") {
    title = `● ${t(tierShortName(tier))}`;
    detail = exp === null ? t("主机 1 台") : `${t("剩余")} ${remainingText(exp, t)} · ${t("至 {date}", { params: { date: dateText } })}`;
  } else if (tier === "grace") {
    title = `⚠ ${t(tierShortName(tier))}`;
    detail = dateText === "" ? t("原套餐配额保留，续费即恢复") : t("至 {date}", { params: { date: dateText } });
  } else if (tier === "free") {
    title = `○ ${t(tierShortName(tier))}`;
    detail = t("未订阅");
  } else {
    title = `● ${t("已订阅：{plan}", { params: { plan: t(tierShortName(tier)) } })}`;
    detail = dateText === "" ? "" : t("到期 {date}", { params: { date: dateText } });
  }

  const style: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "14px 16px",
    border: `1px solid ${warn ? "var(--rdsh-warn)" : "var(--rdsh-border)"}`,
    borderRadius: 10,
    background: warn ? "var(--rdsh-warn-soft)" : "var(--rdsh-bg-surface)",
    cursor: onClick !== undefined ? "pointer" : "default",
    marginBottom: 12,
    textAlign: "left",
    font: "inherit",
  };

  const header = (
    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: warn ? "var(--rdsh-warn-strong)" : "var(--rdsh-fg)" }}>{title}</span>
        {detail !== "" && (
          <span style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginTop: 2 }}>{detail}</span>
        )}
      </span>
      {onClick !== undefined && <span style={{ color: "var(--rdsh-link)", fontSize: 13 }}>{t("查看详情")} ›</span>}
    </span>
  );

  const content = compact || tier === null ? (
    header
  ) : (
    <>
      {header}
      <span style={{ display: "block", height: 1, background: "var(--rdsh-border)", margin: "12px 0 10px" }} />
      <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--rdsh-fg-muted)", marginBottom: 6 }}>
        {t("我的权益")}
      </span>
      {DISPLAY_ORDER.map((e) => {
        const owned = has(tier, e);
        const label = benefitText(t, e, sub);
        return (
          <span key={e} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 4 }}>
            <span style={{ color: owned ? "var(--rdsh-success-strong)" : "var(--rdsh-fg-muted)", fontWeight: owned ? 600 : 400, lineHeight: "18px" }}>
              {owned ? "✓" : "✗"}
            </span>
            <span style={{ fontSize: 12, color: owned ? "var(--rdsh-fg)" : "var(--rdsh-fg-muted)" }}>
              {t(label)}
              {owned ? "" : `（${t(fromTierHint(e))}）`}
            </span>
          </span>
        );
      })}
    </>
  );

  return onClick !== undefined ? (
    <button onClick={onClick} style={style}>{content}</button>
  ) : (
    <div style={style}>{content}</div>
  );
}

/** 「云端中转」那行带上台数（已用/总量）；其余直接给文案。 */
function benefitText(t: T, e: Entitlement, sub: SubInfo | null): string {
  const base = entitlementLabel(e);
  if (e !== "cloudRelay") return base;
  // 权威值：订阅响应里的 hostQuota（随订阅实时变化，与 App 同源）。
  // ⚠️ 不要用 relayHostsFor —— 它只对 free/plus/pro/ultra 生效，trial/grace 会误显示成"不限"。
  const quota = sub?.hostQuota ?? null;
  if (quota === null) return `${base}：${t("不限")}`; // 专属账号（null = 不限）
  if (quota === 0) return `${base}：0`;
  return `${base}：${sub?.hostsInUse ?? 0}/${quota}`;
}

/** 缺该权益时标注"从哪一档开始有"（升级动因）。 */
function fromTierHint(e: Entitlement): string {
  switch (e) {
    case "cloudRelay":
    case "offlinePackages":
    case "offlineSpeech":
      return "试用起";
    case "cloudSpeech":
      return "旗舰版起";
    case "support":
      return "标准版起";
    case "directConnect":
    case "systemSpeech":
      return "";
  }
}

/** 档位对比矩阵：稳定的可选择档位 × 有差异的权益。 */
function TierMatrix({
  myTier,
  plans,
}: {
  myTier: PlanTier | null;
  plans: ReadonlyArray<{ id: string; vipTier?: number; hosts?: number }>;
}): React.JSX.Element {
  const { t } = useT();
  const cell: React.CSSProperties = { padding: "8px 6px", fontSize: 12, textAlign: "center" };
  const head: React.CSSProperties = { ...cell, fontWeight: 600 };
  const label: React.CSSProperties = { ...cell, textAlign: "left" };
  const hl = (x: PlanTier): React.CSSProperties => (x === myTier ? { background: "var(--rdsh-success-soft)" } : {});
  return (
    <Card title={t("档位对比")}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
          <thead>
            <tr>
              <th style={label} />
              {COMPARABLE_TIERS.map((x) => (
                <th key={x} style={{ ...head, ...hl(x) }}>{t(tierShortName(x))}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DISPLAY_ORDER.map((e) => (
              <tr key={e} style={{ borderTop: "1px solid var(--rdsh-border)" }}>
                <td style={label}>
                  {e === "cloudRelay" ? t("可云端中转主机数") : t(entitlementLabel(e))}
                </td>
                {COMPARABLE_TIERS.map((x) => {
                  if (e === "cloudRelay") {
                    const q = relayHostsFor(x, plans);
                    return (
                      <td key={x} style={{ ...cell, ...hl(x), fontWeight: 600, color: q === 0 ? "var(--rdsh-fg-muted)" : "var(--rdsh-success-strong)" }}>
                        {q === undefined || q === null ? "—" : q === 0 ? "0" : String(q)}
                      </td>
                    );
                  }
                  const owned = has(x, e);
                  return (
                    <td key={x} style={{ ...cell, ...hl(x), color: owned ? "var(--rdsh-success-strong)" : "var(--rdsh-fg-muted)", fontWeight: owned ? 600 : 400 }}>
                      {owned ? "✓" : "✗"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: "var(--rdsh-fg-muted)", marginTop: 8 }}>
        {t("✓ = 该档位可用 · 台数 = 可接云端中转的主机数")}
      </div>
    </Card>
  );
}

function AccountPage(): React.JSX.Element {
  const { t } = useT();
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [sub, setSub] = useState<SubInfo | null>(null);
  const [plans, setPlans] = useState<Array<{ id: string; vipTier?: number; hosts?: number }>>([]);
  const [customerServiceUrl, setCustomerServiceUrl] = useState<string | undefined>(undefined);
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const { err, run } = useError();
  useEffect(() => {
    void run(async () => {
      // 计划表用于把 planId 映射到档位（vipTier）—— 失败不影响本页其余内容。
      const [acc, subInfo, planList] = await Promise.all([
        api.accountInfo(),
        api.subscription(),
        api.listPlans().catch(() => ({ plans: [] })),
      ]);
      setInfo(acc);
      setSub(subInfo);
      setPlans(planList.plans);
    });
  }, []);
  useEffect(() => {
    void api.capabilities().then((c) => { setCustomerServiceUrl(c.site?.customerServiceUrl); if (c.wechatLoginEnabled === true) setWechatEnabled(true); }).catch(() => undefined);
  }, []);
  return (
    <Shell title={t("账户与安全")}>
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <CurrentPlanCard sub={sub} plans={plans} compact onClick={() => navigate("/billing")} />
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
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <Card title={t("邮箱")} badge={<Badge ok={bound} text={bound ? t("已验证") : t("未绑定")} />}>
        {info?.email !== null && info !== null && (
          <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", marginTop: 0 }}>
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
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <Card title={t("手机号")} badge={<Badge ok={bound} text={bound ? t("已验证") : t("未绑定")} />}>
        {info?.phone !== null && info !== null && (
          <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", marginTop: 0 }}>
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
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <Card title={t("两步验证（TOTP）")} badge={<Badge ok={enabled} text={enabled ? t("已开启") : t("未开启")} />}>
        {!enabled ? (
          <>
            <p style={{ fontSize: 13, lineHeight: 1.7, marginTop: 0, color: "var(--rdsh-fg)" }}>{t("两步验证（2FA）：登录时除了密码，还要输入手机验证器 App 生成的 6 位动态码（每 30 秒变化一次）——登录要同时通过“你知道的密码”和“你手机上的验证码”两道关，建议开启。")}</p>
            <div style={{ background: "var(--rdsh-bg-subtle)", border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, padding: 12, margin: "0 0 12px", fontSize: 12, color: "var(--rdsh-fg)" }}>
              <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{t("选择验证器 App（任意 TOTP 应用均可）：")}</p>
              <p style={{ margin: "2px 0" }}>· {t("iPhone 系统自带「密码」App —— 无需安装：Face ID 保护，代码随 iCloud 钥匙串备份、换机自动同步")}</p>
              <p style={{ margin: "2px 0" }}>· {t("Android 系统自带 Google 密码管理器 —— 无需安装，亦可生成验证码")}</p>
              <p style={{ margin: "2px 0" }}>· {t("Microsoft Authenticator —— 推荐首选：安卓与 iPhone 均可在应用商店/官网获取，不依赖 Google Play")}</p>
              <p style={{ margin: "2px 0" }}>· {t("Google Authenticator —— 安卓需 Google Play；iPhone 在 App Store")}</p>
            </div>
          {twofa === null ? (
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
              {qrDataUrl !== "" && <img src={qrDataUrl} alt="TOTP QR" style={{ width: 200, height: 200, borderRadius: 6, border: "1px solid var(--rdsh-border-soft)", marginBottom: 8 }} />}
              <p style={{ fontSize: 13 }}>{t("密钥（手动添加账号时粘贴）：")}</p>
              <code style={{ wordBreak: "break-all" }}>{twofa.secret}</code>
              <div style={{ background: "var(--rdsh-bg-subtle)", border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, padding: 12, margin: "12px 0", fontSize: 12, color: "var(--rdsh-fg)" }}>
                <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{t("设置步骤：")}</p>
                <p style={{ margin: "2px 0" }}>1. {t("任选一款验证器 App 并打开（见上方清单）")}</p>
                <p style={{ margin: "2px 0" }}>2. {t("添加账号 → 扫码绑定；无法扫码时选「手动输入」，粘贴下方密钥")}</p>
                <p style={{ margin: "2px 0" }}>3. {t("App 生成 6 位动态码（每 30 秒轮换）")}</p>
                <p style={{ margin: "2px 0" }}>4. {t("把动态码填回本页输入框（输满 6 位自动提交）→ 点「确认开启」")}</p>
                <p style={{ margin: "8px 0 4px", fontWeight: 600 }}>{t("提示：")}</p>
                <p style={{ margin: "2px 0" }}>· {t("密钥仅在此展示，开启后不再显示 —— 请确保 App 已成功绑定；建议保存密钥截图作备份")}</p>
                <p style={{ margin: "2px 0" }}>· {t("登录时可勾选「记住此设备 30 天」：自己的常用设备勾上，30 天内免输动态码；公用/他人设备请勿勾选；同一浏览器会话内也不会反复要求验证码")}</p>
                <p style={{ margin: "2px 0" }}>· {t("若换机或丢失验证器，需联系平台支持重置 2FA")}</p>
              </div>
              {field(t("当前 TOTP 验证码"), twofaCode, setTwofaCode, "text", { numeric: true })}
              <button
                onClick={() => void run(async () => { await api.activate2fa(twofa.secret, twofaCode.trim()); setTwofa(null); setTwofaCode(""); show("ok", t("2FA 已开启 ✓")); await refresh(); })}
                style={btnStyle()}
              >{t("确认开启")}</button>
            </div>
          )}
          </>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", marginTop: 0 }}>{t("已开启两步验证，登录时需输入 TOTP 动态验证码。")}</p>
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
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <Card title={t("删除账号（不可恢复）")}>
        <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", marginTop: 0 }}>
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
  const [seconds, startCountdown] = useCountdown();
  const { toast, show } = useToast();
  const { err, run, pending } = useError();

  // sms 未配置 → 隐藏手机号通道（未登录，走公开 /api/capabilities）
  useEffect(() => {
    void api.capabilities().then((c) => {
      setCap(c);
      if (c.smsEnabled === false) setChannel("email");
    }).catch(() => undefined);
  }, []);

  const resend = (): void => {
    void run(async () => {
      try {
        await api.resetRequest(channel, identifier.trim(), captchaPayload);
      } catch (e) {
        setCaptchaPayload({}); // 一次性票据已消费/失效 → 清票，强制重新过人机验证
        throw e;
      }
      setCaptchaPayload({}); // 成功后同样清票，再重发需重新验证
      startCountdown();
      show("ok", t("重置码已重新发送"));
    });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <Toast toast={toast} />
      <h1 style={{ fontSize: 20 }}>{t("找回密码")}</h1>
      {!sent ? (
        <>
          <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
            <button onClick={() => setChannel("email")} style={channel === "email" ? btnStyle() : btnStyle("ghost")}>{t("邮箱")}</button>
            {cap?.smsEnabled !== false && (
              <button onClick={() => setChannel("phone")} style={channel === "phone" ? btnStyle() : btnStyle("ghost")}>{t("手机号")}</button>
            )}
          </div>
          {field(channel === "email" ? t("注册邮箱") : t("手机号（+86）"), identifier, setIdentifier)}
          <CaptchaGate captcha={captchaPayload} onCaptcha={setCaptchaPayload} />
          {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
          <button
            onClick={() =>
              void run(async () => {
                try {
                  await api.resetRequest(channel, identifier.trim(), captchaPayload);
                } catch (e) {
                  setCaptchaPayload({}); // 一次性票据已消费/失效 → 清票，强制重新过人机验证
                  throw e;
                }
                setCaptchaPayload({}); // 成功后清票，sent 态重新过人机验证才能重发
                setSent(true);
                startCountdown();
              })
            }
            disabled={pending}
            style={{ ...btnStyle(), width: "100%", opacity: pending ? 0.5 : 1 }}
          >{t("发送重置码")}</button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)" }}>{t("若该{channel}已注册，重置码已发送（10 分钟内有效）。", { params: { channel: channel === "email" ? t("邮箱") : t("手机号") } })}</p>
          {field(t("重置码"), code, setCode)}
          {field(t("新密码（至少 8 位）"), newPassword, setNewPassword, "password")}
          <CaptchaGate captcha={captchaPayload} onCaptcha={setCaptchaPayload} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 12 }}>
            <SendCodeButton label={t("重发重置码")} seconds={seconds} onClick={resend} disabled={pending} />
          </div>
          {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
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
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ marginRight: 5, verticalAlign: -1.5, flexShrink: 0, color: "var(--rdsh-success)" }}
    >
      <title>{t("端到端加密")}</title>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** 用量页图标：语义对齐 App 端用量页（24x24 stroke，与全站 SVG 风格一致）。 */
function UsageIcon({ name, color }: { name: "relay" | "direct" | "cloud" | "local" | "speaker" | "host"; color: string }): React.JSX.Element {
  const paths: Record<string, React.ReactNode> = {
    relay: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
    direct: (
      <>
        <rect x="16" y="16" width="6" height="6" rx="1" />
        <rect x="2" y="16" width="6" height="6" rx="1" />
        <rect x="9" y="2" width="6" height="6" rx="1" />
        <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
        <path d="M12 12V8" />
      </>
    ),
    cloud: (
      <>
        <path d="M12 19v3" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <rect x="9" y="2" width="6" height="13" rx="3" />
      </>
    ),
    local: (
      <>
        <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
        <path d="M12 18h.01" />
      </>
    ),
    speaker: (
      <>
        <path d="M11 5 6 9H2v6h4l5 4V5Z" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </>
    ),
    host: (
      <>
        <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
        <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
        <line x1="6" x2="6.01" y1="6" y2="6" />
        <line x1="6" x2="6.01" y1="18" y2="18" />
      </>
    ),
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {paths[name]}
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
  // 超配额软提示（本地判定，不查后端）：quota = 可云端中转主机数上限（null=不限）。
  const [quota, setQuota] = useState<number | null>(null);
  const [quotaHost, setQuotaHost] = useState<{ name: string; quota: number } | null>(null);
  const { err, run } = useError();

  const openShare = (hostId: string): void => {
    setShareHostId(hostId);
    void run(async () => setShares((await api.listShares(hostId)).shares));
  };

  const requestEnter = (h: HostInfo): void => {
    // 超配额软提示（本地判定，不查后端）：只统计自有主机，按列表顺序前 N 台可用。
    if (h.role === "owner" && quota !== null) {
      const owned = hosts.filter((x) => x.role === "owner");
      const rank = owned.findIndex((x) => x.id === h.id);
      if (rank >= 0 && rank >= quota) {
        setQuotaHost({ name: h.name, quota });
        return;
      }
    }
    // 新标签由 window.open 打开：必须在点击手势里同步调用（跨 await 会被弹窗拦截），
    // 所以指纹计算只在「需要信任确认」的弹窗分支里做。
    const pub = h.e2eePublicKey;
    if (pub === undefined || pub === null || pub === "") {
      enterHost(h.id); // 无 E2EE 公钥 → 直连（明文）
      return;
    }
    const pinned = readE2eePin(h.id);
    if (pinned === pub) {
      enterHost(h.id);
      return;
    }
    void run(async () => {
      const fp = await fingerprint(fromBase64url(pub));
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
    // 配额仅用于"超配额软提示"；失败按"不限"处理（绝不因拉取失败拦住用户）。
    void api.subscription().then((s) => setQuota(s.hostQuota)).catch(() => setQuota(null));
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
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate("/add-host")} style={btnStyle()}>{t("添加主机接入")}</button>
      </div>

      {loading ? (
        <p style={{ color: "var(--rdsh-fg-muted)" }}>{t("加载中…")}</p>
      ) : hosts.length === 0 ? (
        <p style={{ color: "var(--rdsh-fg-muted)" }}>{t("还没有接入主机 —— 用上面的「添加主机」接入你的第一台 DSH。")}</p>
      ) : (
        <div>
          {hosts.map((h) => {
            const isOwner = h.role !== "member";
            const menuOpen = menuHostId === h.id;
            return (
              <div key={h.id} style={{ border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                  <span style={{ fontWeight: 500 }}>
                    {h.e2eePublicKey !== undefined && h.e2eePublicKey !== null && h.e2eePublicKey !== "" && <ShieldIcon />}
                    {h.name}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ color: h.online ? "var(--rdsh-success)" : "var(--rdsh-fg-subtle)", fontSize: 14 }}>{h.online ? "●" : "○"}</span>
                    <span style={{ color: "var(--rdsh-fg-muted)", fontSize: 12 }}>{h.online ? t("在线") : t("离线")}</span>
                  </span>
                  {!isOwner && <span style={{ color: "var(--rdsh-fg-subtle)", fontSize: 12, border: "1px solid var(--rdsh-border-soft)", borderRadius: 4, padding: "1px 6px" }}>{t("共享", { en: "Shared" })}</span>}
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
                      <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "var(--rdsh-bg-surface)", border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, boxShadow: "var(--rdsh-shadow)", zIndex: 20, minWidth: 140, padding: 4 }} onClick={(e) => e.stopPropagation()}>
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
            <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--rdsh-border-soft)", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <p style={{ fontWeight: 500, margin: 0 }}>{t("共享管理")}{shareHostName !== undefined ? ` · ${shareHostName}` : ""}</p>
                <button onClick={() => { setShareHostId(null); setShareName(""); }} style={btnStyle("ghost")}>{t("关闭")}</button>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder={t("成员用户名")} style={{ ...inputStyle(), width: 180 }} />
                <button onClick={doShare} style={btnStyle()}>{t("共享", { en: "Share" })}</button>
              </div>
              {shares.length === 0 ? (
                <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13 }}>{t("尚未共享给任何人")}</p>
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
      {quotaHost !== null && (
        <div style={{ position: "fixed", inset: 0, background: "var(--rdsh-scrim)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setQuotaHost(null)}>
          <div style={{ background: "var(--rdsh-bg-surface)", padding: 20, borderRadius: 12, maxWidth: 400, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 600 }}>{t("主机超出套餐")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, margin: "8px 0 0" }}>
              {t("当前套餐可云端中转的主机数为 {n} 台，这台已超出。升级或续费后即可继续使用。", { params: { n: quotaHost.quota } })}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
              <button onClick={() => { setQuotaHost(null); navigate("/billing"); }} style={btnStyle()}>{t("去升级")}</button>
              <button onClick={() => setQuotaHost(null)} style={btnStyle("ghost")}>{t("取消")}</button>
            </div>
          </div>
        </div>
      )}
      {pendingTrust !== null && (
        <div style={{ position: "fixed", inset: 0, background: "var(--rdsh-scrim)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setPendingTrust(null)}>
          <div style={{ background: "var(--rdsh-bg-surface)", padding: 20, borderRadius: 12, maxWidth: 400, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 600 }}>{pendingTrust.changed ? t("主机的安全指纹已改变") : t("首次连接这台主机")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, margin: "8px 0 0" }}>{t("主机")}: {pendingTrust.name}</p>
            <p style={{ fontFamily: "monospace", fontSize: 16, letterSpacing: 1, margin: "10px 0" }}>{pendingTrust.fingerprint}</p>
            <p style={{ color: "var(--rdsh-fg-subtle)", fontSize: 12, margin: "0 0 12px" }}>
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
  // 续期令牌在 HttpOnly cookie 里；等服务端读 cookie 吊销并清 cookie 完成再跳转。
  // 失败也先本地跳登录（httpOnly cookie 客户端无法自行删除）。
  const done = (): void => navigate("/login");
  void api.logout().catch(() => undefined).finally(done);
}

// ---- 进入 host：整页跳转 /h/<hostId>/（hub 校验归属 → Set-Cookie → 302 根路径，DSH 在根路径运行） ----

function enterHost(hostId: string): void {
  // 新标签打开：host 页在独立 Tab 里跑，关掉即可回门户（不再往页面里注入返回按钮）。
  // 注意：带 "noopener" 时 window.open 恒返回 null（新窗口与 opener 断链），
  // 不能用返回值判断是否被拦截——否则会误触发 fallback，当前页也跟着跳走。
  const url = `/h/${encodeURIComponent(hostId)}/`;
  const w = window.open(url, "_blank");
  if (w === null) {
    window.location.href = url; // 被浏览器拦截 → 退回同页跳转
  } else {
    w.opener = null; // 切断 opener（等价 noopener 的安全效果）
  }
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
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>{t("生成接入令牌")}</h2>
        <p style={{ fontSize: 14, color: "var(--rdsh-fg)", margin: "0 0 8px" }}>{t("用于将主机接入 Hub，并绑定到用户的账号。")}</p>
        <div style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", paddingLeft: 16 }}>
          <p style={{ margin: "2px 0" }}>· {t("明文只在生成时显示一次——刷新或离开本页后无法再次查看，请立即复制")}</p>
          <p style={{ margin: "2px 0" }}>· {t("令牌在有效期内可重复使用，可接入多台主机")}</p>
          <p style={{ margin: "2px 0" }}>· {t("接入后主机保持连接，不依赖此令牌——吊销它不影响已接入主机")}</p>
          <p style={{ margin: "2px 0" }}>· {t("遗忘或泄露，请立即吊销并重新生成，旧令牌即刻失效")}</p>
        </div>
      </div>
      <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 8, padding: 16, marginBottom: 16 }}>
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
          <p style={{ color: "var(--rdsh-danger)", fontSize: 13, fontWeight: 600, margin: "0 0 8px" }}>{t("接入令牌明文只显示这一次，请立即复制")}</p>
          <div style={{ border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, padding: 16, marginBottom: 12 }}>
            <p style={{ margin: "0 0 10px", fontWeight: 600, fontSize: 14 }}>{t("方式一：DSH 插件（界面操作，免装 CLI）")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 12, margin: 0 }}>{t("未装插件？在主机终端执行：")}</p>
            <pre style={{ background: "var(--rdsh-bg-subtle)", border: "1px solid var(--rdsh-border-soft)", borderRadius: 6, padding: 8, fontSize: 12, margin: "4px 0 6px", overflowX: "auto" }}>dsh plugin --profile web add dsh-web-remote</pre>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 12, margin: "0 0 10px" }}>{t("然后重启 dsh web（插件 boot 时加载）")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, margin: "0 0 8px" }}>{t("在 DSH 设置 →「远程访问」面板填入：")}</p>
            <div style={{ marginBottom: 10 }}>
              <code style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", background: "var(--rdsh-bg-subtle)", padding: "6px 8px", borderRadius: 4, wordBreak: "break-all" }}>{generated.hub}</code>
              <button onClick={() => copy("hub", generated.hub)} style={{ ...btnStyle(), marginTop: 6 }}>{copiedKey === "hub" ? `${t("已复制")} ✓` : t("复制 Hub 地址")}</button>
            </div>
            <div style={{ marginBottom: 0 }}>
              <code style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg)", background: "var(--rdsh-bg-subtle)", padding: "6px 8px", borderRadius: 4, wordBreak: "break-all" }}>{generated.token}</code>
              <button onClick={() => copy("token", generated.token)} style={{ ...btnStyle(), marginTop: 6 }}>{copiedKey === "token" ? `${t("已复制")} ✓` : t("复制令牌")}</button>
            </div>
          </div>
          <div style={{ border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, padding: 16 }}>
            <p style={{ margin: "0 0 10px", fontWeight: 600, fontSize: 14 }}>{t("方式二：rdsh-gateway（命令行）")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 12, margin: 0 }}>{t("未装 CLI？终端执行：")}</p>
            <pre style={{ background: "var(--rdsh-bg-subtle)", border: "1px solid var(--rdsh-border-soft)", borderRadius: 6, padding: 8, fontSize: 12, margin: "4px 0 10px", overflowX: "auto" }}>npm i -g remote-dsh</pre>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, margin: "0 0 6px" }}>{t("在主机终端执行：")}</p>
            <pre style={{ background: "var(--rdsh-bg-subtle)", border: "1px solid var(--rdsh-border-soft)", borderRadius: 6, padding: 8, fontSize: 12, margin: "0 0 8px", overflowX: "auto" }}>{generated.command}</pre>
            <button onClick={() => copy("command", generated.command)} style={btnStyle()}>{copiedKey === "command" ? `${t("已复制")} ✓` : t("复制命令")}</button>
            {copyErr !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13, margin: "8px 0 0" }}>{copyErr}</p>}
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 12, margin: "10px 0 2px" }}>{t("接入后运行隧道：")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 12, margin: "2px 0" }}>· {t("前台运行：rdsh host serve")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 12, margin: "2px 0" }}>· {t("常驻服务（服务器 7×24）：rdsh host service install")}</p>
            <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 12, margin: "10px 0 0" }}>{t("主机名默认取机器 hostname，可追加 --name 覆盖")}</p>
          </div>
        </div>
      )}

      <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", fontWeight: 600, marginBottom: 6 }}>{t("接入令牌")}</p>
      {tokens.length === 0 ? (
        <p style={{ color: "var(--rdsh-fg-subtle)", fontSize: 13 }}>{t("（无）")}</p>
      ) : (
        <div>
          {tokens.map((tok) => (
            <div key={tok.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 500 }}>{tok.label ?? compactTimestamp(tok.createdAt)}</span>
              <code style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", background: "var(--rdsh-bg-subtle)", padding: "2px 6px", borderRadius: 4 }}>{tok.fingerprint}</code>
              <span style={{ color: "var(--rdsh-fg-muted)", fontSize: 12 }}>{t("到期 {date}", { params: { date: new Date(tok.expiresAt).toLocaleDateString() } })}</span>
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
      setTimeout(() => navigate("/login"), 1500);
    });
  };

  return (
    <Shell title={t("修改密码")}>
      <div style={{ maxWidth: 420 }}>
        {done && <p style={{ color: "var(--rdsh-success)", fontSize: 14 }}>{t("密码已修改，全部会话已失效 —— 即将跳转登录…")}</p>}
        {!done && (
          <>
            {field(t("当前密码"), current, setCurrent, "password")}
            {field(t("新密码（至少 8 位）"), next, setNext, "password")}
            {field(t("确认新密码"), again, setAgain, "password")}
            {next !== again && next !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{t("两次输入不一致")}</p>}
            {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
            <button onClick={submit} style={btnStyle()}>{t("保存")}</button>
          </>
        )}
      </div>
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
  const { err, run, pending } = useError();

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
      try {
        await api.register(channel, identifier.trim(), password, captchaPayload);
      } catch (e) {
        setCaptchaPayload({}); // 一次性票据已消费/失效 → 清票，强制重新过人机验证
        throw e;
      }
      navigate(`/verify?channel=${channel}&identifier=${encodeURIComponent(identifier.trim())}`);
    });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{t("注册 rdsh")}</h1>
      <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, marginBottom: 24 }}>{t("注册即享 7 天试用（1 台主机），随时随地浏览器访问你的 DSH。")}</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setChannel("email")} style={channel === "email" ? btnStyle() : btnStyle("ghost")}>{t("邮箱")}</button>
        {cap?.smsEnabled !== false && (
          <button onClick={() => setChannel("phone")} style={channel === "phone" ? btnStyle() : btnStyle("ghost")}>{t("手机号")}</button>
        )}
      </div>
      {field(channel === "email" ? t("邮箱地址") : t("手机号（+86，11 位）"), identifier, setIdentifier)}
      {field(t("密码（至少 8 位）"), password, setPassword, "password")}
      <CaptchaGate captcha={captchaPayload} onCaptcha={setCaptchaPayload} />
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, marginBottom: 12, lineHeight: 1.6 }}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          {t("我已阅读并同意")}
          {legalLink(cap?.site?.termsUrl, t("《用户协议》"), { color: "var(--rdsh-link)" })}
          {t("与")}
          {legalLink(cap?.site?.privacyUrl, t("《隐私政策》"), { color: "var(--rdsh-link)" })}
        </span>
      </label>
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} disabled={!agreed || pending} style={{ ...btnStyle(), width: "100%", marginTop: 8, opacity: agreed && !pending ? 1 : 0.5 }}>{t("获取验证码并注册")}</button>
      <p style={{ marginTop: 12, textAlign: "center" }}>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate("/login"); }} style={{ color: "var(--rdsh-link)", fontSize: 13 }}>{t("已有账号？登录")}</a>
      </p>
    </div>
  );
}

function VerifyPage(): React.JSX.Element {
  const { t } = useT();
  const q = new URLSearchParams(window.location.search);
  const channel = (q.get("channel") === "phone" ? "phone" : "email") as "email" | "phone";
  const identifier = q.get("identifier") ?? "";
  const [code, setCode] = useState("");
  const [captchaPayload, setCaptchaPayload] = useState<CaptchaPayload>({});
  const [seconds, startCountdown] = useCountdown();
  const { toast, show } = useToast();
  const { err, run, pending } = useError();

  // 注册页刚发过一码，进入验证页即启动 60s 倒计时，重发与首次发送保持同一间隔
  useEffect(() => {
    startCountdown();
  }, []);

  const submit = (): void => {
    void run(async () => {
      await api.verifyAccount(channel, identifier, code.trim());
      navigate("/hosts");
    });
  };

  const resend = (): void => {
    void run(async () => {
      try {
        await api.registerResend(channel, identifier, captchaPayload);
      } catch (e) {
        setCaptchaPayload({}); // 一次性票据已消费/失效 → 清票，强制重新过人机验证
        throw e;
      }
      setCaptchaPayload({}); // 成功后同样清票，再重发需重新验证
      startCountdown();
      show("ok", t("验证码已重新发送"));
    });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <Toast toast={toast} />
      <h1 style={{ fontSize: 20 }}>{t("验证{channel}", { params: { channel: channel === "email" ? t("邮箱") : t("手机号") } })}</h1>
      <p style={{ color: "var(--rdsh-fg-muted)", fontSize: 13, marginBottom: 24 }}>{t("验证码已发送至 {identifier}（10 分钟内有效）。", { params: { identifier } })}</p>
      {field(t("6 位验证码"), code, setCode)}
      <CaptchaGate captcha={captchaPayload} onCaptcha={setCaptchaPayload} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 12 }}>
        <SendCodeButton label={t("重发验证码")} seconds={seconds} onClick={resend} disabled={pending} />
      </div>
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ ...btnStyle(), width: "100%" }}>{t("验证并登录")}</button>
    </div>
  );
}

interface PlanInfo {
  id: string;
  name: string;
  /** 该档可接入云端中转的主机数（API.md §13.3：不是"用户拥有几台主机"）。 */
  hosts: number;
  priceCny: number;
  priceUsd?: number;
  intervalMonths: number;
  /** 档位 1=标准版 / 2=专业版 / 3=旗舰版；缺省按最低付费档（见 API.md §13）。 */
  vipTier?: number;
}

/** 是否微信内置浏览器。 */
function isWechatWebview(): boolean {
  return /MicroMessenger/i.test(navigator.userAgent);
}

/** 是否移动端浏览器（非微信）。 */
function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** 微信官方 logo（颜色随按钮前景色，用于「微信登录」按钮；商标 © Tencent）。 */
function WechatIcon({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={Math.round((size * 310) / 384)} viewBox="0 0 384 310" aria-hidden="true">
      <path
        d="M343.37 275.112c24.333-17.635 39.886-43.726 39.886-72.71 0-53.132-51.685-96.198-115.439-96.198-63.754 0-115.435 43.066-115.435 96.198 0 53.129 51.681 96.194 115.435 96.194 13.174 0 25.89-1.88 37.68-5.272a11.59 11.59 0 0 1 3.397-.505c2.212 0 4.23.673 6.126 1.774l25.272 14.587c.706.408 1.387.719 2.224.719a3.847 3.847 0 0 0 3.847-3.852c0-.946-.378-1.9-.618-2.808-.147-.543-3.263-12.157-5.201-19.406-.223-.811-.404-1.598-.404-2.451a7.687 7.687 0 0 1 3.23-6.27m-114.036-88.1c-8.493 0-15.385-6.89-15.385-15.393 0-8.502 6.892-15.394 15.385-15.394 8.507 0 15.394 6.892 15.394 15.394 0 8.502-6.887 15.394-15.394 15.394m76.961 0c-8.498 0-15.39-6.892-15.39-15.394 0-8.502 6.892-15.394 15.39-15.394 8.503 0 15.39 6.892 15.39 15.394 0 8.502-6.887 15.394-15.39 15.394zM138.524 0c69.11 0 126.385 42.174 136.817 97.32a153.735 153.735 0 0 0-7.523-.201c-69.775 0-126.338 47.14-126.338 105.28 0 9.806 1.644 19.292 4.655 28.295-2.523.113-5.055.18-7.611.18-15.806 0-31.065-2.262-45.215-6.328a13.889 13.889 0 0 0-4.074-.61c-2.658 0-5.071.812-7.354 2.128l-30.326 17.51c-.845.487-1.669.861-2.67.861a4.614 4.614 0 0 1-4.617-4.617c0-1.143.455-2.283.745-3.376l6.24-23.282c.265-.98.487-1.922.487-2.944a9.23 9.23 0 0 0-3.876-7.526C18.657 181.53 0 150.222 0 115.44 0 51.685 62.017 0 138.524 0zM92.346 96.968c10.206 0 18.472-8.267 18.472-18.472 0-10.201-8.266-18.468-18.472-18.468-10.196 0-18.467 8.267-18.467 18.468 0 10.205 8.27 18.472 18.467 18.472zm92.355 0c10.201 0 18.472-8.267 18.472-18.472 0-10.201-8.27-18.468-18.472-18.468-10.205 0-18.471 8.267-18.471 18.468 0 10.205 8.266 18.472 18.471 18.472z"
        fill="currentColor"
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

/** 二维码支付弹窗：二维码 + 「已完成支付」主动查单（按钮 + 每 4s 自动轮询）+ 取消。 */
function QrPaymentDialog(props: {
  qrDataUrl: string;
  appOrderId: string | null;
  onCancel: () => void;
  onPaid: () => void;
}): React.JSX.Element {
  const { t } = useT();
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const checkingRef = useRef(false);

  // silent=true 为自动轮询：只处理 paid（命中即停），不弹 notice、不切 checking，避免打扰未付款用户。
  const checkNow = useCallback((silent: boolean): void => {
    if (props.appOrderId === null || checkingRef.current) return;
    checkingRef.current = true;
    if (!silent) setChecking(true);
    void api.checkOrder(props.appOrderId)
      .then((r) => {
        if (r.status === "paid") {
          props.onPaid();
          return;
        }
        if (!silent) setNotice(t("尚未收到支付结果，请稍后再试", { en: "Payment not received yet, please try again later." }));
      })
      .catch(() => {
        if (!silent) setNotice(t("暂时无法确认到账，请稍后再试", { en: "Cannot confirm the payment yet, please try again later." }));
      })
      .finally(() => {
        checkingRef.current = false;
        if (!silent) setChecking(false);
      });
  }, [props.appOrderId, props.onPaid, t]);

  // 二维码出现后每 4 秒静默自动查一次，命中 paid 即停（onPaid 会关闭本弹窗）。
  useEffect(() => {
    if (props.appOrderId === null) return;
    const timer = window.setInterval(() => checkNow(true), 4000);
    return () => window.clearInterval(timer);
  }, [props.appOrderId, checkNow]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--rdsh-scrim)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={props.onCancel}>
      <div style={{ background: "var(--rdsh-bg-surface)", padding: 20, borderRadius: 12, textAlign: "center", maxWidth: 280 }} onClick={(e) => e.stopPropagation()}>
        <img src={props.qrDataUrl} width={220} height={220} alt="qr" />
        <p style={{ margin: "12px 0 8px", fontSize: 14 }}>{t("请用微信扫一扫完成支付")}</p>
        {notice !== null && <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--rdsh-fg-muted)" }}>{notice}</p>}
        <button onClick={() => checkNow(false)} disabled={checking} style={{ ...btnStyle(), width: "100%", marginBottom: 8 }}>{checking ? t("查询中…", { en: "Checking…" }) : t("已完成支付", { en: "Payment Completed" })}</button>
        <button onClick={props.onCancel} style={{ ...btnStyle("ghost"), width: "100%" }}>{t("取消")}</button>
      </div>
    </div>
  );
}

function BillingPage(): React.JSX.Element {
  const { t, lang } = useT();
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [sub, setSub] = useState<SubInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [appOrderId, setAppOrderId] = useState<string | null>(null);
  const paidRef = useRef(false);
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

  /** 轮询订阅状态直至支付成功（上限 5 分钟）。判定以「到期时间被延长」为准，而非「是否会员」——否则已是会员再续费/升级时会误判为已支付、二维码秒关。 */
  const pollUntilPaid = (beforeExpiresAt: number | null): void => {
    const timer = window.setInterval(() => {
      void api
        .subscription()
        .then((s) => {
          // 支付成功 = 首次订阅（null → 有值）或到期时间变大；已是会员但未支付时两者相等，不触发。
          const extended = beforeExpiresAt === null ? s.planExpiresAt !== null : (s.planExpiresAt ?? 0) > beforeExpiresAt;
          if (s.planStatus === "subscribed" && extended) {
            window.clearInterval(timer);
            if (paidRef.current) return; // checkOrder 已处理
            paidRef.current = true;
            setQrDataUrl(null);
            setAppOrderId(null);
            show("ok", t("订阅成功，配额已升级"));
            load();
          }
        })
        .catch(() => {});
    }, 2000);
    window.setTimeout(() => window.clearInterval(timer), 5 * 60 * 1000);
  };

  const doSubscribe = async (planId: string, form: "native" | "h5" | "jsapi"): Promise<void> => {
    // 记录支付前到期时间，供轮询兜底判定「到期时间是否真的被延长」（避免已是会员时二维码被秒关）。
    const beforeExpiresAt = sub?.planExpiresAt ?? null;
    const ok = await run(async () => {
      // feature 121/36：native/h5/jsapi 全走 unicpay（经 hub 代理），h5 跳 h5Url、jsapi 调起 WeixinJSBridge。
      const scene = form === "h5" ? "h5" : form === "jsapi" ? "jsapi" : "native";
      const r = await api.unicpayInitiate(planId, scene);
      setAppOrderId(r.appOrderId);
      paidRef.current = false; // 新一笔支付，复位成功守卫
      if (scene === "native") {
        const nativeUrl = r.payParams?.nativeUrl;
        if (typeof nativeUrl === "string") {
          const dataUrl = await QRCode.toDataURL(nativeUrl, { width: 220, margin: 1 });
          setQrDataUrl(dataUrl);
          pollUntilPaid(beforeExpiresAt);
        } else {
          show("err", t("支付已取消或失败"));
        }
      } else if (scene === "h5") {
        const h5Url = r.payParams?.h5Url;
        if (typeof h5Url === "string") {
          window.location.href = h5Url;
        } else {
          show("err", t("支付已取消或失败"));
        }
      } else {
        const prepay = r.payParams?.prepay;
        if (prepay && typeof prepay.appId === "string") {
          invokeWechatJsapi(prepay);
          pollUntilPaid(beforeExpiresAt);
        } else {
          show("err", t("支付已取消或失败"));
        }
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
  // 档位（唯一口径见 entitlements.ts）。专属账号无需订阅 ⟹ 不渲染购买与对比（API.md §13.2）。
  const vipTier = sub?.planId != null ? plans.find((p) => p.id === sub.planId)?.vipTier ?? null : null;
  const myTier = tierOf({ hasEntitlement: sub !== null, planStatus: sub?.planStatus ?? null, vipTier });
  const isInternal = myTier === "internal";

  return (
    <>
      <Shell title={t(isInternal ? "我的权益" : "套餐与订阅")}>
        <Toast toast={toast} />
        {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
        {/* 完整版：身份 + 时间 +「我的权益」清单 */}
        <CurrentPlanCard sub={sub} plans={plans} />
        {isInternal && (
          <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)" }}>{t("如需变更有效期或额度，请联系管理员。")}</p>
        )}
        {isInternal ? null : hasPlans ? (
          <Card title={t("选择套餐")}>
            {plans.map((p) => {
              const current = p.id === currentPlanId;
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", border: "1px solid var(--rdsh-border)", borderRadius: 10, marginBottom: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                      {current && <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, background: "var(--rdsh-success-soft)", color: "var(--rdsh-success-strong)" }}>{t("当前套餐")}</span>}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", marginTop: 2 }}>{lang === "en" ? t("{hosts} hosts · ${price}/{interval} months", { params: { hosts: p.hosts, price: p.priceUsd ?? p.priceCny, interval: p.intervalMonths } }) : t("{hosts} 台 host · ¥{price}/{interval} 月", { params: { hosts: p.hosts, price: p.priceCny, interval: p.intervalMonths } })}</div>
                  </div>
                  <button disabled={current} onClick={() => subscribe(p.id)} style={btnStyle()}>
                    {current ? t("当前套餐") : t("订阅")}
                  </button>
                </div>
              );
            })}
          </Card>
        ) : (
          // 本 hub 未配置计费套餐（`billing.plans` 为空）—— 这是**运营方配置**问题，
          // 不是"用户身份"（用户身份见上方身份卡，`plan_status=NULL` 一律显示「专属账号」）。
          <Card title={t("未配置计费套餐")}>
            <p style={{ fontSize: 13, margin: 0 }}>
              {t("本 hub 未配置 billing.plans，因此没有可购买的套餐。")}
            </p>
            <p style={{ fontSize: 12, color: "var(--rdsh-fg-subtle)", margin: "8px 0 0" }}>
              {t("运营方配置后，此处将展示套餐与订阅入口。")}
            </p>
          </Card>
        )}
        {!isInternal && hasPlans && <TierMatrix myTier={myTier} plans={plans} />}
        {!isInternal && <Card title={t("计费说明")}>
          <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", margin: 0 }}>
            {t("订阅/试用到期后进入 3 天宽限期（隧道保留），之后降级免费档（0 台在线，host 数据保留 30 天）。")}
          </p>
          <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", margin: "8px 0 0" }}>
            {t("支付：微信支付（扫码 / H5 / 微信内）· 暂不提供发票。")}
          </p>
        </Card>}
      </Shell>
      {qrDataUrl !== null && (
        <QrPaymentDialog
          qrDataUrl={qrDataUrl}
          appOrderId={appOrderId}
          onCancel={() => { setQrDataUrl(null); setAppOrderId(null); }}
          onPaid={() => {
            if (paidRef.current) return;
            paidRef.current = true;
            setQrDataUrl(null);
            setAppOrderId(null);
            show("ok", t("订阅成功，配额已升级"));
            load();
          }}
        />
      )}
    </>
  );
}

/** 点数微单位 → 点数（后端余额为整数微单位，1 点数 = 10000）。 */
const CREDITS_MICRO = 10000;

function CreditsPage(): React.JSX.Element {
  const { t, lang } = useT();
  const [balance, setBalance] = useState<number | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [appOrderId, setAppOrderId] = useState<string | null>(null);
  const [confirmTier, setConfirmTier] = useState<{ id: string; credits: number; priceCny: number } | null>(null);
  const [tiers, setTiers] = useState<Array<{ id: string; credits: number; priceCny: number; isPopular?: boolean; isBestValue?: boolean }>>([]);
  const paidRef = useRef(false);
  const { toast, show } = useToast();
  const { err, run } = useError();

  const load = (): void => {
    void run(async () => {
      const [b, ts] = await Promise.all([api.creditsBalance(), api.creditsTiers()]);
      setBalance(b.total / CREDITS_MICRO);
      setTiers(ts);
    });
  };
  useEffect(load, []);

  // 需求三：点「充值」先弹确认框，同意后才真正下单（去掉阻断勾选）。
  const doRecharge = (tier: { id: string; credits: number; priceCny: number }): void => {
    setConfirmTier(tier);
  };

  const confirmRecharge = async (): Promise<void> => {
    const tier = confirmTier;
    if (tier === null) return;
    setConfirmTier(null);
    const before = balance;
    const ok = await run(async () => {
      const r = await api.creditsRecharge(tier.id, "native");
      setAppOrderId(r.appOrderId);
      paidRef.current = false; // 新一笔支付，复位成功守卫
      const nativeUrl = r.payParams?.nativeUrl;
      if (typeof nativeUrl === "string") {
        const dataUrl = await QRCode.toDataURL(nativeUrl, { width: 220, margin: 1 });
        setQrDataUrl(dataUrl);
        const timer = window.setInterval(() => {
          void api.creditsBalance().then((b) => {
            const now = b.total / CREDITS_MICRO;
            if (before !== null && now > before) {
              window.clearInterval(timer);
              if (paidRef.current) return; // checkOrder 已处理
              paidRef.current = true;
              setQrDataUrl(null);
              setAppOrderId(null);
              show("ok", t("点数充值成功", { en: "Credits added" }));
              load();
            }
          }).catch(() => {});
        }, 2000);
        window.setTimeout(() => window.clearInterval(timer), 5 * 60 * 1000);
      } else {
        show("err", t("支付已取消或失败", { en: "Payment cancelled or failed" }));
      }
    });
    if (!ok) load();
  };

  const fmt = (n: number): string => n.toLocaleString();

  return (
    <>
      <Shell title={t("点数充值", { en: "Credits" })}>
        <Toast toast={toast} />
        {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
        <Card title={t("点数余额", { en: "Credits balance" })}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>
            {balance === null ? "—" : fmt(balance)} <span style={{ fontSize: 14, fontWeight: 400 }}>{t("点数", { en: "credits" })}</span>
          </div>
          <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "4px 0 0" }}>
            {t("1 点数 = 1 分钱，用于云端中转流量", { en: "1 credit = ¥0.01, used for cloud relay traffic" })}
          </p>
        </Card>
        <Card title={t("选择充值档位", { en: "Choose amount" })}>
          <div className="rdsh-credits-grid">
            {tiers.map((tier) => (
              <div key={tier.id} style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>¥{tier.priceCny} → {fmt(tier.credits)} {t("点数", { en: "credits" })}</div>
                  {(tier.isPopular === true || tier.isBestValue === true) && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      {tier.isPopular === true && (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, border: "1px solid #FF9800", color: "#FF9800" }}>{t("推荐", { en: "Popular" })}</span>
                      )}
                      {tier.isBestValue === true && (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 8px", borderRadius: 999, border: "1px solid #07C160", color: "#07C160" }}>{t("最划算", { en: "Best value" })}</span>
                      )}
                    </div>
                  )}
                </div>
                <button onClick={() => doRecharge(tier)} style={{ ...btnStyle(), flexShrink: 0 }}>{t("充值", { en: "Top up" })}</button>
              </div>
            ))}
          </div>
        </Card>
        <Card title={t("说明", { en: "Note" })}>
          <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", margin: 0, lineHeight: 1.6 }}>
            {t("充值即表示您已阅读并同意", { en: "By topping up you confirm you have read and agree to" })}{" "}
            {legalLink(`https://rdsh.cn/${lang === "en" ? "en" : "zh-CN"}/iap/`, t("《充值协议》", { en: "the Terms" }), { color: "var(--rdsh-link)" })}
            {t("：虚拟数字内容，购买后不可退款、不可提现、不可转让。", { en: ": virtual digital content, non-refundable, non-withdrawable, non-transferable." })}
          </p>
        </Card>
      </Shell>
      {confirmTier !== null && (
        <div style={{ position: "fixed", inset: 0, background: "var(--rdsh-scrim)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setConfirmTier(null)}>
          <div style={{ background: "var(--rdsh-bg-surface)", padding: 20, borderRadius: 12, maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>{t("充值 ¥{price} → {credits} 点数", { en: "Top up ¥{price} → {credits} credits", params: { price: confirmTier.priceCny, credits: confirmTier.credits } })}</p>
            <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", margin: "0 0 16px", lineHeight: 1.7 }}>
              {t("充值即表示您已阅读并同意", { en: "By topping up you confirm you have read and agree to" })}{" "}
              {legalLink(`https://rdsh.cn/${lang === "en" ? "en" : "zh-CN"}/iap/`, t("《充值协议》", { en: "the Terms" }), { color: "var(--rdsh-link)" })}
              {t("：虚拟数字内容，购买后不可退款、不可提现、不可转让。", { en: ": virtual digital content, non-refundable, non-withdrawable, non-transferable." })}
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setConfirmTier(null)} style={{ ...btnStyle("ghost"), flex: 1 }}>{t("取消", { en: "Cancel" })}</button>
              <button onClick={() => void confirmRecharge()} style={{ ...btnStyle(), flex: 1 }}>{t("同意并充值", { en: "Agree and top up" })}</button>
            </div>
          </div>
        </div>
      )}
      {qrDataUrl !== null && (
        <QrPaymentDialog
          qrDataUrl={qrDataUrl}
          appOrderId={appOrderId}
          onCancel={() => { setQrDataUrl(null); setAppOrderId(null); }}
          onPaid={() => {
            if (paidRef.current) return;
            paidRef.current = true;
            setQrDataUrl(null);
            setAppOrderId(null);
            show("ok", t("点数充值成功", { en: "Credits added" }));
            load();
          }}
        />
      )}
    </>
  );
}

function CreditsPricingPage(): React.JSX.Element {
  const { t } = useT();
  const [tiers, setTiers] = useState<Array<{ id: string; credits: number; priceCny: number }>>([]);
  const { run } = useError();
  useEffect(() => {
    void run(async () => setTiers(await api.creditsTiers()));
  }, []);
  return (
    <Shell title={t("点数价格说明", { en: "Credits pricing" })}>
      <Card title={t("点数价值", { en: "Credit value" })}>
        <p style={{ fontSize: 14, margin: 0 }}>{t("¥1 = 100 点数，即 1 点数 = 1 分钱。", { en: "¥1 = 100 credits, i.e. 1 credit = ¥0.01." })}</p>
      </Card>
      <Card title={t("充值档位", { en: "Top-up tiers" })}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.id} style={{ borderBottom: "1px solid var(--rdsh-border)" }}>
                <td style={{ padding: "8px 0" }}>¥{tier.priceCny}</td>
                <td style={{ padding: "8px 0", textAlign: "right" }}>{tier.credits.toLocaleString()} {t("点数", { en: "credits" })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title={t("消耗标准", { en: "Usage rate" })}>
        <p style={{ fontSize: 14, margin: 0 }}>{t("云端中转流量：1 点数 = 3 MB（上行 + 下行合计）。本地识别与内网直连不消耗点数。", { en: "Cloud relay traffic: 1 credit = 3 MB (up + down combined). Local ASR and LAN direct connection cost nothing." })}</p>
      </Card>
    </Shell>
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
    .admintbl tr { margin-bottom: 10px; border: 1px solid var(--rdsh-border) !important; border-radius: 10px; padding: 8px 12px !important; background: var(--rdsh-bg-surface); }
    .admintbl td { border: none !important; padding: 5px 0 !important; display: flex !important; justify-content: space-between; align-items: center; gap: 12px; text-align: left !important; }
    .admintbl td::before { content: attr(data-label); font-weight: 600; color: var(--rdsh-fg-muted); flex-shrink: 0; }
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
  const base: React.CSSProperties = { padding: "6px 12px", borderRadius: 6, border: "1px solid var(--rdsh-border)", cursor: "pointer", fontSize: 13 };
  if (variant === "primary") return { ...base, background: "var(--rdsh-primary)", color: "var(--rdsh-fg-on-fill)", borderColor: "var(--rdsh-primary)" };
  if (variant === "danger") return { ...base, background: "var(--rdsh-danger-fill)", color: "var(--rdsh-fg-on-fill)", borderColor: "var(--rdsh-danger-fill)" };
  return { ...base, background: "var(--rdsh-bg-surface)" };
}

function adminTableStyle(): React.CSSProperties {
  return { width: "100%", borderCollapse: "collapse", fontSize: 13 };
}

/** 管理列表过滤器（select / date）的统一样式。 */
function adminFilterStyle(): React.CSSProperties {
  return { padding: "7px 8px", borderRadius: 6, border: "1px solid var(--rdsh-border)", fontSize: 12, background: "var(--rdsh-bg-surface)" };
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
function Pager({ page, total, pageSize, onPage, onPageSize }: { page: number; total: number; pageSize: number; onPage: (p: number) => void; onPageSize: (n: number) => void }): React.JSX.Element | null {
  const { t } = useT();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 13, flexWrap: "wrap" }}>
      <button disabled={page === 0} onClick={() => onPage(page - 1)} style={{ ...adminBtnStyle("ghost"), opacity: page === 0 ? 0.4 : 1 }}>{t("上一页")}</button>
      <span style={{ color: "var(--rdsh-fg-muted)" }}>{page + 1} / {totalPages} · {total} {t("条")}</span>
      <button disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)} style={{ ...adminBtnStyle("ghost"), opacity: page >= totalPages - 1 ? 0.4 : 1 }}>{t("下一页")}</button>
      <span style={{ color: "var(--rdsh-fg-muted)" }}>{t("每页", { en: "Per page" })}</span>
      <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} style={{ padding: "6px 8px", background: "var(--rdsh-bg-surface)" }}>
        {[10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
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
  /** 输入类型（缺省 text；password 隐藏；date 选日期，提交由调用方转 ms）。 */
  type?: "text" | "password" | "date";
}
interface DialogSpec {
  title: string;
  fields: ActionField[];
  danger?: boolean;
  /** 二次确认（feature 16 E5）：输入须等于此值才可提交（如删除时输入用户名）。 */
  confirmText?: string;
  submit: (reason: string, values: Record<string, string>) => void | Promise<void>;
}

/** 危险操作模态框：字段 + 必填原因 + 确认/取消（req R10）；type/confirmText 为 feature 16 扩展。 */
function ActionDialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }): React.JSX.Element {
  const { t } = useT();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.filter((f) => f.value !== undefined).map((f) => [f.key, f.value as string])),
  );
  const [reason, setReason] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [reasonErr, setReasonErr] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmable = spec.confirmText === undefined || confirmInput === spec.confirmText;
  const confirm = (): void => {
    if (reason.trim() === "") {
      setReasonErr(t("请填写操作原因"));
      return;
    }
    if (!confirmable) {
      setReasonErr(spec.confirmText !== undefined ? t("请输入 {name} 以确认", { params: { name: spec.confirmText } }) : "");
      return;
    }
    setReasonErr("");
    setBusy(true);
    void Promise.resolve(spec.submit(reason.trim(), values)).finally(() => setBusy(false));
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--rdsh-scrim-soft)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16, boxSizing: "border-box" }}>
      <div style={{ background: "var(--rdsh-bg-surface)", borderRadius: 12, padding: 20, width: 440, maxWidth: "100%", fontFamily: "system-ui, sans-serif" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>{spec.title}</h3>
        {spec.fields.map((f) => (
          <div key={f.key} style={{ marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{f.label}</label>
            {f.options !== undefined ? (
              <select
                value={values[f.key] ?? f.value ?? f.options[0]?.value ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box", background: "var(--rdsh-bg-surface)" }}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={f.type ?? "text"}
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }}
              />
            )}
          </div>
        ))}
        {spec.confirmText !== undefined && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("输入 {name} 以确认", { params: { name: spec.confirmText } })}</label>
            <input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={spec.confirmText}
              style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }}
            />
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("原因（必填）")}</label>
          <textarea value={reason} onChange={(e) => { setReason(e.target.value); if (reasonErr !== "") setReasonErr(""); }} rows={2} placeholder={t("请填写操作原因")} style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }} />
          {reasonErr !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 12, margin: "4px 0 0" }}>{reasonErr}</p>}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={{ ...adminBtnStyle("ghost"), opacity: busy ? 0.5 : 1 }}>{t("取消")}</button>
          <button disabled={busy || !confirmable} onClick={confirm} style={{ ...adminBtnStyle(spec.danger === true ? "danger" : "primary"), opacity: busy || !confirmable ? 0.5 : 1 }}>{t("确认")}</button>
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
  if (err !== "") return <p style={{ color: "var(--rdsh-danger)" }}>{err}</p>;
  if (d === null) return <p>{t("加载中…")}</p>;
  const u = d.user;
  const ts = (ms: number | null): string => (ms === null ? "—" : new Date(ms).toLocaleString());
  const section = (title: string): React.JSX.Element => <h3 style={{ fontSize: 14, margin: "16px 0 6px", color: "var(--rdsh-fg)" }}>{title}</h3>;
  return (
    <div>
      <button onClick={() => navigate("/admin/users")} style={adminBtnStyle("ghost")}>{t("← 返回用户列表")}</button>
      <h2 style={{ fontSize: 18, margin: "10px 0 4px" }}>{u.name}</h2>
      <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "0 0 8px" }}>{t("ID")} {u.id} · {adminRoleLabel(t, u.role)} · {u.accountStatus}</p>

      {section(t("账号信息"))}
      <table className="admintbl" style={adminTableStyle()}>
        <tbody>
          <tr>
            {adminTd(t("邮箱"), u.email === null ? "—" : `${u.email}${u.emailVerified ? ` (${t("邮✓")})` : ` (${t("邮未验证")})`}`)}
            {adminTd(t("手机号"), u.phone === null ? "—" : `${u.phone}${u.phoneVerified ? ` (${t("手✓")})` : ` (${t("手未验证")})`}`)}
          </tr>
          <tr>
            {adminTd(t("状态"), u.locked ? `${u.accountStatus} · ${t("锁定至 {time}", { params: { time: new Date((u.lockedUntil as number)).toLocaleString() } })}` : u.accountStatus)}
            {adminTd(t("套餐"), `${u.planStatus ?? "—"}${u.planExpiresAt !== null ? ` · ${t("到期 {date}", { params: { date: ts(u.planExpiresAt) } })}` : ""}`)}
          </tr>
          <tr>
            {adminTd(t("主机"), d.quota !== null ? `${d.hostCount} / ${d.quota}` : String(d.hostCount))}
            {adminTd(t("注册时间"), ts(u.createdAt === "" ? null : Date.parse(u.createdAt)))}
          </tr>
          <tr>{adminTd(t("最后登录"), u.lastLoginAt !== null ? ts(u.lastLoginAt) : t("从未登录"))}{adminTd(null, "")}</tr>
        </tbody>
      </table>

      {section(t("订阅历史"))}
      {d.subscriptions.length === 0 ? <p style={{ color: "var(--rdsh-fg-subtle)", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("套餐"), t("状态"), t("开始"), t("到期")].map(adminTh)}</tr></thead>
          <tbody>{d.subscriptions.map((s) => (
            <tr key={s.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("套餐"), s.planId)}{adminTd(t("状态"), s.status)}{adminTd(t("开始"), ts(s.startedAt))}{adminTd(t("到期"), ts(s.expiresAt))}
            </tr>
          ))}</tbody>
        </table>
      )}

      {section(t("订单"))}
      {d.orders.length === 0 ? <p style={{ color: "var(--rdsh-fg-subtle)", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("订单号"), t("套餐"), t("金额"), t("状态"), t("时间")].map(adminTh)}</tr></thead>
          <tbody>{d.orders.map((o) => (
            <tr key={o.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("订单号"), o.id)}{adminTd(t("套餐"), o.planId)}{adminTd(t("金额"), `¥${o.amountCny}`)}{adminTd(t("状态"), o.status)}{adminTd(t("时间"), ts(o.createdAt))}
            </tr>
          ))}</tbody>
        </table>
      )}

      {section(t("支付流水"))}
      {d.payments.length === 0 ? <p style={{ color: "var(--rdsh-fg-subtle)", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("渠道"), t("渠道单号"), t("金额"), t("时间")].map(adminTh)}</tr></thead>
          <tbody>{d.payments.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("渠道"), p.channel)}{adminTd(t("渠道单号"), p.channelOrderId)}{adminTd(t("金额"), `¥${p.amountCny}`)}{adminTd(t("时间"), ts(p.paidAt))}
            </tr>
          ))}</tbody>
        </table>
      )}

      {section(t("审计轨迹"))}
      {d.audit.length === 0 ? <p style={{ color: "var(--rdsh-fg-subtle)", fontSize: 13 }}>{t("（无）")}</p> : (
        <table className="admintbl" style={adminTableStyle()}>
          <thead><tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("时间"), t("事件"), t("来源"), t("IP")].map(adminTh)}</tr></thead>
          <tbody>{d.audit.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
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
    { p: "/nodes", label: t("中继节点", { en: "Relay Nodes" }) },
    { p: "/join-tokens", label: t("入网令牌", { en: "Join Tokens" }) },
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
            <button key={n.p} onClick={() => navigate(n.p === "/" ? "/admin" : `/admin${n.p}`)} style={{ ...adminBtnStyle("ghost"), fontWeight: path === n.p || path.startsWith(n.p + "/") ? 700 : 400, background: path === n.p || path.startsWith(n.p + "/") ? "var(--rdsh-bg-active)" : "var(--rdsh-bg-surface)" }}>
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
      ) : path === "/nodes" ? (
        <AdminNodes isWrite={isWrite} />
      ) : path.startsWith("/nodes/") ? (
        <AdminNodeDetail nodeId={path.slice("/nodes/".length)} isWrite={isWrite} />
      ) : path === "/join-tokens" ? (
        <AdminJoinTokens isWrite={isWrite} />
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
  const [portalInfo, setPortalInfo] = useState<AccountInfo | undefined>(undefined); // undefined=检查中
  useEffect(() => {
    // 管理台登录依赖门户会话：未登录门户 → 直接跳门户登录。
    // 关于 null/undefined：本仓 hub 的 `/api/account` 只有三种出口 —— 401（未认证）、404（用户已删）、
    // 200+完整对象，**不会**返回 200+null 或 204。这里的宽松 `== null` 判断纯属防御
    // （自托管 hub / 反向代理可能不合规，`jsonFetch` 对 204 返回 undefined）；正常链路不可达。
    void api
      .accountInfo({ probe: true })
      .then((info: AccountInfo | null | undefined) => {
        if (info == null) {
          window.location.assign("/portal/login");
          return;
        }
        setPortalInfo(info);
      })
      .catch(() => {
        window.location.assign("/portal/login");
      });
  }, []);
  // 门户会话 30 分钟内验证过 2FA（或可信设备）→ 自动免二次输入；否则落到 TOTP 表单
  useEffect(() => {
    if (portalInfo === undefined || portalInfo.totpEnabled !== true) return;
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
      <div style={{ maxWidth: 360, margin: "40px auto", padding: "24px", border: "1px solid var(--rdsh-border)", borderRadius: 12, fontFamily: "system-ui, sans-serif" }}>
        <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>{t("进入管理后台")}</h2>
        <p style={{ fontSize: 13, color: "var(--rdsh-fg-muted)", margin: "0 0 16px" }}>{t("管理后台需要两步验证（TOTP）才能使用，请先开启 2FA。")}</p>
        <button onClick={() => navigate("/settings/2fa")} style={{ ...adminBtnStyle(), width: "100%", padding: "10px", fontSize: 15 }}>{t("去开启 2FA")}</button>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 360, margin: "40px auto", padding: "24px", border: "1px solid var(--rdsh-border)", borderRadius: 12, fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>{t("进入管理后台")}</h2>
      <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "0 0 16px" }}>{t("管理后台需两步验证（TOTP）。未开启 2FA 的账号请先在「账户与安全」开启。")}</p>
      <input
        value={totp}
        onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        placeholder={t("动态验证码")}
        style={{ width: "100%", padding: "10px", fontSize: 20, letterSpacing: 6, textAlign: "center", marginBottom: 8, boxSizing: "border-box", border: "1px solid var(--rdsh-border)", borderRadius: 6 }}
      />
      <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} /> {t("记住此设备 30 天（下次登录免输动态码）")}
      </label>
      <p style={{ margin: "-4px 0 12px", fontSize: 12, color: "var(--rdsh-fg-subtle)" }}>{t("（自己的常用设备可勾选；公用或他人的设备请勿勾选）")}</p>
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}
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
  if (err !== "") return <p style={{ color: "var(--rdsh-danger)" }}>{err}</p>;
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
        <div key={k} style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--rdsh-fg-muted)" }}>{k}</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function AdminUsers({ isWrite, isAdmin }: { isWrite: boolean; isAdmin: boolean }): React.JSX.Element {
  const { t } = useT();
  const [pageSize, setPageSize] = useState(20);
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loginFrom, setLoginFrom] = useState("");
  const [loginTo, setLoginTo] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [menuUserId, setMenuUserId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [plans, setPlans] = useState<Array<{ id: string; name: string; hosts: number }>>([]);
  const fetch = (query: string, p: number): void => {
    adminApi
      .users({
        q: query !== "" ? query : undefined,
        role: roleFilter !== "" ? roleFilter : undefined,
        status: statusFilter !== "" ? statusFilter : undefined,
        lastLoginFrom: loginFrom !== "" ? new Date(`${loginFrom}T00:00:00`).getTime() : undefined,
        lastLoginTo: loginTo !== "" ? new Date(`${loginTo}T23:59:59.999`).getTime() : undefined,
        limit: pageSize,
        offset: p * pageSize,
      })
      .then((r) => { setUsers(r.users); setTotal(r.total); })
      .catch(() => { setUsers([]); setTotal(0); });
  };
  const reload = (): void => fetch(q, page);
  useEffect(() => {
    adminApi.config().then((c) => setPlans(c.plans)).catch(() => setPlans([]));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => fetch(q, page), 300);
    return () => clearTimeout(timer);
  }, [q, page, pageSize, roleFilter, statusFilter, loginFrom, loginTo]);
  useEffect(() => {
    if (menuUserId === null) return;
    const close = (): void => setMenuUserId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuUserId]);
  const open = (u: AdminUserRow, title: string, action: string, fields: ActionField[] = [], danger = false, confirmText?: string): void => {
    setDialog({
      title,
      fields,
      danger,
      confirmText,
      submit: (reason, values) =>
        adminApi
          .userAction(u.id, action, { reason, ...(action === "reset-password" ? { password: values.password ?? "" } : {}), ...(action === "set-role" ? { role: values.role ?? "" } : {}) })
          .then(() => {
            setMsg("ok");
            setDialog(null);
            reload();
          })
          .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  /** 延长试用：天数 → grant-trial（顺延，不吞剩余）。 */
  const grantTrial = (u: AdminUserRow): void => {
    setDialog({
      title: `${t("延长试用")} · ${u.name}`,
      fields: [{ key: "days", label: t("天数"), value: "7" }],
      submit: (reason, values) =>
        adminApi
          .userAction(u.id, "grant-trial", { reason, days: Number(values.days) })
          .then(() => { setMsg("ok"); setDialog(null); reload(); })
          .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  /** 赠送订阅：档位 + 天数 + 金额（0=赠送）→ grant-subscription。 */
  const grantSubscription = (u: AdminUserRow): void => {
    setDialog({
      title: `${t("赠送订阅")} · ${u.name}`,
      fields: [
        {
          key: "planId",
          label: t("套餐"),
          value: plans[0]?.id ?? "pro",
          options: plans.map((p) => ({ value: p.id, label: `${p.name}（${p.hosts} 台）` })),
        },
        { key: "days", label: t("时长（天）"), value: "30" },
        { key: "amountCny", label: t("金额（元，0=赠送）"), value: "0" },
      ],
      submit: (reason, values) =>
        adminApi
          .userAction(u.id, "grant-subscription", { reason, planId: values.planId ?? "", days: Number(values.days), amountCny: Number(values.amountCny) })
          .then(() => { setMsg("ok"); setDialog(null); reload(); })
          .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  /** 设为永久无限：plan=null（后端校验：null 不得带到期）。 */
  const grantUnlimited = (u: AdminUserRow): void => {
    setDialog({
      title: `${t("设为永久无限")} · ${u.name}`,
      fields: [],
      danger: true,
      confirmText: u.name,
      submit: (reason) =>
        adminApi
          .userAction(u.id, "plan", { reason, planStatus: null })
          .then(() => { setMsg("ok"); setDialog(null); reload(); })
          .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  const fmtLogin = (ms: number | null): string => (ms === null ? t("从未登录") : new Date(ms).toLocaleString());
  /** 状态列：临时锁定 / 账号状态 + 邮箱/手机验证徽标（R4/R5）。 */
  const statusCell = (u: AdminUserRow): React.JSX.Element => {
    const stateParts: string[] = [];
    if (u.locked) stateParts.push(t("锁定至 {time}", { params: { time: new Date((u.lockedUntil as number)).toLocaleTimeString() } }));
    if (u.accountStatus !== "active") stateParts.push(u.accountStatus);
    if (stateParts.length === 0) stateParts.push(t("正常"));
    const badges: string[] = [];
    if (u.email !== null && u.email !== "") badges.push(u.emailVerified ? t("邮✓") : t("邮未验证"));
    if (u.phone !== null && u.phone !== "") badges.push(u.phoneVerified ? t("手✓") : t("手未验证"));
    return (
      <span>
        {stateParts.join(" · ")}
        {badges.length > 0 ? <span style={{ color: "var(--rdsh-fg-subtle)", fontSize: 11 }}>{` (${badges.join(" / ")})`}</span> : null}
      </span>
    );
  };
  const list = users ?? [];
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        {isWrite && <button onClick={() => setShowCreate(true)} style={adminBtnStyle("primary")}>{t("+ 新建用户")}</button>}
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={t("搜索 用户名/邮箱/手机号")} style={{ padding: "8px 10px", width: "100%", maxWidth: 300, boxSizing: "border-box" }} />
        <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(0); }} style={adminFilterStyle()} title={t("角色")}>
          <option value="">{t("角色")}：{t("全部")}</option>
          <option value="user">{t("普通用户")}</option>
          <option value="readonly">{t("只读")}</option>
          <option value="operator">{t("运营")}</option>
          <option value="admin">{t("管理员", { en: "Admin" })}</option>
        </select>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }} style={adminFilterStyle()} title={t("状态")}>
          <option value="">{t("状态")}：{t("全部")}</option>
          <option value="active">{t("正常")}</option>
          <option value="banned">{t("封禁")}</option>
          <option value="locked">{t("锁定")}</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--rdsh-fg-muted)" }}>
          {t("登录时间")}
          <input type="date" value={loginFrom} onChange={(e) => { setLoginFrom(e.target.value); setPage(0); }} style={adminFilterStyle()} />
          <span>~</span>
          <input type="date" value={loginTo} onChange={(e) => { setLoginTo(e.target.value); setPage(0); }} style={adminFilterStyle()} />
        </label>
      </div>
      {msg !== "" && <p style={{ fontSize: 12, color: "var(--rdsh-link)" }}>{msg}</p>}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("用户"), t("角色"), t("状态"), t("主机"), t("套餐"), t("最后登录"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("用户"), u.name)}
              {adminTd(t("角色"), <span style={{ color: "var(--rdsh-fg-muted)" }}>{adminRoleLabel(t, u.role)}</span>)}
              {adminTd(t("状态"), statusCell(u))}
              {adminTd(t("主机"), u.hostCount)}
              {adminTd(t("套餐"), u.planStatus ?? "—")}
              {adminTd(t("最后登录"), fmtLogin(u.lastLoginAt))}
              {adminTd(null, (isWrite || isAdmin) && (
                <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuUserId(menuUserId === u.id ? null : u.id); }}
                    style={adminBtnStyle("ghost")}
                    title={t("更多操作")}
                  >⋯</button>
                  {menuUserId === u.id && (
                    <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, background: "var(--rdsh-bg-surface)", border: "1px solid var(--rdsh-border)", borderRadius: 8, boxShadow: "var(--rdsh-shadow)", zIndex: 20, minWidth: 130, padding: 4 }} onClick={(e) => e.stopPropagation()}>
                      <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); navigate(`/admin/users/${u.id}`); }}>{t("详情")}</button>
                      {isWrite && u.accountStatus !== "banned" && <button style={menuItemStyle(true)} onClick={() => { setMenuUserId(null); open(u, t("封禁"), "ban", [], true); }}>{t("封禁")}</button>}
                      {isWrite && u.accountStatus === "banned" && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("解封"), "unban"); }}>{t("解封")}</button>}
                      {isWrite && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("重置密码"), "reset-password", [{ key: "password", label: t("新密码（≥8 位）"), type: "password" }]); }}>{t("重置密码")}</button>}
                      {isWrite && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("重置2FA"), "reset-2fa", [], true); }}>{t("重置2FA")}</button>}
                      {isWrite && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); grantTrial(u); }}>{t("延长试用")}</button>}
                      {isAdmin && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); grantSubscription(u); }}>{t("赠送订阅")}</button>}
                      {isWrite && <button style={menuItemStyle(true)} onClick={() => { setMenuUserId(null); grantUnlimited(u); }}>{t("永久无限")}</button>}
                      {isAdmin && <button style={menuItemStyle()} onClick={() => { setMenuUserId(null); open(u, t("改角色"), "set-role", [{ key: "role", label: t("角色"), value: u.role, options: [{ value: "user", label: t("普通用户") }, { value: "readonly", label: t("只读") }, { value: "operator", label: t("运营") }, { value: "admin", label: t("管理员", { en: "Admin" }) }] }]); }}>{t("改角色")}</button>}
                      {isAdmin && <button style={menuItemStyle(true)} onClick={() => { setMenuUserId(null); open(u, t("删除"), "delete", [], true, u.name); }}>{t("删除")}</button>}
                    </div>
                  )}
                </div>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} total={total} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(0); }} />
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
      {showCreate && <CreateUserDialog isAdmin={isAdmin} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); setMsg("ok"); reload(); }} />}
    </div>
  );
}

/** 新建用户对话框（feature 16 R1/R2）：标识 + 角色 + 初始密码（默认强制首登改密）+ 可选到期 + 原因。 */
function CreateUserDialog({ isAdmin, onClose, onCreated }: { isAdmin: boolean; onClose: () => void; onCreated: () => void }): React.JSX.Element {
  const { t } = useT();
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState("user");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [trialDays, setTrialDays] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const roleOptions = isAdmin
    ? [{ value: "user", label: t("普通用户") }, { value: "readonly", label: t("只读") }, { value: "operator", label: t("运营") }, { value: "admin", label: t("管理员", { en: "Admin" }) }]
    : [{ value: "user", label: t("普通用户") }, { value: "readonly", label: t("只读") }];
  const create = (): void => {
    setErr("");
    if (identifier.trim() === "") { setErr(t("请输入登录标识")); return; }
    if (password.length < 8) { setErr(t("密码至少 8 位")); return; }
    if (password !== password2) { setErr(t("两次输入的密码不一致")); return; }
    if (reason.trim() === "") { setErr(t("请填写操作原因")); return; }
    const days = trialDays.trim() === "" ? null : Number(trialDays);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) { setErr(t("试用天数须为 1–3650 的整数，或留空表示永久")); return; }
    setBusy(true);
    adminApi
      .createUser({ identifier: identifier.trim(), password, role: role as "user" | "readonly" | "operator" | "admin", mustChange, ...(days !== null ? { trialDays: days } : {}), reason: reason.trim() })
      .then(onCreated)
      .catch((e: unknown) => { setErr(e instanceof Error ? e.message : "create failed"); setBusy(false); });
  };
  const field = (label: React.ReactNode, node: React.ReactNode): React.JSX.Element => (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{label}</label>
      {node}
    </div>
  );
  // 字号由 theme.css 统一声明（窄屏 16px，避免 iOS 聚焦输入框时自动放大整页）
  const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", boxSizing: "border-box" };
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--rdsh-scrim-soft)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16, boxSizing: "border-box" }}>
      <div style={{ background: "var(--rdsh-bg-surface)", borderRadius: 12, padding: 20, width: 440, maxWidth: "100%", fontFamily: "system-ui, sans-serif" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>{t("新建用户")}</h3>
        {field(t("登录标识（用户名 / 邮箱 / +86 手机）"), <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="zhangsan@corp.com" style={inputStyle} />)}
        {field(t("角色"), (
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ ...inputStyle, background: "var(--rdsh-bg-surface)" }}>
            {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ))}
        {field(t("初始密码（≥8 位）"), <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />)}
        {field(t("确认密码"), <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} style={inputStyle} />)}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 10, color: "var(--rdsh-fg)" }}>
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
          {t("强制首次登录修改密码")}
        </label>
        {field(t("试用天数（留空 = 永久无限）"), <input type="text" inputMode="numeric" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} placeholder="7" style={inputStyle} />)}
        {field(t("原因（必填）"), <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder={t("请填写操作原因")} style={{ ...inputStyle, fontFamily: "inherit" }} />)}
        {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 12, margin: "0 0 8px" }}>{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={{ ...adminBtnStyle("ghost"), opacity: busy ? 0.5 : 1 }}>{t("取消")}</button>
          <button onClick={create} disabled={busy} style={{ ...adminBtnStyle("primary"), opacity: busy ? 0.5 : 1 }}>{t("创建")}</button>
        </div>
      </div>
    </div>
  );
}

function AdminHosts({ isWrite }: { isWrite: boolean }): React.JSX.Element {
  const { t } = useT();
  const [pageSize, setPageSize] = useState(20);
  const [hosts, setHosts] = useState<AdminHostRow[] | null>(null);
  const [q, setQ] = useState("");
  const [onlineFilter, setOnlineFilter] = useState("");
  const [e2eeFilter, setE2eeFilter] = useState("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const fetch = (query: string, p: number): void => {
    adminApi
      .hosts({
        q: query !== "" ? query : undefined,
        online: onlineFilter !== "" ? onlineFilter : undefined,
        e2ee: e2eeFilter !== "" ? e2eeFilter : undefined,
        createdFrom: createdFrom !== "" ? new Date(`${createdFrom}T00:00:00`).getTime() : undefined,
        createdTo: createdTo !== "" ? new Date(`${createdTo}T23:59:59.999`).getTime() : undefined,
        limit: pageSize,
        offset: p * pageSize,
      })
      .then((r) => { setHosts(r.hosts); setTotal(r.total); })
      .catch(() => { setHosts([]); setTotal(0); });
  };
  const reload = (): void => fetch(q, page);
  useEffect(() => {
    const timer = setTimeout(() => fetch(q, page), 300);
    return () => clearTimeout(timer);
  }, [q, page, pageSize, onlineFilter, e2eeFilter, createdFrom, createdTo]);
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
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={t("搜索 主机名/归属用户")} style={{ padding: "8px 10px", width: "100%", maxWidth: 300, boxSizing: "border-box" }} />
        <select value={onlineFilter} onChange={(e) => { setOnlineFilter(e.target.value); setPage(0); }} style={adminFilterStyle()} title={t("在线")}>
          <option value="">{t("在线")}：{t("全部")}</option>
          <option value="online">{t("在线")}</option>
          <option value="offline">{t("离线")}</option>
        </select>
        <select value={e2eeFilter} onChange={(e) => { setE2eeFilter(e.target.value); setPage(0); }} style={adminFilterStyle()} title="E2EE">
          <option value="">E2EE：{t("全部")}</option>
          <option value="yes">{t("是")}</option>
          <option value="no">{t("否")}</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--rdsh-fg-muted)" }}>
          {t("加入时间")}
          <input type="date" value={createdFrom} onChange={(e) => { setCreatedFrom(e.target.value); setPage(0); }} style={adminFilterStyle()} />
          <span>~</span>
          <input type="date" value={createdTo} onChange={(e) => { setCreatedTo(e.target.value); setPage(0); }} style={adminFilterStyle()} />
        </label>
      </div>
      {msg !== "" && <p style={{ fontSize: 12, color: "var(--rdsh-link)" }}>{msg}</p>}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("主机名"), t("归属"), t("在线"), t("E2EE"), t("加入时间"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(hosts ?? []).map((h) => (
            <tr key={h.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("主机名"), h.name)}
              {adminTd(t("归属"), <span style={{ color: "var(--rdsh-fg-muted)" }}>{h.ownerName}</span>)}
              {adminTd(t("在线"), <span style={{ color: h.online ? "var(--rdsh-success)" : "var(--rdsh-fg-subtle)", fontSize: 14 }}>{h.online ? "●" : "○"}</span>)}
              {adminTd(t("E2EE"), h.e2eePublicKey != null ? "🛡" : "—")}
              {adminTd(t("加入时间"), new Date(h.createdAt).toLocaleDateString())}
              {adminTd(null, isWrite && <button onClick={() => revoke(h)} style={adminBtnStyle("danger")}>{t("吊销")}</button>)}
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} total={total} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(0); }} />
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function fmtBps(bps: number): string {
  if (bps <= 0) return "—";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

function AdminNodes({ isWrite }: { isWrite: boolean }): React.JSX.Element {
  const { t } = useT();
  const [nodes, setNodes] = useState<AdminNodeRow[] | null>(null);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addHost, setAddHost] = useState("");
  const [addTokenId, setAddTokenId] = useState("");
  const [joinTokens, setJoinTokens] = useState<Array<{ id: string; name: string; tokenPlaintext: string; revokedAt: number | null }>>([]);
  const [generated, setGenerated] = useState<{ command: string; config: string } | null>(null);
  const [addListen, setAddListen] = useState("127.0.0.1:8444");
  const [tlsMode, setTlsMode] = useState<"behindProxy" | "acme" | "tls">("behindProxy");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [tlsCert, setTlsCert] = useState("");
  const [tlsKey, setTlsKey] = useState("");
  const reload = (): void => {
    adminApi.nodes({ limit: pageSize, offset: page * pageSize }).then((r) => { setNodes(r.nodes); setTotal(r.total); }).catch(() => { setNodes([]); setTotal(0); });
  };
  useEffect(reload, [page, pageSize]);
  useEffect(() => {
    // 打开「添加」面板时拉取可用入网令牌，供下拉选择。
    if (!addOpen) return;
    adminApi.relayJoinTokens().then((r) => setJoinTokens(r.tokens)).catch(() => setJoinTokens([]));
  }, [addOpen]);
  const generate = (): void => {
    const name = addName.trim();
    if (name === "") { setMsg(t("请填写名称")); return; }
    // 名称/host 会直接拼进 shell 命令：拒绝空白与 shell 元字符，避免命令被拼坏或注入。
    if (/[\s;&|$`"'<>(){}[\]\\]/.test(name)) { setMsg(t("名称含不支持的字符")); return; }
    if (addTokenId === "") { setMsg(t("请选择入网令牌")); return; }
    const tok = joinTokens.find((x) => x.id === addTokenId);
    if (tok === undefined) { setMsg(t("入网令牌不存在")); return; }
    const host = addHost.trim();
    // host 只接受裸主机名（字母/数字/点/连字符），不允许 scheme:// 或路径。
    if (host !== "" && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) { setMsg(t("主机域名格式不正确")); return; }
    // listen 为空会触发 Go 默认 0.0.0.0:443，反代模式下会意外公网暴露明文，故拦截。
    if (addListen.trim() === "") { setMsg(t("请填写监听地址", { en: "Listen address is required" })); return; }
    const relayUrl = host !== "" ? `https://${host}` : "https://{hostname}";
    const hubUrl = window.location.origin;
    const command = host !== ""
      ? `rdsh-relay join ${hubUrl} --join-token ${tok.tokenPlaintext} --relay-url ${relayUrl} --name ${name}`
      : `rdsh-relay join ${hubUrl} --join-token ${tok.tokenPlaintext} --name ${name}`;
    // TLS 三选一（relay validate() 强制）：反代终止 / ACME / 手动证书。
    if (tlsMode === "tls" && (tlsCert.trim() === "" || tlsKey.trim() === "")) {
      setMsg(t("请填写证书与私钥路径", { en: "Certificate and key paths are required" }));
      return;
    }
    const tlsField: Record<string, unknown> = tlsMode === "behindProxy"
      ? { behindProxy: true }
      : tlsMode === "acme"
        ? { acme: { enabled: true, email: acmeEmail.trim() } }
        : { tls: { cert: tlsCert.trim(), key: tlsKey.trim() } };
    const config = JSON.stringify({ hubUrl, relayUrl, name, listen: addListen.trim(), joinToken: tok.tokenPlaintext, ...tlsField }, null, 2);
    setGenerated({ command, config });
  };
  const copyText = (text: string): void => {
    if (navigator.clipboard !== undefined) {
      void navigator.clipboard.writeText(text).then(() => setMsg(t("已复制"))).catch(() => setMsg(t("自动复制失败，请手动复制")));
    } else {
      setMsg(t("请手动复制"));
    }
  };
  const revoke = (n: AdminNodeRow): void => {
    setDialog({
      title: `${t("吊销")} · ${n.name}`,
      fields: [],
      danger: true,
      submit: (reason) => adminApi.revokeNode(n.id, reason).then(() => { setMsg("ok"); setDialog(null); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  const rename = (n: AdminNodeRow): void => {
    setDialog({
      title: `${t("重命名")} · ${n.name}`,
      fields: [{ key: "name", label: t("名称"), value: n.name }],
      submit: (reason, values) => adminApi.renameNode(n.id, values.name ?? "", reason).then(() => { setMsg("ok"); setDialog(null); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  const toggleEnable = (n: AdminNodeRow): void => {
    const act = n.enabled ? adminApi.disableNode.bind(adminApi) : adminApi.enableNode.bind(adminApi);
    act(n.id, "toggle").then(() => { setMsg("ok"); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed"));
  };
  return (
    <div>
      <div style={{ marginBottom: 10, display: "flex", gap: 8, alignItems: "center" }}>
        {isWrite && <button onClick={() => setAddOpen((v) => !v)} style={adminBtnStyle()}>{t("添加中继节点", { en: "Add Relay Node" })}</button>}
        {msg !== "" && <span style={{ fontSize: 12, color: "var(--rdsh-link)" }}>{msg}</span>}
      </div>
      {addOpen && (
        <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: 14, marginBottom: 12, background: "var(--rdsh-bg-surface)" }}>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("名称", { en: "Name" })}</label>
            <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="sg-01" style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("主机域名（可选，留空用 {hostname}）", { en: "Host name (optional; blank = {hostname})" })}</label>
            <input value={addHost} onChange={(e) => setAddHost(e.target.value)} placeholder="sg01.tunnel.rdsh.cn" style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("入网令牌", { en: "Join token" })}</label>
            <select value={addTokenId} onChange={(e) => setAddTokenId(e.target.value)} style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box", background: "var(--rdsh-bg-surface)" }}>
              <option value="">{t("请选择入网令牌", { en: "Select a join token" })}</option>
              {joinTokens.filter((x) => x.revokedAt === null).map((x) => (
                <option key={x.id} value={x.id}>{x.tokenPlaintext}（{x.name}）</option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("监听地址", { en: "Listen address" })}</label>
            <input value={addListen} onChange={(e) => setAddListen(e.target.value)} placeholder="127.0.0.1:8444" style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("TLS 模式", { en: "TLS mode" })}</label>
            <select value={tlsMode} onChange={(e) => { const m = e.target.value as "behindProxy" | "acme" | "tls"; setTlsMode(m); setAddListen(m === "behindProxy" ? "127.0.0.1:8444" : "0.0.0.0:443"); }} style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box", background: "var(--rdsh-bg-surface)" }}>
              <option value="behindProxy">{t("反向代理终止 TLS", { en: "Reverse proxy terminates TLS" })}</option>
              <option value="acme">{t("ACME 自动签发", { en: "ACME auto-issue" })}</option>
              <option value="tls">{t("手动证书", { en: "Manual certificate" })}</option>
            </select>
          </div>
          {tlsMode === "acme" && (
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("ACME 邮箱", { en: "ACME email" })}</label>
              <input value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} placeholder="ops@example.com" style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }} />
            </div>
          )}
          {tlsMode === "tls" && (
            <>
              <div style={{ marginBottom: 8 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("证书路径", { en: "Certificate path" })}</label>
                <input value={tlsCert} onChange={(e) => setTlsCert(e.target.value)} placeholder="/etc/rdsh/fullchain.pem" style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--rdsh-fg-muted)", marginBottom: 4 }}>{t("私钥路径", { en: "Private key path" })}</label>
                <input value={tlsKey} onChange={(e) => setTlsKey(e.target.value)} placeholder="/etc/rdsh/privkey.pem" style={{ width: "100%", padding: "8px 10px", boxSizing: "border-box" }} />
              </div>
            </>
          )}
          <button onClick={generate} style={adminBtnStyle()}>{t("生成接入信息", { en: "Generate" })}</button>
        </div>
      )}
      {generated !== null && (
        <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: 14, marginBottom: 12, background: "var(--rdsh-bg-surface)" }}>
          <p style={{ fontSize: 13, margin: "0 0 6px" }}>{t("接入命令（复制到 relay 机器执行）：", { en: "Join command (run on the relay host):" })}</p>
          <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", background: "var(--rdsh-bg-subtle)", padding: 8, borderRadius: 6 }}>{generated.command}</code>
          <div style={{ marginTop: 6 }}><button onClick={() => copyText(generated.command)} style={adminBtnStyle("ghost")}>{t("复制命令", { en: "Copy command" })}</button></div>
          <p style={{ fontSize: 13, margin: "12px 0 6px" }}>{t("relay.json（写入 relay 数据目录）：", { en: "relay.json (write into the relay data dir):" })}</p>
          <pre style={{ fontSize: 12, wordBreak: "break-all", margin: 0, background: "var(--rdsh-bg-subtle)", padding: 8, borderRadius: 6, overflow: "auto" }}>{generated.config}</pre>
          <div style={{ marginTop: 6 }}><button onClick={() => copyText(generated.config)} style={adminBtnStyle("ghost")}>{t("复制配置", { en: "Copy config" })}</button></div>
          <div style={{ marginTop: 8 }}><button onClick={() => setGenerated(null)} style={adminBtnStyle("ghost")}>{t("关闭", { en: "Close" })}</button></div>
        </div>
      )}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("状态", { en: "Status" }), t("对外地址", { en: "Advertise URL" }), t("IP", { en: "IP" }), t("主机数", { en: "Hosts" }), t("活跃会话", { en: "Sessions" }), t("当前带宽", { en: "Bandwidth" }), t("最后心跳", { en: "Last heartbeat" }), t("操作", { en: "Actions" })].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(nodes ?? []).map((n) => (
            <tr key={n.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("状态", { en: "Status" }), (
                <span style={{ color: n.status === "online" ? "var(--rdsh-success)" : "var(--rdsh-fg-subtle)", fontSize: 14 }}>
                  {n.status === "online" ? "●" : n.status === "draining" ? "◐" : "○"}
                </span>
              ))}
              {adminTd(t("对外地址", { en: "Advertise URL" }), <button onClick={() => navigate(`/admin/nodes/${encodeURIComponent(n.id)}`)} style={{ ...adminBtnStyle("ghost"), padding: 0 }}>{n.advertiseUrl}</button>)}
              {adminTd(t("IP", { en: "IP" }), <span style={{ color: "var(--rdsh-fg-muted)" }}>{n.lastIp ?? "—"}</span>)}
              {adminTd(t("主机数", { en: "Hosts" }), String(n.hostCount))}
              {adminTd(t("活跃会话", { en: "Sessions" }), String(n.bandwidth?.activeStreams ?? 0))}
              {adminTd(t("当前带宽", { en: "Bandwidth" }), fmtBps(n.bandwidth?.currentBps ?? 0))}
              {adminTd(t("最后心跳", { en: "Last heartbeat" }), n.lastHeartbeat > 0 ? new Date(n.lastHeartbeat).toLocaleString() : "—")}
              {adminTd(null, isWrite && (
                <span style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => toggleEnable(n)} style={adminBtnStyle("ghost")}>{n.enabled ? t("禁用", { en: "Disable" }) : t("启用", { en: "Enable" })}</button>
                  <button onClick={() => rename(n)} style={adminBtnStyle("ghost")}>{t("重命名", { en: "Rename" })}</button>
                  <button onClick={() => revoke(n)} style={adminBtnStyle("danger")}>{t("吊销", { en: "Revoke" })}</button>
                </span>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} total={total} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(0); }} />
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function AdminJoinTokens({ isWrite }: { isWrite: boolean }): React.JSX.Element {
  const { t } = useT();
  const [tokens, setTokens] = useState<Array<{ id: string; name: string; createdAt: number; revokedAt: number | null; joinCount: number; tokenTail4: string; tokenPlaintext: string }> | null>(null);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [events, setEvents] = useState<Array<{ id: string; nodeId: string; srcIp: string | null; at: number }> | null>(null);
  const reload = (): void => {
    adminApi.relayJoinTokens().then((r) => setTokens(r.tokens)).catch(() => setTokens([]));
  };
  useEffect(reload, []);
  const create = (): void => {
    // 名称可空：后端自动用「当前年月日时分秒」生成默认名。
    adminApi.createRelayJoinToken(addName.trim()).then((r) => { setCreated({ name: r.name, token: r.token }); setAddName(""); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed"));
  };
  const rename = (tok: { id: string; name: string }): void => {
    setDialog({
      title: `${t("改名")} · ${tok.name}`,
      fields: [{ key: "name", label: t("名称"), value: tok.name }],
      submit: (reason, values) =>
        adminApi.renameRelayJoinToken(tok.id, values.name ?? "", reason).then(() => { setMsg("ok"); setDialog(null); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  const copy = (id: string): void => {
    adminApi.relayJoinTokenPlaintext(id).then(async (r) => {
      try {
        if (navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(r.token);
        } else {
          // 非安全环境回退：execCommand
          const ta = document.createElement("textarea");
          ta.value = r.token;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setMsg(t("已复制"));
      } catch {
        setMsg(t("自动复制失败，请手动复制"));
      }
      setCopied(r.token); // 始终展示明文，供手动复制
    }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed"));
  };
  const revoke = (tok: { id: string; name: string }): void => {
    adminApi.revokeRelayJoinToken(tok.id, "revoke").then(() => { setMsg("ok"); reload(); }).catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed"));
  };
  const showEvents = (id: string): void => {
    adminApi.relayJoinTokenEvents(id).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  };
  return (
    <div>
      <div style={{ marginBottom: 10, display: "flex", gap: 8, alignItems: "center" }}>
        {isWrite && (
          <div style={{ display: "flex", gap: 8 }}>
            <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder={t("令牌名称（留空自动生成）", { en: "Token name (blank = auto)" })} style={{ padding: "6px 10px" }} />
            <button onClick={create} style={adminBtnStyle()}>{t("生成令牌", { en: "Generate Token" })}</button>
          </div>
        )}
        {msg !== "" && <span style={{ fontSize: 12, color: "var(--rdsh-link)" }}>{msg}</span>}
      </div>
      {created !== null && (
        <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: 14, marginBottom: 12, background: "var(--rdsh-bg-surface)" }}>
          <p style={{ fontSize: 13, margin: "0 0 6px" }}>{t("入网令牌（可再次复制）：", { en: "Join token (re-copyable):" })}</p>
          <code style={{ fontSize: 12, wordBreak: "break-all" }}>{created.token}</code>
          <div style={{ marginTop: 8 }}><button onClick={() => setCreated(null)} style={adminBtnStyle("ghost")}>{t("关闭", { en: "Close" })}</button></div>
        </div>
      )}
      {copied !== null && (
        <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: 14, marginBottom: 12, background: "var(--rdsh-bg-surface)" }}>
          <p style={{ fontSize: 13, margin: "0 0 6px" }}>{t("入网令牌（可手动复制）：", { en: "Join token (copy manually if needed):" })}</p>
          <code style={{ fontSize: 12, wordBreak: "break-all" }}>{copied}</code>
          <div style={{ marginTop: 8 }}><button onClick={() => setCopied(null)} style={adminBtnStyle("ghost")}>{t("关闭", { en: "Close" })}</button></div>
        </div>
      )}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("名称", { en: "Name" }), t("令牌(尾4位)", { en: "Token (last 4)" }), t("已入网", { en: "Joined" }), t("状态", { en: "Status" }), t("操作", { en: "Actions" })].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(tokens ?? []).map((tok) => (
            <tr key={tok.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("名称", { en: "Name" }), tok.name)}
              {adminTd(t("令牌(尾4位)", { en: "Token (last 4)" }), `…${tok.tokenTail4}`)}
              {adminTd(t("已入网", { en: "Joined" }), String(tok.joinCount))}
              {adminTd(t("状态", { en: "Status" }), tok.revokedAt === null ? t("有效", { en: "Active" }) : t("已吊销", { en: "Revoked" }))}
              {adminTd(null, isWrite && (
                <span style={{ display: "flex", gap: 6 }}>
                  {tok.revokedAt === null && <button onClick={() => copy(tok.id)} style={adminBtnStyle("ghost")}>{t("复制", { en: "Copy" })}</button>}
                  {tok.revokedAt === null && <button onClick={() => revoke(tok)} style={adminBtnStyle("danger")}>{t("吊销", { en: "Revoke" })}</button>}
                  <button onClick={() => rename(tok)} style={adminBtnStyle("ghost")}>{t("改名", { en: "Rename" })}</button>
                  <button onClick={() => showEvents(tok.id)} style={adminBtnStyle("ghost")}>{t("审计记录", { en: "Audit" })}</button>
                </span>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {dialog !== null && <ActionDialog spec={dialog} onClose={() => setDialog(null)} />}
      {events !== null && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13 }}>{t("入网记录", { en: "Join events" })}</p>
          <table className="admintbl" style={adminTableStyle()}>
            <thead><tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("节点", { en: "Node" }), t("来源 IP", { en: "Source IP" }), t("时间", { en: "Time" })].map(adminTh)}</tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
                  {adminTd(t("节点", { en: "Node" }), e.nodeId.slice(0, 8))}
                  {adminTd(t("来源 IP", { en: "Source IP" }), e.srcIp ?? "—")}
                  {adminTd(t("时间", { en: "Time" }), new Date(e.at).toLocaleString())}
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => setEvents(null)} style={adminBtnStyle("ghost")}>{t("关闭", { en: "Close" })}</button>
        </div>
      )}
    </div>
  );
}

function AdminNodeDetail({ nodeId, isWrite }: { nodeId: string; isWrite: boolean }): React.JSX.Element {
  const { t } = useT();
  const [data, setData] = useState<{ node: AdminNodeRow; hosts: Array<{ id: string; name: string; ownerId: number; online: boolean }> } | null>(null);
  useEffect(() => {
    adminApi.nodeDetail(nodeId).then(setData).catch(() => setData(null));
  }, [nodeId]);
  if (data === null) return <div style={{ padding: 20, fontFamily: "system-ui, sans-serif" }}>{t("加载中…")}</div>;
  const n = data.node;
  const b = n.bandwidth;
  return (
    <div>
      <button onClick={() => navigate("/admin/nodes")} style={adminBtnStyle("ghost")}>{t("← 返回节点列表", { en: "← Back to nodes" })}</button>
      <h3 style={{ fontSize: 16, margin: "12px 0 8px" }}>{n.name}</h3>
      <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: 14, marginBottom: 12, background: "var(--rdsh-bg-surface)" }}>
        <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: 0 }}>{t("对外地址", { en: "Advertise URL" })}：{n.advertiseUrl}</p>
        <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "4px 0 0" }}>nodeId：{n.id}</p>
        <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "4px 0 0" }}>{t("状态", { en: "Status" })}：{n.status} · {t("优先级", { en: "Weight" })} {n.weight} · {t("容量", { en: "Capacity" })} {n.capacity === 0 ? "∞" : n.capacity}</p>
        <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "4px 0 0" }}>{t("最后心跳", { en: "Last heartbeat" })}：{n.lastHeartbeat > 0 ? new Date(n.lastHeartbeat).toLocaleString() : "—"}</p>
      </div>
      <div style={{ border: "1px solid var(--rdsh-border)", borderRadius: 10, padding: 14, marginBottom: 12, background: "var(--rdsh-bg-surface)" }}>
        <p style={{ fontSize: 12, margin: "0 0 4px" }}>{t("实时负载", { en: "Live load" })}</p>
        <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "0 0 4px" }}>{t("连接数", { en: "Connections" })}：{b?.connections ?? 0} · {t("活跃会话", { en: "Active sessions" })}：{b?.activeStreams ?? 0}</p>
        <p style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", margin: "0 0 4px" }}>{t("当前带宽", { en: "Current" })}：{fmtBps(b?.currentBps ?? 0)} · 5m {fmtBps(b?.avg5mBps ?? 0)} · 1h {fmtBps(b?.avg1hBps ?? 0)} · 24h {fmtBps(b?.avg24hBps ?? 0)}</p>
      </div>
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("主机名", { en: "Host" }), t("归属", { en: "Owner" }), t("在线", { en: "Online" })].map(adminTh)}</tr>
        </thead>
        <tbody>
          {data.hosts.map((h) => (
            <tr key={h.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("主机名", { en: "Host" }), h.name)}
              {adminTd(t("归属", { en: "Owner" }), String(h.ownerId))}
              {adminTd(t("在线", { en: "Online" }), <span style={{ color: h.online ? "var(--rdsh-success)" : "var(--rdsh-fg-subtle)", fontSize: 14 }}>{h.online ? "●" : "○"}</span>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminBilling({ isWrite, isAdmin }: { isWrite: boolean; isAdmin: boolean }): React.JSX.Element {
  const { t } = useT();
  const [orders, setOrders] = useState<AdminOrderRow[] | null>(null);
  const [payments, setPayments] = useState<AdminPaymentRow[] | null>(null);
  const [msg, setMsg] = useState("");
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [orderQ, setOrderQ] = useState("");
  const [orderPlan, setOrderPlan] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [plans, setPlans] = useState<Array<{ id: string; name: string }>>([]);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const fetchOrders = (): void => {
    adminApi.orders({
      q: orderQ.trim() !== "" ? orderQ.trim() : undefined,
      planId: orderPlan !== "" ? orderPlan : undefined,
      status: orderStatus !== "" ? orderStatus : undefined,
      limit: pageSize,
      offset: page * pageSize,
    })
      .then((r) => { setOrders(r.orders); setTotal(r.total); }).catch(() => { setOrders([]); setTotal(0); });
  };
  const reload = (): void => {
    fetchOrders();
    adminApi.payments().then((r) => setPayments(r.payments)).catch(() => setPayments([]));
  };
  useEffect(reload, []);
  useEffect(() => {
    const timer = setTimeout(fetchOrders, 300);
    return () => clearTimeout(timer);
  }, [orderQ, orderPlan, orderStatus, page, pageSize]);
  useEffect(() => {
    adminApi.config().then((c) => setPlans(c.plans)).catch(() => setPlans([]));
  }, []);
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
        { key: "days", label: t("时长（天）"), value: "30" },
      ],
      submit: (reason, values) =>
        adminApi
          .credit({ userId: Number(values.userId), planId: values.planId ?? "", amountCny: Number(values.amountCny), days: Number(values.days), reason })
          .then(() => { setMsg("ok"); setDialog(null); reload(); })
          .catch((e: unknown) => setMsg(e instanceof Error ? e.message : "failed")),
    });
  };
  return (
    <div>
      {msg !== "" && <p style={{ fontSize: 12, color: "var(--rdsh-link)" }}>{msg}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>{t("订单")}</h3>
        {isAdmin && <button onClick={credit} style={adminBtnStyle("primary")}>{t("补单")}</button>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" }}>
        <input value={orderQ} onChange={(e) => { setOrderQ(e.target.value); setPage(0); }} placeholder={t("按订单号精确搜索", { en: "Exact order id" })} style={{ padding: "8px 10px", width: "100%", maxWidth: 300, boxSizing: "border-box" }} />
        <select value={orderPlan} onChange={(e) => { setOrderPlan(e.target.value); setPage(0); }} style={adminFilterStyle()} title={t("套餐")}>
          <option value="">{t("套餐")}：{t("全部")}</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={orderStatus} onChange={(e) => { setOrderStatus(e.target.value); setPage(0); }} style={adminFilterStyle()} title={t("状态")}>
          <option value="">{t("状态")}：{t("全部")}</option>
          <option value="created">{t("待支付")}</option>
          <option value="paid">{t("已支付")}</option>
          <option value="closed">{t("已关闭")}</option>
          <option value="refunded">{t("已退款")}</option>
        </select>
      </div>
      <table className="admintbl" style={{ ...adminTableStyle(), marginTop: 8 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("订单号"), t("用户"), t("套餐"), t("金额"), t("状态"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(orders ?? []).map((o) => (
            <tr key={o.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
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
      <Pager page={page} total={total} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(0); }} />
      <h3 style={{ fontSize: 14, marginTop: 16 }}>{t("支付流水")}</h3>
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("流水号"), t("订单号"), t("渠道"), t("渠道单号"), t("金额"), t("支付时间")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(payments ?? []).map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
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
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const base = source === "" ? undefined : { source };
    adminApi.audit({ ...base, limit: pageSize, offset: page * pageSize })
      .then((r) => { setEvents(r.events); setTotal(r.total); }).catch(() => { setEvents([]); setTotal(0); });
  }, [source, page, pageSize]);
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <select value={source} onChange={(e) => { setSource(e.target.value); setPage(0); }} style={{ padding: "8px" }}>
          <option value="">{t("全部来源")}</option>
          <option value="user">{t("用户")}</option>
          <option value="admin">{t("管理员")}</option>
        </select>
        <a href="/api/admin/audit.csv" target="_blank" rel="noreferrer" style={{ ...adminBtnStyle("ghost"), textDecoration: "none" }}>{t("导出 CSV")}</a>
      </div>
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("时间"), t("用户"), t("事件"), t("来源"), t("操作者")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(events ?? []).map((e) => (
            <tr key={e.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("时间"), new Date(e.createdAt).toLocaleString())}
              {adminTd(t("用户"), e.userId ?? "—")}
              {adminTd(t("事件"), e.event)}
              {adminTd(t("来源"), e.source)}
              {adminTd(t("操作者"), <span style={{ color: "var(--rdsh-fg-muted)" }}>{e.actorUserId ?? "—"}</span>)}
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} total={total} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(0); }} />
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
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--rdsh-bg-subtle)", flexWrap: "wrap" }}>
          <span style={{ color: "var(--rdsh-fg-muted)" }}>{k}</span>
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
  return <pre style={{ fontSize: 12, background: "var(--rdsh-bg-subtle)", padding: 16, borderRadius: 10, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{JSON.stringify(c, null, 2)}</pre>;
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
      {msg !== "" && <p style={{ fontSize: 12, color: "var(--rdsh-link)" }}>{msg}</p>}
      <table className="admintbl" style={adminTableStyle()}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rdsh-border)" }}>{[t("账号"), t("邮箱"), t("角色"), t("操作")].map(adminTh)}</tr>
        </thead>
        <tbody>
          {(admins ?? []).map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid var(--rdsh-bg-subtle)" }}>
              {adminTd(t("账号"), a.name)}
              {adminTd(t("邮箱"), <span style={{ color: "var(--rdsh-fg-muted)" }}>{a.email ?? "—"}</span>)}
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

// ---- 用量统计（feature 11 T2）----

type UsageRange = "7d" | "30d" | "month" | "lastMonth";

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

function rangeFor(r: UsageRange): { from: string; to: string } {
  const now = new Date();
  const today = fmtDate(now);
  if (r === "7d") return { from: fmtDate(addDays(now, -6)), to: today };
  if (r === "30d") return { from: fmtDate(addDays(now, -29)), to: today };
  if (r === "month") return { from: fmtDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: fmtDate(first), to: fmtDate(last) };
}

function rangeLabel(r: UsageRange): string {
  if (r === "7d") return "近7天";
  if (r === "30d") return "近30天";
  if (r === "month") return "本月";
  return "上月";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMinutes(seconds: number, t: T): string {
  if (seconds < 60) return `${Math.round(seconds)} ${t("秒")}`;
  return `${(seconds / 60).toFixed(0)} ${t("分钟")}`;
}

function formatChars(chars: number, t: T): string {
  return `${chars.toLocaleString()} ${t("字符")}`;
}

/** 每根柱 = 一天；series 支持多序列（对照图并排）。null = 无数据日（不画柱）。 */
function BarChart({ series, colors, height = 96, maxOverride }: { series: Array<Array<number | null>>; colors: string[]; height?: number; maxOverride?: number }): React.JSX.Element {
  const n = series.reduce((m, arr) => Math.max(m, arr.length), 0);
  const max = maxOverride ?? Math.max(1, ...series.flat().map((v) => v ?? 0));
  if (n === 0) return <></>;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height }}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 1, height: "100%", minWidth: 0 }}>
          {series.map((arr, si) => {
            const v = arr[i] ?? null;
            const h = v === null || v === 0 ? 0 : Math.max(2, Math.round((v / max) * (height - 2)));
            return <div key={si} style={{ flex: 1, height: h, background: colors[si] ?? "var(--rdsh-primary)", borderRadius: "2px 2px 0 0" }} />;
          })}
        </div>
      ))}
    </div>
  );
}

function seriesFromDays(from: string, to: string, days: UsageDay[], pick: (d: UsageDay) => number): Array<number | null> {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: Array<number | null> = [];
  const d = new Date(`${from}T00:00:00`);
  while (fmtDate(d) <= to) {
    const day = byDate.get(fmtDate(d));
    out.push(day === undefined ? null : pick(day));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function sumSeries(arr: Array<number | null>): number {
  let sum = 0;
  for (const v of arr) sum += v ?? 0;
  return sum;
}

function avgSeries(arr: Array<number | null>): number | null {
  let sum = 0;
  let count = 0;
  for (const v of arr) {
    if (v !== null) {
      sum += v;
      count++;
    }
  }
  return count === 0 ? null : sum / count;
}

function UsagePage(): React.JSX.Element {
  const { t } = useT();
  const [range, setRange] = useState<UsageRange>("30d");
  const [days, setDays] = useState<UsageDay[]>([]);
  const [hostUsage, setHostUsage] = useState<Array<{ id: string; name: string; relayBytes: number; directBytes: number }>>([]);
  const [loading, setLoading] = useState(true);
  // 点数余额（对齐 App 用量页顶部）：拆成「充值余额 / 赠送余额」两张卡。
  // 赠送 = bonus_carried（上月结转，本月底到期）+ bonus_current（本月新发，下月底到期）；
  // 取值失败保持 null，只影响余额区，不影响图表。
  const [creditBal, setCreditBal] = useState<{ purchased: number; bonus: number } | null>(null);
  const { err, run } = useError();

  useEffect(() => {
    void api
      .creditsBalance()
      .then((b) => setCreditBal({ purchased: b.purchased / CREDITS_MICRO, bonus: (b.bonusCarried + b.bonusCurrent) / CREDITS_MICRO }))
      .catch(() => setCreditBal(null));
  }, []);

  useEffect(() => {
    const { from, to } = rangeFor(range);
    void run(async () => {
      setLoading(true);
      try {
        const r = await api.usage(from, to);
        setDays(r.days);
      } finally {
        setLoading(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => {
    void run(async () => {
      try {
        const r = await api.listHosts();
        const rows = await Promise.all(
          r.hosts.map(async (h: HostInfo) => {
            const u = await api.usageHost(h.id, from, to);
            const relayBytes = u.days.reduce((a, d) => a + d.relayBytesUp + d.relayBytesDown, 0);
            const directBytes = u.days.reduce((a, d) => a + d.directBytesUp + d.directBytesDown, 0);
            return { id: h.id, name: h.name, relayBytes, directBytes };
          }),
        );
        setHostUsage(rows);
      } catch {
        setHostUsage([]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const { from, to } = rangeFor(range);
  const relaySeries = seriesFromDays(from, to, days, (d) => d.relayBytesUp + d.relayBytesDown);
  const directSeries = seriesFromDays(from, to, days, (d) => d.directBytesUp + d.directBytesDown);
  const cloudSeries = seriesFromDays(from, to, days, (d) => d.cloudAsrSeconds);
  const localSeries = seriesFromDays(from, to, days, (d) => d.localAsrSeconds);

  const relayTotal = sumSeries(relaySeries);
  const directTotal = sumSeries(directSeries);
  const cloudTotal = sumSeries(cloudSeries);
  const localTotal = sumSeries(localSeries);
  const relayAvg = avgSeries(relaySeries);
  const directAvg = avgSeries(directSeries);
  const cloudAvg = avgSeries(cloudSeries);
  const localAvg = avgSeries(localSeries);

  const cloudTtsSeries = seriesFromDays(from, to, days, (d) => d.cloudTtsChars);
  const localTtsSeries = seriesFromDays(from, to, days, (d) => d.localTtsChars);
  const cloudTtsTotal = sumSeries(cloudTtsSeries);
  const localTtsTotal = sumSeries(localTtsSeries);
  const cloudTtsAvg = avgSeries(cloudTtsSeries);
  const localTtsAvg = avgSeries(localTtsSeries);

  // 同行共享纵轴：一对卡取两卡峰值的最大值，使"同一天的两值"可跨卡比较（R13）。
  const peakOf = (arr: Array<number | null>): number => Math.max(0, ...arr.map((v) => v ?? 0));
  const relayMax = Math.max(peakOf(relaySeries), peakOf(directSeries));
  const asrMax = Math.max(peakOf(cloudSeries), peakOf(localSeries));
  const ttsMax = Math.max(peakOf(cloudTtsSeries), peakOf(localTtsSeries));
  // 主机总流量条：以流量最大的主机为 100% 基准，其余按各自流量等比缩短。
  const hostMaxTotal = hostUsage.reduce((m, h) => Math.max(m, h.relayBytes + h.directBytes), 0);

  const hasData = days.length > 0;
  const green = "#07c160";
  const orange = "#f59e0b";

  const metric = (
    label: string,
    iconName: "relay" | "direct" | "cloud" | "local" | "speaker",
    badge: string,
    badgeColor: string,
    totalText: string,
    avgText: string | null,
    series: Array<number | null>,
    color: string,
    maxOverride?: number,
  ): React.JSX.Element => (
    <div key={label} style={{ border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <UsageIcon name={iconName} color={color} />
        <span style={{ fontWeight: 600 }}>{t(label)}</span>
        <span style={{ fontSize: 11, color: badgeColor, border: `1px solid ${badgeColor}`, borderRadius: 4, padding: "1px 6px" }}>{t(badge)}</span>
        <span style={{ marginLeft: "auto", fontWeight: 600, fontSize: 15 }}>{totalText}</span>
      </div>
      <BarChart series={[series]} colors={[color]} maxOverride={maxOverride} />
      <div style={{ fontSize: 12, color: "var(--rdsh-fg-muted)", marginTop: 6 }}>
        {t("合计")} {totalText}{avgText !== null ? ` · ${t("日均")} ${avgText}` : ""}
      </div>
    </div>
  );

  return (
    <Shell title={t("用量统计")}>
      {err !== "" && <p style={{ color: "var(--rdsh-danger)", fontSize: 13 }}>{err}</p>}

      {/* 充值余额 / 赠送余额两张卡：响应式栅格（宽屏并排、窄屏堆叠），与下方指标卡同栅格。
          赠送余额 = bonus_carried + bonus_current（两笔到期时间不同，仅展示时相加）。 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
        <Card title={t("充值余额", { en: "Purchased credits" })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>
              {creditBal === null ? "—" : Math.round(creditBal.purchased).toLocaleString()}{" "}
              <span style={{ fontSize: 13, fontWeight: 400 }}>{t("点数", { en: "credits" })}</span>
            </div>
            <button onClick={() => navigate("/credits")} style={btnStyle("ghost")}>
              {t("去充值", { en: "Top up" })} ›
            </button>
          </div>
        </Card>
        <Card title={t("赠送余额", { en: "Bonus credits" })}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {creditBal === null ? "—" : Math.round(creditBal.bonus).toLocaleString()}{" "}
            <span style={{ fontSize: 13, fontWeight: 400 }}>{t("点数", { en: "credits" })}</span>
          </div>
        </Card>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {(["7d", "30d", "month", "lastMonth"] as UsageRange[]).map((r) => (
          <button key={r} onClick={() => setRange(r)} style={{ ...btnStyle("ghost"), fontWeight: range === r ? 700 : 400, background: range === r ? "var(--rdsh-bg-active)" : "var(--rdsh-bg-surface)" }}>
            {t(rangeLabel(r))}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: "var(--rdsh-fg-muted)" }}>{t("加载中…")}</p>
      ) : !hasData ? (
        <p style={{ color: "var(--rdsh-fg-muted)" }}>{t("暂无用量数据")}</p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginBottom: 12 }}>
            {metric("中转流量", "relay", "计费", orange, formatBytes(relayTotal), relayAvg !== null ? formatBytes(relayAvg) : null, relaySeries, orange, relayMax)}
            {metric("直连流量", "direct", "免费", green, formatBytes(directTotal), directAvg !== null ? formatBytes(directAvg) : null, directSeries, green, relayMax)}
            {metric("云端识别", "cloud", "自费", orange, formatMinutes(cloudTotal, t), cloudAvg !== null ? formatMinutes(cloudAvg, t) : null, cloudSeries, orange, asrMax)}
            {metric("本地识别", "local", "免费", green, formatMinutes(localTotal, t), localAvg !== null ? formatMinutes(localAvg, t) : null, localSeries, green, asrMax)}
            {metric("云端朗读", "speaker", "自费", orange, formatChars(cloudTtsTotal, t), cloudTtsAvg !== null ? formatChars(cloudTtsAvg, t) : null, cloudTtsSeries, orange, ttsMax)}
            {metric("本地朗读", "speaker", "免费", green, formatChars(localTtsTotal, t), localTtsAvg !== null ? formatChars(localTtsAvg, t) : null, localTtsSeries, green, ttsMax)}
          </div>

          {hostUsage.length > 0 && (
            <div style={{ border: "1px solid var(--rdsh-border-soft)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, marginBottom: 8 }}><UsageIcon name="host" color="#3b82f6" />{t("主机总流量")} <span style={{ fontSize: 11, color: "var(--rdsh-fg-muted)" }}>（{t("中转流量")} {formatBytes(hostUsage.reduce((a, h) => a + h.relayBytes, 0))} · {t("直连流量")} {formatBytes(hostUsage.reduce((a, h) => a + h.directBytes, 0))}）</span></div>
              {hostUsage.map((h) => {
                const hostTotal = h.relayBytes + h.directBytes;
                const pct = hostMaxTotal > 0 ? (hostTotal / hostMaxTotal) * 100 : 0;
                return (
                  <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.name}>{h.name}</span>
                    <div style={{ flex: 1, display: "flex" }}>
                      <div style={{ width: `${pct}%`, display: "flex", gap: 4, height: 12, borderRadius: 2, overflow: "hidden" }}>
                        {h.relayBytes > 0 && <div style={{ flex: h.relayBytes, background: orange }} />}
                        {h.directBytes > 0 && <div style={{ flex: h.directBytes, background: green }} />}
                      </div>
                    </div>
                    <span style={{ fontSize: 12, color: "var(--rdsh-fg-muted)" }}>{formatBytes(hostTotal)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {directTotal > 0 && (
            <p style={{ fontSize: 13, color: green, margin: "4px 0 12px" }}>
              💡 {t("已省下 ≈{x} 中转流量", { params: { x: formatBytes(directTotal) } })}
            </p>
          )}

          <p style={{ fontSize: 12, color: "var(--rdsh-fg-subtle)", borderTop: "1px solid var(--rdsh-border-soft)", paddingTop: 8, margin: 0 }}>
            {t("数据来源：中转/直连流量 = 网关（设备端）统计 · 本地/云端语音与朗读 = App（设备端）统计（本地朗读 = 离线模型；系统朗读与系统识别不计；字符按 Unicode 码点）")}
          </p>
        </>
      )}
    </Shell>
  );
}
