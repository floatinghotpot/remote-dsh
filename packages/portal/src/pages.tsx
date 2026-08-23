/**
 * portal 页面 + 手写路由（零依赖：不引 react-router）。
 *
 * 会话：httpOnly Cookie（fetch credentials include）；refreshToken 存 sessionStorage
 * 供登出吊销（hub 门户自身代码，无第三方脚本）。
 */
import { useEffect, useState } from "react";
import { api, ApiError, subscribeEvents } from "./api.ts";
import type { HostInfo } from "./api.ts";

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
  if (path === "/settings/password") return <PasswordPage />;
  if (path === "/hosts" || path === "/") return <HostsPage />;
  return <HostsPage />; // 未知路径兜底 host 列表
}

function Shell({ title, children, onLogout }: { title: string; children: React.ReactNode; onLogout?: () => void }): React.JSX.Element {
  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18 }}>{title}</h1>
        {onLogout !== undefined && (
          <button onClick={onLogout} style={btnStyle()}>退出登录</button>
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

function useError(): { err: string; clear: () => void; run: (fn: () => Promise<void>) => Promise<boolean> } {
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      setErr("");
      await fn();
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  return { err, clear: () => setErr(""), run };
}

// ---- 登录 / 首次设密 ----

function Login(): React.JSX.Element {
  const isFirst = new URLSearchParams(window.location.search).get("first") === "1";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const { err, run } = useError();

  const submit = (): void => {
    void run(async () => {
      if (isFirst) {
        const r = await api.firstPassword(name, password);
        sessionStorage.setItem(REFRESH_KEY, r.refreshToken);
        navigate("/hosts");
      } else {
        const r = await api.login(name, password);
        sessionStorage.setItem(REFRESH_KEY, r.refreshToken);
        navigate(r.mustChangePassword ? "/login?first=1" : "/hosts");
      }
    });
  };

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>rdsh · 你的机器，随处可达</h1>
      <p style={{ color: "#666", fontSize: 13, marginBottom: 24 }}>
        {isFirst ? "首次登录：设置你的密码" : "登录后访问你的 DSH 智能体"}
      </p>
      {field(isFirst ? "用户名（管理员创建）" : "用户名", name, setName)}
      {field(isFirst ? "新密码（至少 8 位）" : "密码", password, setPassword, "password")}
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ ...btnStyle(), width: "100%", marginTop: 8 }}>
        {isFirst ? "设置密码并登录" : "登录"}
      </button>
    </div>
  );
}

// ---- host 列表 ----

function HostsPage(): React.JSX.Element {
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [bindOpen, setBindOpen] = useState(false);
  const [code, setCode] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const { err, run } = useError();

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

  const bind = (): void => {
    void run(async () => {
      await api.bind(code.trim());
      setBindOpen(false);
      setCode("");
      load();
    });
  };

  const revoke = (hostId: string): void => {
    if (!window.confirm("吊销该 host？其隧道立即断开，需重新绑定。")) return;
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

  return (
    <Shell title="rdsh · 我的机器" onLogout={logout}>
      {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => setBindOpen(true)} style={btnStyle()}>绑定新机器</button>
      </div>

      {bindOpen && (
        <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <p style={{ marginTop: 0, fontSize: 13 }}>
            在机器上运行 <code>rdsh join https://{window.location.host}</code>，把终端显示的 6 位配对码填到下面（10 分钟内有效）：
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="配对码" style={{ ...inputStyle(), width: 160 }} maxLength={6} />
            <button onClick={bind} style={btnStyle()}>绑定</button>
            <button onClick={() => setBindOpen(false)} style={btnStyle("ghost")}>取消</button>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: "#666" }}>加载中…</p>
      ) : hosts.length === 0 ? (
        <p style={{ color: "#666" }}>还没有绑定机器 —— 用上面的“绑定新机器”接入你的第一台 DSH。</p>
      ) : (
        <div>
          {hosts.map((h) => (
            <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid #eee", borderRadius: 8, marginBottom: 8 }}>
              <span style={{ color: h.online ? "#16a34a" : "#999", fontSize: 14 }}>{h.online ? "●" : "○"}</span>
              <span style={{ fontWeight: 500 }}>{h.name}</span>
              <span style={{ color: "#666", fontSize: 12 }}>{h.online ? "在线" : "离线"}</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button onClick={() => enterHost(h.id)} style={btnStyle()}>进入</button>
                <button onClick={() => { setRenameId(h.id); setRenameName(h.name); }} style={btnStyle("ghost")}>改名</button>
                <button onClick={() => revoke(h.id)} style={btnStyle("danger")}>吊销</button>
              </div>
              {renameId === h.id && (
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={renameName} onChange={(e) => setRenameName(e.target.value)} style={{ ...inputStyle(), width: 140 }} />
                  <button onClick={() => rename(h.id)} style={btnStyle()}>保存</button>
                </div>
              )}
            </div>
          ))}
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

// ---- 修改密码 ----

function PasswordPage(): React.JSX.Element {
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
    <Shell title="修改密码" onLogout={logout}>
      {done && <p style={{ color: "#16a34a", fontSize: 14 }}>密码已修改，全部会话已失效 —— 即将跳转登录…</p>}
      {!done && (
        <>
          {field("当前密码", current, setCurrent, "password")}
          {field("新密码（至少 8 位）", next, setNext, "password")}
          {field("确认新密码", again, setAgain, "password")}
          {next !== again && next !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>两次输入不一致</p>}
          {err !== "" && <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>}
          <button onClick={submit} style={btnStyle()}>保存</button>
        </>
      )}
    </Shell>
  );
}
