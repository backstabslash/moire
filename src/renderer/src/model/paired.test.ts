import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../../shared/types";
import { fuzzyMatch } from "./files";
import { isTest, orderBy, type PairedGroup, pairedOrder, pairFiles } from "./paired";

const changed = (path: string, status: FileDiff["status"] = "modified", noise?: string): FileDiff => ({
  path,
  status,
  binary: false,
  additions: 1,
  deletions: 0,
  hunks: [],
  ...(noise ? { noise } : {}),
});

function show(groups: PairedGroup[]): string[] {
  return groups.flatMap((g) => [
    g.tier ? `# ${g.label} (${g.rows.length})` : g.label,
    ...g.rows.map((r) =>
      "slot" in r ? `  └ ${r.slot} (no test change)` : r.suffix ? `  └ ${r.suffix}` : `${r.file.path.split("/").pop()}${r.hint ? ` ${r.hint}` : ""}`,
    ),
  ]);
}

const MOCKUP = [
  changed("src/components/checkout/CartSummary.tsx"),
  changed("src/components/checkout/CartSummary.module.css"),
  changed("src/components/checkout/CurrencyPicker.tsx", "untracked"),
  changed("src/components/checkout/CurrencyPicker.module.css", "untracked"),
  changed("src/components/checkout/index.ts"),
  changed("src/hooks/useCart.ts"),
  changed("src/lib/money/currency.ts", "untracked"),
  changed("src/lib/money/format.ts"),
  changed("src/lib/money/round.ts", "deleted"),
  changed("src/locales/en.json"),
  changed("src/locales/de.json"),
  changed("src/server/routes/orders.ts"),
  changed("src/server/db/schema.ts"),
  changed("src/server/db/migrations/0042_order_currency.sql", "untracked"),
  changed("tests/components/checkout/CartSummary.test.tsx"),
  changed("tests/lib/money/format.test.ts"),
  changed("tests/lib/money/currency.test.ts", "untracked"),
  changed("docs/checkout.md"),
  changed("package.json"),
  changed("pnpm-lock.yaml", "modified", "Lockfile"),
  changed(".github/workflows/ci.yml"),
];

describe("pairFiles", () => {
  it("groups the mockup's change set by module, with tests and styles under their source", () => {
    expect(show(pairFiles(MOCKUP))).toEqual([
      "components/checkout",
      "CartSummary.tsx",
      "  └ .module.css",
      "  └ .test.tsx",
      "CurrencyPicker.tsx",
      "  └ .module.css",
      "  └ .test.tsx (no test change)",
      "index.ts",
      "hooks",
      "useCart.ts",
      "  └ .test.ts (no test change)",
      "lib/money",
      "currency.ts",
      "  └ .test.ts",
      "format.ts",
      "  └ .test.ts",
      "round.ts",
      "locales",
      "de.json",
      "en.json",
      "server/db",
      "0042_order_currency.sql migrations/",
      "schema.ts",
      "server/routes",
      "orders.ts",
      "  └ .test.ts (no test change)",
      "# Config and CI (2)",
      "package.json",
      "ci.yml",
      "# Docs (1)",
      "checkout.md",
      "# Folded (1)",
      "pnpm-lock.yaml",
    ]);
  });

  it("lists the real folders behind a module", () => {
    const [checkout] = pairFiles(MOCKUP);
    expect(checkout.folders).toEqual(["src/components/checkout", "tests/components/checkout"]);
  });

  it("drops __tests__ and keeps deeper folders as a hint, in the stem", () => {
    const files = [
      changed("src/a/b/c/d/view.ts"),
      changed("src/a/b/c/d/__tests__/view.test.ts"),
      changed("src/a/b/view.ts"),
      changed("lib/x.go"),
      changed("lib/x_test.go"),
      changed("app/test_y.py"),
      changed("app/y.py"),
      changed("src/lib/z.ts"),
    ];
    expect(show(pairFiles(files))).toEqual([
      "a/b",
      "view.ts c/d/",
      "  └ .test.ts",
      "view.ts",
      "  └ .test.ts (no test change)",
      "app",
      "y.py",
      "  └ test_y.py",
      "lib",
      "x.go",
      "  └ _test.go",
      "z.ts",
      "  └ .test.ts (no test change)",
    ]);
    expect(pairFiles(files).find((g) => g.label === "lib")?.folders).toEqual(["lib", "src/lib"]);
  });

  it("labels the root module src and leaves out slots for index, types, schema and deleted files", () => {
    const files = [changed("src/app.tsx"), changed("src/index.ts"), changed("src/types.ts"), changed("src/old.ts", "deleted"), changed("tests/app.test.tsx")];
    expect(show(pairFiles(files))).toEqual(["src", "app.tsx", "  └ .test.tsx", "index.ts", "old.ts", "types.ts"]);
  });

  it("adds no test slots when nothing in the change set is a test", () => {
    const files = [changed("src/hooks/useCart.ts"), changed("src/lib/money/format.ts")];
    expect(show(pairFiles(files))).toEqual(["hooks", "useCart.ts", "lib/money", "format.ts"]);
  });

  it("checks for tests in the whole change set, so a filter doesn't add slots", () => {
    const shown = MOCKUP.filter((f) => f.path.endsWith("format.ts"));
    expect(show(pairFiles(shown, MOCKUP))).toEqual(["lib/money", "format.ts"]);
  });

  it("leads with the source file, then other files, then tests, and shows a name when the suffix is empty", () => {
    const files = [
      changed("src/x/a.test.ts"),
      changed("src/x/a.css"),
      changed("src/x/a.ts"),
      changed("tests/x/a.ts"),
      changed("src/x/run"),
      changed("tests/x/run"),
    ];
    expect(show(pairFiles(files))).toEqual(["x", "a.ts", "  └ .css", "  └ .test.ts", "  └ .ts", "run", "  └ run"]);
  });

  it("puts root .md files in Docs and noise ahead of everything", () => {
    const files = [changed("README.md"), changed("docs/guide/setup.txt"), changed("src/__snapshots__/a.snap", "modified", "Snapshot"), changed("Makefile")];
    expect(show(pairFiles(files))).toEqual(["# Config and CI (1)", "Makefile", "# Docs (2)", "README.md", "setup.txt", "# Folded (1)", "a.snap"]);
  });
});

describe("isTest", () => {
  it("knows test folders and test names", () => {
    for (const p of ["tests/a.ts", "src/__tests__/a.ts", "spec/a.rb", "a/test/b.c", "a.test.ts", "a.spec.tsx", "a_test.go", "pkg/test_a.py"])
      expect(isTest(p), p).toBe(true);
    for (const p of ["src/a.ts", "testing/a.ts", "latest.ts", "contest_a.py", "test_a.ts", "src/specs.ts"]) expect(isTest(p), p).toBe(false);
  });
});

describe("pairedOrder", () => {
  it("walks the rows in the order they're drawn", () => {
    const drawn = pairFiles(MOCKUP).flatMap((g) => g.rows.flatMap((r) => ("file" in r ? [r.file.path] : [])));
    expect(pairedOrder(MOCKUP).map((f) => f.path)).toEqual(drawn);
    expect(drawn).toHaveLength(MOCKUP.length);
  });

  it("keeps its order when files are filtered out", () => {
    const full = pairedOrder(MOCKUP);
    for (const q of ["cart", "money", "ts", "test", "json", "c"]) {
      const kept = MOCKUP.filter((f) => fuzzyMatch(q, f.path));
      expect(pairedOrder(kept), q).toEqual(full.filter((f) => kept.includes(f)));
    }
    const noLead = MOCKUP.filter((f) => !f.path.endsWith("CartSummary.tsx"));
    expect(pairedOrder(noLead)).toEqual(full.filter((f) => noLead.includes(f)));
  });

  it("falls back to folder order for By folder", () => {
    expect(
      orderBy("folder", MOCKUP)
        .map((f) => f.path)
        .slice(0, 3),
    ).toEqual(["package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml"]);
  });
});
