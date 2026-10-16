import type { FileDiff } from "../../../shared/types";
import { orderFiles } from "./files";

export type Grouping = "paired" | "folder";

export type PairedRow = { file: FileDiff; hint?: string; suffix?: string } | { slot: string; lead: string };

export interface PairedGroup {
  label: string;
  tier: boolean;
  folders: string[];
  mixed: boolean;
  rows: PairedRow[];
}

const collator = new Intl.Collator();
const ROOTS = new Set(["src", "test", "tests"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec"]);
const UNTESTED = new Set(["index", "types", "schema"]);
const SOURCE = /\.(c|cc|cjs|cpp|cs|cts|dart|ex|exs|go|h|hpp|java|jsx?|kt|mjs|mts|php|py|rb|rs|scala|svelte|swift|tsx?|vue)$/;
const TIERS = ["Config and CI", "Docs", "Folded"];

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

export function isTest(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop()!;
  return parts.some((p) => TEST_DIRS.has(p)) || /\.(test|spec)\.|_test\./.test(name) || /^test_.*\.py$/.test(name);
}

const isSource = (path: string) => SOURCE.test(path) && !/\.d\.[cm]?ts$/.test(path);
const rank = (path: string) => (isTest(path) ? 2 : isSource(path) ? 0 : 1);

// Go's foo_test.go and Python's test_foo.py pair with foo.
function stemOf(name: string): string {
  const stem = name.split(".")[0] || name;
  if (/^test_.+\.py$/.test(name)) return stem.slice(5);
  return stem.length > 5 && stem.endsWith("_test") ? stem.slice(0, -5) : stem;
}

function tierOf(f: FileDiff): number {
  if (f.noise) return 2;
  if (/\.md$/i.test(f.path) || f.path.startsWith("docs/")) return 1;
  if (!f.path.includes("/") || f.path.startsWith(".github/")) return 0;
  return -1;
}

function placeOf(path: string) {
  const dirs = path.split("/").slice(0, -1);
  const root = dirs.length && ROOTS.has(dirs[0]) ? dirs.shift()! : "";
  const kept = dirs.filter((d) => d !== "__tests__");
  const stem = stemOf(nameOf(path));
  const module = kept.slice(0, 2).join("/");
  const deeper = kept
    .slice(2)
    .map((d) => `${d}/`)
    .join("");
  return { root, module, deeper, stem, cluster: `${module}:${deeper}${stem}` };
}

function testSlot(path: string, stem: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return ext === "go" ? "_test.go" : ext === "py" ? `test_${stem}.py` : `.test.${ext}`;
}

interface Module {
  roots: Set<string>;
  folders: Set<string>;
  clusters: Map<string, { deeper: string; stem: string; files: FileDiff[] }>;
}

// `changed` is the whole change set, so a filter can't invent a missing test.
export function pairFiles(files: FileDiff[], changed: FileDiff[] = files): PairedGroup[] {
  const modules = new Map<string, Module>();
  const tiers: FileDiff[][] = TIERS.map(() => []);
  for (const f of files) {
    const tier = tierOf(f);
    if (tier >= 0) {
      tiers[tier].push(f);
      continue;
    }
    const { root, module, deeper, stem } = placeOf(f.path);
    let m = modules.get(module);
    if (!m) modules.set(module, (m = { roots: new Set(), folders: new Set(), clusters: new Map() }));
    m.roots.add(root);
    m.folders.add(dirOf(f.path).slice(0, -1));
    const key = `${deeper}${stem}`;
    let c = m.clusters.get(key);
    if (!c) m.clusters.set(key, (c = { deeper, stem, files: [] }));
    c.files.push(f);
  }

  const tests = changed.filter((f) => isTest(f.path));
  const tested = new Set(tests.map((f) => placeOf(f.path).cluster));
  const out: PairedGroup[] = [];
  for (const [module, m] of [...modules].sort(([x], [y]) => collator.compare(x, y))) {
    const rows: PairedRow[] = [];
    for (const [key, c] of [...m.clusters].sort(([x], [y]) => collator.compare(x, y))) {
      const [lead, ...rest] = c.files.sort((x, y) => rank(x.path) - rank(y.path) || collator.compare(x.path, y.path));
      rows.push({ file: lead, hint: c.deeper || undefined });
      for (const f of rest) {
        const name = nameOf(f.path);
        rows.push({ file: f, suffix: (name.startsWith(c.stem) && name.slice(c.stem.length)) || name });
      }
      const wantsTest = tests.length > 0 && rank(lead.path) === 0 && lead.status !== "deleted" && !UNTESTED.has(c.stem);
      if (wantsTest && !tested.has(`${module}:${key}`)) rows.push({ slot: testSlot(lead.path, c.stem), lead: lead.path });
    }
    out.push({
      label: module || "src",
      tier: false,
      folders: [...m.folders].sort(collator.compare),
      mixed: m.roots.has("src") && (m.roots.has("test") || m.roots.has("tests")),
      rows,
    });
  }
  tiers.forEach((list, i) => {
    if (!list.length) return;
    const rows = orderFiles(list).map((file) => ({ file, hint: dirOf(file.path) || undefined }));
    out.push({ label: TIERS[i], tier: true, folders: [], mixed: false, rows });
  });
  return out;
}

export const pairedOrder = (files: FileDiff[]): FileDiff[] => pairFiles(files).flatMap((g) => g.rows.flatMap((r) => ("file" in r ? [r.file] : [])));

export const orderBy = (grouping: Grouping, files: FileDiff[]) => (grouping === "paired" ? pairedOrder(files) : orderFiles(files));
