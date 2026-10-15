import { type BundledLanguage, createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { fenceLang } from "../model/lang";
import { customLangs } from "./grammars";
import { moireTheme } from "./themes";
import type { HighlightRequest, HighlightResponse, Tok, TokLines } from "./types";

type ShikiLines = ReturnType<Highlighter["codeToTokensBase"]>;

const MAX_LINE = 1000;
// Big files send their first lines ahead, so the top isn't plain while the rest is coloured.
const AHEAD = 1000;
const EMBEDS = new Set(["markdown", "mdx", "vue", "svelte", "astro"]);
const FENCED = new Set(["markdown", "mdx"]);
const EMBEDDED = /^[ \t]*(?:`{3,}|~{3,})[ \t]*\{?\.?([\w#+.-]+)|\blang=["']?([\w#+.-]+)/gm;
const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*\{?\.?([\w#+.-]*)/;

let highlighter: Promise<Highlighter> | null = null;

function getHighlighter() {
  highlighter ??= createHighlighter({
    themes: [moireTheme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

async function load(hl: Highlighter, lang: string) {
  if (lang === "text" || hl.getLoadedLanguages().includes(lang)) return true;
  try {
    await hl.loadLanguage(customLangs[lang] ?? (lang as BundledLanguage));
    return true;
  } catch {
    return false;
  }
}

function embedded(text: string) {
  const langs = new Set<string>();
  for (const m of text.matchAll(EMBEDDED)) langs.add(fenceLang(m[1] ?? m[2]));
  return [...langs];
}

function tokenize(hl: Highlighter, lang: string, lines: string[], after?: ShikiLines): ShikiLines {
  const grammarState = after && hl.getLastGrammarState(after);
  return hl.codeToTokensBase(lines.join("\n"), { lang: lang as BundledLanguage, theme: moireTheme, tokenizeMaxLineLength: MAX_LINE, grammarState });
}

// Shiki's markdown grammar embeds only some languages, so fenced bodies are coloured on their own.
function colourFences(hl: Highlighter, lines: string[], out: ShikiLines) {
  const loaded = hl.getLoadedLanguages();
  let open: { fence: string; lang: string; from: number } | null = null;
  lines.forEach((line, i) => {
    const m = FENCE.exec(line);
    if (!open) {
      if (m) open = { fence: m[1], lang: fenceLang(m[2]), from: i + 1 };
      return;
    }
    if (!m || m[1][0] !== open.fence[0] || m[1].length < open.fence.length || line.trim() !== m[1]) return;
    if (open.lang !== "text" && loaded.includes(open.lang) && i > open.from) {
      out.splice(open.from, i - open.from, ...tokenize(hl, open.lang, lines.slice(open.from, i)));
    }
    open = null;
  });
}

const flat = (lines: ShikiLines): TokLines => lines.map((line) => line.map((t): Tok => [t.content, t.color ?? "", t.fontStyle ?? 0]));

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, lang, texts, partial } = event.data;
  const hl = await getHighlighter();
  const useLang = (await load(hl, lang)) ? lang : "text";
  if (EMBEDS.has(useLang)) await Promise.all(texts.flatMap((t) => (t ? embedded(t) : [])).map((l) => load(hl, l)));
  const lines = texts.map((text) => text?.split(/\r?\n/) ?? null);
  const ahead = !!partial && useLang !== "text" && lines.some((l) => l && l.length > AHEAD * 3);
  const heads = lines.map((l) => l && tokenize(hl, useLang, ahead ? l.slice(0, AHEAD) : l));
  if (ahead) self.postMessage({ id, sides: heads.map((h) => h && flat(h)), done: false } satisfies HighlightResponse);
  const sides = heads.map((head, i) => {
    const l = lines[i];
    if (!head || !l) return null;
    const all = ahead && l.length > AHEAD ? [...head, ...tokenize(hl, useLang, l.slice(AHEAD), head)] : head;
    if (FENCED.has(useLang)) colourFences(hl, l, all);
    return flat(all);
  });
  self.postMessage({ id, sides, done: true } satisfies HighlightResponse);
};
