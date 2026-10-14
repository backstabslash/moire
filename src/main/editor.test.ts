import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEditor } from "./editor";
import { dirs } from "./test-repo";

function binDir(...names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "moire-bin-"));
  dirs.push(dir);
  for (const name of names) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

describe("resolveEditor", () => {
  it("picks the first known editor on PATH, with its line syntax", () => {
    const dir = binDir("zed", "code");
    expect(resolveEditor(undefined, dir)).toEqual({ exe: join(dir, "code"), args: ["-g", "{file}:{line}"] });
    expect(resolveEditor(undefined, binDir("idea"))?.args).toEqual(["--line", "{line}", "{file}"]);
  });

  it("uses a saved template, and finds nothing when the editor isn't installed", () => {
    const dir = binDir("zed");
    expect(resolveEditor("zed --new {file}:{line}", dir)).toEqual({ exe: join(dir, "zed"), args: ["--new", "{file}:{line}"] });
    expect(resolveEditor("nonexistent-editor {file}", dir)).toBeNull();
  });
});
