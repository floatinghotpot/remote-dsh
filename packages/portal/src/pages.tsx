/**
 * portal 页面 + 手写路由（零依赖：不引 react-router）。
 *
 * 会话：httpOnly Cookie（fetch credentials include）；refreshToken 存 sessionStorage
 * 供登出吊销（hub 门户自身代码，无第三方脚本）。
 */
import { useEffect, useState } from "react";
import { api, ApiError, subscribeEvents } from "./api.ts";
import type { HostInfo, JoinTokenInfo, CaptchaPayload, AccountInfo, Capabilities } from "./api.ts";
import { useT, getLang } from "./i18n.ts";
import type { T } from "./i18n.ts";
import { TermsPage, PrivacyPage } from "./legal.tsx";

const REFRESH_KEY = "rdsh_refresh";

/** portal 部署在 /portal 前缀下（host 转发的 DSH 占用根路径）。 */
const BASE = "/portal";

function navigate(path: string): void {
  window.history.pushState({}, "", `${BASE}${path}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
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
  if (path === "/login") return <Login />;
  if (path === "/register") return <RegisterPage />;
  if (path === "/terms") return <TermsPage />;
  if (path === "/privacy") return <PrivacyPage />;
  if (path === "/verify") return <VerifyPage />;
  if (path === "/billing") return <BillingPage />;
  if (path === "/settings/password") return <PasswordPage />;
  if (path === "/settings/account") return <AccountPage />;
  if (path === "/settings/email") return <EmailSettingsPage />;
  if (path === "/settings/phone") return <PhoneSettingsPage />;
  if (path === "/settings/2fa") return <TwoFaSettingsPage />;
  if (path === "/settings/danger") return <DangerZonePage />;
  if (path === "/reset-password") return <ResetPasswordPage />;
  if (path === "/add-host") return <AddHostPage />;
  if (path === "/hosts" || path === "/") return <HostsPage />;
  return <HostsPage />; // 未知路径兜底 host 列表
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

function Shell({ title, children, onLogout }: { title: string; children: React.ReactNode; onLogout?: () => void }): React.JSX.Element {
  const { t } = useT();
  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18 }}>{title}</h1>
        {onLogout !== undefined && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <LangToggle />
            <button onClick={() => navigate("/settings/account")} style={btnStyle("ghost")}>{t("账户")}</button>
            <button onClick={onLogout} style={btnStyle()}>{t("退出登录")}</button>
          </div>
        )}
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

function field(label: string, value: string, onChange: (v: string) => void, type = "text"): React.JSX.Element {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ display: "block", marginBottom: 4, fontSize: 13 }}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle()} autoComplete="off" />
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
function SiteFooter(): React.JSX.Element | null {
  const { t } = useT();
  const [cap, setCap] = useState<Capabilities | null>(null);
  useEffect(() => {
    void api.capabilities().then(setCap).catch(() => undefined);
  }, []);
  if (cap === null) return null;

  const site = cap.site;
  const beian = cap.beian;
  const link: React.CSSProperties = { color: "#999", textDecoration: "none" };
  const nav: React.ReactNode[] = [];
  if (site?.name !== undefined) {
    nav.push(site.url !== undefined ? <a href={site.url} target="_blank" rel="noreferrer" style={link}>{site.name}</a> : <span>{site.name}</span>);
  }
  if (site?.productUrl !== undefined) {
    nav.push(<a href={site.productUrl} target="_blank" rel="noreferrer" style={link}>{t("产品介绍")}</a>);
  }
  nav.push(<a href="#" onClick={(e) => { e.preventDefault(); navigate("/terms"); }} style={link}>{t("用户协议")}</a>);
  nav.push(<a href="#" onClick={(e) => { e.preventDefault(); navigate("/privacy"); }} style={link}>{t("隐私政策")}</a>);

  return (
    <footer style={{ textAlign: "center", marginTop: 24, fontSize: 12, color: "#999", lineHeight: 1.8 }}>
      <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap" }}>
        {nav.map((node, i) => (
          <span key={i} style={{ whiteSpace: "nowrap" }}>{i > 0 ? " | " : ""}{node}</span>
        ))}
      </div>
      {beian?.icp !== undefined && <div><a href={beian.icpUrl ?? "https://beian.miit.gov.cn"} target="_blank" rel="noreferrer" style={link}>{beian.icp}</a></div>}
      {beian?.gongan !== undefined && <div><a href={beian.gonganUrl ?? "https://beian.mps.gov.cn"} target="_blank" rel="noreferrer" style={link}>{beian.gongan}</a></div>}
    </footer>
  );
}

// ---- 登录 / 首次设密 ----

function Login(): React.JSX.Element {
  const { t } = useT();
  const isFirst = new URLSearchParams(window.location.search).get("first") === "1";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totpPending, setTotpPending] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const { err, run } = useError();

  const submit = (): void => {
    void run(async () => {
      if (isFirst) {
        const r = await api.firstPassword(name, password);
        sessionStorage.setItem(REFRESH_KEY, r.refreshToken);
        navigate("/hosts");
      } else if (totpPending !== null) {
        const r = await api.totpLogin(totpPending, totpCode);
        sessionStorage.setItem(REFRESH_KEY, r.refreshToken);
        navigate(r.mustChangePassword ? "/login?first=1" : "/hosts");
      } else {
        const r = await api.login(name, password);
        if (r.requiresTotp === true && r.pendingToken !== undefined) {
          setTotpPending(r.pendingToken);
        } else {
          sessionStorage.setItem(REFRESH_KEY, r.refreshToken ?? "");
          navigate(r.mustChangePassword ? "/login?first=1" : "/hosts");
        }
      }
    });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LangToggle />
      </div>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{t("rdsh · 你的 AI 智能体，随处可达")}</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 24 }}>
        {totpPending !== null ? t("输入你的两步验证码（TOTP）") : isFirst ? t("首次登录：设置你的密码") : t("远程指挥你的 DeepSeek Harness 智能体，只需使用浏览器，任意设备、随时、随地")}
      </p>
      {totpPending !== null ? (
        field(t("验证码"), totpCode, setTotpCode)
      ) : (
        <>
          {field(isFirst ? t("用户名（管理员创建）") : t("邮箱 / 手机号 / 用户名"), name, setName)}
          {field(isFirst ? t("新密码（至少 8 位）") : t("密码"), password, setPassword, "password")}
        </>
      )}
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ ...btnStyle(), width: "100%", marginTop: 8 }}>
        {totpPending !== null ? t("验证并登录") : isFirst ? t("设置密码并登录") : t("登录")}
      </button>
      {totpPending === null && !isFirst && (
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
  const { err, run } = useError();
  useEffect(() => {
    void run(async () => {
      const [acc, subInfo] = await Promise.all([api.accountInfo(), api.subscription()]);
      setInfo(acc);
      setSub(subInfo);
    });
  }, []);
  return (
    <Shell title={t("账户与安全")} onLogout={logout}>
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate("/hosts")} style={btnStyle("ghost")}>{t("← 返回主机列表")}</button>
      </div>
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
        label={t("两步验证（TOTP）")}
        desc={info?.totpEnabled === true ? t("已开启，登录需输入动态验证码") : t("开启后登录需输入动态验证码")}
        badge={<Badge ok={info?.totpEnabled === true} text={info?.totpEnabled ? t("已开启") : t("未开启")} />}
        onClick={() => navigate("/settings/2fa")}
      />
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
    <Shell title={t("邮箱设置")} onLogout={logout}>
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
    <Shell title={t("手机号设置")} onLogout={logout}>
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
  const [twofaSecret, setTwofaSecret] = useState("");
  const [twofaCode, setTwofaCode] = useState("");
  const { toast, show } = useToast();
  const { err, run } = useError();
  useEffect(() => {
    void run(async () => setInfo(await api.accountInfo()));
  }, []);
  const refresh = async (): Promise<void> => setInfo(await api.accountInfo());
  const enabled = info?.totpEnabled === true;

  return (
    <Shell title={t("两步验证")} onLogout={logout}>
      <BackToAccount />
      <Toast toast={toast} />
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <Card title={t("两步验证（TOTP）")} badge={<Badge ok={enabled} text={enabled ? t("已开启") : t("未开启")} />}>
        {!enabled ? (
          twofaSecret === "" ? (
            <button onClick={() => void run(async () => setTwofaSecret((await api.enable2fa()).secret))} style={btnStyle()}>{t("开启 2FA")}</button>
          ) : (
            <div>
              <p style={{ fontSize: 13 }}>{t("密钥（复制到 Google Authenticator / 1Password 等）：")}</p>
              <code style={{ wordBreak: "break-all" }}>{twofaSecret}</code>
              {field(t("当前 TOTP 验证码"), twofaCode, setTwofaCode)}
              <button
                onClick={() => void run(async () => { await api.activate2fa(twofaSecret, twofaCode.trim()); setTwofaSecret(""); setTwofaCode(""); show("ok", t("2FA 已开启 ✓")); await refresh(); })}
                style={btnStyle()}
              >{t("确认开启")}</button>
            </div>
          )
        ) : (
          <div>
            <p style={{ fontSize: 13, color: "#6b7280", marginTop: 0 }}>{t("已开启两步验证，登录时需输入 TOTP 动态验证码。")}</p>
            {field(t("输入当前验证码以关闭"), twofaCode, setTwofaCode)}
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
    <Shell title={t("删除账号")} onLogout={logout}>
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

function HostsPage(): React.JSX.Element {
  const { t } = useT();
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [shareHostId, setShareHostId] = useState<string | null>(null);
  const [shareName, setShareName] = useState("");
  const [shares, setShares] = useState<Array<{ userId: number; name: string; role: string }>>([]);
  const { err, run } = useError();

  const openShare = (hostId: string): void => {
    setShareHostId(hostId);
    void run(async () => setShares((await api.listShares(hostId)).shares));
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
    <Shell title={t("rdsh · 我的主机")} onLogout={logout}>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate("/add-host")} style={btnStyle()}>{t("添加主机 / 接入 token")}</button>
      </div>

      {loading ? (
        <p style={{ color: "#666" }}>{t("加载中…")}</p>
      ) : hosts.length === 0 ? (
        <p style={{ color: "#666" }}>{t("还没有接入主机 —— 用上面的「添加主机」接入你的第一台 DSH。")}</p>
      ) : (
        <div>
          {hosts.map((h) => {
            const isOwner = h.role !== "member";
            return (
              <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid #eee", borderRadius: 8, marginBottom: 8 }}>
                <span style={{ color: h.online ? "#16a34a" : "#999", fontSize: 14 }}>{h.online ? "●" : "○"}</span>
                <span style={{ fontWeight: 500 }}>{h.name}</span>
                <span style={{ color: "#666", fontSize: 12 }}>{h.online ? t("在线") : t("离线")}</span>
                {!isOwner && <span style={{ color: "#999", fontSize: 12, border: "1px solid #eee", borderRadius: 4, padding: "1px 6px" }}>{t("共享", { en: "Shared" })}</span>}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button onClick={() => enterHost(h.id)} style={btnStyle()}>{t("进入")}</button>
                  {isOwner && <button onClick={() => { setRenameId(h.id); setRenameName(h.name); }} style={btnStyle("ghost")}>{t("改名")}</button>}
                  {isOwner && <button onClick={() => openShare(h.id)} style={btnStyle("ghost")}>{t("共享", { en: "Share" })}</button>}
                  {isOwner && <button onClick={() => revoke(h.id)} style={btnStyle("danger")}>{t("吊销")}</button>}
                </div>
                {renameId === h.id && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <input value={renameName} onChange={(e) => setRenameName(e.target.value)} style={{ ...inputStyle(), width: 140 }} />
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
    </Shell>
  );
}

function logout(): void {
  const refresh = sessionStorage.getItem(REFRESH_KEY);
  if (refresh !== null) {
    void api.logout(refresh).catch(() => undefined);
  }
  sessionStorage.removeItem(REFRESH_KEY);
  navigate("/login");
}

// ---- 进入 host：整页跳转 /h/<hostId>/（hub 校验归属 → Set-Cookie → 302 根路径，DSH 在根路径运行） ----

function enterHost(hostId: string): void {
  window.location.href = `/h/${encodeURIComponent(hostId)}/`;
}

// ---- 添加主机：生成用户级 join token + 接入命令（明文只显示一次）----

function AddHostPage(): React.JSX.Element {
  const { t } = useT();
  const [tokens, setTokens] = useState<JoinTokenInfo[]>([]);
  const [name, setName] = useState("");
  const [service, setService] = useState(false);
  const [ttl, setTtl] = useState(30 * 24 * 3600);
  const [generated, setGenerated] = useState<{ token: string; command: string } | null>(null);
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
      const r = await api.createJoinToken(name.trim() || null, ttl);
      const hub = `https://${window.location.host}`;
      const args = `--token ${r.token}${name.trim() ? ` --name ${name.trim()}` : ""}`;
      setGenerated({
        token: r.token,
        command: service ? `rdsh host service install ${hub} ${args}` : `rdsh host join ${hub} ${args}`,
      });
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

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  };

  return (
    <Shell title={t("rdsh · 添加主机")} onLogout={logout}>
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate("/hosts")} style={btnStyle("ghost")}>{t("← 返回主机列表")}</button>
      </div>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, marginBottom: 16 }}>
        {field(t("主机名（可选，默认取本机 hostname）"), name, setName)}
        <label style={{ display: "block", marginBottom: 12, fontSize: 13 }}>
          <input type="checkbox" checked={service} onChange={(e) => setService(e.target.checked)} /> {t("常驻服务（服务器 7×24）")}
        </label>
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
        <button onClick={generate} style={btnStyle()}>{t("生成接入命令")}</button>
      </div>

      {generated !== null && (
        <div style={{ border: "1px solid #16a34a", borderRadius: 8, padding: 16, marginBottom: 16, background: "#f0fdf4" }}>
          <p style={{ marginTop: 0, fontSize: 13, fontWeight: 600 }}>{t("接入命令（明文只显示这一次，请立即复制）")}</p>
          <pre style={{ background: "#fff", border: "1px solid #ccc", borderRadius: 6, padding: 10, fontSize: 12, overflowX: "auto" }}>{generated.command}</pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => copy(generated.command)} style={btnStyle()}>{t("复制命令")}</button>
            <button onClick={() => copy(generated.token)} style={btnStyle("ghost")}>{t("复制 token")}</button>
          </div>
          <p style={{ fontSize: 12, color: "#666", marginBottom: 0 }}>{t("在主机终端粘贴执行（未装 rdsh 时先 <code>npm i -g remote-dsh</code>）。")}</p>
        </div>
      )}

      <p style={{ fontSize: 13, color: "#666", fontWeight: 600 }}>{t("Auth Tokens")}</p>
      {tokens.length === 0 ? (
        <p style={{ color: "#999", fontSize: 13 }}>{t("（无）")}</p>
      ) : (
        <div>
          {tokens.map((tok) => (
            <div key={tok.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid #eee", borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 500 }}>{tok.label ?? t("未命名")}</span>
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
    <Shell title={t("修改密码")} onLogout={logout}>
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
      <p style={{ color: "#666", fontSize: 13, marginBottom: 24 }}>{t("注册即享 3 天试用（1 台主机），随时随地浏览器访问你的 DSH。")}</p>
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
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/terms"); }} style={{ color: "#2563eb" }}>{t("《用户协议》")}</a>
          {t("与")}
          <a href="#" onClick={(e) => { e.preventDefault(); navigate("/privacy"); }} style={{ color: "#2563eb" }}>{t("《隐私政策》")}</a>
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

function BillingPage(): React.JSX.Element {
  const { t } = useT();
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [sub, setSub] = useState<SubInfo | null>(null);
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

  const subscribe = (planId: string): void => {
    void run(async () => {
      await api.subscribe(planId);
      show("ok", t("订阅成功，配额已升级"));
      load();
    });
  };

  const hasPlans = plans.length > 0;
  const currentPlanId = sub?.planId ?? null;
  const hasStatus = sub !== null && (hasPlans || sub.planStatus !== null);

  return (
    <Shell title={t("套餐与订阅")} onLogout={logout}>
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => navigate("/hosts")} style={btnStyle("ghost")}>{t("← 返回主机列表")}</button>
      </div>
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
          {t("支付：微信 / 支付宝（上线后支持）· 7 天无理由退款 · MVP 暂不提供发票。")}
        </p>
      </Card>
    </Shell>
  );
}
