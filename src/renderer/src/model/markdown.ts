import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import type { ChangeMarks } from "./preview";

const md = new MarkdownIt({ html: true, linkify: false });

const LEAVES = new Set(["paragraph_open", "heading_open", "fence", "code_block", "hr", "tr_open"]);

const VOID = new Set(["img", "br", "hr", "wbr", "source", "embed"]);
const TABLE_PARTS = new Set(["thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"]);

// Wrapping a block that leaves a tag open, like <details>, would close it early.
function wrappable(content: string): boolean {
  const html = content.trim();
  if (html.startsWith("<!--") && !html.replace(/<!--[\s\S]*?-->/g, "").trim()) return true;
  const tag = /^<([a-z][\w-]*)[\s/>]/i.exec(html)?.[1]?.toLowerCase();
  if (!tag || TABLE_PARTS.has(tag)) return false;
  if (VOID.has(tag) && /^<[^<>]*>$/.test(html)) return true;
  if (!html.toLowerCase().endsWith(`</${tag}>`)) return false;
  return html.match(new RegExp(`<${tag}[\\s>]`, "gi"))!.length === html.match(new RegExp(`</${tag}>`, "gi"))!.length;
}

export function renderMarkdown(text: string, marks: ChangeMarks | null, image: (src: string) => string | null): string {
  // Marks go on under a name the file can't guess, so HTML in it can't fake them.
  const own = `data-m${crypto.randomUUID().replaceAll("-", "")}-`;
  const tokens = md.parse(text, {});
  const leaves = [];
  const loose: { from: number; to: number; opens: boolean }[] = [];
  for (const t of tokens) {
    if ((t.type === "paragraph_open" || t.type === "paragraph_close") && t.hidden) {
      t.hidden = false;
      if (t.nesting === 1) t.attrJoin(`${own}class`, "tight");
    }
    if (!t.map) continue;
    if (LEAVES.has(t.type) || (t.type === "html_block" && wrappable(t.content))) leaves.push(t);
    else if (t.type === "html_block") loose.push({ from: t.map[0] + 1, to: t.map[1], opens: !t.content.trimStart().startsWith("</") });
  }

  const blocks = leaves.map((t) => ({ from: t.map![0] + 1, to: t.map![1], chg: false, cut: false, cutEnd: false, hunks: new Set<number>() }));
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
      let i = startedBy(n);
      const inside = i >= 0 && n <= blocks[i].to;
      if (!inside && !sourceLines[n - 1]?.trim()) continue;
      const run = inside ? undefined : loose.find((r) => n >= r.from && n <= r.to);
      if (run?.opens && startedBy(run.to) + 1 < blocks.length) i = startedBy(run.to) + 1;
      const block = blocks[Math.max(i, 0)];
      block.chg = true;
      block.hunks.add(hunk);
    }
    for (const [n, hunk] of marks.cuts) {
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
    t.attrSet(`${own}from`, String(b.from));
    t.attrSet(`${own}to`, String(b.to));
    if (b.chg) t.attrJoin(`${own}class`, "md-chg");
    if (b.cut) t.attrJoin(`${own}class`, "md-cut");
    if (b.cutEnd) t.attrJoin(`${own}class`, "md-cut-end");
    if (b.hunks.size) t.attrSet(`${own}hunks`, [...b.hunks].sort((x, y) => x - y).join(" "));
  });

  return sanitize(md.renderer.render(tokens, md.options, {}), own, image);
}

const defaultHtmlBlock = md.renderer.rules.html_block!;

md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
  const html = defaultHtmlBlock(tokens, idx, options, env, self);
  return tokens[idx].attrs ? `<div${self.renderAttrs(tokens[idx])}>${html}</div>\n` : html;
};

// Anything that could hide a change from the reviewer goes, so hidden text shows and colour can't blend it in.
function sanitize(html: string, own: string, image: (src: string) => string | null): string {
  const page = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "template", "dialog", "noscript"],
    FORBID_ATTR: ["style", "id", "class", "hidden", "color", "bgcolor"],
  });
  for (const el of page.querySelectorAll("*")) {
    const attrs = [...el.attributes].filter((a) => a.name.startsWith("data-"));
    for (const a of attrs) el.removeAttribute(a.name);
    for (const a of attrs) if (a.name.startsWith(own)) el.setAttribute(a.name === `${own}class` ? "class" : `data-${a.name.slice(own.length)}`, a.value);
  }
  for (const details of page.querySelectorAll("details")) {
    if (details.querySelector(".md-chg, .md-cut, .md-cut-end")) details.open = true;
  }
  for (const img of page.querySelectorAll("img")) {
    const url = image(img.getAttribute("src") ?? "");
    if (url) {
      img.setAttribute("src", url);
      continue;
    }
    const off = document.createElement("span");
    off.className = "md-img-off";
    off.textContent = img.alt;
    img.replaceWith(off);
  }
  const box = document.createElement("div");
  box.append(page);
  return box.innerHTML;
}
