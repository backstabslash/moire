import DOMPurify from "dompurify";
import MarkdownIt, { type MarkdownIt as Parser, type StateCore, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";
import type { ChangeMarks } from "./preview";
import { fillFence, imageSource } from "./redline";

const options = { html: true, linkify: false };
const md = new MarkdownIt(options);
const pageMd = new MarkdownIt(options).use(footnote);

const ENDS_BY_OPENER: [string, string][] = [
  ["<!--", "-->"],
  ["<![CDATA[", "]]>"],
  ["<?", "?>"],
  ["<!", ">"],
];

const lastEnds = new WeakMap<object, Map<string, number>>();

// These only match up to their end marker, and the built-in rule rescans the rest of the text for it at every opener.
for (const parser of [md, pageMd]) {
  parser.inline.ruler.before("html_inline", "moire_unended", (state, silent) => {
    const end = ENDS_BY_OPENER.find(([opener]) => state.src.startsWith(opener, state.pos))?.[1];
    if (!end) return false;
    const seen = lastEnds.get(state) ?? new Map<string, number>();
    lastEnds.set(state, seen);
    if (!seen.has(end)) seen.set(end, state.src.lastIndexOf(end));
    if (seen.get(end)! >= state.pos) return false;
    if (!silent) state.pending += "<";
    state.pos++;
    return true;
  });
}

// Without this, the closing --- turns the whole block into one huge heading.
pageMd.block.ruler.before("table", "moire_front_matter", (state, start, end, silent) => {
  const line = (n: number) => state.getLines(n, n + 1, 0, false).trimEnd();
  if (start !== 0 || line(0) !== "---" || !/^[\w"'-]+:/.test(line(1))) return false;
  let close = 1;
  while (close < end && line(close) !== "---" && line(close) !== "...") close++;
  if (close >= end) return false;
  if (silent) return true;
  const token = state.push("fence", "code", 0);
  token.info = "yaml";
  token.markup = "---";
  token.content = state.getLines(1, close, 0, true);
  token.map = [0, close + 1];
  state.line = close + 1;
  return true;
});

const LEAVES = new Set(["paragraph_open", "heading_open", "fence", "code_block", "hr", "tr_open"]);

const VOID = new Set(["img", "br", "hr", "wbr", "source", "embed", "input", "link", "meta", "area", "base", "col", "param", "track"]);
const TABLE_PARTS = new Set(["thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"]);
// The browser reads these as text up to their closing tag, whatever blocks lie in between.
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes", "iframe", "plaintext", "noscript"]);
const TAG_NAME = /\/?[a-z][\w-]*/iy;
const NOT_AN_ELEMENT = /^\s*<[?!](?!--)/;

interface Tag {
  closing: boolean;
  name: string;
}

function withoutComments(html: string): string | null {
  let out = "";
  let from = 0;
  for (let at = html.indexOf("<!--"); at >= 0; at = html.indexOf("<!--", from)) {
    const end = html.indexOf("-->", at + 2);
    if (end < 0) return null;
    out += html.slice(from, at);
    from = end + 3;
  }
  return out + html.slice(from);
}

// By hand, because a regex goes quadratic on a file full of tags that never end.
function tagsIn(html: string): Tag[] | null {
  const tags: Tag[] = [];
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", at + 1)) {
    TAG_NAME.lastIndex = at + 1;
    const found = TAG_NAME.exec(html);
    if (!found) continue;
    let end = TAG_NAME.lastIndex;
    if (end < html.length && !/[\s/>]/.test(html[end])) continue;
    let quote = "";
    for (; end < html.length && (quote || html[end] !== ">"); end++) {
      const c = html[end];
      if (quote) quote = c === quote ? "" : quote;
      else if (c === '"' || c === "'") quote = c;
    }
    if (end >= html.length) return null;
    tags.push({ closing: found[0][0] === "/", name: found[0].replace("/", "").toLowerCase() });
    at = end;
  }
  return tags;
}

// A comment, tag or raw-text element left open reads on past its block and takes the rest of the page with it.
function leavesOpen(html: string, tags: Tag[] | null): boolean {
  if (!tags || NOT_AN_ELEMENT.test(html)) return true;
  const raw = new Set<string>();
  for (const { closing, name } of tags) if (RAW_TEXT.has(name)) raw[closing ? "delete" : "add"](name);
  return raw.size > 0;
}

function closedTags(content: string): Tag[] | null {
  const html = withoutComments(content);
  const tags = html === null ? null : tagsIn(html);
  return html === null || leavesOpen(html, tags) ? null : tags;
}

// Wrapping a block that leaves a tag open, like <details>, would close it early.
function wrappable(content: string, tags: Tag[]): boolean {
  const html = withoutComments(content)!.trim();
  if (!html) return true;
  const open: string[] = [];
  for (const { closing, name } of tags) {
    if (TABLE_PARTS.has(name) && !open.length) return false;
    if (VOID.has(name)) continue;
    if (!closing) open.push(name);
    else if (open.pop() !== name) return false;
  }
  return !open.length && html.startsWith("<");
}

function defuseInline(children: Token[]) {
  const closed = new Set<string>();
  for (const child of children.toReversed()) {
    if (child.type !== "html_inline") continue;
    const tag = tagsIn(child.content)?.[0];
    if (!tag || !RAW_TEXT.has(tag.name)) continue;
    if (tag.closing) closed.add(tag.name);
    else if (!closed.delete(tag.name)) child.type = "text";
  }
}

function lastStartingBy<T extends { from: number }>(list: T[], line: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from <= line) [found, lo] = [mid, mid + 1];
    else hi = mid - 1;
  }
  return found;
}

const BARE_CR = /\r(?!\n)/g;
const FOOTNOTE_MARK = /\^\[|\[\^/g;
const FOOTNOTE_RULES = ["footnote_def", "footnote_inline", "footnote_ref", "footnote_tail"];
const MAX_FOOTNOTES = 500;

// The footnote plugin copies the whole token list per footnote, so a file made of them would hold the window for minutes.
function parse(parser: Parser, text: string, env: Record<string, string>): Token[] {
  const source = text.replace(BARE_CR, " ");
  if (parser !== pageMd || (source.match(FOOTNOTE_MARK)?.length ?? 0) <= MAX_FOOTNOTES) return parser.parse(source, env);
  parser.disable(FOOTNOTE_RULES);
  try {
    return parser.parse(source, env);
  } finally {
    parser.enable(FOOTNOTE_RULES);
  }
}

export function plainPage(text: string): string {
  const box = document.createElement("div");
  const note = document.createElement("p");
  note.className = "md-too-big";
  note.textContent = "This file is too big to render, so here is its text. The diff still shows what changed.";
  const pre = document.createElement("pre");
  pre.textContent = text;
  box.append(note, pre);
  return box.innerHTML;
}

type ImageUrl = (src: string) => string | null;

export function renderMarkdown(text: string, marks: ChangeMarks | null, image: ImageUrl): string {
  return build(md, text, marks, image).innerHTML;
}

export function markdownPage(text: string, marks: ChangeMarks | null, image: ImageUrl): HTMLElement {
  const page = build(pageMd, text, marks, image);
  for (const code of page.querySelectorAll<HTMLElement>("pre > code[data-from]")) fenceBox(code);
  return page;
}

function fenceBox(code: HTMLElement) {
  const lines = code.textContent.replace(/\n$/, "").split("\n");
  fillFence(
    code,
    lines.map((text) => ({ kind: "", text })),
  );
  const pre = code.parentElement!;
  const box = document.createElement("div");
  box.className = "md-fence";
  pre.replaceWith(box);
  const tools = document.createElement("span");
  tools.className = "md-tools";
  const copy = document.createElement("button");
  copy.className = "md-copy";
  copy.textContent = "Copy";
  if (code.dataset.lang) tools.append(Object.assign(document.createElement("span"), { textContent: code.dataset.lang }));
  tools.append(copy);
  box.append(tools, pre);
}

function build(parser: Parser, text: string, marks: ChangeMarks | null, image: ImageUrl): HTMLElement {
  // Marks go on under a name the file can't guess, so HTML in it can't fake them.
  const own = `data-m${crypto.randomUUID().replaceAll("-", "")}-`;
  const env = { own };
  const tokens = parse(parser, text, env);
  const leaves = [];
  const loose: { from: number; to: number; opens: boolean }[] = [];
  for (const t of tokens) {
    const tags = t.type === "html_block" ? closedTags(t.content) : null;
    if (t.type === "html_block" && !tags) Object.assign(t, { type: "fence", tag: "code", markup: "```", info: "html" });
    if (t.type === "inline" && t.children) defuseInline(t.children);
    if ((t.type === "paragraph_open" || t.type === "paragraph_close") && t.hidden) {
      t.hidden = false;
      if (t.nesting === 1) t.attrJoin(`${own}class`, "tight");
    }
    if (t.type === "fence" && parser === pageMd) t.attrSet(`${own}lang`, t.info.trim().split(/\s+/)[0].toLowerCase());
    if (t.type === "fence" && t.markup === "---") t.attrJoin(`${own}class`, "md-front");
    // The sanitizer takes style attributes, and with them a table's column alignment.
    const align = t.type === "th_open" || t.type === "td_open" ? /text-align:(\w+)/.exec(String(t.attrGet("style")))?.[1] : null;
    if (align) t.attrJoin(`${own}class`, `md-align-${align}`);
    if (!t.map) continue;
    if (LEAVES.has(t.type) || (tags && wrappable(t.content, tags))) leaves.push(t);
    else if (t.type === "html_block") loose.push({ from: t.map[0] + 1, to: t.map[1], opens: !t.content.trimStart().startsWith("</") });
  }

  // Footnotes render at the end whatever line they were written on.
  leaves.sort((x, y) => x.map![0] - y.map![0]);
  const blocks = leaves.map((t) => ({ from: t.map![0] + 1, to: t.map![1], chg: false, cut: false, cutEnd: false, hunks: new Set<number>() }));
  const startedBy = (n: number) => lastStartingBy(blocks, n);
  loose.sort((x, y) => x.from - y.from);
  const sourceLines = text.split("\n");
  if (marks && blocks.length) {
    for (const [n, hunk] of marks.added) {
      let i = startedBy(n);
      const inside = i >= 0 && n <= blocks[i].to;
      if (!inside && !sourceLines[n - 1]?.trim()) continue;
      const candidate = inside ? undefined : loose[lastStartingBy(loose, n)];
      const run = candidate && n <= candidate.to ? candidate : undefined;
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

  return sanitize(parser.renderer.render(tokens, parser.options, env), own, image);
}

for (const parser of [md, pageMd]) {
  const defaultHtmlBlock = parser.renderer.rules.html_block!;
  parser.renderer.rules.html_block = (tokens, idx, options, env, self) => {
    const html = defaultHtmlBlock(tokens, idx, options, env, self);
    return tokens[idx].attrs ? `<div${self.renderAttrs(tokens[idx])}>${html}</div>\n` : html;
  };
}

// The sanitizer drops ids and classes, so footnote targets travel under the page's own name.
for (const rule of ["footnote_ref", "footnote_open", "footnote_block_open"]) {
  const base = pageMd.renderer.rules[rule]!;
  pageMd.renderer.rules[rule] = (tokens, idx, options, env, self) =>
    base(tokens, idx, options, env, self)
      .replace(/\bid="/, `${env!.own}anchor="`)
      .replace('class="footnotes"', `${env!.own}class="md-footnotes"`);
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;
const TASK = /^\[([ xX])\] /;

export function slug(text: string, seen: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

pageMd.core.ruler.after("inline", "moire_page", (state: StateCore) => {
  const own = state.env.own as string;
  const tag = (html: string) => {
    const token = new state.Token("html_inline", "", 0);
    token.content = html;
    return token;
  };
  const seen = new Map<string, number>();
  state.tokens.forEach((t, i) => {
    if (t.type !== "inline" || !t.children?.length) return;
    const head = state.tokens[i - 1];
    const outer = state.tokens[i - 2];
    const first = t.children[0];
    if (head.type === "heading_open") {
      const words = t.children.filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content);
      head.attrSet(`${own}anchor`, slug(words.join(""), seen));
    }
    if (first.type !== "text" || outer?.nesting !== 1) return;
    const task = outer.type === "list_item_open" && TASK.exec(first.content);
    if (task) {
      first.content = first.content.slice(task[0].length);
      t.children.unshift(tag(`<span ${own}class="md-box${task[1] === " " ? "" : " on"}"></span>`));
      outer.attrJoin(`${own}class`, "md-task");
    }
    const alert = outer.type === "blockquote_open" && ALERT.exec(first.content);
    if (alert) {
      const kind = alert[1].toLowerCase();
      t.children.splice(
        0,
        t.children[1]?.type === "softbreak" ? 2 : 1,
        tag(`<span ${own}class="md-alert-title">${kind[0].toUpperCase()}${kind.slice(1)}</span>`),
      );
      outer.attrJoin(`${own}class`, `md-alert md-alert-${kind}`);
    }
  });
});

const HIDES_ITS_TEXT = "audio, video, canvas, meter, progress, datalist, rp, marquee";

// Anything that could hide a change from the reviewer goes, so hidden text shows and colour can't blend it in.
function sanitize(html: string, own: string, image: ImageUrl): HTMLElement {
  const page = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "template", "dialog", "noscript", "mphantom"],
    FORBID_ATTR: ["style", "id", "class", "hidden", "popover", "color", "bgcolor"],
  });
  for (const el of page.querySelectorAll(HIDES_ITS_TEXT)) el.replaceWith(...el.childNodes);
  for (const el of page.querySelectorAll("*")) {
    const attrs = [...el.attributes].filter((a) => a.name.startsWith("data-"));
    for (const a of attrs) el.removeAttribute(a.name);
    for (const a of attrs) if (a.name.startsWith(own)) el.setAttribute(a.name === `${own}class` ? "class" : `data-${a.name.slice(own.length)}`, a.value);
  }
  for (const details of page.querySelectorAll("details")) {
    if (details.querySelector(".md-chg, .md-cut, .md-cut-end")) details.open = true;
  }
  for (const img of page.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const url = image(src);
    if (url) {
      imageSource.set(img, src);
      img.setAttribute("src", url);
      const tone = /#gh-(light|dark)-mode-only$/.exec(src)?.[1];
      if (tone) img.className = `md-only-${tone}`;
      continue;
    }
    const off = document.createElement("span");
    off.className = "md-img-off";
    imageSource.set(off, src);
    off.textContent = img.alt;
    img.replaceWith(off);
  }
  const box = document.createElement("div");
  box.append(page);
  return box;
}
