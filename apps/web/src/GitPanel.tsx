import { FormEvent, useEffect, useState } from "react";
import { AlertCircle, Check, GitBranch, GitCommitHorizontal, LoaderCircle, RefreshCw } from "lucide-react";
import type { GitFileStatus, GitStatus } from "@forge/contracts";

interface GitPanelProps {
  status: GitStatus;
  taskRunning: boolean;
  onStatus: (status: GitStatus) => void;
}

type GitIndexAction = "stage" | "unstage";

async function responsePayload(response: Response) {
  return await response.json() as GitStatus & { message?: string };
}

function commitDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function GitChangeGroup({ title, changes, selected, action, disabled, onSelected, onAction }: {
  title: string;
  changes: GitFileStatus[];
  selected: Set<string>;
  action: GitIndexAction;
  disabled: boolean;
  onSelected: (paths: Set<string>) => void;
  onAction: () => void;
}) {
  const allSelected = changes.length > 0 && changes.every((change) => selected.has(change.path));
  const actionLabel = action === "stage" ? "暂存所选" : "取消暂存";
  return <section className="git-change-group" aria-labelledby={`git-${action}-title`}>
    <div className="git-section-title">
      <strong id={`git-${action}-title`}>{title}</strong>
      <span>{changes.length} 项</span>
      {changes.length > 0 && <button type="button" disabled={disabled} onClick={() => onSelected(allSelected ? new Set() : new Set(changes.map((change) => change.path)))}>{allSelected ? "清空" : "全选"}</button>}
    </div>
    {changes.length ? <>
      <ul className="git-change-list">
        {changes.map((change) => <li key={`${action}-${change.path}-${change.originalPath || ""}`}>
          <label>
            <input type="checkbox" checked={selected.has(change.path)} disabled={disabled} onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(change.path);
              else next.delete(change.path);
              onSelected(next);
            }} />
            <span className="git-status-code" aria-hidden="true">{action === "stage" ? change.worktreeStatus : change.indexStatus}</span>
            <span title={change.path}><strong>{change.path}</strong>{change.originalPath && <small>原路径：{change.originalPath}</small>}</span>
          </label>
        </li>)}
      </ul>
      <button className="git-index-action" type="button" disabled={disabled || selected.size === 0 || selected.size > 200} onClick={onAction}>{actionLabel}{selected.size > 0 && ` · ${selected.size}`}</button>
      {selected.size > 200 && <small className="git-selection-warning">一次最多处理 200 项，请减少选择。</small>}
    </> : <div className="git-group-empty">无{title}</div>}
  </section>;
}

export default function GitPanel({ status, taskRunning, onStatus }: GitPanelProps) {
  const [branchName, setBranchName] = useState("");
  const [switchBranchName, setSwitchBranchName] = useState(status.branch);
  const [commitMessage, setCommitMessage] = useState("");
  const [stagedSelection, setStagedSelection] = useState<Set<string>>(new Set());
  const [unstagedSelection, setUnstagedSelection] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"refresh" | "branch" | "switch" | "stage" | "unstage" | "commit" | "">("");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const stagedChanges = status.changes.filter((change) => change.staged);
  const unstagedChanges = status.changes.filter((change) => change.unstaged);
  const disabled = taskRunning || Boolean(busy);

  useEffect(() => {
    if (!status.branches.some((branch) => branch.name === switchBranchName)) setSwitchBranchName(status.branch);
    setStagedSelection((current) => new Set([...current].filter((filePath) => stagedChanges.some((change) => change.path === filePath))));
    setUnstagedSelection((current) => new Set([...current].filter((filePath) => unstagedChanges.some((change) => change.path === filePath))));
  }, [status.branch, status.branches, status.changes, switchBranchName]);

  const request = async (url: string, options?: RequestInit) => {
    setFeedback(null);
    const response = await fetch(url, options);
    const payload = await responsePayload(response);
    if (!response.ok) throw new Error(payload.message || "Git 操作失败");
    onStatus(payload);
    return payload;
  };

  const run = async (kind: typeof busy, action: () => Promise<string>) => {
    setBusy(kind);
    try {
      setFeedback({ tone: "success", text: await action() });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy("");
    }
  };

  const refresh = () => run("refresh", async () => {
    await request("/api/git/status");
    return "Git 状态已刷新";
  });

  const updateIndex = (action: GitIndexAction) => run(action, async () => {
    const selection = action === "stage" ? unstagedSelection : stagedSelection;
    await request("/api/git/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, paths: [...selection] }),
    });
    if (action === "stage") setUnstagedSelection(new Set());
    else setStagedSelection(new Set());
    return action === "stage" ? `已暂存 ${selection.size} 项变更` : `已取消暂存 ${selection.size} 项变更`;
  });

  const createBranch = (event: FormEvent) => {
    event.preventDefault();
    if (!branchName.trim() || busy) return;
    void run("branch", async () => {
      const next = await request("/api/git/branches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: branchName }),
      });
      setBranchName("");
      setSwitchBranchName(next.branch);
      return `已创建并切换到 ${next.branch}`;
    });
  };

  const switchBranch = (event: FormEvent) => {
    event.preventDefault();
    if (!switchBranchName || switchBranchName === status.branch || status.changes.length || busy) return;
    void run("switch", async () => {
      const next = await request("/api/git/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: switchBranchName }),
      });
      return `已切换到 ${next.branch}`;
    });
  };

  const commit = (event: FormEvent) => {
    event.preventDefault();
    if (!commitMessage.trim() || busy || stagedChanges.length === 0) return;
    void run("commit", async () => {
      await request("/api/git/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: commitMessage }),
      });
      setCommitMessage("");
      setStagedSelection(new Set());
      return "已提交暂存区中的变更";
    });
  };

  if (!status.available || !status.isRepository) {
    return <section className="git-empty" aria-labelledby="git-empty-title">
      <GitBranch size={24} />
      <strong id="git-empty-title">{status.available ? "当前工作区不是 Git 仓库" : "Git 不可用"}</strong>
      <span>{status.message || "选择一个 Git 工作区后，可以在这里管理分支和提交。"}</span>
      <button type="button" onClick={() => void refresh()} disabled={busy === "refresh"}>{busy === "refresh" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}重新检查</button>
    </section>;
  }

  return <div className="git-panel" aria-busy={Boolean(busy)}>
    <header className="git-overview">
      <div><GitBranch size={16} /><span><strong>{status.branch}</strong><small>{status.head ? `HEAD ${status.head}` : "尚无提交"}</small></span></div>
      <button type="button" aria-label="刷新 Git 状态" title="刷新 Git 状态" onClick={() => void refresh()} disabled={disabled}>{busy === "refresh" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
    </header>

    {(status.ahead > 0 || status.behind > 0) && <p className="git-sync">领先 {status.ahead} · 落后 {status.behind}</p>}

    <form className="git-form" onSubmit={switchBranch}>
      <label htmlFor="git-switch-branch">切换本地分支</label>
      <div><select id="git-switch-branch" value={switchBranchName} onChange={(event) => setSwitchBranchName(event.target.value)} disabled={disabled}>{status.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.current ? "（当前）" : ""}</option>)}</select><button type="submit" disabled={disabled || status.changes.length > 0 || switchBranchName === status.branch}>{busy === "switch" ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}切换</button></div>
      <small>{status.changes.length > 0 ? "工作区有未提交变更，清理后才能切换；Forge 不会自动 stash。" : "只切换现有本地分支，不执行强制覆盖。"}</small>
    </form>

    <div className="git-section" aria-labelledby="git-changes-title">
      <div className="git-section-heading"><strong id="git-changes-title">工作区变更</strong><span>{stagedChanges.length} 已暂存 · {unstagedChanges.length} 未暂存</span></div>
      <GitChangeGroup title="未暂存" changes={unstagedChanges} selected={unstagedSelection} action="stage" disabled={disabled} onSelected={setUnstagedSelection} onAction={() => void updateIndex("stage")} />
      <GitChangeGroup title="已暂存" changes={stagedChanges} selected={stagedSelection} action="unstage" disabled={disabled} onSelected={setStagedSelection} onAction={() => void updateIndex("unstage")} />
    </div>

    <form className="git-form" onSubmit={createBranch}>
      <label htmlFor="git-branch-name">创建并切换分支</label>
      <div><input id="git-branch-name" value={branchName} onChange={(event) => setBranchName(event.target.value)} maxLength={120} autoComplete="off" disabled={disabled} /><button type="submit" disabled={disabled || !branchName.trim()}>{busy === "branch" ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}创建</button></div>
      <small>保留当前工作区内容，不执行强制切换。</small>
    </form>

    <form className="git-form" onSubmit={commit}>
      <label htmlFor="git-commit-message">提交已暂存内容</label>
      <div><input id="git-commit-message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} maxLength={120} disabled={disabled} aria-describedby="git-commit-help" /><button type="submit" disabled={disabled || stagedChanges.length === 0 || !commitMessage.trim()}>{busy === "commit" ? <LoaderCircle className="spin" size={14} /> : <GitCommitHorizontal size={14} />}提交</button></div>
      <small id="git-commit-help">{stagedChanges.length > 0 ? `将提交 ${stagedChanges.length} 项已暂存变更；未暂存内容不会提交。` : "先在上方选择并暂存变更；Forge 不会自动暂存其他内容。"}</small>
    </form>

    <section className="git-history" aria-labelledby="git-history-title">
      <div className="git-section-heading"><strong id="git-history-title">最近提交</strong><span>{status.commits.length} 条</span></div>
      {status.commits.length ? <ol>{status.commits.map((commit) => <li key={commit.hash}><code>{commit.shortHash}</code><span><strong>{commit.subject}</strong><small>{commit.author} · {commitDate(commit.authoredAt)}</small></span></li>)}</ol> : <div className="git-group-empty">尚无提交记录</div>}
    </section>

    {feedback && <div className={`git-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.tone === "error" ? <AlertCircle size={14} /> : <Check size={14} />}{feedback.text}</div>}
  </div>;
}
