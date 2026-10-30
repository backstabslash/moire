import type { FileDiff } from "../../../shared/types";
import { langFor } from "./lang";
import { MODULE } from "./modes";

export type Family = "code" | "markup" | "styles" | "config" | "docs" | "shell" | "data" | "build" | "lock" | "image" | "binary" | "git" | "other";

const LOCKS = new Set(["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "go.sum", "go.work.sum", "packages.lock.json"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "svg", "tif", "tiff", "heic"]);
const BINARIES = new Set([
  ...["woff", "woff2", "ttf", "otf", "eot", "pdf", "wasm", "exe", "dll", "so", "dylib", "a", "o", "class", "pyc", "jar", "bin"],
  ...["zip", "gz", "tgz", "xz", "bz2", "zst", "tar", "7z", "rar", "mp3", "mp4", "mov", "webm", "wav", "ogg", "flac", "sqlite", "db", "parquet"],
]);
const BUILD_NAMES = new Set([
  "cmakelists.txt",
  "jenkinsfile",
  "build",
  "build.bazel",
  "workspace",
  "workspace.bazel",
  "meson.build",
  "procfile",
  "tiltfile",
  "earthfile",
]);
const GIT_NAMES = new Set([".gitignore", ".gitattributes", ".gitmodules", ".gitconfig", ".gitkeep", ".git-blame-ignore-revs", ".mailmap"]);
const DOC_NAME = /^(readme|licen[cs]e|notice|changelog|changes|authors|contributing|copying)(-[\w-]+)?$/;
const PY_REQUIREMENTS = /^(requirements|constraints)\b.*\.(txt|in)$/;
const DOC_EXTS = new Set(["txt", "rst", "adoc"]);

const BY_LANG: Record<string, Family> = {};
const add = (family: Family, langs: string) => langs.split(" ").forEach((l) => (BY_LANG[l] = family));
add("markup", "html html-derivative xml xsl vue vue-html svelte astro angular-html handlebars pug haml erb razor blade twig liquid jinja marko templ");
add("styles", "css scss sass less stylus postcss");
add("config", "json jsonc json5 yaml toml ini dotenv properties hcl terraform ssh-config nginx apache systemd go-mod ignore");
add("docs", "markdown mdx rst asciidoc latex bibtex typst org");
add("shell", "shellscript fish powershell bat nushell");
add("data", "sql plsql prisma csv tsv jsonl");
add("build", "docker make cmake just");
add("git", "git-commit git-rebase codeowners");

export function familyOf(path: string, diff?: Pick<FileDiff, "binary" | "oldMode" | "newMode">): Family {
  if ((diff?.newMode ?? diff?.oldMode) === MODULE) return "git";
  const name = path.split("/").pop()!.toLowerCase();
  const ext = name.includes(".", 1) ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (LOCKS.has(name) || ext === "lock" || ext === "lockb") return "lock";
  if (IMAGES.has(ext)) return "image";
  if (GIT_NAMES.has(name)) return "git";
  if (diff?.binary || BINARIES.has(ext)) return "binary";
  if (BUILD_NAMES.has(name)) return "build";
  if (PY_REQUIREMENTS.test(name)) return "config";
  if (DOC_NAME.test(name) || DOC_EXTS.has(ext)) return "docs";
  const lang = langFor(path);
  return BY_LANG[lang] ?? (lang === "text" ? "other" : "code");
}
