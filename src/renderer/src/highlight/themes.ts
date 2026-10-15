import type { ThemeRegistration } from "shiki";

const ink = "var(--tok-ink)";

export const moireTheme: ThemeRegistration = {
  name: "moire",
  type: "light",
  colors: { "editor.foreground": ink },
  settings: [
    { settings: { foreground: ink } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--tok-com)", fontStyle: "italic" } },
    { scope: ["string", "string.template", "punctuation.definition.string"], settings: { foreground: "var(--tok-str)" } },
    { scope: ["constant.numeric", "constant.language", "variable.other.constant", "constant.other"], settings: { foreground: "var(--tok-num)" } },
    {
      scope: ["keyword", "storage", "storage.type", "storage.modifier", "variable.language", "keyword.operator.new", "keyword.operator.expression"],
      settings: { foreground: "var(--tok-kw)", fontStyle: "bold" },
    },
    { scope: ["keyword.operator", "punctuation", "meta.brace"], settings: { foreground: "var(--tok-pun)", fontStyle: "" } },
    {
      scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"],
      settings: { foreground: "var(--tok-ty)" },
    },
    { scope: ["entity.name.tag", "support.type.property-name"], settings: { foreground: "var(--tok-ty)" } },
  ],
};
