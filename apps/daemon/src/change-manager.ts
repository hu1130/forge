import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Activity, ForgeTask } from "@forge/contracts";

export type ChangeAction = "revert" | "reapply";

const maximumPatchBytes = 10 * 1024 * 1024;

function runGitApply(workspacePath: string, patch: string, action: ChangeAction, check: boolean) {
  return new Promise<void>((resolve, reject) => {
    const args = ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "--recount"];
    if (action === "revert") args.push("--reverse");
    if (check) args.push("--check");
    args.push("-");
    const child = spawn("git", args, { cwd: workspacePath, shell: false, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { errorOutput = `${errorOutput}${chunk}`.slice(-3000); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "ENOENT" ? "撤销代码需要安装 Git" : `无法启动 Git：${error.message}`));
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `Git apply 失败（${code ?? "unknown"}）`));
    });
    child.stdin.end(patch);
  });
}

function candidateActivities(task: ForgeTask, action: ChangeAction, turnId?: string) {
  const fileActivities = task.activities.filter((activity): activity is Extract<Activity, { kind: "files" }> => activity.kind === "files" && !activity.portableOnly);
  const selected = turnId ? fileActivities.filter((activity) => activity.turnId === turnId) : fileActivities;
  const candidates = selected.filter((activity) => action === "revert" ? !activity.revertedAt : Boolean(activity.revertedAt));
  return action === "revert" ? candidates.reverse() : candidates;
}

export async function applyTaskChanges(task: ForgeTask, action: ChangeAction, turnId?: string) {
  const workspacePath = task.workspacePath;
  if (!workspacePath) throw new Error("任务没有可用的工作区");
  const workspace = await stat(workspacePath).catch(() => null);
  if (!workspace?.isDirectory()) throw new Error("任务工作区不存在或无法访问");

  const activities = candidateActivities(task, action, turnId);
  if (!activities.length) throw new Error(action === "revert" ? "当前范围没有可撤销的代码变更" : "当前范围没有可重新应用的代码变更");
  const patches = activities.flatMap((activity) => activity.files.map((file) => file.diff?.trim()).filter((diff): diff is string => Boolean(diff)));
  if (!patches.length) throw new Error("当前任务没有可执行的标准补丁");
  if (patches.some((patch) => !/^(?:diff --git |--- )/.test(patch))) throw new Error("当前任务包含非标准补丁，无法安全撤销");
  const patch = `${patches.join("\n")}\n`;
  if (Buffer.byteLength(patch) > maximumPatchBytes) throw new Error("代码补丁超过 10 MB，无法在界面中安全处理");

  try {
    await runGitApply(workspacePath, patch, action, true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${action === "revert" ? "无法撤销" : "无法重新应用"}：文件内容可能已被继续修改。${detail ? ` ${detail}` : ""}`);
  }
  await runGitApply(workspacePath, patch, action, false);
  return activities.map((activity) => activity.id);
}
