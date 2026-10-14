import { bundledLanguagesInfo } from "shiki/langs";

const byKey = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  byKey.set(info.id, info.id);
  for (const alias of info.aliases ?? []) byKey.set(alias, info.id);
}

const byName: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  "cmakelists.txt": "cmake",
  "cargo.lock": "toml",
  ".env": "dotenv",
};

export function langFor(path: string): string {
  const name = path.split("/").pop()!.toLowerCase();
  if (byName[name]) return byName[name];
  if (name.startsWith(".env")) return "dotenv";
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  return byKey.get(ext) ?? "text";
}
