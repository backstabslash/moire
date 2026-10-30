import type { FileDiff } from "../../../shared/types";
import { type Family, familyOf } from "./family";
import { langFor } from "./lang";

const ROLE_GLYPH_FAMILIES = new Set<Family>(["lock", "image", "binary", "git", "other"]);

const BY_LANG: Record<string, string> = {
  typescript: "TS",
  tsx: "TX",
  javascript: "JS",
  jsx: "JX",
  python: "PY",
  go: "GO",
  rust: "RS",
  java: "JV",
  kotlin: "KT",
  swift: "SW",
  c: "C",
  cpp: "C+",
  csharp: "C#",
  "objective-c": "OC",
  ruby: "RB",
  php: "PH",
  lua: "LU",
  dart: "DA",
  elixir: "EX",
  erlang: "ER",
  haskell: "HS",
  scala: "SC",
  clojure: "CL",
  ocaml: "ML",
  fsharp: "F#",
  r: "R",
  julia: "JL",
  perl: "PL",
  zig: "ZG",
  nim: "NM",
  solidity: "SO",
  vue: "VU",
  svelte: "SV",
  astro: "AS",
  html: "<>",
  xml: "<>",
  css: "#",
  scss: "SA",
  sass: "SA",
  less: "LS",
  json: "{}",
  jsonc: "{}",
  json5: "{}",
  yaml: "YM",
  toml: "TM",
  markdown: "MD",
  mdx: "MX",
  graphql: "GQ",
  proto: "PB",
  shellscript: "SH",
  fish: "SH",
  powershell: "PS",
  bat: "BT",
  sql: "SQ",
  prisma: "PR",
  docker: "DK",
  make: "MK",
  cmake: "CM",
  terraform: "TF",
  hcl: "TF",
  nix: "NX",
};

const BY_NAME: [RegExp, string][] = [
  [/^package\.json$/, "N"],
  [/^[jt]sconfig([.-].*)?\.json$/, BY_LANG.typescript],
  [/^(docker-)?compose([.-].*)?\.ya?ml$/, BY_LANG.docker],
  [/^cargo\.toml$/, BY_LANG.rust],
  [/^go\.(mod|work)$/, BY_LANG.go],
  [/^(pyproject\.toml|(requirements|constraints)\b.*\.(txt|in))$/, BY_LANG.python],
  [/^vite(st)?\.config\./, "VI"],
  [/^(eslint\.config\.|\.eslintrc)/, "ES"],
  [/^(prettier\.config\.|\.prettierrc)/, "PT"],
  [/^\.gitlab-ci\.ya?ml$/, "CI"],
];

export function markOf(path: string, diff?: Pick<FileDiff, "binary" | "oldMode" | "newMode">): string | null {
  if (ROLE_GLYPH_FAMILIES.has(familyOf(path, diff))) return null;
  const name = path.split("/").pop()!.toLowerCase();
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return "CI";
  return BY_NAME.find(([pattern]) => pattern.test(name))?.[1] ?? BY_LANG[langFor(path)] ?? null;
}
