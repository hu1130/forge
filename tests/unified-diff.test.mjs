import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve("apps/daemon/dist/unified-diff.js")).href;

test("aggregated turn diffs become one stable checkpoint with per-file patches", async () => {
  const { turnDiffActivity } = await import(`${moduleUrl}?parse=${Date.now()}`);
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+one
+two`;
  const activity = turnDiffActivity("turn-42", diff, "2026-09-09T00:00:00.000Z");
  assert.equal(activity.id, "turn-diff-turn-42");
  assert.equal(activity.turnId, "turn-42");
  assert.deepEqual(activity.files.map(({ path: filePath, additions, deletions }) => ({ filePath, additions, deletions })), [
    { filePath: "src/a.ts", additions: 1, deletions: 1 },
    { filePath: "src/b.ts", additions: 2, deletions: 0 },
  ]);
  assert.match(activity.files[0].diff, /^diff --git a\/src\/a\.ts/m);
  assert.doesNotMatch(activity.files[0].diff, /src\/b\.ts/);
});

test("deleted files use the old path", async () => {
  const { filesFromUnifiedDiff } = await import(`${moduleUrl}?deleted=${Date.now()}`);
  const files = filesFromUnifiedDiff(`diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone`);
  assert.equal(files[0].path, "old.txt");
  assert.equal(files[0].deletions, 1);
});
