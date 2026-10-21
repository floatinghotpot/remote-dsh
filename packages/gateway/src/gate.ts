/**
 * gate.ts — 访问口令（accessCode）门禁的公共组件：challenge 页 + cookie 校验。
 *
 * 供隧道口（join.ts 的明文分发器）与直连口（server.ts）共用，避免两份实现漂移。
 * 对应 req 的「固定口令 / 门禁」（gateway.accessCode，feature 15）。
 */
import { GATE_COOKIE, GATE_COOKIE_TTL_MS, signGateCookie, verifyGateCookie, verifyGateCode } from "./access-gate.ts";

export { GATE_COOKIE, GATE_COOKIE_TTL_MS, signGateCookie, verifyGateCookie, verifyGateCode };

/** gate challenge 错误态（语言中立 key，gateChallengeHtml 内本地化）。 */
export type GateError = "wrong" | "locked" | null;

/** 从 Accept-Language 头取首个语言（数组取首、缺失 undefined）。 */
export function headerAcceptLanguage(headers: Record<string, string | string[] | undefined>): string | undefined {
  const al = headers["accept-language"];
  return Array.isArray(al) ? al.join(",") : typeof al === "string" ? al : undefined;
}

/** 从 cookie 头提取 rdsh_gate 值（无则 null）。 */
export function gateCookieFromHeader(cookieHeader: string | string[] | undefined): string | null {
  const s = Array.isArray(cookieHeader) ? cookieHeader.join(";") : typeof cookieHeader === "string" ? cookieHeader : "";
  for (const part of s.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === GATE_COOKIE) return part.slice(idx + 1).trim();
  }
  return null;
}

/** HTML 转义（challenge 页内插 hostName/actionPath 防注入；actionPath 已 percent-encoded，此处为纵深防御）。 */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 访问口令 challenge 页（内联，零外部依赖；Accept-Language 含 zh → 中文，否则英文兜底）。 */
export function gateChallengeHtml(hostName: string, actionPath: string, error: GateError, acceptLanguage?: string): string {
  const safeHost = escapeHtml(hostName);
  const safePath = escapeHtml(actionPath);
  const zh = typeof acceptLanguage === "string" && /zh/i.test(acceptLanguage);
  const t = zh
    ? { title: "访问密码", heading: `主机「${safeHost}」受访问密码保护`, note: "此密码由主机所有者设置，hub 无法绕过。", placeholder: "请输入访问密码", submit: "进入", wrong: "访问密码错误", locked: "尝试次数过多，请稍后再试" }
    : { title: "Access code", heading: `Host "${safeHost}" is protected by an access code`, note: "This code is set by the host owner; the hub cannot bypass it.", placeholder: "Enter access code", submit: "Enter", wrong: "Incorrect access code", locked: "Too many attempts — please try again later" };
  const errHtml = error === null ? "" : `<p style="color:#dc2626;font-size:13px;margin:10px 0 0">${error === "wrong" ? t.wrong : t.locked}</p>`;
  return (
    `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${t.title}</title>` +
    `<body style="font-family:system-ui,sans-serif;background:#f6f7f9;margin:0">` +
    `<div style="max-width:360px;margin:64px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
    `<h1 style="font-size:18px;margin:0 0 8px">${t.heading}</h1>` +
    `<p style="font-size:13px;color:#6b7280;margin:0 0 16px">${t.note}</p>` +
    `<form method="POST" action="${safePath}">` +
    `<input name="gate_code" type="password" autocomplete="off" autofocus placeholder="${t.placeholder}" style="width:100%;box-sizing:border-box;height:38px;border:1px solid #d1d5db;border-radius:8px;padding:0 12px;font-size:14px">` +
    `<button type="submit" style="width:100%;margin-top:12px;height:38px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer">${t.submit}</button>` +
    `</form>${errHtml}</div></body></html>`
  );
}

/** 无口令直连的 403 页：ticket 只给 App 用，人肉访问唯一路径 = 设口令；给出两种启动方式各自的口令设置方法。 */
export function directForbiddenHtml(acceptLanguage?: string): string {
  const zh = typeof acceptLanguage === "string" && /zh/i.test(acceptLanguage);
  const t = zh
    ? {
        title: "直接访问需要设置访问口令",
        heading: "无法直接访问",
        note: "为了保护这台主机，直接访问前需要先设置一个访问口令。",
        how: "如何设置（取决于主机的启动方式）：",
        opt1: "命令行启动：在主机上执行 rdsh host gate set <口令>",
        opt2: "插件启动（dsh-web-remote）：在 DSH 的「远程访问」面板里设置访问密码",
      }
    : {
        title: "Direct access requires an access code",
        heading: "Direct access denied",
        note: "To protect this host, direct access requires an access code.",
        how: "How to set it (depends on how the host was started):",
        opt1: "CLI: run rdsh host gate set <code> on the host",
        opt2: "Plugin (dsh-web-remote): set the access code in the DSH \"Remote Access\" panel",
      };
  return (
    `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${t.title}</title>` +
    `<body style="font-family:system-ui,sans-serif;background:#f6f7f9;margin:0">` +
    `<div style="max-width:440px;margin:64px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
    `<h1 style="font-size:18px;margin:0 0 8px">${t.heading}</h1>` +
    `<p style="font-size:13px;color:#6b7280;margin:0 0 12px">${t.note}</p>` +
    `<p style="font-size:14px;color:#1f2937;margin:0 0 6px">${t.how}</p>` +
    `<ol style="font-size:14px;color:#1f2937;line-height:1.8;margin:0;padding-left:20px">` +
    `<li>${escapeHtml(t.opt1)}</li>` +
    `<li>${escapeHtml(t.opt2)}</li>` +
    `</ol></div></body></html>`
  );
}

/** 全局失败封顶（直连口有真实客户端 IP，按 IP 维度限流更合理；与 join 的全局封顶保持同量级）。 */
export interface GateLimiter {
  /** 是否处于锁定（true = 拒绝校验，直接回 locked challenge）。 */
  blocked(ip: string): boolean;
  /** 记录一次失败；达上限后进入锁定。 */
  fail(ip: string): void;
  /** 成功清除计数。 */
  clear(ip: string): void;
}

/** 创建 gate 失败限流器：每 IP 连续错 N 次锁定 L 毫秒。 */
export function createGateLimiter(maxFails = 10, lockMs = 60_000): GateLimiter {
  const states = new Map<string, { fails: number; lockedUntil: number }>();
  return {
    blocked(ip: string): boolean {
      const s = states.get(ip);
      if (s === undefined) return false;
      if (s.lockedUntil > Date.now()) return true;
      if (s.lockedUntil !== 0) {
        s.lockedUntil = 0;
        s.fails = 0;
      }
      return false;
    },
    fail(ip: string): void {
      const s = states.get(ip) ?? { fails: 0, lockedUntil: 0 };
      s.fails += 1;
      if (s.fails >= maxFails) {
        s.fails = 0;
        s.lockedUntil = Date.now() + lockMs;
      }
      states.set(ip, s);
    },
    clear(ip: string): void {
      states.delete(ip);
    },
  };
}
