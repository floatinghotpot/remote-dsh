/**
 * api.ts — portal 的 hub API client（同源 fetch，httpOnly Cookie 会话）。
 */

/** sessionStorage 里的 refresh token key（登录时写入，401 静默续期使用）。 */
export const REFRESH_KEY = "rdsh_refresh";
const REFRESH_TIMEOUT_MS = 8000;

/** 续期结果分级：ok=成功 / invalid=令牌真过期 / transient=网络异常或超时。 */
type RefreshResult = "ok" | "invalid" | "transient";

/** 单飞静默续期：并发 401 只触发一次 refresh；成功换新 cookie + 轮换 refresh token。 */
let refreshPromise: Promise<RefreshResult> | null = null;
function silentRefresh(): Promise<RefreshResult> {
  const rt = sessionStorage.getItem(REFRESH_KEY);
  if (rt === null) return Promise.resolve("invalid");
  if (refreshPromise === null) {
    refreshPromise = (async (): Promise<RefreshResult> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: rt }),
          signal: ctrl.signal,
        });
        if (res.status === 401 || res.status === 403) return "invalid";
        if (!res.ok) return "transient";
        const body = (await res.json()) as { refreshToken?: string };
        if (typeof body.refreshToken === "string" && body.refreshToken !== "") {
          sessionStorage.setItem(REFRESH_KEY, body.refreshToken);
        }
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

/** 续期确认为令牌过期 → 清本地会话，整页跳登录并携带回跳路径（相对 /portal）。 */
function redirectToLogin(): void {
  sessionStorage.removeItem(REFRESH_KEY);
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
}

export interface JoinTokenInfo {
  id: string;
  label: string | null;
  fingerprint: string;
  createdAt: string;
  expiresAt: number;
  revoked: boolean;
}

export interface AccountInfo {
  name: string;
  role: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  totpEnabled: boolean;
  smsEnabled: boolean;
  planStatus: string | null;
  planExpiresAt: number | null;
  planId: string | null;
}

export interface Capabilities {
  registration: "open" | "closed";
  emailEnabled: boolean;
  smsEnabled: boolean;
  captchaProvider: "arithmetic" | "none" | "aliyun";
  beian?: { icp?: string; icpUrl?: string; gongan?: string; gonganUrl?: string };
  site?: { brand?: string; name?: string; url?: string; productUrl?: string; termsUrl?: string; privacyUrl?: string; customerServiceUrl?: string; footer?: Array<{ text: string; href?: string }> };
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
  logout(refreshToken: string): Promise<void> {
    return jsonFetch("/api/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) });
  },
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    return jsonFetch("/api/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
  },
  changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
  },
  firstPassword(name: string, newPassword: string): Promise<LoginResponse> {
    return jsonFetch("/api/auth/first-password", { method: "POST", body: JSON.stringify({ name, newPassword }) });
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
    return jsonFetch("/api/auth/password/reset", { method: "POST", body: JSON.stringify({ channel, identifier, ...captcha }) });
  },
  resetConfirm(channel: "email" | "phone", identifier: string, code: string, newPassword: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/password/reset/confirm", { method: "POST", body: JSON.stringify({ channel, identifier, code, newPassword }) });
  },
  bindEmail(email: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account/email", { method: "POST", body: JSON.stringify({ email }) });
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
    return jsonFetch("/api/auth/register", { method: "POST", body: JSON.stringify({ channel, identifier, password, ...captcha }) });
  },
  registerResend(channel: "email" | "phone", identifier: string, captcha: CaptchaPayload): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/register/resend", { method: "POST", body: JSON.stringify({ channel, identifier, ...captcha }) });
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
  listPlans(): Promise<{ plans: Array<{ id: string; name: string; hosts: number; priceCny: number; intervalDays: number }> }> {
    return jsonFetch("/api/billing/plans");
  },
  subscribe(planId: string, form?: "native" | "h5" | "jsapi"): Promise<{ orderId: string; paid: boolean; payInfo?: WechatPayInfo }> {
    return jsonFetch("/api/billing/subscribe", { method: "POST", body: JSON.stringify(form === undefined ? { planId } : { planId, form }) });
  },
  subscription(): Promise<{ planStatus: string | null; planId: string | null; planExpiresAt: number | null; hostQuota: number | null; hostsInUse: number }> {
    return jsonFetch("/api/billing/subscription");
  },
  cancelSubscription(): Promise<{ ok: boolean }> {
    return jsonFetch("/api/billing/cancel", { method: "POST", body: "{}" });
  },
  deleteAccount(password: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/account", { method: "DELETE", body: JSON.stringify({ password }) });
  },
  accountInfo(opts?: { probe?: boolean }): Promise<AccountInfo> {
    return jsonFetch("/api/account", undefined, opts);
  },
  capabilities(): Promise<Capabilities> {
    return jsonFetch("/api/capabilities");
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
export interface AdminConfig {
  registration: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
  captchaProvider: string;
  e2eeMode: string;
  plans: Array<{ id: string; name: string; hosts: number; priceCny: number; intervalDays: number }>;
  site: Record<string, unknown>;
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
  users(params?: { q?: string; limit?: number; offset?: number }): Promise<{ users: AdminUserRow[]; total: number }> {
    const sp = new URLSearchParams();
    if (params?.q) sp.set("q", params.q);
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.offset !== undefined) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return adminJson(`/api/admin/users${qs !== "" ? `?${qs}` : ""}`);
  },
  userAction(id: number, action: string, body: Record<string, unknown>): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/users/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });
  },
  userDetail(id: number): Promise<AdminUserDetail> {
    return adminJson(`/api/admin/users/${id}`);
  },
  hosts(params?: { q?: string; limit?: number; offset?: number }): Promise<{ hosts: AdminHostRow[]; total: number }> {
    const sp = new URLSearchParams();
    if (params?.q) sp.set("q", params.q);
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.offset !== undefined) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return adminJson(`/api/admin/hosts${qs !== "" ? `?${qs}` : ""}`);
  },
  revokeHost(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/hosts/${encodeURIComponent(id)}/revoke`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  orders(): Promise<{ orders: AdminOrderRow[] }> {
    return adminJson("/api/admin/orders");
  },
  payments(): Promise<{ payments: AdminPaymentRow[] }> {
    return adminJson("/api/admin/payments");
  },
  refundOrder(id: string, reason: string): Promise<{ ok: boolean }> {
    return adminJson(`/api/admin/orders/${encodeURIComponent(id)}/refund`, { method: "POST", body: JSON.stringify({ reason }) });
  },
  credit(body: { userId: number; planId: string; amountCny: number; expiresAtMs: number; reason: string }): Promise<{ ok: boolean; orderId: string }> {
    return adminJson("/api/admin/credit", { method: "POST", body: JSON.stringify(body) });
  },
  audit(params?: { userId?: number; event?: string; source?: string }): Promise<{ events: AdminAuditRow[] }> {
    const q = new URLSearchParams();
    if (params?.userId !== undefined) q.set("userId", String(params.userId));
    if (params?.event !== undefined) q.set("event", params.event);
    if (params?.source !== undefined) q.set("source", params.source);
    const qs = q.toString();
    return adminJson(`/api/admin/audit${qs !== "" ? `?${qs}` : ""}`);
  },
  health(): Promise<{ uptimeSeconds: number; tunnelCount: number; onlineHosts: number; dbSize: number; version: string; lastBackupAt: number | null }> {
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
};

/** 简易事件流订阅（host 在线/离线实时推送）。 */
export function subscribeEvents(onEvent: (e: { type: string; hostId: string }) => void): () => void {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/api/events`);
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(String(msg.data)) as { type: string; hostId: string });
    } catch {
      /* 忽略坏帧 */
    }
  };
  return () => ws.close();
}
