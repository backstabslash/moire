import type { Hunk } from "../shared/types";

export class StaleError extends Error {
  constructor() {
    super("The file no longer matches the diff");
  }
}

// Lines keep their "\n" so a missing newline at end of file survives the round trip.
function splitKeep(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// Applies the selected changes of an A→B diff to A (toward "b"), or reverts them from B (toward "a").
export function splice(base: string, hunks: Hunk[], selected: (hunk: number, line: number) => boolean, toward: "a" | "b"): string {
  const src = splitKeep(base);
  const own = toward === "b" ? "del" : "add";
  const out: string[] = [];
  const push = (line: string) => {
    // A line that lost its place at end of file needs its newline back.
    if (out.length && !out[out.length - 1].endsWith("\n")) out[out.length - 1] += "\n";
    out.push(line);
  };
  let pos = 0;
  hunks.forEach((hunk, h) => {
    const [start, count] = toward === "b" ? [hunk.oldStart, hunk.oldLines] : [hunk.newStart, hunk.newLines];
    const first = count === 0 ? start : start - 1;
    if (first < pos || first > src.length) throw new StaleError();
    while (pos < first) push(src[pos++]);
    hunk.lines.forEach((line, i) => {
      const text = line.text + (line.noNewline ? "" : "\n");
      if (line.kind === "ctx" || line.kind === own) {
        if (src[pos] !== text) throw new StaleError();
        pos++;
        if (line.kind === "ctx" || !selected(h, i)) push(text);
      } else if (selected(h, i)) {
        push(text);
      }
    });
  });
  while (pos < src.length) push(src[pos++]);
  return out.join("");
}
