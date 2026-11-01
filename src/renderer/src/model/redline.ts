import { diffArrays } from "diff";
import type { FileDiff } from "../../../shared/types";
import { alignBlocks, type Block } from "./blocks";
import { cutsAt, mergeEdits, type Range, wordRanges } from "./words";

export type OldCuts = ReadonlyMap<number, number>;

export function oldCuts(file: FileDiff): OldCuts {
  const out = new Map<number, number>();
  file.hunks.forEach((hunk, h) => {
    for (const line of hunk.lines) if (line.kind === "del") out.set(line.oldNo!, h);
  });
  return out;
}

interface Op {
  start: number;
  end: number;
  wrap?: () => HTMLElement;
  insert?: Node;
}

// Works right to left, so each split leaves the offsets still to come untouched.
export function paint(root: HTMLElement, ops: Op[]) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let pos = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ node: n, start: pos });
    pos += n.length;
  }
  const order = [...ops].sort((x, y) => y.start - x.start || Number(!!x.insert) - Number(!!y.insert));
  for (const op of order) {
    if (op.insert) {
      insertAt(root, nodes, op.start, op.insert);
      continue;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      const lo = Math.max(op.start, start) - start;
      const hi = Math.min(op.end, start + node.length) - start;
      if (hi <= lo) continue;
      const middle = lo ? node.splitText(lo) : node;
      if (hi - lo < middle.length) middle.splitText(hi - lo);
      const box = op.wrap!();
      middle.replaceWith(box);
      box.append(middle);
    }
  }
}

function insertAt(root: HTMLElement, nodes: { node: Text; start: number }[], at: number, what: Node) {
  const found = at ? nodes.findLast(({ node, start }) => start < at && at <= start + node.length) : undefined;
  if (!found) return void root.prepend(what);
  const local = at - found.start;
  if (local < found.node.length) found.node.splitText(local);
  found.node.after(what);
}

function cloneRange(root: HTMLElement, [start, end]: Range): Node {
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (pos <= start && start < pos + n.length) range.setStart(n, start - pos);
    if (pos < end && end <= pos + n.length) range.setEnd(n, end - pos);
    pos += n.length;
  }
  let out: Node = range.cloneContents();
  const first = range.commonAncestorContainer;
  for (let el = first instanceof Element ? first : first.parentElement; el && el !== root; el = el.parentElement) {
    const shell = el.cloneNode(false);
    shell.appendChild(out);
    out = shell;
  }
  return out;
}

const INLINE = new Set(["B", "STRONG", "I", "EM", "S", "U", "DEL", "CODE", "KBD", "SAMP", "VAR", "SUB", "SUP", "SMALL", "SPAN", "BR", "IMG"]);

// The page is parsed again on its way to the screen, which tears a link out of a link or a block out of a paragraph.
function inlineOnly(el: HTMLElement) {
  for (const inner of el.querySelectorAll("*")) if (!INLINE.has(inner.tagName)) inner.replaceWith(...inner.childNodes);
}

const marker = (tag: "ins" | "del" | "mark", className: string) => () => {
  const el = document.createElement(tag);
  el.className = className;
  return el;
};

const MAX_FENCE_EDITS = 1000;

export interface FenceRow {
  kind: "" | "add" | "del";
  text: string;
  words?: Range[];
}

export function fenceRows(a: string[], b: string[]): FenceRow[] {
  const parts = diffArrays(a, b, { maxEditLength: MAX_FENCE_EDITS });
  if (!parts) return [...a.map((text) => ({ kind: "del", text }) as const), ...b.map((text) => ({ kind: "add", text }) as const)];
  const out: FenceRow[] = [];
  let cut: FenceRow[] = [];
  let paired = 0;
  for (const part of parts) {
    if (part.removed) {
      cut = part.value.map((text) => ({ kind: "del", text }));
      paired = 0;
      for (const row of cut) out.push(row);
    } else if (part.added) {
      for (const text of part.value) {
        const was = cut[paired++];
        const words = was && wordRanges(was.text, text);
        if (words) was.words = words[0];
        out.push({ kind: "add", text, words: words?.[1] });
      }
      cut = [];
    } else {
      cut = [];
      for (const text of part.value) out.push({ kind: "", text });
    }
  }
  return out;
}

export function fillFence(code: HTMLElement, rows: FenceRow[]) {
  code.replaceChildren();
  // One at a time: a fence can have more lines than a call can take arguments.
  for (const row of rows) {
    const line = document.createElement("span");
    line.className = row.kind ? `md-ln ${row.kind}` : "md-ln";
    line.textContent = row.text;
    if (row.words)
      paint(
        line,
        row.words.map(([start, end]) => ({ start, end, wrap: marker("mark", "md-w") })),
      );
    code.append(line);
  }
}

export const fenceLines = (code: HTMLElement) => [...code.querySelectorAll<HTMLElement>(".md-ln")];
const fenceText = (code: HTMLElement) => fenceLines(code).map((l) => l.textContent);

export function fenceSource(code: HTMLElement): string {
  const skip = code.closest(".is-old") ? "add" : "del";
  return fenceLines(code)
    .filter((l) => !l.classList.contains(skip))
    .map((l) => l.textContent)
    .join("\n");
}

type Outcome = "same" | "words" | "apart";

function wordMarks(x: HTMLElement, y: HTMLElement, inline: boolean, fallback: boolean): Outcome {
  const textA = x.textContent;
  const textB = y.textContent;
  if (textA === textB) return "same";
  const found = wordRanges(textA, textB) ?? (fallback ? ([[[0, textA.length]], [[0, textB.length]]] as [Range[], Range[]]) : null);
  if (!found) return "apart";
  const [cut, put] = mergeEdits(textA, found);
  const ops: Op[] = put.map(([start, end]) => ({ start, end, wrap: marker("ins", "md-ins") }));
  if (inline) {
    for (const { at, cut: range } of cutsAt(cut, put)) {
      const del = marker("del", "md-del")();
      del.append(cloneRange(x, range));
      inlineOnly(del);
      ops.push({ start: at, end: at, insert: del });
    }
  } else {
    paint(
      x,
      cut.map(([start, end]) => ({ start, end, wrap: marker("del", "md-del") })),
    );
  }
  paint(y, ops);
  return "words";
}

// Word marks inside these land between rows or items, or in markup that can't hold them.
const NO_WORD_MARKS = "table, ul, ol, dl, details, pre, svg, math";

function compare(x: HTMLElement, y: HTMLElement, inline: boolean): Outcome {
  if (x.tagName === "CODE" && y.tagName === "CODE") {
    const rows = fenceRows(fenceText(x), fenceText(y));
    if (!rows.some((r) => r.kind)) return "same";
    fillFence(y, inline ? rows : rows.filter((r) => r.kind !== "del"));
    if (!inline)
      fillFence(
        x,
        rows.filter((r) => r.kind !== "add"),
      );
    return "words";
  }
  if (x.tagName === "TR" && y.tagName === "TR") {
    if (x.children.length !== y.children.length) return "apart";
    const cells = [...x.children].map((cell, i) => wordMarks(cell as HTMLElement, y.children[i] as HTMLElement, inline, true));
    return cells.includes("words") ? "words" : "same";
  }
  if (x.querySelector(NO_WORD_MARKS) || y.querySelector(NO_WORD_MARKS)) return x.textContent === y.textContent ? "same" : "apart";
  return wordMarks(x, y, inline, false);
}

// An image's URL on the page carries its side's revision, so comparing versions needs what the file wrote.
export const imageSource = new WeakMap<Element, string>();

const ADDRESSED = "a[href], img, .md-img-off";
const addressOf = (t: Element) => imageSource.get(t) ?? t.getAttribute("href") ?? "";

const targetsOf = (el: HTMLElement) =>
  [...el.querySelectorAll(`${ADDRESSED}, .md-box`)].map((t) =>
    t.classList.contains("md-box") ? (t.classList.contains("on") ? "ticked" : "not ticked") : addressOf(t),
  );

// A link's words say nothing about where it goes, unless they are the address, and a jump within the page goes nowhere new.
const hiddenAddresses = (el: HTMLElement) =>
  [...el.querySelectorAll(ADDRESSED)].flatMap((t) => {
    const address = addressOf(t);
    return !address || address.startsWith("#") || address === t.textContent.trim() ? [] : [address];
  });

// The words can match while the link, image or checkbox under them changed, and that's the edit a reviewer most needs.
function noteTargets(y: HTMLElement, cut: string[], put: string[]) {
  const note = document.createElement("span");
  note.className = "md-target";
  for (const text of new Set(cut)) note.append(Object.assign(marker("del", "md-del")(), { textContent: text }));
  for (const text of new Set(put)) note.append(Object.assign(marker("ins", "md-ins")(), { textContent: text }));
  if (!cut.length && !put.length) note.textContent = "Formatting changed";
  (y.tagName === "TR" ? y.lastElementChild! : y).append(note);
}

function targetEdits(x: HTMLElement, y: HTMLElement): { cut: string[]; put: string[] } {
  const [before, after] = [targetsOf(x), targetsOf(y)];
  const parts = diffArrays(before, after, { maxEditLength: MAX_FENCE_EDITS });
  if (!parts) return { cut: before, put: after };
  return { cut: parts.filter((p) => p.removed).flatMap((p) => p.value), put: parts.filter((p) => p.added).flatMap((p) => p.value) };
}

const TEXT_BLOCK = "p, h1, h2, h3, h4, h5, h6";

// New or removed prose takes one band under its words, so a whole rewrite doesn't break into a box per wrapped line.
function markWhole(el: HTMLElement, kind: "ins" | "del") {
  if (!el.matches(TEXT_BLOCK) || el.classList.contains("md-whole") || el.querySelector(NO_WORD_MARKS)) return;
  const end = el.textContent.length;
  if (!el.textContent.trim()) return;
  paint(el, [{ start: 0, end, wrap: marker(kind, `md-${kind}`) }]);
  el.classList.add("md-whole");
}

function sourceBox(rows: FenceRow[], hunk: number): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "md-source md-chg md-words";
  pre.dataset.hunks = String(hunk);
  const code = document.createElement("code");
  fillFence(code, rows);
  pre.append(code);
  return pre;
}

const READABLE = /[\p{L}\p{N}]/u;
const TABLE_RULE = /^(?=.*-)(?=.*[|:])[\s|:-]+$/;
const EMPTY_BY_NATURE = "hr, tr, code";
const SHOWS_WITHOUT_TEXT = "img, svg, math, table, hr, .md-img-off, .md-box";

const rendersNothing = (el: HTMLElement) => !el.matches(EMPTY_BY_NATURE) && !el.textContent.trim() && !el.querySelector(SHOWS_WITHOUT_TEXT);
const showable = (source: string) => READABLE.test(source) || TABLE_RULE.test(source);

const WORD = /[\p{L}\p{N}]+/gu;
// Written here but never meant to appear as words: list markers, footnote and reference labels, alert names and entities.
const SYNTAX = /^[ \t]*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s+)?|^[ \t]*\[[^\][]*\]:|\[\^[^\][]*\]|\]\[[^\][]*\]|\[![a-z]+\]|&#?\w+;/gim;
// The name is closed by a lookahead and the rest stops at the next <, so text full of < can't make this quadratic.
const TAG = /<\/?([a-z][a-z0-9-]*)(?=[\s/>])([^<>]*)>/gi;

const LAYOUT_ATTR = /\b(?:align|valign|width|height|rowspan|colspan|name|target|rel|start|loading)\s*=\s*(?:"[\w%.-]*"|'[\w%.-]*'|[\w%.-]+(?=[\s/]|$))/gi;

// The sanitizer drops a tag it doesn't know, and a tag's attributes never reach the page, so neither counts as markup.
const tagWords = (_tag: string, name: string, rest: string) => {
  const known = !name.includes("-") && !(document.createElement(name) instanceof HTMLUnknownElement);
  return ` ${known ? "" : name} ${rest.replace(LAYOUT_ATTR, " ").replace(/[\w:-]+\s*=/g, " ")} `;
};

const wordsIn = (source: string) => tally(source.replace(TAG, tagWords).replace(SYNTAX, " "));

function tally(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [word] of text.toLowerCase().matchAll(WORD)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

function textsOf(el: HTMLElement): string[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest("svg, math")) out.push(walker.currentNode.textContent ?? "");
  return out;
}

const shownWords = (el: HTMLElement) => {
  const alts = [...el.querySelectorAll("img, a")].flatMap((t) => [t.getAttribute("alt") ?? "", t.getAttribute("title") ?? ""]);
  return tally([...textsOf(el), ...targetsOf(el), ...alts].join(" "));
};

// The last check before a change can go unseen: any word the source changed must reach the page, or the source is shown too.
function hidesWords(source: string, other: string, el: HTMLElement): boolean {
  if (el.closest("pre")) return false;
  const shown = shownWords(el);
  const before = wordsIn(other);
  return [...wordsIn(source)].some(([word, n]) => n !== (before.get(word) ?? 0) && n > (shown.get(word) ?? 0));
}

const styledWords = (el: HTMLElement) => {
  const out = new Map<string, number>();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const tags: string[] = [];
    for (let n = walker.currentNode.parentElement; n && n !== el; n = n.parentElement) tags.push(n.tagName);
    for (const [word, count] of tally(walker.currentNode.textContent ?? "")) {
      const key = `${word} ${tags.join(" ")}`;
      out.set(key, (out.get(key) ?? 0) + count);
    }
  }
  return out;
};

// A word kept but no longer struck or stressed can turn a sentence around, however small the edit beside it.
function restyled(x: HTMLElement, y: HTMLElement): boolean {
  if (x.tagName !== y.tagName) return true;
  const [wordsA, wordsB] = [tally(x.textContent), tally(y.textContent)];
  const [styleA, styleB] = [styledWords(x), styledWords(y)];
  const keys = new Set([...styleA.keys(), ...styleB.keys()]);
  return [...keys].some((key) => {
    const word = key.slice(0, key.indexOf(" "));
    return wordsA.get(word) === wordsB.get(word) && styleA.get(key) !== styleB.get(key);
  });
}

// Lines no block owns have nothing to mark, like raw HTML leaving a tag open or a link definition, so their source is shown.
function looseLines(
  leaves: HTMLElement[],
  unseen: ReadonlySet<HTMLElement>,
  text: string,
  changed: ReadonlyMap<number, number>,
): Map<number, { line: number; text: string }[]> {
  const owned = new Set<number>();
  const hidden = new Set<number>();
  for (const el of leaves) for (let n = Number(el.dataset.from); n <= Number(el.dataset.to); n++) (unseen.has(el) ? hidden : owned).add(n);
  const lines = text.split("\n");
  const out = new Map<number, { line: number; text: string }[]>();
  for (const [line, hunk] of [...changed].sort((p, q) => p[0] - q[0])) {
    const source = lines[line - 1];
    if (owned.has(line) || !source?.trim() || !(hidden.has(line) || showable(source))) continue;
    out.set(hunk, [...(out.get(hunk) ?? []), { line, text: source }]);
  }
  return out;
}

function hunksIn(el: HTMLElement, cuts: OldCuts): number[] {
  const out = new Set<number>();
  for (let n = Number(el.dataset.from); n <= Number(el.dataset.to); n++) {
    const hunk = cuts.get(n);
    if (hunk !== undefined) out.add(hunk);
  }
  return [...out];
}

function addHunks(el: HTMLElement, hunks: number[]) {
  const had = el.dataset.hunks?.split(" ").map(Number) ?? [];
  const all = [...new Set([...had, ...hunks])].sort((p, q) => p - q);
  if (all.length) el.dataset.hunks = all.join(" ");
}

function anchorIn(leaf: HTMLElement | null, root: HTMLElement, container: string | null): HTMLElement | null {
  for (let n = leaf; n && n !== root; n = n.parentElement) {
    if (container === null ? n.parentElement === root : n.parentElement?.tagName === container && n.parentElement !== root) return n;
  }
  return null;
}

const holdsLine = (el: HTMLElement, lines: ReadonlyMap<number, number>) => {
  for (let n = Number(el.dataset.from); n <= Number(el.dataset.to); n++) if (lines.has(n)) return true;
  return false;
};

const wordsOf = (el: HTMLElement) => el.textContent.replace(/\s+/g, " ").trim();

// A <details> around a removed block has its own summary line, which would otherwise read as kept.
function holdsLooseText(el: HTMLElement): boolean {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const leaf of copy.querySelectorAll("[data-from]")) leaf.remove();
  return !copy.hasAttribute("data-from") && copy.textContent.trim() !== "";
}

function outermost(leaf: HTMLElement, root: HTMLElement, gone: ReadonlySet<Element>, emptied: Map<Element, boolean>): HTMLElement {
  let el = leaf;
  for (let up = el.parentElement; up && up !== root; el = up, up = el.parentElement) {
    if (!emptied.has(up))
      emptied.set(
        up,
        [...up.querySelectorAll("[data-from]")].every((l) => gone.has(l)),
      );
    if (!emptied.get(up)) break;
  }
  return el;
}

const CHANGED = ".md-chg, .md-cut, .md-cut-end, .md-gone, .md-was, .md-del, .md-ins";

function openChanged(root: HTMLElement) {
  for (const details of root.querySelectorAll("details")) if (details.closest(CHANGED) || details.querySelector(CHANGED)) details.open = true;
}

const outerDetails = (el: Element | null | undefined) => el?.parentElement?.closest("details") ?? null;

// Both sides open together, or the matching blocks around a change can't line up.
function openBoth(x: HTMLElement, y: HTMLElement) {
  for (let p = x.closest("details"), q = y.closest("details"); p && q; p = outerDetails(p), q = outerDetails(q)) {
    if (p.open || q.open) p.open = q.open = true;
  }
}

// Puts a removed block back among the blocks around it, in the list or table it came from when that still exists.
function place(el: HTMLElement, oldRoot: HTMLElement, root: HTMLElement, prev: HTMLElement | null, next: HTMLElement | null) {
  const container = el.parentElement === oldRoot ? null : el.parentElement!.tagName;
  const after = anchorIn(prev, root, container);
  if (after) return after.after(el);
  const before = anchorIn(next, root, container);
  if (before) return before.before(el);
  let outer = el;
  for (let up = el.parentElement!; up !== oldRoot; up = up.parentElement!) {
    const shell = up.cloneNode(false) as HTMLElement;
    shell.append(outer);
    outer = shell;
  }
  const top = anchorIn(prev, root, null);
  if (top) top.after(outer);
  else root.prepend(outer);
}

const squeezed = (text: string) => text.replace(/\s+/g, "");

// A block sanitized down to nothing can't show a change, so it leaves the page and its changed lines appear as source.
function shownLeaves(root: HTMLElement): HTMLElement[] {
  const shown = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-from]")) {
    if (rendersNothing(el)) el.remove();
    else shown.push(el);
  }
  return shown;
}

// A new file has no old side to compare against, so whatever its source says that the page doesn't would go unseen.
export function showHiddenText(page: HTMLElement, text: string) {
  const lines = text.split("\n");
  const box = (from: number, to: number) =>
    sourceBox(
      lines.slice(from - 1, to).map((line) => ({ kind: "add", text: line })),
      0,
    );
  const leaves = [...page.querySelectorAll<HTMLElement>("[data-from]")];
  const owned = new Set<number>();
  for (const el of leaves) {
    const [from, to] = [Number(el.dataset.from), Number(el.dataset.to)];
    for (let n = from; n <= to; n++) owned.add(n);
    if (rendersNothing(el)) el.replaceWith(box(from, to));
    else if (hidesWords(lines.slice(from - 1, to).join("\n"), "", el)) (el.closest<HTMLElement>("pre, table, ul, ol, dl") ?? el).after(box(from, to));
  }
  const shown = shownWords(page);
  lines.forEach((line, i) => {
    if (owned.has(i + 1) || ![...wordsIn(line).keys()].some((word) => !shown.has(word))) return;
    const next = leaves.find((el) => el.isConnected && Number(el.dataset.from) > i + 1);
    if (next) (next.closest<HTMLElement>(".md-fence, pre, table") ?? next).before(box(i + 1, i + 1));
    else page.append(box(i + 1, i + 1));
  });
}

export function markChanges(a: HTMLElement, b: HTMLElement, textA: string, textB: string, cuts: OldCuts, added: ReadonlyMap<number, number>, inline: boolean) {
  const changed = cuts.size > 0 || added.size > 0 || !!b.querySelector(".md-chg, .md-cut, .md-cut-end");
  const leavesA = shownLeaves(a);
  const leavesB = shownLeaves(b);
  const blocks = (leaves: HTMLElement[], text: string): Block[] => {
    const lines = text.split("\n");
    return leaves.map((el) => ({ kind: el.tagName, source: lines.slice(Number(el.dataset.from) - 1, Number(el.dataset.to)).join("\n") }));
  };
  const sourceA = blocks(leavesA, textA);
  const sourceB = blocks(leavesB, textB);
  const removed: { el: HTMLElement; hunks: number[]; prev: HTMLElement | null; at: number }[] = [];
  const pairs = alignBlocks(sourceA, sourceB);
  const unseen = new Set<HTMLElement>();
  let prev: HTMLElement | null = null;

  pairs.forEach((pair, i) => {
    const x = pair.a === null ? null : leavesA[pair.a];
    const y = pair.b === null ? null : leavesB[pair.b];
    if (x && y) {
      x.dataset.pair = y.dataset.pair = String(i);
      const hunks = hunksIn(x, cuts);
      const same = sourceA[pair.a!].source === sourceB[pair.b!].source;
      const dirty = y.classList.contains("md-chg") || hunks.length > 0 || wordsOf(x) !== wordsOf(y);
      if (same && !holdsLine(y, added)) {
        // A change in loose text pins its bar on the next block, which the page now doesn't need.
        y.classList.remove("md-chg");
        if (!y.matches(".md-cut, .md-cut-end")) delete y.dataset.hunks;
      } else if (dirty && !same) {
        const targets = targetEdits(x, y);
        const hadOwnMarkup = x.innerHTML !== y.innerHTML;
        const reformatted = x.tagName !== "CODE" && restyled(x, y);
        const noted = targets.cut.length > 0 || targets.put.length > 0;
        const lost = hidesWords(sourceA[pair.a!].source, sourceB[pair.b!].source, x) || hidesWords(sourceB[pair.b!].source, sourceA[pair.a!].source, y);
        const outcome = compare(x, y, inline);
        // The words and markup match but the source doesn't, as with an edit inside a comment.
        const hidden = outcome === "same" && !noted && !hadOwnMarkup && squeezed(sourceA[pair.a!].source) !== squeezed(sourceB[pair.b!].source);
        if (hidden || lost) for (const el of [x, y]) unseen.add(el);
        if (hidden) y.classList.remove("md-chg");
        else y.classList.add("md-chg");
        if (noted || (!lost && (outcome === "same" ? hadOwnMarkup : outcome === "words" && reformatted))) noteTargets(y, targets.cut, targets.put);
        if (outcome === "words") y.classList.add("md-words");
        if (outcome === "words" && x.tagName === "CODE") for (const code of [x, y]) code.closest(".md-fence")?.classList.add("has-edits");
        if (outcome === "words" && x.tagName === "TR" && !inline) x.classList.add("md-edited");
        if (outcome === "apart") markWhole(y, "ins");
        if (outcome === "apart") removed.push({ el: x, hunks, prev, at: i });
        else if (!inline && outcome === "same" && !hidden) x.classList.add("md-was");
        addHunks(y, hunks);
        if (!inline) addHunks(x, hunks);
      }
    } else if (x) {
      x.dataset.lone = "";
      const hunks = hunksIn(x, cuts);
      // An edit can reshape blocks it never touched, like a deleted closing fence swallowing what follows.
      if (hunks.length || changed) {
        removed.push({ el: x, hunks, prev, at: i });
        if (hidesWords(sourceA[pair.a!].source, "", x)) unseen.add(x);
      }
    } else if (y) {
      y.dataset.lone = "";
      if (changed) {
        if (hidesWords(sourceB[pair.b!].source, "", y)) unseen.add(y);
        y.classList.add("md-chg");
        markWhole(y, "ins");
        const addresses = hiddenAddresses(y);
        if (addresses.length) noteTargets(y, [], addresses);
      }
    }
    if (y) prev = y;
  });

  const gone = new Set<Element>(removed.map((r) => r.el));
  for (const r of removed) {
    r.el.classList.add("md-gone");
    markWhole(r.el, "del");
    addHunks(r.el, r.hunks);
    const addresses = r.el.dataset.lone === undefined ? [] : hiddenAddresses(r.el);
    if (addresses.length) noteTargets(r.el, addresses, []);
  }
  const looseOld = looseLines(leavesA, unseen, textA, cuts);
  const looseNew = looseLines(leavesB, unseen, textB, added);
  const looseRows = (hunk: number) =>
    fenceRows(
      (looseOld.get(hunk) ?? []).map((l) => l.text),
      (looseNew.get(hunk) ?? []).map((l) => l.text),
    );
  const nextOf = (leaves: HTMLElement[], line: number) => leaves.find((el) => Number(el.dataset.from) > line) ?? null;
  const afterCut = (line: number) => {
    const next = pairs.find((p) => p.a !== null && p.b !== null && Number(leavesA[p.a].dataset.from) > line);
    return next ? leavesB[next.b!] : null;
  };
  // The next block can be a line inside a table or a fence, and a drawn diagram hides what's in its fence.
  const putBefore = (root: HTMLElement, next: HTMLElement | null, box: HTMLElement) =>
    next ? (next.closest<HTMLElement>(".md-fence") ?? next.closest<HTMLElement>("pre, table") ?? next).before(box) : root.append(box);
  const looseHunks = [...new Set([...looseOld.keys(), ...looseNew.keys()])];

  if (!inline) {
    for (const hunk of looseHunks) {
      const rows = looseRows(hunk);
      const cut = looseOld.get(hunk);
      const put = looseNew.get(hunk);
      if (cut)
        putBefore(
          a,
          nextOf(leavesA, cut.at(-1)!.line),
          sourceBox(
            rows.filter((r) => r.kind === "del"),
            hunk,
          ),
        );
      if (put)
        putBefore(
          b,
          nextOf(leavesB, put.at(-1)!.line),
          sourceBox(
            rows.filter((r) => r.kind === "add"),
            hunk,
          ),
        );
    }
    openChanged(a);
    openChanged(b);
    for (const { a: i, b: j } of pairs) if (i !== null && j !== null) openBoth(leavesA[i], leavesB[j]);
    return;
  }

  const nextAfter = (at: number) => {
    for (let i = at + 1; i < pairs.length; i++) if (pairs[i].b !== null) return leavesB[pairs[i].b!];
    return null;
  };
  const moved = new Set<Element>();
  const emptied = new Map<Element, boolean>();
  let last: { from: HTMLElement | null; el: HTMLElement } | null = null;
  for (const r of removed) {
    if (moved.has(r.el)) continue;
    const outer = outermost(r.el, a, gone, emptied);
    moved.add(outer);
    for (const leaf of outer.querySelectorAll("[data-from]")) moved.add(leaf);
    if (holdsLooseText(outer)) outer.classList.add("md-gone");
    const anchor: HTMLElement | null = last && last.from === r.prev ? last.el : r.prev;
    place(outer, a, b, anchor, leavesB[pairs[r.at].b ?? -1] ?? nextAfter(r.at));
    last = { from: r.prev, el: outer };
  }
  for (const hunk of looseHunks) {
    const put = looseNew.get(hunk);
    const next = put ? nextOf(leavesB, put.at(-1)!.line) : afterCut(looseOld.get(hunk)!.at(-1)!.line);
    putBefore(b, next, sourceBox(looseRows(hunk), hunk));
  }
  for (const el of b.querySelectorAll<HTMLElement>(".md-gone")) {
    delete el.dataset.from;
    delete el.dataset.to;
    delete el.dataset.pair;
    delete el.dataset.lone;
  }

  const shown = new Set<string>();
  for (const el of b.querySelectorAll<HTMLElement>(".md-gone, .md-words")) for (const h of el.dataset.hunks?.split(" ") ?? []) shown.add(h);
  for (const el of b.querySelectorAll<HTMLElement>(".md-cut, .md-cut-end")) {
    if (el.dataset.hunks?.split(" ").every((h) => shown.has(h))) el.classList.remove("md-cut", "md-cut-end");
  }
  openChanged(b);
}
