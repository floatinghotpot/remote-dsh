/**
 * i18n.ts — portal 轻量国际化（零依赖）。
 *
 * 设计：key = 中文原文，`EN` 字典存英文翻译；`t(key)` 在 zh 下原样返回 key，
 * en 下返回 `EN[key] ?? key`（漏翻自动回退中文）。支持 `{param}` 占位与个别
 * 同形异义覆盖（`t("共享", { en: "Share" })`，如徽标 Shared vs 按钮 Share）。
 *
 * 语言：navigator.language 检测 + localStorage 持久化 + 模块级订阅（切换全页重渲染）。
 */
import { useEffect, useState } from "react";

export type Lang = "zh" | "en";

/** t 函数签名（供组件类型标注复用）。 */
export type T = (key: string, opts?: { en?: string; params?: Record<string, string | number> }) => string;

const STORAGE_KEY = "rdsh_lang";

/** 英文翻译字典（key = 中文原文）。 */
const EN: Record<string, string> = {
  // ---- 通用 ----
  "账户": "Account",
  "退出登录": "Sign out",
  "账户与安全": "Account & Security",
  "套餐": "Plan",
  "当前绑定：{x}": "Currently bound: {x}",
  "剩余 {x} · 隧道保留 · 到期后降级免费档": "{x} left · tunnels kept · downgrades to free after expiry",
  "验证码已发送到邮箱，请查收（10 分钟内有效）": "Code sent to your email (valid 10 min)",
  "短信验证码已发送，请查收（10 分钟内有效）": "SMS code sent (valid 10 min)",
  "手机号（+86）": "Phone (+86)",
  "← 返回主机列表": "← Back to hosts",
  "← 返回账户与安全": "← Back to account",
  "在线": "Online",
  "离线": "Offline",
  "进入": "Enter",
  "改名": "Rename",
  "保存": "Save",
  "解绑": "Unbind",
  "未绑定": "Not bound",
  "已验证": "Verified",
  "发送验证码": "Send code",
  "验证码": "Code",
  "验证邮箱": "Verify email",
  "验证手机号": "Verify phone",
  "邮箱": "Email",
  "手机号": "Phone",
  "加载中…": "Loading…",
  "（无）": "(none)",
  "未命名": "Unnamed",
  "到期 {date}": "Expires {date}",
  "吊销": "Revoke",
  "重新发送 {s}s": "Resend in {s}s",

  // ---- 登录 ----
  "rdsh · 你的 AI 智能体，随处可达": "rdsh · Your AI agent, reachable anywhere",
  "远程指挥你的 DeepSeek Harness 智能体，只需使用浏览器，任意设备、随时、随地":
    "Remotely command your DeepSeek Harness agent — just a browser, any device, anytime, anywhere",
  "登录": "Sign in",
  "用户名": "Username",
  "用户名（管理员创建）": "Username (created by admin)",
  "邮箱 / 手机号 / 用户名": "Email / phone / username",
  "密码": "Password",
  "新密码（至少 8 位）": "New password (min 8 characters)",
  "验证并登录": "Verify & sign in",
  "设置密码并登录": "Set password & sign in",
  "忘记密码？": "Forgot password?",
  "注册": "Register",
  "输入你的两步验证码（TOTP）": "Enter your 2FA code (TOTP)",
  "首次登录：设置你的密码": "First sign-in: set your password",
  "登录后访问你的 DSH 智能体": "Sign in to access your DSH agent",

  // ---- 验证码 ----
  "完成滑块验证": "Complete the slider captcha",
  "防机器人验证：{question}": "Anti-bot check: {question}",
  "答案": "Answer",
  "确认验证": "Verify",

  // ---- 注册 ----
  "注册 rdsh": "Register rdsh",
  "注册即享 3 天试用（1 台主机），随时随地浏览器访问你的 DSH。":
    "Register for a 3-day trial (1 host) — access your DSH from any browser, anytime.",
  "邮箱地址": "Email",
  "手机号（+86，11 位）": "Phone (+86, 11 digits)",
  "密码（至少 8 位）": "Password (min 8 characters)",
  "我已阅读并同意": "I have read and agree to",
  "《用户协议》": "the Terms of Service",
  "与": "and",
  "《隐私政策》": "the Privacy Policy",
  "获取验证码并注册": "Get code & register",
  "已有账号？登录": "Already have an account? Sign in",
  "验证{channel}": "Verify {channel}",
  "验证码已发送，请查收": "Code sent — please check",
  "验证码已发送到{channel}，请查收（10 分钟内有效）": "Code sent to your {channel} (valid 10 min)",
  "邮箱已验证 ✓": "Email verified ✓",
  "手机号已验证 ✓": "Phone verified ✓",

  // ---- 找回密码 ----
  "找回密码": "Reset password",
  "注册邮箱": "Registered email",
  "发送重置码": "Send reset code",
  "若该{channel}已注册，重置码已发送（10 分钟内有效）。":
    "If that {channel} is registered, a reset code was sent (valid 10 min).",
  "重置码": "Reset code",
  "重置密码": "Reset password",

  // ---- 主机列表 ----
  "rdsh · 我的主机": "rdsh · My Hosts",
  "添加主机 / 接入 token": "Add host / join token",
  "还没有接入主机 —— 用上面的「添加主机」接入你的第一台 DSH。":
    "No hosts yet — use “Add host” above to connect your first DSH.",
  "共享管理": "Sharing",
  "关闭": "Close",
  "成员用户名": "Member username",
  "尚未共享给任何人": "Not shared with anyone yet",
  "移除": "Remove",
  "吊销该 host？其隧道立即断开，需重新接入。":
    "Revoke this host? Its tunnel drops immediately and it must rejoin.",
  "吊销该 join token？已注册主机不受影响，仅阻止未来注册。":
    "Revoke this join token? Registered hosts are unaffected; this only blocks future registration.",
  "验证码已发送至 {identifier}（10 分钟内有效）。": "Code sent to {identifier} (valid 10 min).",
  "6 位验证码": "6-digit code",

  // ---- 添加主机 ----
  "rdsh · 添加主机": "rdsh · Add Host",
  "主机名（可选，默认取本机 hostname）": "Host name (optional, defaults to this machine's hostname)",
  "常驻服务（服务器 7×24）": "Run as a persistent service (24×7)",
  "有效期": "Validity",
  "1 天": "1 day",
  "7 天": "7 days",
  "30 天（默认）": "30 days (default)",
  "90 天": "90 days",
  "1 年": "1 year",
  "生成接入命令": "Generate join command",
  "接入命令（明文只显示这一次，请立即复制）": "Join command (shown once — copy it now)",
  "复制命令": "Copy command",
  "复制 token": "Copy token",
  "在主机终端粘贴执行（未装 rdsh 时先 <code>npm i -g remote-dsh</code>）。":
    "Run it in the host terminal (install rdsh first if needed: <code>npm i -g remote-dsh</code>).",
  "Auth Tokens": "Auth Tokens",

  // ---- 账户 ----
  "rdsh · 账户与安全": "rdsh · Account & Security",
  "套餐与订阅": "Plans & subscription",
  "两步验证（TOTP）": "Two-factor auth (TOTP)",
  "删除账号": "Delete account",
  "查看套餐与配额": "View plans & quota",
  "已绑定 {x}": "Bound: {x}",
  "绑定邮箱后可自助找回密码": "Bind an email to self-serve password reset",
  "绑定手机号后可用短信验证码找回密码": "Bind a phone for SMS-based password reset",
  "已开启，登录需输入动态验证码": "Enabled — sign-in requires a dynamic code",
  "开启后登录需输入动态验证码": "Sign-in will require a dynamic code",
  "立即断开全部主机并清除个人数据，不可恢复": "Disconnects all hosts and erases personal data. Irreversible.",

  // ---- 订阅状态卡 ----
  "🏠 自托管模式": "🏠 Self-hosted mode",
  "host 数量不限 · 无需订阅 · 开源免费": "Unlimited hosts · no subscription · open source",
  "● 试用中": "● Trial",
  "剩余 {x} · 配额 {used}/{quota} 台": "{x} left · quota {used}/{quota} hosts",
  "配额 {used}/{quota} 台": "Quota {used}/{quota} hosts",
  "● 已订阅 {plan}": "● Subscribed · {plan}",
  "到期 {date} · 配额 {used}/{quota} 台": "Expires {date} · quota {used}/{quota} hosts",
  "⚠ 宽限期": "⚠ Grace period",
  "隧道保留 · 到期后降级免费档": "Tunnels kept · downgrades to free after expiry",
  "○ 免费档": "○ Free tier",
  "0 台配额 · host 数据保留 30 天": "0 host quota · data kept 30 days",
  "查看详情": "Details",
  "升级套餐": "Upgrade",
  "管理": "Manage",
  "已到期": "Expired",
  "{days} 天 {hours} 小时": "{days}d {hours}h",
  "{hours} 小时": "{hours}h",

  // ---- 邮箱/手机号/2FA/删除子页 ----
  "邮箱设置": "Email settings",
  "邮箱地址（换绑需重新验证）": "Email (re-verify to rebind)",
  "邮箱已解绑": "Email unbound",
  "手机号设置": "Phone settings",
  "手机号已解绑": "Phone unbound",
  "两步验证": "Two-factor auth",
  "已开启": "Enabled",
  "未开启": "Disabled",
  "开启 2FA": "Enable 2FA",
  "密钥（复制到 Google Authenticator / 1Password 等）：": "Secret (add to Google Authenticator / 1Password etc.):",
  "当前 TOTP 验证码": "Current TOTP code",
  "确认开启": "Enable",
  "已开启两步验证，登录时需输入 TOTP 动态验证码。": "2FA is enabled — sign-in requires a TOTP code.",
  "输入当前验证码以关闭": "Enter your current code to disable",
  "关闭 2FA": "Disable 2FA",
  "2FA 已开启 ✓": "2FA enabled ✓",
  "2FA 已关闭": "2FA disabled",
  "删除账号（不可恢复）": "Delete account (irreversible)",
  "删除后将立即断开全部主机并清除个人数据（账务记录保留），且不可恢复。请谨慎操作。":
    "Disconnects all hosts and erases personal data (billing records kept). Irreversible — proceed with care.",
  "输入密码以确认": "Enter your password to confirm",
  "永久删除账号": "Permanently delete account",
  "确认永久删除账号？此操作不可恢复。": "Permanently delete your account? This cannot be undone.",

  // ---- 套餐页 ----
  "自托管模式": "Self-hosted mode",
  "你正在自托管运行 remote-dsh（开源免费）：host 数量不限 · 无需订阅 · 无到期限制。":
    "You are self-hosting remote-dsh (free & open source): unlimited hosts, no subscription, no expiry.",
  "完整功能：多用户 / 2FA / 审计 / 共享。": "Full features: multi-user / 2FA / audit / sharing.",
  "运营方在 hub.json 配置 billing.plans 后，此处将展示套餐与订阅入口。":
    "Once the operator configures billing.plans in hub.json, plans will appear here.",
  "选择套餐": "Choose a plan",
  "{hosts} 台 host · ¥{price}/{interval} 天": "{hosts} hosts · ¥{price}/{interval} days",
  "当前套餐": "Current plan",
  "订阅": "Subscribe",
  "订阅成功，配额已升级": "Subscribed — quota upgraded",
  "计费说明": "Billing notes",
  "订阅/试用到期后进入 3 天宽限期（隧道保留），之后降级免费档（0 台在线，host 数据保留 30 天）。":
    "After trial/subscription expiry: 3-day grace period (tunnels kept), then downgrade to free tier (0 online, data kept 30 days).",
  "支付：微信 / 支付宝（上线后支持）· 7 天无理由退款 · MVP 暂不提供发票。":
    "Payment: WeChat / Alipay (when live) · 7-day no-reason refund · invoices not yet available.",

  // ---- 修改密码 ----
  "修改密码": "Change password",
  "当前密码": "Current password",
  "确认新密码": "Confirm new password",
  "两次输入不一致": "Passwords do not match",
  "密码已修改，全部会话已失效 —— 即将跳转登录…": "Password changed — all sessions revoked. Redirecting to sign in…",

  // ---- 页脚 ----
  "产品介绍": "Product",
  "用户协议": "Terms of Service",
  "隐私政策": "Privacy Policy",

  // ---- 落地页 ----
  "你的 AI 智能体，随处可达": "Your AI agent, reachable anywhere",
  "免公网 IP · 免装客户端": "No public IP · no client install",
  "立即注册": "Get started",
  "进入控制台": "Go to dashboard",
};

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* localStorage 不可用（隐私模式等） */
  }
  return typeof navigator !== "undefined" && (navigator.language ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

let currentLang: Lang = detectLang();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** 切换语言（持久化 + 通知全页重渲染）。 */
export function setLang(l: Lang): void {
  currentLang = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
  notify();
}

export function getLang(): Lang {
  return currentLang;
}

/** 取本地化文案；zh 原样，en 查 EN 字典（漏翻回退中文）；`en` 参数用于同形异义覆盖。 */
export function translate(key: string, opts?: { en?: string; params?: Record<string, string | number> }): string {
  let out = currentLang === "en" ? (opts?.en ?? EN[key] ?? key) : key;
  const params = opts?.params;
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** React hook：订阅语言变化，返回当前 t 函数/语言/切换器。 */
export function useT(): { t: (key: string, opts?: { en?: string; params?: Record<string, string | number> }) => string; lang: Lang; setLang: (l: Lang) => void } {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = (): void => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { t: translate, lang: currentLang, setLang };
}
