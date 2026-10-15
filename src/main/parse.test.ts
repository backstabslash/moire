import { describe, expect, it } from "vitest";
import { parseDiff, unquote } from "./parse";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@ function main() {
 one
--- not a header
+two
 three
-four
\\ No newline at end of file
+four
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
index 3333333..4444444 100644
--- a/old name.txt\t
+++ b/new name.txt\t
@@ -2 +2 @@
-x
+y
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 5555555..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..6666666
Binary files /dev/null and b/img.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git "a/tab\\there" "b/tab\\there"
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ "b/tab\\there"
@@ -0,0 +1 @@
+hi
`;

describe("parseDiff", () => {
  const files = parseDiff(DIFF);

  it("parses a modified file with line numbers and no-newline markers", () => {
    const f = files[0];
    expect(f).toMatchObject({ path: "src/app.ts", status: "modified", binary: false, additions: 2, deletions: 2 });
    expect(f.hunks).toHaveLength(1);
    const h = f.hunks[0];
    expect(h).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, header: "function main() {" });
    expect(h.lines).toEqual([
      { kind: "ctx", text: "one", oldNo: 1, newNo: 1 },
      { kind: "del", text: "-- not a header", oldNo: 2 },
      { kind: "add", text: "two", newNo: 2 },
      { kind: "ctx", text: "three", oldNo: 3, newNo: 3 },
      { kind: "del", text: "four", oldNo: 4, noNewline: true },
      { kind: "add", text: "four", newNo: 4 },
    ]);
  });

  it("parses renames with spaces and default hunk counts", () => {
    expect(files[1]).toMatchObject({ path: "new name.txt", oldPath: "old name.txt", status: "renamed", additions: 1, deletions: 1 });
    expect(files[1].hunks[0]).toMatchObject({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, header: "" });
  });

  it("parses deleted, binary, mode-only and quoted files", () => {
    expect(files[2]).toMatchObject({ path: "gone.txt", status: "deleted", deletions: 1 });
    expect(files[2].hunks[0].lines).toEqual([{ kind: "del", text: "bye", oldNo: 1 }]);
    expect(files[3]).toMatchObject({ path: "img.png", status: "added", binary: true, hunks: [], blobs: "0000000..6666666" });
    expect(files[2].blobs).toBeUndefined();
    expect(files[4]).toMatchObject({ path: "run.sh", status: "modified", oldMode: "100644", newMode: "100755", hunks: [] });
    expect(files[0].oldMode).toBeUndefined();
    expect(files[5]).toMatchObject({ path: "tab\there", status: "added", additions: 1 });
    expect(files).toHaveLength(6);
  });

  it("reads symlink modes and merges a type change into one file", () => {
    const [link, swapped] = parseDiff(`diff --git a/link b/link
index 12a8d8a..3b7781e 120000
--- a/link
+++ b/link
@@ -1 +1 @@
-target1
\\ No newline at end of file
+target2
\\ No newline at end of file
diff --git a/tc b/tc
deleted file mode 100644
index 587be6b..0000000
--- a/tc
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/tc b/tc
new file mode 120000
index 0000000..7f66e4f
--- /dev/null
+++ b/tc
@@ -0,0 +1 @@
+f.txt
\\ No newline at end of file
`);
    expect(link).toMatchObject({ path: "link", oldMode: "120000", newMode: "120000", additions: 1, deletions: 1 });
    expect(swapped).toMatchObject({ path: "tc", status: "modified", oldMode: "100644", newMode: "120000", additions: 1, deletions: 1 });
    expect(swapped.hunks.flatMap((h) => h.lines.map((l) => l.kind + l.text))).toEqual(["delx", "addf.txt"]);
  });

  it("unquotes octal escapes as utf-8", () => {
    expect(unquote('"a/caf\\303\\251"')).toBe("a/café");
  });
});
