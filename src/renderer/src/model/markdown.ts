import MarkdownIt from "markdown-it";
import type { ChangeMarks } from "./preview";

// Raw HTML stays escaped text, so nothing in a reviewed file can inject markup.
const md = new MarkdownIt({ html: false, linkify: false });

// Blocks that get change marks; containers like lists and tables are marked through their children.
const LEAVES = new Set(["paragraph_open", "heading_open", "fence", "code_block", "hr", "tr_open"]);

const defaultImage = md.renderer.rules.image!;

// Renders Markdown with data-from/data-to source lines on each block, and md-chg, md-cut and md-cut-end on changed ones,
// with data-hunks listing the hunks behind the marks. image maps an image's src to a repo URL; others render as their alt text.
export function renderMarkdown(text: string, marks: ChangeMarks | null, image: (src: string) => string | null): string {
  const tokens = md.parse(text, {});
  const leaves = [];
  for (const t of tokens) {
    // Tight list items hide their paragraph; keep it so it can carry marks, and let CSS drop its margin.
    if ((t.type === "paragraph_open" || t.type === "paragraph_close") && t.hidden) {
      t.hidden = false;
      if (t.nesting === 1) t.attrJoin("class", "tight");
    }
    if (LEAVES.has(t.type) && t.map) leaves.push(t);
  }

  // Leaves never nest, so they're in line order.
  const blocks = leaves.map((t) => ({ from: t.map![0] + 1, to: t.map![1], chg: false, cut: false, cutEnd: false, hunks: new Set<number>() }));
  // the last block starting at or before line n, or -1
  const startedBy = (n: number) => {
    let lo = 0;
    let hi = blocks.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].from <= n) [found, lo] = [mid, mid + 1];
      else hi = mid - 1;
    }
    return found;
  };
  const sourceLines = text.split("\n");
  if (marks && blocks.length) {
    for (const [n, hunk] of marks.added) {
      const i = startedBy(n);
      const inside = i >= 0 && n <= blocks[i].to;
      if (!inside && !sourceLines[n - 1]?.trim()) continue;
      // Lines no block renders, like link definitions or a table's alignment row, mark the block before them.
      const block = blocks[Math.max(i, 0)];
      block.chg = true;
      block.hunks.add(hunk);
    }
    for (const [n, hunk] of marks.cuts) {
      // Removed lines followed by added ones are an edit, marked through the added lines.
      if (marks.added.has(n)) continue;
      const i = startedBy(n);
      if (i >= 0 && n > blocks[i].from && n <= blocks[i].to) {
        blocks[i].chg = true;
        blocks[i].hunks.add(hunk);
      } else if (i >= 0 && n === blocks[i].from) {
        blocks[i].cut = true;
        blocks[i].hunks.add(hunk);
      } else if (i + 1 < blocks.length) {
        blocks[i + 1].cut = true;
        blocks[i + 1].hunks.add(hunk);
      } else {
        blocks[i].cutEnd = true;
        blocks[i].hunks.add(hunk);
      }
    }
  }
  leaves.forEach((t, i) => {
    const b = blocks[i];
    t.attrSet("data-from", String(b.from));
    t.attrSet("data-to", String(b.to));
    if (b.chg) t.attrJoin("class", "md-chg");
    if (b.cut) t.attrJoin("class", "md-cut");
    if (b.cutEnd) t.attrJoin("class", "md-cut-end");
    if (b.hunks.size) t.attrSet("data-hunks", [...b.hunks].sort((x, y) => x - y).join(" "));
  });

  return md.renderer.render(tokens, md.options, { image });
}

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const url = (env as { image: (src: string) => string | null }).image(String(token.attrGet("src") ?? ""));
  if (!url) return `<span class="md-img-off">${md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env))}</span>`;
  token.attrSet("src", url);
  return defaultImage(tokens, idx, options, env, self);
};
