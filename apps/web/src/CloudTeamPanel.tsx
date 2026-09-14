import { useEffect, useState, type FormEvent } from "react";
import { Building2, Check, LoaderCircle, MailPlus, RefreshCw, Trash2, UserRoundCog, UsersRound } from "lucide-react";
import type {
  CloudAuthSession, CloudPendingInvitation, CloudPendingInvitationsPayload, CloudTeamOverview,
  CloudTenantContext, CloudTenantInvitation, CloudTenantListPayload, CloudTenantMember,
} from "@forge/contracts";

type AuthenticatedSession = Extract<CloudAuthSession, { authenticated: true }>;

interface CloudTeamPanelProps {
  session: AuthenticatedSession;
  cloudApiBase: string;
  anyTaskRunning: boolean;
}

async function responsePayload<T>(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || fallback);
  return payload;
}

const roleLabel = { owner: "所有者", admin: "管理员", member: "成员" } as const;

export default function CloudTeamPanel({ session, cloudApiBase, anyTaskRunning }: CloudTeamPanelProps) {
  const [tenants, setTenants] = useState<CloudTenantContext[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState(session.tenant.id);
  const [overview, setOverview] = useState<CloudTeamOverview | null>(null);
  const [pending, setPending] = useState<CloudPendingInvitation[]>([]);
  const [teamName, setTeamName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const request = (path: string, init?: RequestInit) => fetch(`${cloudApiBase}${path}`, { ...init, credentials: "include" });
  const mutationHeaders = { "content-type": "application/json", "x-csrf-token": session.csrfToken };

  const load = async () => {
    setBusy("loading");
    setError("");
    try {
      const calls: [Promise<Response>, Promise<Response>, Promise<Response> | undefined] = [
        request("/v1/tenants"),
        request("/v1/invitations"),
        session.tenant.kind === "team" ? request("/v1/team") : undefined,
      ];
      const [tenantResponse, pendingResponse, teamResponse] = await Promise.all(calls);
      setTenants((await responsePayload<CloudTenantListPayload>(tenantResponse, "无法读取工作区列表")).tenants);
      setPending((await responsePayload<CloudPendingInvitationsPayload>(pendingResponse, "无法读取待处理邀请")).invitations);
      setOverview(teamResponse ? await responsePayload<CloudTeamOverview>(teamResponse, "无法读取团队成员") : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  useEffect(() => { void load(); }, [session.tenant.id]);

  const switchWorkspace = async (tenantId: string) => {
    if (anyTaskRunning) throw new Error("请先等待当前任务结束，再切换工作区");
    if (tenantId === session.tenant.id) return;
    const response = await request("/v1/auth/tenant", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ tenantId }),
    });
    await responsePayload<AuthenticatedSession>(response, "工作区切换失败");
    window.location.reload();
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };

  const createTeam = (event: FormEvent) => {
    event.preventDefault();
    void run("create", async () => {
      const response = await request("/v1/tenants", {
        method: "POST", headers: mutationHeaders, body: JSON.stringify({ name: teamName }),
      });
      const tenant = await responsePayload<CloudTenantContext>(response, "团队创建失败");
      setTeamName("");
      await switchWorkspace(tenant.id);
    });
  };

  const invite = (event: FormEvent) => {
    event.preventDefault();
    void run("invite", async () => {
      const response = await request("/v1/team/invitations", {
        method: "POST", headers: mutationHeaders, body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const result = await responsePayload<{ invitation: CloudTenantInvitation; delivery: "sent" | "failed" | "unavailable" }>(response, "邀请发送失败");
      setInviteEmail("");
      setNotice(result.delivery === "sent"
        ? `邀请已发送到 ${result.invitation.email}`
        : result.delivery === "failed"
          ? "邀请已创建，但邮件发送失败；对方登录后仍能在待处理邀请中看到。"
          : "邀请已创建；当前未配置邮件发送，对方登录后可在待处理邀请中接受。"
      );
      await load();
    });
  };

  const accept = (invitation: CloudPendingInvitation) => void run(`accept:${invitation.id}`, async () => {
    const response = await request("/v1/invitations/accept", {
      method: "POST", headers: mutationHeaders, body: JSON.stringify({ invitationId: invitation.id }),
    });
    const tenant = await responsePayload<CloudTenantContext>(response, "接受邀请失败");
    await switchWorkspace(tenant.id);
  });

  const revoke = (invitation: CloudTenantInvitation) => {
    if (!window.confirm(`撤销发送给 ${invitation.email} 的邀请吗？`)) return;
    void run(`invite:${invitation.id}`, async () => {
      const response = await request(`/v1/team/invitations/${invitation.id}`, { method: "DELETE", headers: mutationHeaders });
      if (!response.ok) await responsePayload(response, "撤销邀请失败");
      setNotice("邀请已撤销。");
      await load();
    });
  };

  const changeRole = (member: CloudTenantMember, role: CloudTenantMember["role"]) => void run(`member:${member.userId}`, async () => {
    const response = await request(`/v1/team/members/${member.userId}`, {
      method: "PATCH", headers: mutationHeaders, body: JSON.stringify({ role }),
    });
    if (!response.ok) await responsePayload(response, "调整角色失败");
    if (member.userId === session.user.id) { window.location.reload(); return; }
    setNotice(`${member.displayName} 已设为${roleLabel[role]}。`);
    await load();
  });

  const remove = (member: CloudTenantMember) => {
    if (!window.confirm(`从团队移除 ${member.displayName}（${member.email}）吗？该成员在此工作区的登录会话会立即失效。`)) return;
    void run(`member:${member.userId}`, async () => {
      const response = await request(`/v1/team/members/${member.userId}`, { method: "DELETE", headers: mutationHeaders });
      if (!response.ok) await responsePayload(response, "移除成员失败");
      if (member.userId === session.user.id) { window.location.reload(); return; }
      setNotice(`${member.displayName} 已从团队移除。`);
      await load();
    });
  };

  const manager = session.tenant.role === "owner" || session.tenant.role === "admin";
  const disabled = Boolean(busy);

  return <section className="cloud-team-shell" aria-labelledby="cloud-team-title">
    <div className="cloud-team-heading">
      <div><span className="settings-eyebrow">MULTI-TENANT</span><h3 id="cloud-team-title">工作区与团队</h3></div>
      <button className="icon-button compact" type="button" aria-label="刷新团队信息" disabled={disabled} onClick={() => void load()}>
        <RefreshCw className={busy === "loading" ? "spin" : ""} size={15} />
      </button>
    </div>

    <div className="cloud-workspace-switcher">
      <label htmlFor="cloud-workspace-select">当前工作区</label>
      <div className="cloud-inline-form">
        <select id="cloud-workspace-select" value={selectedTenantId} disabled={disabled || anyTaskRunning} onChange={(event) => setSelectedTenantId(event.target.value)}>
          {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.kind === "team" ? roleLabel[tenant.role] : "个人"}</option>)}
        </select>
        <button type="button" disabled={disabled || anyTaskRunning || selectedTenantId === session.tenant.id} onClick={() => void run("switch", () => switchWorkspace(selectedTenantId))}>
          {busy === "switch" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}切换
        </button>
      </div>
      {anyTaskRunning && <small>任务运行期间不能切换，以免本机运行时进入错误租户。</small>}
    </div>

    {pending.length > 0 && <div className="cloud-pending-invitations">
      <strong>待处理邀请</strong>
      {pending.map((invitation) => <div className="cloud-team-row" key={invitation.id}>
        <span className="cloud-team-avatar"><Building2 size={15} /></span>
        <span><b>{invitation.tenant.name}</b><small>{invitation.invitedByName} 邀请你成为{roleLabel[invitation.role]}</small></span>
        <button type="button" disabled={disabled || anyTaskRunning} onClick={() => accept(invitation)}>{busy === `accept:${invitation.id}` ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}接受</button>
      </div>)}
    </div>}

    <form className="cloud-create-team" onSubmit={createTeam}>
      <label htmlFor="cloud-team-name"><Building2 size={15} />创建团队工作区</label>
      <div className="cloud-inline-form">
        <input id="cloud-team-name" value={teamName} minLength={2} maxLength={80} required placeholder="例如：产品研发组" disabled={disabled} onChange={(event) => setTeamName(event.target.value)} />
        <button type="submit" disabled={disabled || anyTaskRunning || teamName.trim().length < 2}>{busy === "create" ? <LoaderCircle className="spin" size={14} /> : <UsersRound size={14} />}创建</button>
      </div>
    </form>

    {overview && <div className="cloud-team-management">
      <div className="cloud-team-subheading"><div><UsersRound size={16} /><strong>成员</strong><span>{overview.members.length}</span></div><small>{manager ? "邀请由邮件和已验证邮箱双重确认" : "成员可以共享当前租户的云端目录"}</small></div>
      {manager && <form className="cloud-invite-form" onSubmit={invite}>
        <label htmlFor="cloud-invite-email">邀请成员邮箱</label>
        <div className="cloud-inline-form cloud-invite-fields">
          <input id="cloud-invite-email" type="email" autoComplete="email" value={inviteEmail} required placeholder="member@example.com" disabled={disabled} onChange={(event) => setInviteEmail(event.target.value)} />
          <select aria-label="邀请角色" value={inviteRole} disabled={disabled} onChange={(event) => setInviteRole(event.target.value as "admin" | "member")}>
            <option value="member">成员</option>
            {session.tenant.role === "owner" && <option value="admin">管理员</option>}
          </select>
          <button type="submit" disabled={disabled || !inviteEmail.trim()}>{busy === "invite" ? <LoaderCircle className="spin" size={14} /> : <MailPlus size={14} />}邀请</button>
        </div>
      </form>}

      <div className="cloud-member-list">{overview.members.map((member) => {
        const lastOwner = member.role === "owner" && overview.members.filter((item) => item.role === "owner").length === 1;
        return <div className="cloud-team-row" key={member.userId}>
        <span className="cloud-team-avatar"><UserRoundCog size={15} /></span>
        <span><b>{member.displayName}{member.userId === session.user.id ? "（你）" : ""}</b><small>{member.email}</small></span>
        {session.tenant.role === "owner" ? <div className="cloud-member-actions">
          <select aria-label={`设置 ${member.displayName} 的角色`} title={lastOwner ? "请先将另一位成员设为所有者" : undefined} value={member.role} disabled={disabled || lastOwner} onChange={(event) => changeRole(member, event.target.value as CloudTenantMember["role"])}>
            <option value="owner">所有者</option><option value="admin">管理员</option><option value="member">成员</option>
          </select>
          <button className="danger-icon" type="button" aria-label={`移除 ${member.displayName}`} title={lastOwner ? "团队必须至少保留一位所有者" : undefined} disabled={disabled || lastOwner} onClick={() => remove(member)}><Trash2 size={14} /></button>
        </div> : <span className="cloud-role-pill">{roleLabel[member.role]}</span>}
      </div>;
      })}</div>

      {manager && overview.invitations.length > 0 && <div className="cloud-team-invites"><strong>等待接受</strong>{overview.invitations.map((invitation) => <div className="cloud-team-row" key={invitation.id}>
        <span className="cloud-team-avatar"><MailPlus size={15} /></span>
        <span><b>{invitation.email}</b><small>{roleLabel[invitation.role]} · 7 天内有效</small></span>
        <button className="danger-icon" type="button" aria-label={`撤销发送给 ${invitation.email} 的邀请`} disabled={disabled} onClick={() => revoke(invitation)}><Trash2 size={14} /></button>
      </div>)}</div>}
    </div>}

    {error && <div className="settings-feedback feedback-error" role="alert">{error}</div>}
    {notice && <div className="settings-feedback feedback-success" role="status">{notice}</div>}
  </section>;
}
