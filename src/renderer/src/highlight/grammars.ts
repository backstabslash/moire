import type { LanguageRegistration } from "shiki";

export const customLangs: Record<string, LanguageRegistration> = {
  "go-mod": {
    name: "go-mod",
    scopeName: "source.go-mod",
    repository: {},
    patterns: [
      { match: "//.*$", name: "comment.line.double-slash.go-mod" },
      { match: "^\\s*(module|go|toolchain|godebug|require|replace|exclude|retract|tool|use)\\b", captures: { 1: { name: "keyword.other.go-mod" } } },
      { match: "=>", name: "keyword.operator.go-mod" },
      { match: "\\bv\\d+\\.\\d+\\.\\d+[\\w.+-]*|(?<=^go\\s+)\\d+(\\.\\d+)*", name: "constant.numeric.version.go-mod" },
      { match: "\\bh1:[A-Za-z0-9+/=]+", name: "string.other.hash.go-mod" },
      { match: "[()]", name: "punctuation.section.parens.go-mod" },
    ],
  },
  ignore: {
    name: "ignore",
    scopeName: "source.ignore",
    repository: {},
    patterns: [
      { match: "^\\s*#.*$", name: "comment.line.number-sign.ignore" },
      { match: "^\\s*!", name: "keyword.control.negation.ignore" },
      { match: "\\*\\*|[*?]|\\[[^\\]]*\\]", name: "string.regexp.glob.ignore" },
      { match: "/", name: "punctuation.separator.path.ignore" },
      { match: "(?<=\\s)[-!]?[\\w-]+(?=[=\\s]|$)", name: "entity.other.attribute-name.ignore" },
    ],
  },
};
