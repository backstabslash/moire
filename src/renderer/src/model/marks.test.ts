import { describe, expect, it } from "vitest";
import { markOf } from "./marks";

describe("markOf", () => {
  it.each([
    ["src/limiter.ts", "TS"],
    ["src/App.tsx", "TX"],
    ["scripts/build.mjs", "JS"],
    ["app/main.py", "PY"],
    ["cmd/main.go", "GO"],
    ["src/lib.rs", "RS"],
    ["web/index.html", "<>"],
    ["web/panel.css", "#"],
    ["config.json", "{}"],
    ["deploy.yaml", "YM"],
    ["README.md", "MD"],
    ["scripts/release.sh", "SH"],
    ["Dockerfile", "DK"],
    ["Makefile", "MK"],
  ])("%s shows %s", (path, mark) => {
    expect(markOf(path)).toBe(mark);
  });

  it.each([
    ["package.json", "N"],
    ["tsconfig.web.json", "TS"],
    ["docker-compose.prod.yml", "DK"],
    ["compose.yaml", "DK"],
    ["Cargo.toml", "RS"],
    ["go.mod", "GO"],
    ["pyproject.toml", "PY"],
    ["requirements-dev.txt", "PY"],
    ["vite.config.ts", "VI"],
    ["eslint.config.mjs", "ES"],
    [".github/workflows/ci.yml", "CI"],
    [".gitlab-ci.yml", "CI"],
  ])("%s is known by name, as %s", (path, mark) => {
    expect(markOf(path)).toBe(mark);
  });

  it.each(["pnpm-lock.yaml", "package-lock.json", "assets/logo.svg", "assets/photo.png", "fonts/mono.woff2", ".gitignore", "LICENSE", "notes.unknownext"])(
    "%s keeps its role glyph",
    (path) => {
      expect(markOf(path)).toBeNull();
    },
  );

  it("keeps the role glyph for binaries and submodules, whatever their name says", () => {
    expect(markOf("data/model.json", { binary: true })).toBeNull();
    expect(markOf("vendor/lib.js", { binary: false, newMode: "160000" })).toBeNull();
  });
});
