import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../../shared/types";
import { fuzzyMatch, listFiles } from "./files";

const files = (...paths: string[]) => paths.map((path) => ({ path }) as FileDiff);
const rows = (...paths: string[]) => listFiles(files(...paths)).map((r) => (r.suffix ? `${r.file.path} ${r.suffix}` : r.file.path));

describe("listFiles", () => {
  it("tucks a changed test under its code, even when the name sorts first", () => {
    expect(rows("web/Cart.tsx", "web/Cart.test.tsx", "web/Cart.module.css")).toEqual(["web/Cart.module.css", "web/Cart.tsx", "web/Cart.test.tsx .test.tsx"]);
  });

  it("knows the test names of other languages", () => {
    expect(rows("go/store.go", "go/store_test.go")).toEqual(["go/store.go", "go/store_test.go _test.go"]);
    expect(rows("py/store.py", "py/test_store.py")).toEqual(["py/store.py", "py/test_store.py test_store.py"]);
    expect(rows("js/a.js", "js/a.spec.js")).toEqual(["js/a.js", "js/a.spec.js .spec.js"]);
  });

  it("matches on the whole name, so a test finds foo.ts and not foo.bar.ts", () => {
    expect(rows("foo.bar.ts", "foo.ts", "foo.test.ts")).toEqual(["foo.bar.ts", "foo.ts", "foo.test.ts .test.ts"]);
  });

  it("tucks a test under code with another extension, but not under data or styles", () => {
    expect(rows("a/view.tsx", "a/view.test.ts")).toEqual(["a/view.tsx", "a/view.test.ts .test.ts"]);
    expect(rows("a/view.css", "a/view.test.ts")).toEqual(["a/view.css", "a/view.test.ts"]);
  });

  it("only tucks within a folder", () => {
    expect(rows("src/a.ts", "tests/a.test.ts")).toEqual(["src/a.ts", "tests/a.test.ts"]);
  });

  it("leaves a test alone when its code didn't change", () => {
    expect(rows("src/a.test.ts", "src/b.ts")).toEqual(["src/a.test.ts", "src/b.ts"]);
  });
});

describe("fuzzyMatch", () => {
  it("fuzzy-matches paths", () => {
    expect(fuzzyMatch("stts", "src/main/stage.test.ts")).toBe(true);
    expect(fuzzyMatch("main stage", "src/main/stage.ts")).toBe(true);
    expect(fuzzyMatch("zz", "src/main/stage.ts")).toBe(false);
  });
});
