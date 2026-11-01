// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { structuredPatch } from "diff";
import { describe, expect, it } from "vitest";
import type { FileDiff, Hunk } from "../../../shared/types";
import { markdownPage } from "./markdown";
import { changeMarks } from "./preview";
import { markChanges, oldCuts } from "./redline";

const DOCS = ["README.md", "CLAUDE.md", "skills/moire-notes/SKILL.md"];
const ROUNDS = 12;

let seed = 1;
const pick = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;

function edited(text: string): string {
  const lines = text.split("\n");
  for (let k = 0; k < 6 + pick(10); k++) {
    const i = pick(lines.length);
    const op = pick(5);
    if (op === 0) lines.splice(i, 1 + pick(3));
    else if (op === 1) lines.splice(i, 0, `Inserted sentence number ${k}.`, "");
    else if (op === 2)
      lines[i] = (lines[i] ?? "")
        .split(" ")
        .map((w) => (pick(4) ? w : "reworded"))
        .join(" ");
    else if (op === 3) lines[i] = (lines[i] ?? "").replace(/\b\w+\b/, "**bold**");
    else lines.splice(pick(lines.length), 0, ...lines.splice(i, 1));
  }
  return lines.join("\n");
}

function diffOf(a: string, b: string): FileDiff {
  const hunks = structuredPatch("x", "x", a, b, "", "", { context: 3 }).hunks.map((h): Hunk => {
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    const lines = h.lines
      .filter((l) => !l.startsWith("\\"))
      .map((l) => {
        if (l[0] === "-") return { kind: "del" as const, text: l.slice(1), oldNo: oldNo++ };
        if (l[0] === "+") return { kind: "add" as const, text: l.slice(1), newNo: newNo++ };
        return { kind: "ctx" as const, text: l.slice(1), oldNo: oldNo++, newNo: newNo++ };
      });
    return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, header: "", lines };
  });
  return { path: "x.md", status: "modified", binary: false, additions: 0, deletions: 0, hunks };
}

function words(el: HTMLElement, drop: string): string[] {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const x of copy.querySelectorAll(drop)) x.remove();
  for (const x of copy.querySelectorAll(".md-ln, td, th, li, p, h1, h2, h3, h4, h5, h6")) x.append(" ");
  return copy.textContent.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

const plain = (text: string) => markdownPage(text, null, () => null);

describe.each(DOCS)("redlining random edits to %s", (path) => {
  const doc = readFileSync(path, "utf8");

  it("keeps the new text whole and every old word on the page", () => {
    for (let round = 0; round < ROUNDS; round++) {
      const next = edited(doc);
      const file = diffOf(doc, next);
      const oldPage = plain(doc);
      const page = markdownPage(next, changeMarks(file), () => null);
      markChanges(plain(doc), page, doc, next, oldCuts(file), changeMarks(file).added, true);
      expect(words(page, ".md-del, .md-gone, .md-source, .md-target, .md-ln.del, .md-tools").join("")).toBe(words(plain(next), ".md-tools").join(""));
      const shown = words(page, ".md-tools").join("");
      const seen = new Map<string, number>();
      for (const word of words(oldPage, ".md-tools")) {
        seen.set(word, (seen.get(word) ?? 0) + 1);
        expect(shown.split(word).length - 1, word).toBeGreaterThanOrEqual(seen.get(word)!);
      }
    }
  });

  it("leaves each side's own text intact side by side", () => {
    for (let round = 0; round < ROUNDS; round++) {
      const next = edited(doc);
      const file = diffOf(doc, next);
      const a = plain(doc);
      const b = markdownPage(next, changeMarks(file), () => null);
      markChanges(a, b, doc, next, oldCuts(file), changeMarks(file).added, false);
      expect(words(a, ".md-source, .md-target, .md-tools").join("")).toBe(words(plain(doc), ".md-tools").join(""));
      expect(words(b, ".md-source, .md-target, .md-tools").join("")).toBe(words(plain(next), ".md-tools").join(""));
    }
  });
});
