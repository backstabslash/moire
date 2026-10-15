import { bundledLanguagesInfo } from "shiki/langs";
import { describe, expect, it } from "vitest";
import { customLangs } from "../highlight/grammars";
import { EXTENSIONS, FILENAMES, fenceLang, langFor } from "./lang";

describe("langFor", () => {
  it("maps every table entry to a language the worker can load", () => {
    const known = new Set(["text", ...bundledLanguagesInfo.map((l) => l.id), ...Object.keys(customLangs)]);
    expect([...Object.values(FILENAMES), ...Object.values(EXTENSIONS)].filter((id) => !known.has(id))).toEqual([]);
  });

  it.each([
    ["src/app.ts", "typescript"],
    ["web/Button.tsx", "tsx"],
    ["include/vec.h", "c"],
    ["include/vec.hpp", "cpp"],
    ["src/main.cc", "cpp"],
    ["lib/worker.ex", "elixir"],
    ["test/worker_test.exs", "elixir"],
    ["go.mod", "go-mod"],
    ["go.sum", "go-mod"],
    ["Dockerfile", "docker"],
    ["Dockerfile.dev", "docker"],
    ["deploy/api.dockerfile", "docker"],
    ["Containerfile", "docker"],
    ["Gemfile", "ruby"],
    ["Rakefile", "ruby"],
    ["Jenkinsfile", "groovy"],
    ["Makefile", "make"],
    ["GNUmakefile", "make"],
    ["rules.mk", "make"],
    [".gitignore", "ignore"],
    ["docker/.dockerignore", "ignore"],
    [".bashrc", "shellscript"],
    [".zshrc", "shellscript"],
    [".profile", "shellscript"],
    [".envrc", "shellscript"],
    [".env", "dotenv"],
    [".env.local", "dotenv"],
    ["nginx/site.conf", "ini"],
    ["nginx.conf", "nginx"],
    ["icon.svg", "xml"],
    ["build.gradle", "groovy"],
    ["build.gradle.kts", "kotlin"],
    ["fix.patch", "diff"],
    ["fix.diff", "diff"],
    ["CMakeLists.txt", "cmake"],
    ["justfile", "just"],
    ["main.tf", "terraform"],
    ["flake.nix", "nix"],
    ["tsconfig.json", "jsonc"],
    ["tsconfig.build.json", "jsonc"],
    ["notes.txt", "text"],
    ["LICENSE", "text"],
  ])("%s is %s", (path, lang) => {
    expect(langFor(path)).toBe(lang);
  });

  it.each([
    ["#!/usr/bin/env python3\nprint(1)\n", "python"],
    ["#!/usr/bin/python3.11\n", "python"],
    ["#!/bin/bash\nset -e\n", "shellscript"],
    ["#!/bin/sh\n", "shellscript"],
    ["#! /usr/bin/env zsh\n", "shellscript"],
    ["#!/usr/bin/env node\n", "javascript"],
    ["#!/usr/bin/env -S node --no-warnings\n", "javascript"],
    ["#!/usr/bin/env ruby\n", "ruby"],
    ["#!/usr/bin/perl -w\n", "perl"],
    ["#!/usr/bin/env -S uv run --script\n", "python"],
    ["#!/usr/bin/env unknown-thing\n", "text"],
    ["no shebang\n", "text"],
  ])("an extensionless script starting %j is %s", (text, lang) => {
    expect(langFor("bin/release", text)).toBe(lang);
  });

  it("lets a shebang override an extensionless name but not an extension", () => {
    expect(langFor("scripts/build", "#!/bin/bash\n")).toBe("shellscript");
    expect(langFor("build", "load('//x')\n")).toBe("python");
    expect(langFor("tool.py", "#!/bin/sh\n")).toBe("python");
    expect(langFor("run.cgi", "#!/usr/bin/env perl\n")).toBe("perl");
  });

  it("reads a .h header as C++ when it uses C++", () => {
    expect(langFor("a.h", "#include <stddef.h>\nint f(void);\n")).toBe("c");
    expect(langFor("a.h", "#include <vector>\nnamespace x {}\n")).toBe("cpp");
    expect(langFor("a.h", "class Foo {\npublic:\n};\n")).toBe("cpp");
  });
});

describe("fenceLang", () => {
  it.each([
    ["ts", "typescript"],
    ["py", "python"],
    ["bash", "shellscript"],
    ["console", "shellsession"],
    ["toml", "toml"],
    ["Dockerfile", "docker"],
    ["ex", "elixir"],
    ["gitignore", "ignore"],
    ["{.rust", "rust"],
    ["", "text"],
    ["nonsense", "text"],
  ])("%j is %s", (info, lang) => {
    expect(fenceLang(info)).toBe(lang);
  });
});
