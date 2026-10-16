import type { DiffLine, FileContents, FileDiff, Hunk } from "../../../shared/types";
import { langFor } from "./lang";
import { LINK, MODULE, modeNote } from "./modes";
import { gapKey, lineKey } from "./selection";
import { type Range, wordRanges } from "./words";

export type Layout = "split" | "unified";
export type Scope = "changed" | "full";

const INDENTED = new Set([
  "python",
  "yaml",
  "haskell",
  "fsharp",
  "nim",
  "coffee",
  "pug",
  "haml",
  "sass",
  "stylus",
  "elm",
  "gdscript",
  "mojo",
  "purescript",
  "imba",
  "just",
]);
// Formats where any whitespace change can change the meaning, so nothing folds.
const EXACT = new Set([
  "markdown",
  "mdx",
  "mdc",
  "rst",
  "asciidoc",
  "org",
  "wikitext",
  "latex",
  "tex",
  "make",
  "diff",
  "tsv",
  "csv",
  "cobol",
  "fortran-fixed-form",
]);

export interface Side {
  no: number;
  text: string;
  words?: Range[];
  sel?: string;
  staged?: boolean;
}

export type Row =
  | { t: "hunk"; key: string; hunk: number; label: string; ctx: string; adds: number; dels: number; staged: "full" | "partial" | null; folded?: Folded }
  | { t: "fold"; key: string; count: number; expandable: boolean; newFrom: number }
  | { t: "split"; key: string; hunk: number; kind: "ctx" | "chg"; a?: Side; b?: Side; faded?: boolean }
  | { t: "uni"; key: string; hunk: number; kind: "ctx" | "add" | "del"; a?: number; b?: number; line: Side; faded?: boolean }
  | { t: "note"; key: string; text: string; expand?: string };

export interface Folded {
  keys: string[];
  count: number;
  gaps: [newFrom: number, count: number][];
  // On the first of several whitespace folds: the keys of all of them.
  all?: string[];
}

export interface BuildOptions {
  layout: Layout;
  scope: Scope;
  expanded: ReadonlySet<string>;
  showAll?: boolean;
  plates?: number;
}

// Main decodes text as UTF-8, which turns each byte it can't read into U+FFFD.
export function notUtf8(file: FileDiff, contents: FileContents | null): boolean {
  if (file.binary || file.tooLarge || contents?.tooLarge) return false;
  const bad = (text: string | null | undefined) => !!text?.includes("�");
  return file.hunks.some((h) => h.lines.some((l) => bad(l.text))) || bad(contents?.a) || bad(contents?.b);
}

export function buildRows(file: FileDiff, contents: FileContents | null, opts: BuildOptions): Row[] {
  if (file.status === "unchanged") return wholeFile(contents);
  const note = (text: string): Row[] => [{ t: "note", key: "note", text }];
  const renamed = file.status === "renamed" ? `Renamed from ${file.oldPath}. ` : "";
  if (file.binary) return note(`${renamed}Binary file, contents not shown.`);
  if (file.unread) return note("Not read: there are over 1,000 untracked files. Add their folder to .gitignore, or stage it whole.");
  if (file.tooLarge) return note(file.status === "untracked" ? "File is over 2 MB, contents not shown." : `${renamed}Over 2 MB of changes, not shown.`);
  if (file.status === "conflicted") return note("Merge conflict. Resolve it in your editor (e); the All view (3) shows it with the markers.");
  const pointer = submoduleNote(file) ?? symlinkNote(file);
  if (pointer) return note(renamed + pointer);
  if (file.noise && !opts.showAll && !opts.expanded.has("noise")) {
    const n = file.additions + file.deletions;
    return [{ t: "note", key: "noise", text: `${file.noise}, ${n} changed ${n === 1 ? "line" : "lines"}, folded away.`, expand: "noise" }];
  }
  if (!file.hunks.length) return note(emptyNote(file));

  const bLines = splitLines(contents?.b ?? null);
  const aLines = splitLines(contents?.a ?? null);
  const gapText = (oldNo: number, newNo: number) => (bLines ? bLines[newNo - 1] : aLines?.[oldNo - 1]) ?? "";
  const rows: Row[] = [];
  let oldNext = 1;
  let newNext = 1;

  const lang = langFor(file.path, contents?.b ?? contents?.a);
  const spacing = EXACT.has(lang) ? null : INDENTED.has(lang) ? "indented" : "free";
  const wsFolded = file.hunks.map((hunk, h) => !opts.showAll && !opts.expanded.has(`ws${h}`) && !!spacing && whitespaceOnly(hunk, spacing === "indented"));
  // A one-line fold bar would take the room of the line it hides, so that line is shown instead.
  const emitGap = (key: string, oldFrom: number, newFrom: number, count: number, h: number) => {
    if (count <= 0) return;
    const expandable = bLines !== null || aLines !== null;
    const single = count === 1 && !wsFolded[h - 1] && !wsFolded[h];
    if (expandable && (opts.scope === "full" || opts.expanded.has(key) || single)) {
      for (let i = 0; i < count; i++) {
        emitContext(rows, opts.layout, `${key}:${i}`, -1, oldFrom + i, newFrom + i, gapText(oldFrom + i, newFrom + i), gapKey(newFrom + i));
      }
    } else {
      rows.push({ t: "fold", key, count, expandable, newFrom });
    }
  };

  file.hunks.forEach((hunk, h) => {
    const oldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    const newFirst = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    emitGap(`gap${h}`, oldNext, newNext, newFirst - newNext, h);
    const key = `ws${h}`;
    if (wsFolded[h]) {
      rows.push({ ...hunkRow(hunk, h), folded: { keys: [key], count: 0, gaps: [] } });
    } else {
      rows.push(hunkRow(hunk, h));
      emitHunkLines(rows, h === opts.plates ? "split" : opts.layout, hunk, h);
    }
    oldNext = oldFirst + hunk.oldLines;
    newNext = newFirst + hunk.newLines;
  });

  const trailing = bLines ? bLines.length - newNext + 1 : aLines ? aLines.length - oldNext + 1 : 0;
  emitGap(`gap${file.hunks.length}`, oldNext, newNext, trailing, file.hunks.length);
  const out = absorbGaps(rows);
  const folds = out.flatMap((r) => (r.t === "hunk" && r.folded ? [r.folded] : []));
  if (folds.length > 1) folds[0].all = folds.flatMap((f) => f.keys);
  return out;
}

function absorbGaps(rows: Row[]): Row[] {
  const out: Row[] = [];
  const take = (f: Folded, gap: Row & { t: "fold" }, before: boolean) => {
    f.keys[before ? "unshift" : "push"](gap.key);
    f.count += gap.count;
    f.gaps.push([gap.newFrom, gap.count]);
  };
  for (const row of rows) {
    const last = out.at(-1);
    if (row.t === "hunk" && row.folded && last?.t === "fold" && last.expandable) {
      out.pop();
      take(row.folded, last, true);
      out.push(row);
    } else if (row.t === "fold" && row.expandable && last?.t === "hunk" && last.folded) {
      take(last.folded, row, false);
    } else {
      out.push(row);
    }
  }
  return out;
}

function wholeFile(contents: FileContents | null): Row[] {
  if (!contents) return [];
  if (contents.tooLarge) return [{ t: "note", key: "note", text: "Binary file or over 2 MB, contents not shown." }];
  const lines = splitLines(contents.b);
  if (!lines) return [{ t: "note", key: "note", text: "Can't read this file." }];
  if (!lines.length) return [{ t: "note", key: "note", text: "Empty file." }];
  const rows: Row[] = [];
  lines.forEach((text, i) => emitContext(rows, "unified", `l${i}`, -1, i + 1, i + 1, text, gapKey(i + 1)));
  return rows;
}

function emptyNote(file: FileDiff): string {
  const { oldMode: a, newMode: b } = file;
  const mode = a && b && a !== b ? modeNote(file)!.words : null;
  if (file.status === "added" || file.status === "untracked") return "Empty file.";
  if (file.status === "deleted") return "Deleted an empty file.";
  if (file.status === "renamed") return `Renamed from ${file.oldPath}${mode ? `, ${mode}` : ""}, no content changes.`;
  if (mode) return `${mode[0].toUpperCase()}${mode.slice(1)} (${a} → ${b}), no content changes.`;
  return "No content changes.";
}

function changedText(file: FileDiff, kind: "add" | "del"): string | undefined {
  return file.hunks.flatMap((h) => h.lines).find((l) => l.kind === kind)?.text;
}

function submoduleNote(file: FileDiff): string | null {
  if ((file.newMode ?? file.oldMode) !== MODULE || (file.oldMode && file.oldMode !== MODULE)) return null;
  const commit = (kind: "add" | "del") => /^Subproject commit ([0-9a-f]+)(-dirty)?$/.exec(changedText(file, kind) ?? "");
  const [from, to] = [commit("del"), commit("add")];
  const dirty = to?.[2] ? ", with uncommitted changes inside it" : "";
  if (from && to) {
    if (from[1] === to[1]) return dirty ? "Submodule has uncommitted changes inside it." : null;
    return `Submodule moved from ${from[1].slice(0, 7)} to ${to[1].slice(0, 7)}${dirty}.`;
  }
  if (to) return `Submodule added at ${to[1].slice(0, 7)}${dirty}.`;
  if (from) return `Submodule removed, it was at ${from[1].slice(0, 7)}.`;
  return null;
}

function symlinkNote(file: FileDiff): string | null {
  if ((file.newMode ?? file.oldMode) !== LINK || (file.oldMode && file.oldMode !== LINK)) return null;
  const [from, to] = [changedText(file, "del"), changedText(file, "add")];
  if (from !== undefined && to !== undefined) return `Symlink target changed from ${from} to ${to}.`;
  if (to !== undefined) return `Symlink to ${to}.`;
  if (from !== undefined) return `Deleted a symlink to ${from}.`;
  return null;
}

function whitespaceOnly(hunk: Hunk, indented: boolean): boolean {
  const squash = (kind: "add" | "del") => {
    const texts = hunk.lines.filter((l) => l.kind === kind).map((l) => l.text);
    if (!indented) return dropSpaces(texts.join("\n"));
    return texts
      .filter((t) => t.trim())
      .map((t) => t.match(/^\s*/)![0] + dropSpaces(t))
      .join("\n");
  };
  return hunk.lines.some((l) => l.kind !== "ctx") && squash("add") === squash("del");
}

// Whitespace between two word characters still matters (`a b` isn't `ab`), and so does any inside a string literal.
function dropSpaces(text: string): string {
  const word = /[\p{L}\p{N}_$]/u;
  const space = /\s/;
  const s = text.trim();
  let out = "";
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote && !(c === "\n" && quote !== "`")) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === quote) quote = "";
    } else if (space.test(c)) {
      quote = "";
      let end = i + 1;
      while (end < s.length && space.test(s[end])) end++;
      if (word.test(s[i - 1] ?? "") && word.test(s[end] ?? "")) out += " ";
      i = end - 1;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

export function splitLines(text: string | null): string[] | null {
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function hunkRow(hunk: Hunk, h: number): Row & { t: "hunk" } {
  let adds = 0;
  let dels = 0;
  let staged = 0;
  for (const l of hunk.lines) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
    if (l.staged) staged++;
  }
  return {
    t: "hunk",
    key: `hunk${hunk.oldStart},${hunk.oldLines}+${hunk.newStart},${hunk.newLines}`,
    hunk: h,
    label: `−${hunk.oldStart},${hunk.oldLines}  +${hunk.newStart},${hunk.newLines}`,
    ctx: hunk.header.trim(),
    adds,
    dels,
    staged: staged === 0 ? null : staged === adds + dels ? "full" : "partial",
  };
}

function emitContext(rows: Row[], layout: Layout, key: string, h: number, oldNo: number, newNo: number, text: string, sel: string, faded = false) {
  if (layout === "split") {
    rows.push({ t: "split", key, hunk: h, kind: "ctx", a: { no: oldNo, text, sel }, b: { no: newNo, text, sel }, faded });
  } else {
    rows.push({ t: "uni", key, hunk: h, kind: "ctx", a: oldNo, b: newNo, line: { no: newNo, text, sel }, faded });
  }
}

function emitHunkLines(rows: Row[], layout: Layout, hunk: Hunk, h: number) {
  const lines = hunk.lines;
  const faded = lines.every((l) => l.kind === "ctx" || l.staged);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "ctx") {
      emitContext(rows, layout, `h${h}:${i}`, h, line.oldNo!, line.newNo!, line.text, lineKey(h, i), faded);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    const start = i;
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);

    const delSides = dels.map((l, k): Side => ({ no: l.oldNo!, text: l.text, sel: lineKey(h, start + k), staged: l.staged }));
    const addSides = adds.map((l, k): Side => ({ no: l.newNo!, text: l.text, sel: lineKey(h, start + dels.length + k), staged: l.staged }));
    const pairs = align(delSides, addSides);

    if (layout === "split") {
      pairs.forEach(([a, b], k) => rows.push({ t: "split", key: `h${h}:${start}:${k}`, hunk: h, kind: "chg", a, b }));
    } else {
      delSides.forEach((s, k) => rows.push({ t: "uni", key: `h${h}:${start}:d${k}`, hunk: h, kind: "del", a: s.no, line: s }));
      addSides.forEach((s, k) => rows.push({ t: "uni", key: `h${h}:${start}:a${k}`, hunk: h, kind: "add", b: s.no, line: s }));
    }
  }
}

export function followHunk(prev: Hunk, hunks: Hunk[]): number {
  const changes = (h: Hunk) => JSON.stringify(h.lines.filter((l) => l.kind !== "ctx").map((l) => [l.kind, l.text]));
  const want = changes(prev);
  let best = 0;
  let score = Infinity;
  hunks.forEach((h, i) => {
    const s = (changes(h) === want ? 0 : 1e9) + Math.abs(h.oldStart - prev.oldStart);
    if (s < score) [best, score] = [i, s];
  });
  return best;
}

const LOOKAHEAD = 8;

export function align(dels: Side[], adds: Side[]): [Side | undefined, Side | undefined][] {
  const matches: [number, number][] = [];
  let next = 0;
  dels.forEach((del, i) => {
    for (let k = next; k < adds.length && k < next + LOOKAHEAD; k++) {
      const marks = wordRanges(del.text, adds[k].text);
      if (!marks) continue;
      [del.words, adds[k].words] = marks;
      matches.push([i, k]);
      next = k + 1;
      return;
    }
  });

  const out: [Side | undefined, Side | undefined][] = [];
  let di = 0;
  let ai = 0;
  for (const [i, k] of [...matches, [dels.length, adds.length]]) {
    const gapDels = dels.slice(di, i);
    const gapAdds = adds.slice(ai, k);
    for (let n = 0; n < Math.max(gapDels.length, gapAdds.length); n++) out.push([gapDels[n], gapAdds[n]]);
    if (i < dels.length) out.push([dels[i], adds[k]]);
    di = i + 1;
    ai = k + 1;
  }
  return out;
}
