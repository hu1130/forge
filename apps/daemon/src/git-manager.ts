import { spawn } from "node:child_process";
import type { GitBranchInfo, GitCommitInfo, GitFileStatus, GitStatus } from "@forge/contracts";

interface GitResult {
  stdout: string;
  stderr: string;
}

class GitCommandError extends Error {
  constructor(message: string, readonly unavailable = false) {
    super(message);
  }
}

function runGit(workspacePath: string, args: string[], acceptedExitCodes = [0]) {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, { cwd: workspacePath, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-10_000); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(new GitCommandError(error.code === "ENOENT" ? "本机未安装 Git" : `无法启动 Git：${error.message}`, error.code === "ENOENT"));
    });
    child.once("exit", (code) => {
      if (acceptedExitCodes.includes(code ?? -1)) resolve({ stdout, stderr });
      else reject(new GitCommandError(stderr.trim() || `Git 命令失败（${code ?? "unknown"}）`));
    });
  });
}

function parseBranch(header: string) {
  const value = header.replace(/^##\s*/, "");
  const detached = value.match(/^HEAD \(no branch\)/);
  const branch = detached ? "detached HEAD" : value.split("...")[0].replace(/^No commits yet on /, "").trim();
  const ahead = Number(value.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(value.match(/behind (\d+)/)?.[1] || 0);
  return { branch: branch || "未知分支", ahead, behind };
}

export function parseGitStatus(output: string) {
  const records = output.split("\0").filter(Boolean);
  const header = records.shift() || "## 未知分支";
  const branch = parseBranch(header);
  const changes: GitFileStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const path = record.slice(3);
    const renamed = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    const originalPath = renamed ? records[++index] : undefined;
    changes.push({
      path,
      originalPath,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: worktreeStatus !== " " || indexStatus === "?",
    });
  }
  return { ...branch, changes };
}

function parseBranches(output: string, currentBranch: string): GitBranchInfo[] {
  const branches = output.split("\n").flatMap((line) => {
    const [name, marker] = line.trimEnd().split("\t");
    return name ? [{ name, current: marker === "*" || name === currentBranch }] : [];
  });
  if (currentBranch !== "detached HEAD" && currentBranch !== "未知分支" && !branches.some((branch) => branch.name === currentBranch)) {
    branches.unshift({ name: currentBranch, current: true });
  }
  return branches.sort((left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name));
}

function parseCommits(output: string): GitCommitInfo[] {
  return output.trim().split("\n").flatMap((line) => {
    const [hash, shortHash, subject, author, authoredAt] = line.split("\0");
    return hash && shortHash && authoredAt ? [{ hash, shortHash, subject: subject || "无提交说明", author: author || "未知作者", authoredAt }] : [];
  });
}

function unavailableStatus(available: boolean, branch: string, message: string): GitStatus {
  return { available, isRepository: false, branch, ahead: 0, behind: 0, changes: [], branches: [], commits: [], message };
}

export async function getGitStatus(workspacePath: string): Promise<GitStatus> {
  try {
    await runGit(workspacePath, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if (error instanceof GitCommandError && error.unavailable) {
      return unavailableStatus(false, "无 Git", error.message);
    }
    return unavailableStatus(true, "未初始化", "当前工作区不是 Git 仓库");
  }

  const status = parseGitStatus((await runGit(workspacePath, ["status", "--porcelain=v1", "--branch", "-z"])).stdout);
  const head = await runGit(workspacePath, ["rev-parse", "--short", "HEAD"])
    .then((result) => result.stdout.trim())
    .catch(() => undefined);
  const [branches, commits] = await Promise.all([
    runGit(workspacePath, ["branch", "--format=%(refname:short)%09%(HEAD)"])
      .then((result) => parseBranches(result.stdout, status.branch)),
    head
      ? runGit(workspacePath, ["log", "-n", "8", "--format=%H%x00%h%x00%s%x00%an%x00%aI"]).then((result) => parseCommits(result.stdout))
      : Promise.resolve([]),
  ]);
  return { available: true, isRepository: true, head, branches, commits, ...status };
}

export type GitIndexAction = "stage" | "unstage";

export async function updateGitIndex(workspacePath: string, rawPaths: unknown, action: GitIndexAction) {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > 200) throw new Error("请选择 1 到 200 个变更路径");
  const paths = [...new Set(rawPaths.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
  if (!paths.length) throw new Error("请选择要处理的变更路径");
  const status = await getGitStatus(workspacePath);
  if (!status.available) throw new Error(status.message || "本机未安装 Git");
  if (!status.isRepository) throw new Error("当前工作区不是 Git 仓库");
  const candidates = new Map(status.changes.map((change) => [change.path, change]));
  for (const filePath of paths) {
    const change = candidates.get(filePath);
    if (!change || (action === "stage" ? !change.unstaged : !change.staged)) {
      throw new Error(`变更路径状态已经变化，请刷新后重试：${filePath}`);
    }
  }
  if (action === "stage") {
    await runGit(workspacePath, ["--literal-pathspecs", "add", "--", ...paths]);
  } else if (status.head) {
    await runGit(workspacePath, ["--literal-pathspecs", "restore", "--staged", "--", ...paths]);
  } else {
    await runGit(workspacePath, ["--literal-pathspecs", "rm", "--cached", "--", ...paths]);
  }
  return getGitStatus(workspacePath);
}

export async function createGitBranch(workspacePath: string, rawName: string) {
  const name = rawName.trim();
  if (!name || name.length > 120) throw new Error("分支名称应为 1 到 120 个字符");
  const status = await getGitStatus(workspacePath);
  if (!status.available) throw new Error(status.message || "本机未安装 Git");
  if (!status.isRepository) throw new Error("当前工作区不是 Git 仓库");
  await runGit(workspacePath, ["check-ref-format", "--branch", name]);
  await runGit(workspacePath, ["switch", "-c", name]);
  return getGitStatus(workspacePath);
}

export async function switchGitBranch(workspacePath: string, rawName: string) {
  const name = rawName.trim();
  const status = await getGitStatus(workspacePath);
  if (!status.available) throw new Error(status.message || "本机未安装 Git");
  if (!status.isRepository) throw new Error("当前工作区不是 Git 仓库");
  if (!status.branches.some((branch) => branch.name === name)) throw new Error("请选择现有的本地分支");
  if (name === status.branch) return status;
  if (status.changes.length) throw new Error("工作区存在未提交变更；Forge 不会自动 stash 或强制切换分支");
  await runGit(workspacePath, ["switch", name]);
  return getGitStatus(workspacePath);
}

export async function commitStagedChanges(workspacePath: string, rawMessage: string) {
  const message = rawMessage.trim();
  if (!message || message.length > 120) throw new Error("提交说明应为 1 到 120 个字符");
  const status = await getGitStatus(workspacePath);
  if (!status.available) throw new Error(status.message || "本机未安装 Git");
  if (!status.isRepository) throw new Error("当前工作区不是 Git 仓库");
  if (!status.changes.some((change) => change.staged)) throw new Error("没有已暂存的变更；Forge 不会自动暂存工作区文件");
  await runGit(workspacePath, ["commit", "-m", message]);
  return getGitStatus(workspacePath);
}
