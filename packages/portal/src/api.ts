/**
 * api.ts — portal 的 hub API client（同源 fetch，httpOnly Cookie 会话）。
 */
import { getLang } from "./i18n.js";

/** 静默续期：续期令牌由 hub 下发的 HttpOnly cookie 承载（服务端读取），这里发空 body；cookie 缺失/失效 ⇒ 401。 */
const REFRESH_TIMEOUT_MS = 8000;

/** 续期结果分级：ok=成功 / invalid=令牌真过期 / transient=网络异常或超时。 */
type RefreshResult = "ok" | "invalid" | "transient";

/** 单飞静默续期：并发 401 只触发一次 refresh；成功换新 cookie + 轮换续期令牌。 */
let refreshPromise: Promise<RefreshResult> | null = null;
function silentRefresh(): Promise<RefreshResult> {
  if (refreshPromise === null) {
    refreshPromise = (async (): Promise<RefreshResult> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
      try {
        // 续期令牌在 HttpOnly cookie 里（JS 不可读），发空 body，由服务端读 cookie。
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "include",
          signal: ctrl.signal,
        });
        if (res.status === 401 || res.status === 403) return "invalid";
        if (!res.ok) return "transient";
        return "ok";
      } catch {
        return "transient"; // 网络失败 / 超时（abort）
      } finally {
        clearTimeout(timer);
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

/** 续期确认为令牌过期 → 整页跳登录并携带回跳路径（相对 /portal）。 */
function redirectToLogin(): void {
  const full = window.location.pathname + window.location.search;
  const rel = full.startsWith("/portal") ? full.slice("/portal".length) : full;
  const next = rel.length > 1 ? `?next=${encodeURIComponent(rel)}` : "";
  window.location.assign(`/portal/login${next}`);
}

export interface HostInfo {
  id: string;
  name: string;
  online: boolean;
  createdAt: string;
  role?: "owner" | "member";
  e2eePublicKey?: string | null;
  /** 主机自报的形态：desktop / cli / box / unknown；老主机为 null。 */
  deviceKind?: string | null;
  /** 主机自报的版本对象（键为包名）；未上报为 null。 */
  versions?: Record<string, unknown> | null;
  /** 主机自报的启动状态：starting = 网关已起、dsh 未就绪；ready = 可服务。 */
  status?: "starting" | "ready" | null;
}

export interface JoinTokenInfo {
  id: string;
  label: string | null;
  fingerprint: string;
  createdAt: string;
  expiresAt: number;
  revoked: boolean;
}

export interface LlmUsageModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  chargedMicro: number;
  byDay: Array<{ date: string; inputTokens: number; outputTokens: number }>;
}

export interface LlmCatalogModel {
  id: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
}

export interface LlmKeyInfo {
  id: string;
  name: string;
  hostId: string | null;
  tokenHead4: string;
  tokenTail4: string;
  status: string;
  spentMicro: number;
  budgetMicro: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AccountInfo {
  name: string;
  role: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  totpEnabled: boolean;
  wechatBound: boolean;
  wechatNickname: string | null;
  smsEnabled: boolean;
  planStatus: string | null;
  planExpiresAt: number | null;
  planId: string | null;
}

export interface UsageDay {
  date: string;
  relaySeconds: number;
  relayBytesUp: number;
  relayBytesDown: number;
  directBytesUp: number;
  directBytesDown: number;
  cloudAsrSeconds: number;
  localAsrSeconds: number;
  cloudTtsChars: number;
  localTtsChars: number;
  sessions: number;
}

export interface Capabilities {
  registration: "open" | "closed";
  emailEnabled: boolean;
  smsEnabled: boolean;
  captchaProvider: "arithmetic" | "none" | "aliyun";
  wechatLoginEnabled?: boolean;
  site?: { brand?: { zh?: string; en?: string }; termsUrl?: string; privacyUrl?: string; customerServiceUrl?: string };
}

/** 验证码载荷：arithmetic 用 captchaToken+captchaAnswer；aliyun 用 captchaVerifyParam。 */
export type CaptchaPayload = Record<string, string>;

/** subscribe 返回的支付形态数据（native=codeUrl / h5=h5Url / jsapi=WeixinJSBridge 参数）。 */
export interface WechatPayInfo {
  orderId?: string;
  codeUrl?: string;
  h5Url?: string;
  appId?: string;
  timeStamp?: string;
  nonceStr?: string;
  package?: string;
  signType?: string;
  paySign?: string;
}

export interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  mustChangePassword?: boolean;
  user?: { id: number; name: string };
  requiresTotp?: boolean;
  pendingToken?: string;
  name?: string;
}

async function jsonFetch<T>(path: string, init?: RequestInit, opts?: { probe?: boolean }): Promise<T> {
  const doFetch = (): Promise<Response> =>
    fetch(path, {
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...init,
    });
  let res = await doFetch();
  if (res.status === 401) {
    const outcome = await silentRefresh();
    if (outcome === "ok") {
      res = await doFetch(); // 续期成功 → 重试一次
    } else if (outcome === "invalid") {
      // 令牌真过期：非探测才跳登录；探测由调用方按未登录处理
      if (opts?.probe !== true) redirectToLogin();
      throw new ApiError(401, "UNAUTHORIZED", "session expired");
    } else {
      // 网络异常/超时：不跳登录，抛可区分错误让页面提示重试
      throw new ApiError(0, "REFRESH_FAILED", "session refresh failed (network)");
    }
  }
  if (res.status === 401) {
    throw new ApiError(401, "UNAUTHORIZED", "session expired");
  }
  if (!res.ok) {
    let code = "ERROR";
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* 非 JSON */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const api = {
  login(name: string, password: string): Promise<LoginResponse> {
    return jsonFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ name, password }) });
  },
  wechatConfirm(token: string): Promise<{ accessToken: string; refreshToken: string; user: { id: number; name: string } }> {
    return jsonFetch("/api/wechat/confirm", { method: "POST", body: JSON.stringify({ token }) });
  },
  logout(): Promise<void> {
    // 续期令牌在 HttpOnly cookie 里，服务端登出时读 cookie 吊销。
    return jsonFetch("/api/auth/logout", { method: "POST", body: "{}" });
  },
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    return jsonFetch("/api/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
  },
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
  },
  listHosts(): Promise<{ hosts: HostInfo[] }> {
    return jsonFetch("/api/hosts");
  },
  renameHost(hostId: string, name: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/hosts/${hostId}`, { method: "PATCH", body: JSON.stringify({ name }) });
  },
  revokeHost(hostId: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/hosts/${hostId}`, { method: "DELETE" });
  },
  createJoinToken(label: string | null, ttlSeconds: number): Promise<{ id: string; token: string; expiresAt: number }> {
    return jsonFetch("/api/hosts/join-token", { method: "POST", body: JSON.stringify({ label, ttlSeconds }) });
  },
  listJoinTokens(): Promise<{ tokens: JoinTokenInfo[] }> {
    return jsonFetch("/api/hosts/join-tokens");
  },
  revokeJoinToken(id: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/hosts/join-tokens/${id}`, { method: "DELETE" });
  },
  totpLogin(pendingToken: string, code: string, trustDevice?: boolean): Promise<{ accessToken: string; refreshToken: string; mustChangePassword: boolean }> {
    return jsonFetch("/api/auth/totp", { method: "POST", body: JSON.stringify({ pendingToken, code, trustDevice: trustDevice === true }) });
  },
  captchaChallenge(): Promise<{ token: string; question: string }> {
    return jsonFetch("/api/captcha/arithmetic", { method: "POST", body: "{}" });
  },
  captchaConfig(): Promise<{ provider: "arithmetic" | "none" | "aliyun"; sceneId?: string; prefix?: string }> {
    return jsonFetch("/api/captcha/config");
  },
  resetRequest(channel: "email" | "phone", identifier: string, captcha: CaptchaPayload): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/password/reset", { method: "POST", body: JSON.stringify({ channel, identifier, lang: getLang(), ...captcha }) });
  },
  resetConfirm(channel: "email" | "phone", identifier: string, code: string, newPassword: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/password/reset/confirm", { method: "POST", body: JSON.stringify({ channel, identifier, code, newPassword }) });
  },
  bindEmail(email: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/email", { method: "POST", body: JSON.stringify({ email, lang: getLang() }) });
  },
  verifyEmail(email: string, code: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/email/verify", { method: "POST", body: JSON.stringify({ email, code }) });
  },
  unbindEmail(): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/email/unbind", { method: "POST", body: "{}" });
  },
  enable2fa(): Promise<{ secret: string; otpauthUrl: string }> {
    return jsonFetch("/api/account/2fa/enable", { method: "POST", body: "{}" });
  },
  activate2fa(secret: string, code: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/2fa/verify", { method: "POST", body: JSON.stringify({ secret, code }) });
  },
  disable2fa(code: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/2fa/disable", { method: "POST", body: JSON.stringify({ code }) });
  },
  shareHost(hostId: string, name: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/hosts/${hostId}/share`, { method: "POST", body: JSON.stringify({ name }) });
  },
  listShares(hostId: string): Promise<{ shares: Array<{ userId: number; name: string; role: string }> }> {
    return jsonFetch(`/api/hosts/${hostId}/share`);
  },
  revokeShare(hostId: string, userId: number): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/hosts/${hostId}/share/${userId}`, { method: "DELETE" });
  },
  // ---- 08-saas：注册 / 验证 / 手机号 / 计费 / 删除 ----
  register(channel: "email" | "phone", identifier: string, password: string, captcha: CaptchaPayload): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/register", { method: "POST", body: JSON.stringify({ channel, identifier, password, lang: getLang(), ...captcha }) });
  },
  registerResend(channel: "email" | "phone", identifier: string, captcha: CaptchaPayload): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/register/resend", { method: "POST", body: JSON.stringify({ channel, identifier, lang: getLang(), ...captcha }) });
  },
  verifyAccount(channel: "email" | "phone", identifier: string, code: string): Promise<LoginResponse> {
    return jsonFetch("/api/auth/verify", { method: "POST", body: JSON.stringify({ channel, identifier, code }) });
  },
  bindPhone(phone: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/phone", { method: "POST", body: JSON.stringify({ phone }) });
  },
  verifyPhone(phone: string, code: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/phone/verify", { method: "POST", body: JSON.stringify({ phone, code }) });
  },
  unbindPhone(): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/phone/unbind", { method: "POST", body: "{}" });
  },
  listPlans(): Promise<{ plans: Array<{ id: string; name: string; hosts: number; priceCny: number; intervalMonths: number; vipTier?: number; bonusCredits?: number; isPopular?: boolean; isBestValue?: boolean }> }> {
    return jsonFetch("/api/billing/plans");
  },
  /** 经 hub 代理向 unicpay 下单（feature 121/36）。返回 { appOrderId, ticket, payParams }，payParams 形如 { kind, nativeUrl?, h5Url?, prepay? }。 */
  unicpayInitiate(planId: string, scene: "app" | "native" | "miniapp" | "alipay" | "h5" | "jsapi"): Promise<{ appOrderId: string; ticket?: string; payParams?: { kind?: string; nativeUrl?: string; h5Url?: string; prepay?: WechatPayInfo } }> {
    return jsonFetch("/api/billing/unicpay/initiate", { method: "POST", body: JSON.stringify({ goodsId: planId, scene }) });
  },
  subscription(): Promise<{ planStatus: string | null; planId: string | null; planExpiresAt: number | null; hostQuota: number | null; hostsInUse: number }> {
    return jsonFetch("/api/billing/subscription");
  },
  deleteAccount(password: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account", { method: "DELETE", body: JSON.stringify({ password }) });
  },
  accountInfo(opts?: { probe?: boolean }): Promise<AccountInfo> {
    return jsonFetch("/api/account", undefined, opts);
  },
  listLlmKeys(): Promise<{ keys: LlmKeyInfo[] }> {
    return jsonFetch("/api/account/llm/keys");
  },
  createLlmKey(name: string): Promise<{ keyId: string; token: string; name: string }> {
    return jsonFetch("/api/account/llm/keys", { method: "POST", body: JSON.stringify({ name }) });
  },
  revokeLlmKey(keyId: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/account/llm/keys/${keyId}/revoke`, { method: "POST", body: "{}" });
  },
  updateLlmKeyName(keyId: string, name: string): Promise<{ ok: boolean; name: string }> {
    return jsonFetch(`/api/account/llm/keys/${encodeURIComponent(keyId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
  },
  deleteLlmKey(keyId: string): Promise<{ ok: boolean }> {
    return jsonFetch(`/api/account/llm/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
  },
  llmUsage(from: string, to: string): Promise<{ models: LlmUsageModel[] }> {
    return jsonFetch(`/api/account/llm/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },
  llmModels(): Promise<{ models: LlmCatalogModel[] }> {
    return jsonFetch("/api/account/llm/models");
  },
  capabilities(): Promise<Capabilities> {
    return jsonFetch("/api/capabilities");
  },
  usage(from: string, to: string): Promise<{ days: UsageDay[] }> {
    return jsonFetch(`/api/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },
  usageHost(hostId: string, from: string, to: string): Promise<{ days: UsageDay[] }> {
    return jsonFetch(`/api/usage/host?hostId=${encodeURIComponent(hostId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },
  creditsBalance(): Promise<{ purchased: number; bonusCarried: number; bonusCurrent: number; total: number }> {
    return jsonFetch("/api/credits/balance");
  },
  creditsSpendDaily(from: string, to: string): Promise<{ totalMicro: number; days: Array<{ date: string; micro: number }> }> {
    return jsonFetch(`/api/credits/spend-daily?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },
  creditsRecharge(goodsId: string, scene: "app" | "native" | "miniapp" | "alipay"): Promise<{ appOrderId: string; payParams?: { kind?: string; nativeUrl?: string } }> {
    return jsonFetch("/api/credits/recharge", { method: "POST", body: JSON.stringify({ goodsId, scene }) });
  },
  creditsTiers(): Promise<Array<{ id: string; credits: number; priceCny: number; isPopular?: boolean; isBestValue?: boolean }>> {
    return jsonFetch<{ tiers: Array<{ id: string; credits: number; priceCny: number; isPopular?: boolean; isBestValue?: boolean }> }>("/api/credits/tiers").then((r) => r.tiers);
  },
  /** 主动查单 + 幂等补发（34-payment-order-check）。返回 { status, delivered }。 */
  checkOrder(appOrderId: string): Promise<{ status: string; delivered: boolean }> {
    return jsonFetch("/api/billing/order/check", { method: "POST", body: JSON.stringify({ appOrderId }) });
  },
};

// ---- 管理后台（/api/admin/*，独立会话；401 不触发用户续期/跳登录） ----

export interface AdminMe {
  userId: number;
  name: string;
  role: string;
}
export interface AdminUserRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  accountStatus: string;
  planStatus: string | null;
  planExpiresAt: number | null;
  createdAt: string;
  hostCount: number;
  emailVerified: boolean;
  phoneVerified: boolean;
  lastLoginAt: number | null;
  locked: boolean;
  lockedUntil: number | null;
}
/** 管理台建号入参（feature 16；feature 23 起 trialDays 替代 expiresAtMs）。 */
export interface AdminCreateUserInput {
  identifier: string;
  password: string;
  role: "user" | "readonly" | "operator" | "admin";
  mustChange: boolean;
  trialDays?: number;
}
export interface AdminHostRow {
  id: string;
  ownerId: number;
  ownerName: string;
  name: string;
  e2eePublicKey: string | null;
  online: boolean;
  createdAt: string;
}

export interface AdminNodeBandwidth {
  currentBps: number;
  avg5mBps: number;
  avg1hBps: number;
  avg24hBps: number;
  connections: number;
  activeStreams: number;
}

export interface AdminNodeRow {
  id: string;
  name: string;
  advertiseUrl: string;
  region: string;
  status: string;
  enabled: boolean;
  lastIp: string | null;
  capacity: number;
  weight: number;
  lastHeartbeat: number;
  hostCount: number;
  bandwidth: AdminNodeBandwidth;
  createdAt: number;
}
export interface AdminOrderRow {
  id: string;
  userId: number;
  planId: string;
  amountCny: number;
  status: string;
  channel: string | null;
  createdAt: number;
  paidAt: number | null;
}
export interface AdminPaymentRow {
  id: string;
  orderId: string;
  userId: number;
  channel: string;
  channelOrderId: string;
  amountCny: number;
  paidAt: number;
}
export interface AdminAuditRow {
  id: number;
  userId: number | null;
  event: string;
  detailJson: string;
  ip: string;
  source: string;
  actorUserId: number | null;
  createdAt: number;
}
export interface AdminSubscriptionRow {
  id: number;
  userId: number;
  planId: string;
  status: string;
  startedAt: number;
  expiresAt: number;
  createdAt: number;
}
export interface AdminUserDetail {
  user: AdminUserRow;
  hostCount: number;
  quota: number | null;
  subscriptions: AdminSubscriptionRow[];
  orders: AdminOrderRow[];
  payments: AdminPaymentRow[];
  audit: AdminAuditRow[];
}
export interface AdminCreditBalances {
  purchased: number;
  bonusCarried: number;
  bonusCurrent: number;
  total: number;
}
/** 点数流水行（`delta` / `balanceAfter` 为整数微单位，1 点数 = 10000）。 */
export interface AdminCreditLedgerRow {
  id: number;
  delta: number;
  bucket: string;
  reason: string;
  sourceType: string | null;
  sourceId: string | null;
  idempotencyKey: string | null;
  balanceAfter: number | null;
  createdAt: number;
}
export interface AdminUserCredits {
  balances: AdminCreditBalances;
  ledger: AdminCreditLedgerRow[];
}
export interface AdminDashboard {
  totalUsers: number;
  totalHosts: number;
  onlineHosts: number;
  tunnelCount: number;
  subscribed: number;
  dbSize: number;
  uptimeSeconds: number;
  version: string;
}
export interface AdminAnalytics {
  newUsersToday: number;
  funnel: { registered: number; subscribed: number; renewed: number };
  retention: Array<{ month: string; users: number; m1: number | null; m3: number | null; m6: number | null }>;
  revenue: {
    payingUsers: number;
    totalAmount: number;
    arpu: number;
    byChannel: Array<{ channel: string; count: number; amount: number }>;
    byPlan: Array<{ planId: string; count: number; amount: number }>;
  };
  churn: { monthlyChurnRate: number | null; avgLifetimeMonths: number | null };
  events: {
    dau: number;
    mau: number;
    newUsersToday: number;
    purchaseAttempts: { subscription: number; credit: number };
    retention: Array<{ date: string; users: number; d1: number | null; d7: number | null; d30: number | null }>;
  };
}
export interface AdminConfig {
  registration: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
  captchaProvider: string;
  e2eeMode: string;
  plans: Array<{ id: string; name: string; hosts: number; priceCny: number; intervalMonths: number }>;
  site: Record<string, unknown>;
}

/** 68：供应商配置（provider_configs，params 为 JSON 字符串）。 */
export interface AdminProviderConfigRow {
  provider: string;
  params: string;
  updatedAt: number;
}

/** 68：模型代理（services，prices/params 为 JSON 字符串）。 */
export interface AdminServiceRow {
  service: string;
  capability: string;
  displayName: string | null;
  params: string | null;
  unit: string;
  prices: string;
  enabled: boolean;
  updatedAt: number;
}

/** 68：上游服务（service_pool，一条 = service + provider + upstream_model）。 */
export interface AdminServicePoolRow {
  id: string;
  service: string;
  provider: string;
  upstreamModel: string | null;
  params: string | null;
  enabled: boolean;
  updatedAt: number;
}

/** 68：上游 Key（service = 凭据形态 llm/voice；capabilities = 可用能力，NULL/空 = 全部）。 */
export interface AdminUpstreamKeyRow {
  id: string;
  provider: string;
  service: string;
  credentialType: string | null;
  label: string;
  weight: number;
  enabled: boolean;
  capabilities: string | null;
  maxConcurrency: number;
  kekVersion: number;
  createdAt: number;
  revokedAt: number | null;
}

async function adminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let code = "ERROR";
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* 非 JSON */
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const adminApi = {
  login(totp: string, trustDevice?: boolean): Promise<{ ok: boolean }> {
    return adminJson("/api/admin/login", { method: "POST", body: JSON.stringify({ totp, trustDevice: trustDevice === true }) });
  },
  logout(): Promise<{ ok: boolean }> {
    return adminJson("/api/admin/logout", { method: "POST", body: "{}" });
  },
  me(): Promise<AdminMe> {
    return adminJson("/api/admin/me");
  },
  dashboard(): Promise<AdminDashboard> {
    return adminJson("/api/admin/dashboard");
  },
  analytics(): Promise<AdminAnalytics> {
    return adminJson("/api/admin/analytics");
  },
  users(params?: { q?: string; role?: string; status?: string; lastLoginFrom?: number; lastLoginTo?: number; limit?: number; offset?: number }): Promise<{ users: AdminUserRow[]; total: number }> {
    const sp = new URLSearchParams();
    if (params?.q) sp.set("q", params.q);
    if (params?.role) sp.set("role", params.role);
    if (params?.status) sp.set("status", params.status);
    if (params?.lastLoginFrom !== undefined) sp.set("lastLoginFrom", String(params.lastLoginFrom));
    if (params?.lastLoginTo !== undefined) sp.set("lastLoginTo", String(params.lastLoginTo));
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.offset !== undefined) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return adminJson(`/api/admin/users${qs !== "" ? `?${qs}` : ""}`);
  },
  userAction(id: number, action: string, body: Record<string, unknown>): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/users/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });
  },
  createUser(input: AdminCreateUserInput & { reason?: string }): Promise<{ ok: boolean; user: AdminUserRow }> {
    return adminJson("/api/admin/users", { method: "POST", body: JSON.stringify(input) });
  },
  userDetail(id: number): Promise<AdminUserDetail> {
    return adminJson(`/api/admin/users/${id}`);
  },
  /** 管理面：某用户的点数余额与流水（GET /api/admin/credits，2026-11-04 接入详情页）。 */
  userCredits(id: number): Promise<AdminUserCredits> {
    return adminJson(`/api/admin/credits?userId=${id}`);
  },
  hosts(params?: { q?: string; online?: string; e2ee?: string; createdFrom?: number; createdTo?: number; limit?: number; offset?: number }): Promise<{ hosts: AdminHostRow[]; total: number }> {
    const sp = new URLSearchParams();
    if (params?.q) sp.set("q", params.q);
    if (params?.online) sp.set("online", params.online);
    if (params?.e2ee) sp.set("e2ee", params.e2ee);
    if (params?.createdFrom !== undefined) sp.set("createdFrom", String(params.createdFrom));
    if (params?.createdTo !== undefined) sp.set("createdTo", String(params.createdTo));
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.offset !== undefined) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return adminJson(`/api/admin/hosts${qs !== "" ? `?${qs}` : ""}`);
  },
  revokeHost(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/hosts/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  nodes(params?: { limit?: number; offset?: number }): Promise<{ nodes: AdminNodeRow[]; total: number }> {
    const q = new URLSearchParams();
    if (params?.limit !== undefined) q.set("limit", String(params.limit));
    if (params?.offset !== undefined) q.set("offset", String(params.offset));
    const qs = q.toString();
    return adminJson(`/api/admin/nodes${qs !== "" ? `?${qs}` : ""}`);
  },
  createNode(input: { name: string; advertiseUrl: string; capacity?: number; weight?: number }): Promise<{ nodeId: string; token: string }> {
    return adminJson("/api/admin/nodes", { method: "POST", body: JSON.stringify(input) });
  },
  revokeNode(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/nodes/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  nodeDetail(id: string): Promise<{ node: AdminNodeRow; hosts: Array<{ id: string; name: string; ownerId: number; online: boolean }> }> {
    return adminJson(`/api/admin/nodes/${encodeURIComponent(id)}`);
  },
  /** 71 U5：集群实例列表 + relay.builtin 当前值。 */
  cluster(): Promise<{ instances: Array<{ url: string; region: string; version: string | null; lastSeenAt: number }>; relayBuiltin: boolean }> {
    return adminJson("/api/admin/cluster");
  },
  setRelayBuiltin(builtin: boolean): Promise<{ ok: boolean; builtin: boolean; restartRequired: boolean }> {
    return adminJson("/api/admin/cluster/relay-builtin", { method: "POST", body: JSON.stringify({ builtin }) });
  },
  renameNode(id: string, name: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/nodes/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ name, reason }) });
  },
  enableNode(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/nodes/${encodeURIComponent(id)}/enable`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  disableNode(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/nodes/${encodeURIComponent(id)}/disable`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  relayJoinTokens(): Promise<{ tokens: Array<{ id: string; name: string; createdAt: number; revokedAt: number | null; joinCount: number; tokenTail4: string; tokenPlaintext: string }> }> {
    return adminJson("/api/admin/join-tokens");
  },
  createRelayJoinToken(name: string): Promise<{ id: string; name: string; token: string }> {
    return adminJson("/api/admin/join-tokens", { method: "POST", body: JSON.stringify({ name }) });
  },
  renameRelayJoinToken(id: string, name: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/join-tokens/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ name, reason }) });
  },
  revokeRelayJoinToken(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/join-tokens/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  relayJoinTokenPlaintext(id: string): Promise<{ token: string }> {
    return adminJson(`/api/admin/join-tokens/${encodeURIComponent(id)}/token`);
  },
  relayJoinTokenEvents(id: string): Promise<{ events: Array<{ id: string; nodeId: string; srcIp: string | null; at: number }> }> {
    return adminJson(`/api/admin/join-tokens/${encodeURIComponent(id)}/events`);
  },
  orders(params?: { q?: string; planId?: string; status?: string; limit?: number; offset?: number }): Promise<{ orders: AdminOrderRow[]; total: number }> {
    const sp = new URLSearchParams();
    if (params?.q) sp.set("q", params.q);
    if (params?.planId) sp.set("planId", params.planId);
    if (params?.status) sp.set("status", params.status);
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.offset !== undefined) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return adminJson(`/api/admin/orders${qs !== "" ? `?${qs}` : ""}`);
  },
  payments(): Promise<{ payments: AdminPaymentRow[] }> {
    return adminJson("/api/admin/payments");
  },
  refundOrder(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/orders/${encodeURIComponent(id)}/refund`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  credit(body: { userId: number; planId: string; amountCny: number; days: number; reason: string }): Promise<{ ok: boolean; orderId: string }> {
    return adminJson("/api/admin/credit", { method: "POST", body: JSON.stringify(body) });
  },
  audit(params?: { userId?: number; event?: string; source?: string; limit?: number; offset?: number }): Promise<{ events: AdminAuditRow[]; total: number }> {
    const q = new URLSearchParams();
    if (params?.userId !== undefined) q.set("userId", String(params.userId));
    if (params?.event !== undefined) q.set("event", params.event);
    if (params?.source !== undefined) q.set("source", params.source);
    if (params?.limit !== undefined) q.set("limit", String(params.limit));
    if (params?.offset !== undefined) q.set("offset", String(params.offset));
    const qs = q.toString();
    return adminJson(`/api/admin/audit${qs !== "" ? `?${qs}` : ""}`);
  },
  health(): Promise<{
    uptimeSeconds: number;
    tunnelCount: number;
    onlineHosts: number;
    dbSize: number;
    version: string;
    lastBackupAt: number | null;
    events: { subscriptions: number };
    userCache: { size: number };
    usage: { flushRows: number; flushMs: number; dirty: number };
    n2: { lastBodyBytes: number };
    relay: { nodes: number; connections: number };
  }> {
    return adminJson("/api/admin/health");
  },
  config(): Promise<AdminConfig> {
    return adminJson("/api/admin/config");
  },
  admins(): Promise<{ admins: Array<{ id: number; name: string; email: string | null; role: string }> }> {
    return adminJson("/api/admin/admins");
  },
  setRole(id: number, role: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/admins/${id}/role`, { method: "POST", body: JSON.stringify({ role, reason }) });
  },
  removeAdmin(id: number, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/admins/${id}/remove`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  upstreamProviders(): Promise<{ providers: Array<{ provider: string; service: string; credentialType: string; fields: string[]; paramsFields?: string[] }> }> {
    return adminJson("/api/admin/llm/upstream-providers");
  },
  llmUpstreamKeys(): Promise<{ keys: AdminUpstreamKeyRow[] }> {
    return adminJson("/api/admin/llm/upstream-keys");
  },
  createLlmUpstreamKey(input: Record<string, unknown>): Promise<{ key: { id: string } }> {
    return adminJson("/api/admin/llm/upstream-keys", { method: "POST", body: JSON.stringify(input) });
  },
  updateLlmUpstreamKey(id: string, input: Record<string, unknown>): Promise<{ key: unknown }> {
    return adminJson(`/api/admin/llm/upstream-keys/${id}`, { method: "PUT", body: JSON.stringify(input) });
  },
  revokeLlmUpstreamKey(id: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/llm/upstream-keys/${id}`, { method: "DELETE", body: "{}" });
  },
  revealLlmUpstreamKey(id: string): Promise<{ secret: string }> {
    return adminJson(`/api/admin/llm/upstream-keys/${id}/reveal`);
  },
  // ---- 68：供应商配置 / 模型代理 / 上游服务 ----
  providerConfigs(): Promise<{ configs: AdminProviderConfigRow[] }> {
    return adminJson("/api/admin/provider-configs");
  },
  updateProviderConfig(provider: string, input: { params: unknown }): Promise<{ config: AdminProviderConfigRow }> {
    return adminJson(`/api/admin/provider-configs/${encodeURIComponent(provider)}`, { method: "PUT", body: JSON.stringify(input) });
  },
  services(): Promise<{ services: AdminServiceRow[] }> {
    return adminJson("/api/admin/services");
  },
  updateService(service: string, input: { capability: string; unit: string; prices: unknown; params?: unknown; displayName?: string; enabled: boolean }): Promise<{ service: AdminServiceRow }> {
    return adminJson(`/api/admin/services/${encodeURIComponent(service)}`, { method: "PUT", body: JSON.stringify(input) });
  },
  deleteService(service: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/services/${encodeURIComponent(service)}`, { method: "DELETE", body: "{}" });
  },
  servicePool(service?: string): Promise<{ pool: AdminServicePoolRow[] }> {
    const qs = service === undefined ? "" : `?service=${encodeURIComponent(service)}`;
    return adminJson(`/api/admin/service-pool${qs}`);
  },
  upsertServicePool(input: { id?: string; service: string; provider: string; upstreamModel?: string | null; params?: unknown; enabled: boolean }): Promise<{ entry: AdminServicePoolRow }> {
    return adminJson("/api/admin/service-pool", { method: "POST", body: JSON.stringify(input) });
  },
  deleteServicePool(id: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/service-pool/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
  },
  llmRouters(): Promise<{ routers: Array<{ id: string; service: string; name: string; tokenId: string; status: string; lastIp: string | null; publicBaseUrl: string | null; createdAt: number; approvedAt: number | null; lastSeenAt: number | null }> }> {
    return adminJson("/api/admin/llm/routers");
  },
  approveLlmRouter(id: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/llm/routers/${id}/approve`, { method: "POST", body: "{}" });
  },
  enableLlmRouter(id: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/llm/routers/${id}/enable`, { method: "POST", body: "{}" });
  },
  disableLlmRouter(id: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/llm/routers/${id}/disable`, { method: "POST", body: "{}" });
  },
  deleteLlmRouter(id: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/llm/routers/${id}/delete`, { method: "POST", body: "{}" });
  },
  llmRouterJoinTokens(): Promise<{ tokens: Array<{ id: string; service: string; label: string; expiresAt: number; usedAt: number | null; createdAt: number }> }> {
    return adminJson("/api/admin/llm/router-join-tokens");
  },
  createLlmRouterJoinToken(input: { label?: string; ttlMs?: number; service?: string }): Promise<{ id: string; token: string; label: string; service: string; expiresAt: number }> {
    return adminJson("/api/admin/llm/router-join-tokens", { method: "POST", body: JSON.stringify(input) });
  },
};

/**
 * 简易事件流订阅（host 在线/离线实时推送）。
 *
 * 70 A3：
 * - 断线指数退避重连（1s→2s→4s…封顶 30s）；
 * - 响应服务端 ping（否则 60s 被判死）；
 * - 客户端看门狗：距上次收到 ping 超过 60s → 主动弃用连接重连（半开 TCP 检测）；
 * - 断开后静默续期一次：token 真过期 → 引导重新登录并停止重连。
 */
export function subscribeEvents(onEvent: (e: { type: string; hostId: string }) => void): () => void {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/api/events`;
  let closed = false;
  let ws: WebSocket | null = null;
  let retryMs = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    const sock = new WebSocket(url);
    ws = sock;
    let lastPingAt = Date.now();
    let watchdog: ReturnType<typeof setInterval> | null = null;

    const scheduleReconnect = (): void => {
      if (closed) return;
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
      // 并行静默续期：token 真过期 → 引导重新登录并停止重连（A3 验收 #4）。
      void silentRefresh().then((r) => {
        if (r === "invalid" && !closed) {
          closed = true;
          if (timer !== null) clearTimeout(timer);
          redirectToLogin();
        }
      });
    };

    // 看门狗：60s 内没收到 ping → 半开连接，弃用旧 socket 直接重连（不等 close 握手）。
    watchdog = setInterval(() => {
      if (Date.now() - lastPingAt > 60_000) {
        if (watchdog !== null) clearInterval(watchdog);
        if (ws === sock) ws = null;
        sock.onclose = null;
        try {
          sock.close();
        } catch {
          /* 忽略 */
        }
        scheduleReconnect();
      }
    }, 30_000);

    sock.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data)) as { type: string; hostId?: string };
        if (data.type === "ping") {
          lastPingAt = Date.now();
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "pong" }));
          return;
        }
        onEvent(data as { type: string; hostId: string });
      } catch {
        /* 忽略坏帧 */
      }
    };
    sock.onopen = () => {
      retryMs = 1000; // 连上即重置退避
      lastPingAt = Date.now();
    };
    sock.onclose = () => {
      if (watchdog !== null) clearInterval(watchdog);
      if (ws === sock) ws = null;
      scheduleReconnect();
    };
  };

  connect();
  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    ws?.close();
  };
}
