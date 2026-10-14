import { type BundledLanguage, createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { moireTheme } from "./themes";
import type { HighlightRequest, HighlightResponse, Tok } from "./types";

let highlighter: Promise<Highlighter> | null = null;

function getHighlighter() {
  highlighter ??= createHighlighter({
    themes: [moireTheme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, lang, texts } = event.data;
  const hl = await getHighlighter();
  let useLang = lang;
  if (lang !== "text" && !hl.getLoadedLanguages().includes(lang)) {
    try {
      await hl.loadLanguage(lang as BundledLanguage);
    } catch {
      useLang = "text";
    }
  }
  const sides = texts.map((text) => {
    if (text === null) return null;
    const lines = hl.codeToTokensBase(text, { lang: useLang as BundledLanguage, theme: moireTheme, tokenizeMaxLineLength: 1000 });
    return lines.map((line) => line.map((t): Tok => [t.content, t.color ?? "", t.fontStyle ?? 0]));
  });
  self.postMessage({ id, sides } satisfies HighlightResponse);
};
