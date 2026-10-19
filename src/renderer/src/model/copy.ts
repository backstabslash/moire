import type { FileContents, FileDiff, SideInfo } from "../../../shared/types";
import { langFor } from "./lang";
import { buildRows, type Row, splitLines } from "./rows";
import type { Col } from "./selection";

interface Picked {
  kind: "ctx" | "add" | "del";
  a?: number;
  b?: number;
  text: string;
}

const unselectedChange = (row: Row) => row.t === "uni" && row.kind !== "ctx";

function runs(file: FileDiff, contents: FileContents | null, expanded: ReadonlySet<string>, selection: ReadonlySet<string>): Picked[][] {
  const out: Picked[][] = [];
  let run: Picked[] | null = null;
  for (const row of buildRows(file, contents, { layout: "unified", scope: "full", expanded, showAll: true })) {
    if (row.t === "uni" && row.line.sel && selection.has(row.line.sel)) {
      if (!run) out.push((run = []));
      run.push({ kind: row.kind, a: row.a, b: row.b, text: row.line.text });
    } else if (row.t !== "hunk" && !unselectedChange(row)) {
      run = null;
    }
  }
  return out;
}

export function copyCode(file: FileDiff, contents: FileContents | null, expanded: ReadonlySet<string>, selection: ReadonlySet<string>) {
  const lines = runs(file, contents, expanded, selection).flat();
  return { text: lines.map((l) => `${l.text}\n`).join(""), count: lines.length };
}

export function copySide(contents: FileContents | null, side: "a" | "b") {
  const text = contents && !contents.hidden ? contents[side] : null;
  return text === null ? null : { text, count: splitLines(text)!.length };
}

export interface RowPos {
  index: number;
  offset?: number;
}

export function textBetween(rows: Row[], col: Col, from: RowPos, to: RowPos): string {
  const out: string[] = [];
  for (let i = from.index; i <= to.index; i++) {
    const row = rows[i];
    const line = row?.t === "uni" ? row.line : row?.t === "split" && col !== "u" ? row[col] : undefined;
    if (!line) continue;
    out.push(line.text.slice(i === from.index ? from.offset : 0, i === to.index ? to.offset : undefined));
  }
  return out.join("\n");
}

export function copyMarkdown(
  file: FileDiff,
  contents: FileContents | null,
  expanded: ReadonlySet<string>,
  selection: ReadonlySet<string>,
  sides: { a: SideInfo; b: SideInfo },
) {
  const all = runs(file, contents, expanded, selection);
  const blocks = all.map((run) => {
    const onB = run.some((l) => l.b !== undefined);
    const nums = run.map((l) => (onB ? l.b : l.a)).filter((n): n is number => n !== undefined);
    const side = onB ? sides.b : sides.a;
    const first = Math.min(...nums);
    const last = Math.max(...nums);
    const range = first === last ? `line ${first}` : `lines ${first}–${last}`;
    const where = side.kind === "worktree" ? "working tree" : side.kind === "index" ? "index" : side.label;
    const path = onB ? file.path : (file.oldPath ?? file.path);
    const added = run.every((l) => l.kind === "add");
    const diff = !added && run.some((l) => l.kind !== "ctx");
    const body = run.map((l) => (diff ? `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}` : l.text)).join("\n");
    const note = !added ? "" : file.status === "added" || file.status === "untracked" ? "new file, " : "added, ";
    return `${path} ${range} (${note}${where})\n\`\`\`${diff ? "diff" : langFor(file.path)}\n${body}\n\`\`\``;
  });
  return { text: `${blocks.join("\n\n")}\n`, count: all.flat().length };
}
