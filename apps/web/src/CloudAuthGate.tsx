import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, ArrowRight, LoaderCircle, LockKeyhole, MailCheck, RotateCw, ShieldCheck, UsersRound } from "lucide-react";
import type { CloudAuthSession } from "@forge/contracts";

type AuthenticatedSession = Extract<CloudAuthSession, { authenticated: true }>;
type AuthMode = "login" | "register" | "forgot" | "reset";

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
  const [verificationToken] = useState(() => new URLSearchParams(window.location.search).get("verify") || "");
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get("reset") || "");
  const [invitationToken, setInvitationToken] = useState(() => new URLSearchParams(window.location.search).get("invite") || "");
  const [mode, setMode] = useState<AuthMode>(resetToken ? "reset" : "login");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [verificationComplete, setVerificationComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const nameInvalid = Boolean(error && /显示名称/.test(error));
  const emailInvalid = Boolean(error && /邮箱/.test(error));
  const passwordInvalid = Boolean(error && /密码/.test(error));

  useEffect(() => {
    if (!base) return;
    const controller = new AbortController();
    if (resetToken) {
      setSession({ authenticated: false });
      return () => controller.abort();
    }
    const request = verificationToken
      ? authRequest(base, "/v1/auth/email/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: verificationToken }),
          signal: controller.signal,
        })
      : authRequest(base, "/v1/auth/session", { signal: controller.signal });
    request
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as CloudAuthSession & { message?: string };
        if (!response.ok) throw new Error(payload.message || "账户服务暂时不可用");
        if (payload.authenticated && payload.user.emailVerified) await activateDesktopTenant(payload);
        if (verificationToken) {
          const url = new URL(window.location.href);
          url.searchParams.delete("verify");
          window.history.replaceState(null, "", url);
          setVerificationComplete(true);
        }
        setSession(payload);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (verificationToken) {
          const url = new URL(window.location.href);
          url.searchParams.delete("verify");
          window.history.replaceState(null, "", url);
        }
        setError(reason instanceof Error ? reason.message : String(reason));
        setSession({ authenticated: false });
      });
    return () => controller.abort();
  }, [base, resetToken, verificationToken]);

  if (!base) return children({ cloudApiBase: "", logout: async () => undefined });
  if (session === null) {
    return <main className="cloud-auth-loading"><LoaderCircle className="spin" /><p>正在检查账户会话…</p></main>;
  }
  if (verificationComplete && session.authenticated && !window.forgeDesktop) {
    return <main className="cloud-auth-shell">
      <section className="cloud-auth-intro" aria-label="Forge Cloud 介绍">
        <div className="cloud-auth-brand"><span className="cloud-auth-mark" aria-hidden="true" /><strong>Forge</strong></div>
        <div><span className="cloud-auth-eyebrow">FORGE CLOUD</span><h1>邮箱已确认，<br />账户现在可以安全使用。</h1><p>验证令牌已经作废，租户资源现已对这个账户开放。</p></div>
        <ul><li><ShieldCheck size={17} /><span><strong>验证已完成</strong><small>一次性链接不能再次使用</small></span></li><li><LockKeyhole size={17} /><span><strong>回到本机继续</strong><small>代码、终端与 Agent 仍留在你的电脑</small></span></li></ul>
      </section>
      <section className="cloud-auth-panel" aria-labelledby="cloud-auth-title">
        <div className="cloud-auth-card cloud-auth-verification">
          <span className="cloud-auth-step">0.15 账户安全</span><MailCheck size={30} />
          <h2 id="cloud-auth-title">邮箱验证完成</h2>
          <p><strong>{session.user.email}</strong> 已通过验证。现在可以关闭此页面，返回 Forge 客户端并点击“检查验证状态”。</p>
        </div>
      </section>
    </main>;
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
      setPasswordConfirmation("");
      setNotice("");
    };
    if (session.user.emailVerified && invitationToken) {
      const dismissInvitation = () => {
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState(null, "", url);
        setInvitationToken("");
        setError("");
      };
      const acceptInvitation = async () => {
        if (busy) return;
        setBusy(true); setError("");
        try {
          const acceptedResponse = await authRequest(base, "/v1/invitations/accept", {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
            body: JSON.stringify({ token: invitationToken }),
          });
          const accepted = await acceptedResponse.json().catch(() => ({})) as { id?: string; message?: string };
          if (!acceptedResponse.ok || !accepted.id) throw new Error(accepted.message || "接受团队邀请失败");
          const switchResponse = await authRequest(base, "/v1/auth/tenant", {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
            body: JSON.stringify({ tenantId: accepted.id }),
          });
          const switched = await switchResponse.json().catch(() => ({})) as CloudAuthSession & { message?: string };
          if (!switchResponse.ok || !switched.authenticated) throw new Error(switched.message || "邀请已接受，但工作区切换失败");
          await activateDesktopTenant(switched);
          const url = new URL(window.location.href);
          url.searchParams.delete("invite");
          window.history.replaceState(null, "", url);
          setInvitationToken("");
          setSession(switched);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setBusy(false);
        }
      };
      return <main className="cloud-auth-shell">
        <section className="cloud-auth-intro" aria-label="Forge Cloud 团队邀请">
          <div className="cloud-auth-brand"><span className="cloud-auth-mark" aria-hidden="true" /><strong>Forge</strong></div>
          <div><span className="cloud-auth-eyebrow">TEAM WORKSPACE</span><h1>加入团队，<br />共享云端工作目录。</h1><p>接受后会切换到团队租户；本机代码、终端和密钥仍不会上传。</p></div>
          <ul><li><ShieldCheck size={17} /><span><strong>邮箱身份匹配</strong><small>只有收到邀请且已验证的邮箱可以加入</small></span></li><li><LockKeyhole size={17} /><span><strong>租户权限隔离</strong><small>团队数据不会与个人工作区混在一起</small></span></li></ul>
        </section>
        <section className="cloud-auth-panel" aria-labelledby="cloud-auth-title">
          <div className="cloud-auth-card cloud-auth-verification">
            <span className="cloud-auth-step">0.19 团队协作</span><UsersRound size={30} />
            <h2 id="cloud-auth-title">接受团队邀请</h2>
            <p>当前登录邮箱为 <strong>{session.user.email}</strong>。确认后，Forge 会进入邀请对应的团队工作区。</p>
            {error && <div className="cloud-auth-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
            <button className="cloud-auth-submit" type="button" aria-busy={busy} disabled={busy} onClick={() => void acceptInvitation()}>{busy ? <LoaderCircle className="spin" size={16} /> : <UsersRound size={16} />}接受并进入团队</button>
            <button className="cloud-auth-secondary" type="button" disabled={busy} onClick={dismissInvitation}>暂不接受</button>
          </div>
        </section>
      </main>;
    }
    if (session.user.emailVerified) return children({ session, cloudApiBase: base, logout });
    const refreshVerification = async () => {
      if (busy) return;
      setBusy(true); setError(""); setNotice("");
      try {
        const response = await authRequest(base, "/v1/auth/session");
        const payload = await response.json().catch(() => ({})) as CloudAuthSession & { message?: string };
        if (!response.ok || !payload.authenticated) throw new Error(payload.message || "账户会话已经失效，请重新登录");
        if (!payload.user.emailVerified) {
          setNotice("暂未检测到验证结果。请打开最新邮件链接后再试。");
          return;
        }
        await activateDesktopTenant(payload);
        setSession(payload);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    };
    const resendVerification = async () => {
      if (busy) return;
      setBusy(true); setError(""); setNotice("");
      try {
        const response = await authRequest(base, "/v1/auth/email/resend", {
          method: "POST",
          headers: { "x-csrf-token": session.csrfToken },
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { message?: string };
          throw new Error(payload.message || "验证邮件发送失败");
        }
        setNotice("新的验证邮件已经发出，请检查收件箱和垃圾邮件目录。");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    };
    return <main className="cloud-auth-shell">
      <section className="cloud-auth-intro" aria-label="Forge Cloud 介绍">
        <div className="cloud-auth-brand"><span className="cloud-auth-mark" aria-hidden="true" /><strong>Forge</strong></div>
        <div><span className="cloud-auth-eyebrow">FORGE CLOUD</span><h1>先确认邮箱，<br />再进入隔离工作区。</h1><p>验证完成前不会开放租户任务和扩展目录，避免错误邮箱接管账户。</p></div>
        <ul><li><ShieldCheck size={17} /><span><strong>一次性验证链接</strong><small>24 小时后失效，使用后立即作废</small></span></li><li><LockKeyhole size={17} /><span><strong>本机执行不变</strong><small>代码、终端与 Agent 仍留在你的电脑</small></span></li></ul>
      </section>
      <section className="cloud-auth-panel" aria-labelledby="cloud-auth-title">
        <div className="cloud-auth-card cloud-auth-verification">
          <span className="cloud-auth-step">0.15 账户安全</span><MailCheck size={28} />
          <h2 id="cloud-auth-title">验证你的邮箱</h2>
          <p>验证链接已发送到 <strong>{session.user.email}</strong>。打开邮件中的链接后会自动进入工作区。</p>
          {error && <div className="cloud-auth-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
          {notice && <div className="cloud-auth-notice" role="status"><MailCheck size={15} /><span>{notice}</span></div>}
          <button className="cloud-auth-submit" type="button" aria-busy={busy} disabled={busy} onClick={() => void refreshVerification()}>{busy ? <LoaderCircle className="spin" size={16} /> : <MailCheck size={16} />}检查验证状态</button>
          <button className="cloud-auth-secondary" type="button" disabled={busy} onClick={() => void resendVerification()}><RotateCw size={15} />重新发送验证邮件</button>
          <div className="cloud-auth-switch"><button type="button" onClick={() => void logout()}>使用其他账户</button></div>
        </div>
      </section>
    </main>;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "forgot") {
        const response = await authRequest(base, "/v1/auth/password/forgot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const payload = await response.json().catch(() => ({})) as { message?: string };
        if (!response.ok) throw new Error(payload.message || "无法发送重置邮件");
        setNotice(payload.message || "如果该邮箱已注册，重置邮件会很快发出");
        return;
      }
      if (mode === "reset") {
        if (password !== passwordConfirmation) throw new Error("两次输入的密码不一致");
        const response = await authRequest(base, "/v1/auth/password/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: resetToken, password }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { message?: string };
          throw new Error(payload.message || "密码重置失败");
        }
        const url = new URL(window.location.href);
        url.searchParams.delete("reset");
        window.history.replaceState(null, "", url);
        setMode("login");
        setPassword("");
        setPasswordConfirmation("");
        setNotice("密码已经重置，所有旧设备均已退出。请使用新密码登录。");
        return;
      }
      const response = await authRequest(base, `/v1/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, displayName, password }),
      });
      const payload = await response.json().catch(() => ({})) as CloudAuthSession & { message?: string; verificationDelivery?: "sent" | "failed" };
      if (!response.ok || !payload.authenticated) throw new Error(payload.message || (mode === "login" ? "登录失败" : "注册失败"));
      if (payload.user.emailVerified) await activateDesktopTenant(payload);
      setSession(payload);
      if (!payload.user.emailVerified && payload.verificationDelivery === "failed") setError("账户已创建，但验证邮件发送失败。请点击重新发送。");
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const modeCopy = {
    login: { title: "登录 Forge", description: "继续进入你的个人工作区", action: "登录" },
    register: { title: "创建 Forge 账户", description: "注册后会创建隔离的个人租户，并发送验证邮件", action: "创建账户" },
    forgot: { title: "找回密码", description: "输入注册邮箱，我们会发送一次性重置链接", action: "发送重置邮件" },
    reset: { title: "设置新密码", description: "新密码保存后，所有旧设备会自动退出", action: "重置密码" },
  }[mode];
  const submitDisabled = busy || (mode !== "reset" && !email.trim())
    || (mode !== "forgot" && !password)
    || (mode === "register" && !displayName.trim())
    || (mode === "reset" && !passwordConfirmation);
  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setPassword("");
    setPasswordConfirmation("");
    setError("");
    setNotice("");
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
          <span className="cloud-auth-step">0.15 账户安全</span>
          <h2 id="cloud-auth-title">{modeCopy.title}</h2>
          <p>{modeCopy.description}</p>
          <form onSubmit={submit} noValidate>
            {mode === "register" && <label><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required minLength={2} maxLength={60} aria-invalid={nameInvalid} aria-describedby={nameInvalid ? "cloud-auth-error" : undefined} /></label>}
            {mode !== "reset" && <label><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required maxLength={254} aria-invalid={emailInvalid} aria-describedby={emailInvalid ? "cloud-auth-error" : undefined} /></label>}
            {mode !== "forgot" && <label><span>{mode === "reset" ? "新密码" : "密码"}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={15} maxLength={128} aria-invalid={passwordInvalid} aria-describedby={[(mode === "register" || mode === "reset") ? "password-hint" : "", passwordInvalid ? "cloud-auth-error" : ""].filter(Boolean).join(" ") || undefined} /></label>}
            {mode === "reset" && <label><span>确认新密码</span><input type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} autoComplete="new-password" required minLength={15} maxLength={128} aria-invalid={Boolean(error && /不一致/.test(error))} aria-describedby={error && /不一致/.test(error) ? "cloud-auth-error" : undefined} /></label>}
            {(mode === "register" || mode === "reset") && <small id="password-hint" className="field-hint">至少 15 个字符，建议使用容易记住的长密码短语。</small>}
            {error && <div id="cloud-auth-error" className="cloud-auth-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
            {notice && <div className="cloud-auth-notice" role="status"><MailCheck size={15} /><span>{notice}</span></div>}
            <button className="cloud-auth-submit" type="submit" aria-busy={busy} disabled={submitDisabled}>
              {busy ? <><LoaderCircle className="spin" size={16} />正在处理…</> : <>{modeCopy.action}<ArrowRight size={16} /></>}
            </button>
          </form>
          {mode === "login" ? <div className="cloud-auth-switch cloud-auth-switch-multiple"><button type="button" onClick={() => changeMode("forgot")}>忘记密码</button><span>·</span><button type="button" onClick={() => changeMode("register")}>创建账户</button></div>
            : <div className="cloud-auth-switch"><span>{mode === "register" ? "已经拥有账户？" : "想起密码了？"}</span><button type="button" onClick={() => changeMode("login")}>返回登录</button></div>}
        </div>
      </section>
    </main>
  );
}
