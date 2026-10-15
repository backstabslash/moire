import type { FileContents, FileDiff, SideInfo } from "../../../shared/types";
import { langFor } from "./lang";
import { buildRows, type Row } from "./rows";

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
    const diff = run.some((l) => l.kind !== "ctx");
    const body = run.map((l) => (diff ? `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}` : l.text)).join("\n");
    return `${path} ${range} (${where})\n\`\`\`${diff ? "diff" : langFor(file.path)}\n${body}\n\`\`\``;
  });
  return { text: `${blocks.join("\n\n")}\n`, count: all.flat().length };
}
