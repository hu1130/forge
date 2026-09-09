import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck, Cable, ChevronDown, ChevronUp, ExternalLink, LoaderCircle,
  RefreshCw, Search, ShieldCheck, Sparkles, Store, Trash2,
} from "lucide-react";
import type {
  MarketplaceCategory, MarketplaceItem, MarketplaceItemKind, MarketplacePayload, SkillScope,
} from "@forge/contracts";

const categories: Array<"all" | MarketplaceCategory> = ["all", "开发", "知识", "数据", "效率", "其他"];

async function responsePayload<T>(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || fallback);
  return payload;
}

function installationLabel(item: MarketplaceItem) {
  if (item.installation.status === "updateAvailable") return `可更新 · ${item.installation.installedVersion} → ${item.version}`;
  if (item.installation.status === "installed") return `已安装 · ${item.version}`;
  return "未安装";
}

export default function MarketplacePanel({ scope, onScopeChange, onExtensionsChanged }: {
  scope: SkillScope;
  onScopeChange: (scope: SkillScope) => void;
  onExtensionsChanged: () => void;
}) {
  const [payload, setPayload] = useState<MarketplacePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | MarketplaceItemKind>("all");
  const [category, setCategory] = useState<"all" | MarketplaceCategory>("all");
  const [expanded, setExpanded] = useState("");
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/marketplace?scope=${scope}`);
      setPayload(await responsePayload<MarketplacePayload>(response, "市场加载失败"));
    } catch (reason) {
      setFeedback({ tone: "error", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [scope]);

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (payload?.items || []).filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (category !== "all" && item.category !== category) return false;
      if (!needle) return true;
      return [item.name, item.description, item.publisher, ...item.tags].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [payload, query, kind, category]);

  const refresh = async () => {
    setBusy("refresh");
    setFeedback(null);
    try {
      const response = await fetch("/api/marketplace/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      const next = await responsePayload<MarketplacePayload>(response, "市场刷新失败");
      setPayload(next);
      setFeedback({ tone: next.source.warning ? "error" : "success", message: next.source.warning || "市场目录已刷新。" });
    } catch (reason) {
      setFeedback({ tone: "error", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy("");
    }
  };

  const install = async (item: MarketplaceItem) => {
    const token = tokens[item.id]?.trim() || "";
    let tokenSaved = false;
    setBusy(item.id);
    setFeedback(null);
    try {
      if (item.mcp?.bearerTokenRequired && !token) throw new Error("请先填写此 MCP 服务的访问令牌");
      if (token) {
        if (!item.mcp?.name || !window.forgeDesktop?.saveMcpToken) throw new Error("访问令牌只能在 Forge 桌面版中加密保存");
        await window.forgeDesktop.saveMcpToken(item.mcp.name, token);
        tokenSaved = true;
        await window.forgeDesktop.restartRuntime();
      }
      const response = await fetch(`/api/marketplace/items/${encodeURIComponent(item.id)}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, bearerTokenConfigured: tokenSaved }),
      });
      const next = await responsePayload<MarketplacePayload>(response, `${item.name} 安装失败`);
      setPayload(next);
      setTokens((current) => ({ ...current, [item.id]: "" }));
      setFeedback({ tone: "success", message: item.installation.status === "updateAvailable" ? `${item.name} 已更新。` : `${item.name} 已安装。` });
      onExtensionsChanged();
    } catch (reason) {
      if (tokenSaved && item.installation.status === "notInstalled" && item.mcp?.name && window.forgeDesktop?.deleteMcpToken) {
        await window.forgeDesktop.deleteMcpToken(item.mcp.name).catch(() => undefined);
        await window.forgeDesktop.restartRuntime?.().catch(() => undefined);
      }
      setFeedback({ tone: "error", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy("");
    }
  };

  const uninstall = async (item: MarketplaceItem) => {
    if (!window.confirm(`确定卸载“${item.name}”吗？`)) return;
    setBusy(item.id);
    setFeedback(null);
    try {
      const response = await fetch(`/api/marketplace/items/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      let next = await responsePayload<MarketplacePayload>(response, `${item.name} 卸载失败`);
      if (item.kind === "mcp" && item.installation.installedName && window.forgeDesktop?.deleteMcpToken) {
        await window.forgeDesktop.deleteMcpToken(item.installation.installedName);
        if (window.forgeDesktop.restartRuntime) {
          await window.forgeDesktop.restartRuntime();
          const refreshed = await fetch(`/api/marketplace?scope=${scope}`);
          next = await responsePayload<MarketplacePayload>(refreshed, "卸载后状态刷新失败");
        }
      }
      setPayload(next);
      setFeedback({ tone: "success", message: `${item.name} 已卸载。` });
      onExtensionsChanged();
    } catch (reason) {
      setFeedback({ tone: "error", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy("");
    }
  };

  return <>
    <div className="settings-heading marketplace-heading">
      <div><h3>扩展市场</h3><p>查找经过目录校验的 Skills 与 MCP 服务，安装后由本机 Forge 管理。</p></div>
      <div className="heading-actions">
        <label htmlFor="market-scope">Skill 作用域</label>
        <select id="market-scope" value={scope} onChange={(event) => onScopeChange(event.target.value as SkillScope)}><option value="global">所有项目</option><option value="project">当前项目</option></select>
        <button type="button" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw className={busy === "refresh" ? "spin" : ""} size={14} />刷新</button>
      </div>
    </div>

    {payload && <div className="market-source" role="status">
      <span className={`source-dot source-${payload.source.kind}`} aria-hidden="true" />
      <strong>{payload.source.label}</strong>
      <span>{payload.source.kind === "remote" ? "在线" : payload.source.kind === "cache" ? "缓存" : "内置"}</span>
      <time dateTime={payload.source.refreshedAt}>{new Date(payload.source.refreshedAt).toLocaleString("zh-CN", { hour12: false })}</time>
    </div>}
    {payload?.source.warning && <div className="market-warning"><ShieldCheck size={14} /><span>{payload.source.warning}</span></div>}
    {feedback && <div className={`settings-feedback ${feedback.tone === "error" ? "feedback-error" : "feedback-success"}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div>}

    <div className="market-controls">
      <label className="market-search"><span className="sr-only">搜索市场</span><Search size={14} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、功能或发布者" /></label>
      <div className="market-kind-filter" aria-label="扩展类型">
        {(["all", "skill", "mcp"] as const).map((value) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === "all" ? "全部" : value === "skill" ? "Skills" : "MCP"}</button>)}
      </div>
      <label className="market-category"><span className="sr-only">分类</span><select value={category} onChange={(event) => setCategory(event.target.value as "all" | MarketplaceCategory)}>{categories.map((value) => <option key={value} value={value}>{value === "all" ? "全部分类" : value}</option>)}</select></label>
    </div>

    {loading ? <div className="settings-loading"><LoaderCircle className="spin" size={17} />正在加载扩展市场…</div>
      : !visibleItems.length ? <div className="settings-empty"><Store size={22} /><strong>没有匹配的扩展</strong><span>试试其他关键词、类型或分类。</span></div>
        : <><div className="market-list-head" aria-hidden="true"><span>名称</span><span>类型</span><span>状态</span><span>操作</span></div><div className="market-grid">{visibleItems.map((item) => {
          const isExpanded = expanded === item.id;
          const isBusy = busy === item.id;
          return <article className={`market-card ${item.featured ? "market-featured" : ""}`} key={item.id}>
            <div className={`market-icon market-icon-${item.kind}`}>{item.kind === "skill" ? <Sparkles size={17} /> : <Cable size={17} />}</div>
            <div className="market-card-copy">
              <div className="market-title-row"><strong>{item.name}</strong>{item.verified && <span className="verified-label"><BadgeCheck size={12} />已校验</span>}</div>
              <p>{item.description}</p>
              <small>{item.publisher} · v{item.version}</small>
              <div className="market-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            </div>
            <span className="market-row-kind">{item.kind === "skill" ? "Skill" : "MCP"}</span>
            <span className={`market-row-status status-${item.installation.status}`}>{installationLabel(item)}</span>
            <div className="market-card-actions">
              {item.installation.status !== "installed" && <button className="primary-small" type="button" disabled={Boolean(busy)} onClick={() => void install(item)}>{isBusy ? <LoaderCircle className="spin" size={13} /> : null}{item.installation.status === "updateAvailable" ? "更新" : "安装"}</button>}
              {item.installation.status !== "notInstalled" && <button className="danger-icon" type="button" aria-label={`卸载 ${item.name}`} disabled={Boolean(busy)} onClick={() => void uninstall(item)}><Trash2 size={14} /></button>}
              <button className="market-detail-button" type="button" aria-expanded={isExpanded} aria-controls={`market-details-${item.id}`} onClick={() => setExpanded(isExpanded ? "" : item.id)}>{isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}详情</button>
            </div>
            {isExpanded && <div className="market-details" id={`market-details-${item.id}`}>
              <p>{item.details}</p>
              <dl><div><dt>类型</dt><dd>{item.kind === "skill" ? "Skill 工作流" : `${item.mcp?.transport.toUpperCase()} MCP`}</dd></div><div><dt>分类</dt><dd>{item.category}</dd></div><div><dt>版本</dt><dd>{item.version}</dd></div></dl>
              {item.mcp?.envVars.length ? <p className="market-requirement">运行前需在系统环境中配置：{item.mcp.envVars.join("、")}</p> : null}
              {item.mcp?.useBearerToken && item.installation.status === "notInstalled" && <label className="market-token"><span>访问令牌（{item.mcp.bearerTokenRequired ? "必填" : "可选"}）</span><input type="password" autoComplete="off" required={item.mcp.bearerTokenRequired} value={tokens[item.id] || ""} onChange={(event) => setTokens((current) => ({ ...current, [item.id]: event.target.value }))} placeholder={window.forgeDesktop ? "由 Windows 加密保存" : "请在桌面版中填写"} /></label>}
              {item.homepage && <a href={item.homepage} target="_blank" rel="noreferrer">查看发布者页面<ExternalLink size={12} /></a>}
            </div>}
          </article>;
        })}</div></>}
  </>;
}
