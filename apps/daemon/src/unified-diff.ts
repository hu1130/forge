import type { Activity } from "@forge/contracts";

type ChangedFile = Extract<Activity, { kind: "files" }>["files"][number];

function headerPath(line: string) {
  const raw = line.slice(4).split("\t", 1)[0].trim();
  if (!raw || raw === "/dev/null") return "";
  const unquoted = raw.startsWith('"') && raw.endsWith('"')
    ? (() => { try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); } })()
    : raw;
  return unquoted.replace(/^[ab]\//, "");
}

function sections(diff: string) {
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const starts = lines.flatMap((line, index) => line.startsWith("diff --git ") ? [index] : []);
  if (!starts.length) return diff.trim() ? [lines] : [];
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length));
}

export function filesFromUnifiedDiff(diff: string): ChangedFile[] {
  return sections(diff).flatMap((lines) => {
    const addedHeader = lines.find((line) => line.startsWith("+++ "));
    const removedHeader = lines.find((line) => line.startsWith("--- "));
    const path = addedHeader ? headerPath(addedHeader) : "";
    const fallbackPath = removedHeader ? headerPath(removedHeader) : "";
    const filePath = path || fallbackPath;
    if (!filePath) return [];
    const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return [{ path: filePath, additions, deletions, diff: lines.join("\n").trimEnd() }];
  });
}

export function turnDiffActivity(turnId: string, diff: string, at = new Date().toISOString()): Activity | null {
  const files = filesFromUnifiedDiff(diff);
  return files.length ? { id: `turn-diff-${turnId}`, kind: "files", turnId, files, at } : null;
}
