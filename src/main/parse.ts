import type { DiffLine, FileDiff, Hunk } from "../shared/types";

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

export function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  const bytes: number[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
    } else if (/[0-7]/.test(s[i + 1])) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[s[i + 1]] ?? s.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function quotedEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i + 1;
  }
  return s.length;
}

function headerPath(rest: string): string {
  if (rest.startsWith('"')) return unquote(rest.slice(0, quotedEnd(rest))).slice(2);
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && rest.slice(2 + n, 5 + n) === " b/") return rest.slice(2, 2 + n);
  const split = rest.lastIndexOf(" b/");
  return split > 0 ? rest.slice(2, split) : rest.slice(2);
}

function filePath(rest: string): string | null {
  const name = unquote(rest.replace(/\t$/, ""));
  return name === "/dev/null" ? null : name.slice(2);
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let last: DiffLine | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let skip = false;

  for (const line of text.split("\n")) {
    if (hunk && file && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === "\\") {
        if (last) last.noNewline = true;
        continue;
      }
      let next: DiffLine | null = null;
      if (c === "+") {
        next = { kind: "add", text: line.slice(1), newNo: newNo++ };
        newLeft--;
        file.additions++;
      } else if (c === "-") {
        next = { kind: "del", text: line.slice(1), oldNo: oldNo++ };
        oldLeft--;
        file.deletions++;
      } else if (c === " " || c === undefined) {
        next = { kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ };
        oldLeft--;
        newLeft--;
      }
      if (next) {
        hunk.lines.push(next);
        last = next;
        continue;
      }
      hunk = null;
    }
    if (line.startsWith("\\")) {
      if (last) last.noNewline = true;
    } else if (line.startsWith("diff --git ")) {
      file = { path: headerPath(line.slice(11)), status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      last = null;
      skip = false;
    } else if (line.startsWith("diff --cc ") || line.startsWith("* Unmerged path ")) {
      // git prints a conflicted file as a combined diff in the unstaged view and as one line in the staged view
      const path = line.startsWith("*") ? line.slice(16) : unquote(line.slice(10));
      files.push({ path, status: "conflicted", binary: false, additions: 0, deletions: 0, hunks: [] });
      file = null;
      hunk = null;
      last = null;
      skip = true;
    } else if (skip || !file) {
      continue;
    } else if (line.startsWith("@@")) {
      const m = HUNK.exec(line);
      if (!m) throw new Error(`Malformed hunk header: ${line}`);
      hunk = {
        oldStart: +m[1],
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newLines: m[4] === undefined ? 1 : +m[4],
        header: m[5],
        lines: [],
      };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      last = null;
    } else if (hunk) {
      continue;
    } else if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice(14);
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice(18);
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice(9);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice(9);
    } else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) {
      file.path = unquote(line.slice(10));
    } else if (line.startsWith("--- ")) {
      const p = filePath(line.slice(4));
      if (p !== null && file.status === "renamed") file.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = filePath(line.slice(4));
      if (p !== null) file.path = p;
    } else if (line.startsWith("index ")) {
      const [blobs, mode] = line.slice(6).split(" ");
      file.blobs = blobs;
      if (mode && file.status !== "added") file.oldMode ??= mode;
      if (mode && file.status !== "deleted") file.newMode ??= mode;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }
  const merged = mergeTypeChanges(files);
  for (const f of merged) {
    if (!f.binary) delete f.blobs;
    if ((f.oldMode ?? PLAIN) === PLAIN && (f.newMode ?? PLAIN) === PLAIN) {
      delete f.oldMode;
      delete f.newMode;
    }
  }
  return merged;
}

const PLAIN = "100644";

// Git prints a file that became a symlink (or the reverse) as a deletion followed by a new file at the same path.
function mergeTypeChanges(files: FileDiff[]): FileDiff[] {
  const out: FileDiff[] = [];
  for (const f of files) {
    const prev = out.at(-1);
    if (!prev || prev.status !== "deleted" || f.status !== "added" || prev.path !== f.path) {
      out.push(f);
      continue;
    }
    out[out.length - 1] = {
      path: f.path,
      status: "modified",
      oldMode: prev.oldMode,
      newMode: f.newMode,
      binary: prev.binary || f.binary,
      blobs: prev.blobs && f.blobs && `${prev.blobs.split("..")[0]}..${f.blobs.split("..")[1]}`,
      additions: f.additions,
      deletions: prev.deletions,
      hunks: [...prev.hunks, ...f.hunks],
    };
  }
  return out;
}

export function sortFiles(files: FileDiff[]): FileDiff[] {
  return files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
