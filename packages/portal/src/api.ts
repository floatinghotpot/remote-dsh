/**
 * api.ts — portal 的 hub API client（同源 fetch，httpOnly Cookie 会话）。
 */
export interface HostInfo {
  id: string;
  name: string;
  online: boolean;
  createdAt: string;
  role?: "owner" | "member";
}

export interface JoinTokenInfo {
  id: string;
  label: string | null;
  fingerprint: string;
  expiresAt: number;
  revoked: boolean;
}

export interface AccountInfo {
  name: string;
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
  site?: { name?: string; url?: string; productUrl?: string; termsUrl?: string; privacyUrl?: string; footer?: Array<{ text: string; href?: string }> };
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

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
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
  totpLogin(pendingToken: string, code: string): Promise<{ accessToken: string; refreshToken: string; mustChangePassword: boolean }> {
    return jsonFetch("/api/auth/totp", { method: "POST", body: JSON.stringify({ pendingToken, code }) });
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
  accountInfo(): Promise<AccountInfo> {
    return jsonFetch("/api/account");
  },
  capabilities(): Promise<Capabilities> {
    return jsonFetch("/api/capabilities");
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
