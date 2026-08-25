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
  resetRequest(email: string, captchaToken: string, captchaAnswer: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/password/reset", { method: "POST", body: JSON.stringify({ email, captchaToken, captchaAnswer }) });
  },
  resetConfirm(email: string, code: string, newPassword: string): Promise<{ ok: boolean }> {
    return jsonFetch("/api/auth/password/reset/confirm", { method: "POST", body: JSON.stringify({ email, code, newPassword }) });
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
