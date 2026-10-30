import { describe, expect, it } from "vitest";
import { familyOf } from "./family";

describe("familyOf", () => {
  it.each([
    ["src/limiter.ts", "code"],
    ["cmd/main.go", "code"],
    ["web/index.html", "markup"],
    ["web/App.vue", "markup"],
    ["web/panel.scss", "styles"],
    [".github/workflows/ci.yml", "config"],
    ["package.json", "config"],
    ["tsconfig.json", "config"],
    [".env.local", "config"],
    ["go.mod", "config"],
    [".prettierignore", "config"],
    ["README.md", "docs"],
    ["LICENSE-MIT", "docs"],
    ["e2e/changes.spec.ts", "code"],
    ["src/notice.ts", "code"],
    ["requirements-dev.txt", "config"],
    [".gitlab-ci.yml", "config"],
    ["LICENSE", "docs"],
    ["NOTICE.txt", "docs"],
    ["notes/plan.txt", "docs"],
    ["scripts/release.sh", "shell"],
    [".zshrc", "shell"],
    ["db/schema.sql", "data"],
    ["fixtures/users.csv", "data"],
    ["Dockerfile", "build"],
    ["Dockerfile.dev", "build"],
    ["Makefile", "build"],
    ["BUILD.bazel", "build"],
    ["CMakeLists.txt", "build"],
    ["pnpm-lock.yaml", "lock"],
    ["package-lock.json", "lock"],
    ["Cargo.lock", "lock"],
    ["bun.lockb", "lock"],
    ["go.sum", "lock"],
    ["assets/logo.png", "image"],
    ["assets/icon.svg", "image"],
    ["fonts/mono.woff2", "binary"],
    ["dist/app.zip", "binary"],
    [".gitignore", "git"],
    [".gitattributes", "git"],
    [".gitkeep", "git"],
    [".github/CODEOWNERS", "git"],
    ["data/blob", "other"],
    ["notes.unknownext", "other"],
  ])("%s is %s", (path, family) => {
    expect(familyOf(path)).toBe(family);
  });

  it("treats files git reports as binary as binary, unless they are images", () => {
    expect(familyOf("data/blob", { binary: true })).toBe("binary");
    expect(familyOf("assets/photo.jpg", { binary: true })).toBe("image");
  });

  it("gives submodules the git glyph, whatever they're called", () => {
    expect(familyOf("vendor/lib.js", { binary: false, newMode: "160000" })).toBe("git");
    expect(familyOf("vendor/lib", { binary: false, oldMode: "160000" })).toBe("git");
  });
});
