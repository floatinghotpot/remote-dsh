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
  "登出": "Sign out",
  "账户与安全": "Account & Security",
  "微信客服": "Customer Service",
  "遇到问题？联系在线客服": "Questions? Contact online support",

  // ---- 管理后台 ----
  "进入管理后台": "Enter admin console",
  "管理后台需两步验证（TOTP）。未开启 2FA 的账号请先在「账户与安全」开启。": "The admin console requires two-factor auth (TOTP). Enable 2FA in Account & Security first.",
  "动态验证码": "TOTP code",
  "记住此设备 30 天（下次登录免输动态码）": "Trust this device for 30 days (skip TOTP on next sign-in)",
  "总览": "Overview",
  "用户": "Users",
  "主机": "Hosts",
  "账单": "Billing",
  "审计": "Audit",
  "健康": "Health",
  "配置": "Config",
  "管理员": "Admins",
  "只读": "Read-only",
  "运营": "Operator",
  "普通用户": "Regular user",
  "套餐状态": "Plan status",
  "注册用户": "Users",
  "主机总数": "Total hosts",
  "在线主机": "Online hosts",
  "隧道连接": "Tunnels",
  "付费订阅": "Subscribed",
  "DB 大小": "DB size",
  "版本": "Version",
  "uptime": "Uptime",
  "最近备份": "Last backup",
  "未配置": "Not configured",
  "搜索 用户名/邮箱/手机号": "Search name / email / phone",
  "搜索 主机名/归属用户": "Search host name / owner",
  "加入时间": "Joined",
  "角色": "Role",
  "状态": "Status",
  "操作": "Actions",
  "封禁": "Ban",
  "解封": "Unban",
  "重置2FA": "Reset 2FA",
  "改套餐": "Change plan",
  "删除": "Delete",
  "新密码（≥8 位）": "New password (≥8 chars)",
  "planStatus（subscribed/grace/free/null）": "planStatus (subscribed/grace/free/null)",
  "主机名": "Host name",
  "归属": "Owner",
  "E2EE": "E2EE",
  "订单": "Orders",
  "支付流水": "Payments",
  "订单号": "Order",
  "金额": "Amount",
  "退款": "Refund",
  "流水号": "Payment id",
  "渠道": "Channel",
  "渠道单号": "Channel order id",
  "支付时间": "Paid at",
  "全部来源": "All sources",
  "导出 CSV": "Export CSV",
  "时间": "Time",
  "来源": "Source",
  "操作者": "Actor",
  "账号": "Account",
  "改角色": "Change role",
  "补单": "Manual credit",
  "原因（必填）": "Reason (required)",
  "确认": "Confirm",
  "用户 ID": "User ID",
  "套餐 ID": "Plan ID",
  "金额（元）": "Amount (CNY)",
  "到期时间戳（ms）": "Expires at (ms)",

  "套餐": "Plan",
  "当前绑定：{x}": "Currently bound: {x}",
  "剩余 {x} · 隧道保留 · 到期后降级免费档": "{x} left · tunnels kept · downgrades to free after expiry",
  "验证码已发送到邮箱，请查收（10 分钟内有效）": "Code sent to your email (valid 10 min)",
  "短信验证码已发送，请查收（10 分钟内有效）": "SMS code sent (valid 10 min)",
  "手机号（+86）": "Phone (+86)",
  "← 返回账户与安全": "← Back to account",
  "在线": "Online",
  "离线": "Offline",
  "端到端加密": "End-to-end encrypted",
  "进入": "Enter",
  "改名": "Rename",
  "更多操作": "More actions",
  "管理后台": "Admin console",
  "+ 新建用户": "+ New User",
  "新建用户": "New user",
  "登录标识（用户名 / 邮箱 / +86 手机）": "Login identifier (name / email / +86 phone)",
  "初始密码（≥8 位）": "Initial password (≥8 chars)",
  "确认密码": "Confirm password",
  "强制首次登录修改密码": "Force password change on first sign-in",
  "请输入登录标识": "Enter a login identifier",
  "密码至少 8 位": "Password must be at least 8 chars",
  "两次输入的密码不一致": "Passwords do not match",
  "创建": "Create",
  "无期限（null）": "No expiry (null)",
  "到期时间（留空 = 无期限）": "Expiry date (empty = no expiry)",
  "从未登录": "Never signed in",
  "正常": "Normal",
  "锁定至 {time}": "Locked until {time}",
  "邮✓": "Email ✓",
  "邮未验证": "Email unverified",
  "手✓": "Phone ✓",
  "手未验证": "Phone unverified",
  "最后登录": "Last sign-in",
  "输入 {name} 以确认": "Type {name} to confirm",
  "请输入 {name} 以确认": "Type {name} to confirm",
  "管理后台需要两步验证（TOTP）才能使用，请先开启 2FA。": "The admin console requires two-factor auth (TOTP). Please enable 2FA first.",
  "去开启 2FA": "Enable 2FA",
  "请填写操作原因": "Please fill in a reason",
  "不能操作自己的账号": "You cannot manage your own account",
  "上一页": "Prev",
  "下一页": "Next",
  "条": "rows",
  "详情": "Details",
  "← 返回用户列表": "← Back to users",
  "账号信息": "Account",
  "订阅历史": "Subscriptions",
  "订单": "Orders",
  "支付流水": "Payments",
  "审计轨迹": "Audit trail",
  "ID": "ID",
  "注册时间": "Registered",
  "开始": "Started",
  "到期": "Expires",
  "金额": "Amount",
  "订单号": "Order",
  "渠道": "Channel",
  "渠道单号": "Channel order",
  "事件": "Event",
  "来源": "Source",
  "IP": "IP",
  "共享主机": "Share host",
  "保存": "Save",
  "解绑": "Unbind",
  "未绑定": "Not bound",
  "已绑定": "Bound",
  "该微信可免密登录本账号：{x}": "This WeChat can sign in without a password: {x}",
  "已验证": "Verified",
  "发送验证码": "Send code",
  "验证码": "Code",
  "验证邮箱": "Verify email",
  "验证手机号": "Verify phone",
  "邮箱": "Email",
  "手机号": "Phone",
  "加载中…": "Loading…",
  "（无）": "(none)",
  "到期 {date}": "Expires {date}",
  "吊销": "Revoke",
  "重新发送 {s}s": "Resend in {s}s",

  // ---- 登录 ----
  "远程指挥你的 DeepSeek Harness 智能体，仅需浏览器，任意设备、随时随地，端到端加密":
    "Remotely command your DeepSeek Harness agent — just a browser, any device, anytime, anywhere, end-to-end encrypted",
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
  "微信登录": "WeChat sign-in",
  "使用微信登录": "Sign in with WeChat",
  "或": "or",
  "未找到已绑定的账号，是否创建新账号？": "No bound account found. Create a new one?",
  "创建新账号": "Create new account",
  "已有账号，去登录": "I already have an account — sign in",
  "已有邮箱/手机号账号？先用账号密码登录，再在设置里绑定微信": "Already have an email/phone account? Sign in with it first, then bind WeChat in settings",
  "绑定微信": "Bind WeChat",
  "绑定微信后，该微信可免密登录本账号": "After binding, this WeChat can sign in to this account without a password",
  "已复制": "Copied",
  "微信登录需在服务端配置 hub.json wechatLogin": "WeChat sign-in requires hub.json wechatLogin",

  // ---- 验证码 ----
  "完成滑块验证": "Complete the slider captcha",
  "防机器人验证：{question}": "Anti-bot check: {question}",
  "答案": "Answer",
  "确认验证": "Verify",

  // ---- 注册 ----
  "注册 rdsh": "Register rdsh",
  "注册即享 7 天试用（1 台主机），随时随地浏览器访问你的 DSH。":
    "Register for a 7-day trial (1 host) — access your DSH from any browser, anytime.",
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
  "我的主机": "My Hosts",
  "添加主机接入": "Add host",
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
  "添加主机接入": "Add host",
  "令牌备注（可选）": "Token note (optional)",
  "有效期": "Validity",
  "1 天": "1 day",
  "7 天": "7 days",
  "30 天（默认）": "30 days (default)",
  "90 天": "90 days",
  "1 年": "1 year",
  "生成接入令牌": "Generate join token",
  "接入令牌明文只显示这一次，请立即复制": "Join token plaintext is shown only once — copy it now",
  "复制命令": "Copy command",
  "复制 Hub 地址": "Copy Hub URL",
  "复制令牌": "Copy token",
  "Hub 地址": "Hub URL",
  "已复制": "Copied",
  "复制失败，请手动选择复制": "Copy failed — please select and copy manually",
  "方式一：DSH 插件（界面操作，免装 CLI）": "Option 1: DSH plugin (in-app, no CLI)",
  "在 DSH 设置 →「远程访问」面板填入：": "In DSH Settings → Remote Access panel, enter:",
  "未装插件？在主机终端执行：": "Plugin not installed? In the host terminal run:",
  "然后重启 dsh web（插件 boot 时加载）": "Then restart dsh web (plugins load at boot)",
  "方式二：rdsh-gateway（命令行）": "Option 2: rdsh-gateway (command line)",
  "在主机终端执行：": "In the host terminal run:",
  "未装 CLI？终端执行：": "CLI not installed? Run:",
  "接入后运行隧道：": "After joining, start the tunnel:",
  "前台运行：rdsh host serve": "Foreground: rdsh host serve",
  "常驻服务（服务器 7×24）：rdsh host service install": "Resident service (server 7×24): rdsh host service install",
  "主机名默认取机器 hostname，可追加 --name 覆盖": "Host name defaults to the machine hostname; append --name to override",
  "接入令牌": "Join Tokens",
  "用于将主机接入 Hub，并绑定到用户的账号。": "Onboards a host to the Hub and binds it to your account.",
  "明文只在生成时显示一次——刷新或离开本页后无法再次查看，请立即复制":
    "The plaintext is shown only once at creation — it cannot be viewed again after refresh or leaving this page, so copy it right away",
  "令牌在有效期内可重复使用，可接入多台主机":
    "A token can be reused within its validity period to onboard multiple hosts",
  "接入后主机保持连接，不依赖此令牌——吊销它不影响已接入主机":
    "Hosts stay connected without this token — revoking it does not affect already-onboarded hosts",
  "遗忘或泄露，请立即吊销并重新生成，旧令牌即刻失效":
    "If lost or leaked, revoke and regenerate immediately — the old token becomes invalid at once",

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
  "用 Authenticator App 扫描二维码，或手动输入密钥：": "Scan the QR code with an Authenticator app, or enter the secret manually:",
  "设置步骤：": "Setup steps:",
  "打开 Authenticator App（微软 / Google / 1Password 均可）": "Open an Authenticator app (Microsoft / Google / 1Password all work)",
  "添加账号 → 扫码绑定；无法扫码时选「手动输入」，粘贴下方密钥": "Add an account → scan the QR code; or choose manual entry and paste the secret below",
  "App 生成 6 位动态码（每 30 秒轮换）": "The app shows a 6-digit code (rotates every 30 seconds)",
  "把动态码填回本页输入框（输满 6 位自动提交）→ 点「确认开启」": "Enter the code here (auto-submits at 6 digits) → tap Enable",
  "提示：": "Notes:",
  "密钥仅在此展示，开启后不再显示 —— 请确保 App 已成功绑定；建议保存密钥截图作备份": "The secret is shown only here — it is hidden after enabling. Make sure the app has it bound; consider saving a screenshot as backup",
  "绑定后每次登录需输入动态码；可选「记住此设备 30 天」免重复输入": "Every sign-in requires a dynamic code afterward; you may choose to trust this device for 30 days to skip it",
  "若换机/丢失 Authenticator，需联系管理员重置 2FA": "If you lose your authenticator, contact an admin to reset 2FA",
  "密钥（复制到 Google Authenticator / Microsoft Authenticator / 1Password 等）：": "Secret (add to Google Authenticator / Microsoft Authenticator / 1Password etc.):",
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
  "请用微信扫一扫完成支付": "Scan the QR with WeChat to pay",
  "支付已取消或失败": "Payment cancelled or failed",
  "取消": "Cancel",
  "计费说明": "Billing notes",
  "订阅/试用到期后进入 3 天宽限期（隧道保留），之后降级免费档（0 台在线，host 数据保留 30 天）。":
    "After trial/subscription expiry: 3-day grace period (tunnels kept), then downgrade to free tier (0 online, data kept 30 days).",
  "支付：微信支付（扫码 / H5 / 微信内）· 暂不提供发票。":
    "Payment: WeChat Pay (QR / H5 / in-WeChat) · invoices not yet available.",

  // ---- 修改密码 ----
  "修改密码": "Change password",
  "当前密码": "Current password",
  "定期更换密码，保障账号安全": "Change your password regularly to keep your account secure",
  "确认新密码": "Confirm new password",
  "两次输入不一致": "Passwords do not match",
  "密码已修改，全部会话已失效 —— 即将跳转登录…": "Password changed — all sessions revoked. Redirecting to sign in…",

  // ---- 页脚 ----
  "产品介绍": "Product",
  "用户协议": "Terms of Service",
  "隐私政策": "Privacy Policy",

  // ---- 落地页 ----
  "你的 AI 智能体，随处安全可达": "Your AI agent, securely reachable anywhere",
  "免公网 IP · 免装客户端": "No public IP · no client install",
  "免公网 IP · 免装客户端 · 端到端加密": "No public IP · no client install · end-to-end encrypted",
  "rdsh 架构图": "rdsh architecture",
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
