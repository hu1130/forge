import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, ArrowRight, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import type { CloudAuthSession } from "@forge/contracts";

type AuthenticatedSession = Extract<CloudAuthSession, { authenticated: true }>;

interface CloudAuthGateProps {
  children: (value: { session?: AuthenticatedSession; cloudApiBase: string; logout: () => Promise<void> }) => ReactNode;
}

function configuredCloudApiBase() {
  const configured = window.forgeDesktop?.cloudApiUrl || import.meta.env.VITE_FORGE_CLOUD_API_URL || "";
  if (configured) return configured.replace(/\/$/, "");
  return new URLSearchParams(window.location.search).get("cloud") === "1" ? "/cloud" : "";
}

async function authRequest(base: string, path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, { ...init, credentials: "include" });
}

async function activateDesktopTenant(session: AuthenticatedSession) {
  if (!window.forgeDesktop?.activateCloudContext) return;
  const activated = await window.forgeDesktop.activateCloudContext();
  if (activated.identity.tenantId !== session.tenant.id || activated.identity.userId !== session.user.id) {
    throw new Error("本机运行时与 Forge Cloud 租户不一致");
  }
}

export default function CloudAuthGate({ children }: CloudAuthGateProps) {
  const [base] = useState(configuredCloudApiBase);
  const [session, setSession] = useState<CloudAuthSession | null>(base ? null : { authenticated: false });
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInvalid = Boolean(error && /显示名称/.test(error));
  const emailInvalid = Boolean(error && /邮箱/.test(error));
  const passwordInvalid = Boolean(error && /密码/.test(error));

  useEffect(() => {
    if (!base) return;
    const controller = new AbortController();
    authRequest(base, "/v1/auth/session", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("账户服务暂时不可用");
        const payload = await response.json() as CloudAuthSession;
        if (payload.authenticated) await activateDesktopTenant(payload);
        setSession(payload);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setSession({ authenticated: false });
      });
    return () => controller.abort();
  }, [base]);

  if (!base) return children({ cloudApiBase: "", logout: async () => undefined });
  if (session === null) {
    return <main className="cloud-auth-loading"><LoaderCircle className="spin" /><p>正在检查账户会话…</p></main>;
  }
  if (session.authenticated) {
    const logout = async () => {
      const response = await authRequest(base, "/v1/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": session.csrfToken },
      });
      if (!response.ok && response.status !== 401) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message || "退出登录失败");
      }
      await window.forgeDesktop?.activateLocalContext?.();
      setSession({ authenticated: false });
      setMode("login");
      setEmail("");
      setDisplayName("");
      setPassword("");
    };
    return children({ session, cloudApiBase: base, logout });
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await authRequest(base, `/v1/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, displayName, password }),
      });
      const payload = await response.json().catch(() => ({})) as CloudAuthSession & { message?: string };
      if (!response.ok || !payload.authenticated) throw new Error(payload.message || (mode === "login" ? "登录失败" : "注册失败"));
      await activateDesktopTenant(payload);
      setSession(payload);
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="cloud-auth-shell">
      <section className="cloud-auth-intro" aria-label="Forge Cloud 介绍">
        <div className="cloud-auth-brand"><span className="cloud-auth-mark" aria-hidden="true" /><strong>Forge</strong></div>
        <div>
          <span className="cloud-auth-eyebrow">FORGE CLOUD</span>
          <h1>你的 AI 编程工作区，<br />现在拥有独立账户。</h1>
          <p>账户和租户信息保存在中心服务；代码、终端与 Agent 仍在你的本机安全执行。</p>
        </div>
        <ul>
          <li><ShieldCheck size={17} /><span><strong>租户隔离</strong><small>工作区身份由服务端会话决定</small></span></li>
          <li><LockKeyhole size={17} /><span><strong>本机执行</strong><small>数据库凭据不会进入桌面客户端</small></span></li>
        </ul>
      </section>
      <section className="cloud-auth-panel" aria-labelledby="cloud-auth-title">
        <div className="cloud-auth-card">
          <span className="cloud-auth-step">0.14 安全扩展目录</span>
          <h2 id="cloud-auth-title">{mode === "login" ? "登录 Forge" : "创建 Forge 账户"}</h2>
          <p>{mode === "login" ? "继续进入你的个人工作区" : "注册后会自动创建一个隔离的个人租户"}</p>
          <form onSubmit={submit} noValidate>
            {mode === "register" && <label><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required minLength={2} maxLength={60} aria-invalid={nameInvalid} aria-describedby={nameInvalid ? "cloud-auth-error" : undefined} /></label>}
            <label><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required maxLength={254} aria-invalid={emailInvalid} aria-describedby={emailInvalid ? "cloud-auth-error" : undefined} /></label>
            <label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={15} maxLength={128} aria-invalid={passwordInvalid} aria-describedby={[mode === "register" ? "password-hint" : "", passwordInvalid ? "cloud-auth-error" : ""].filter(Boolean).join(" ") || undefined} /></label>
            {mode === "register" && <small id="password-hint" className="field-hint">至少 15 个字符，建议使用容易记住的长密码短语。</small>}
            {error && <div id="cloud-auth-error" className="cloud-auth-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
            <button className="cloud-auth-submit" type="submit" disabled={busy || !email.trim() || !password || (mode === "register" && !displayName.trim())}>
              {busy ? <><LoaderCircle className="spin" size={16} />正在处理…</> : <>{mode === "login" ? "登录" : "创建账户"}<ArrowRight size={16} /></>}
            </button>
          </form>
          <div className="cloud-auth-switch">
            <span>{mode === "login" ? "第一次使用 Forge Cloud？" : "已经拥有账户？"}</span>
            <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setPassword(""); setError(""); }}>
              {mode === "login" ? "创建账户" : "返回登录"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
