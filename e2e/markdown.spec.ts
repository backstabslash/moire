import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, writeNotes } from "./harness";

const { clipboard, commitAll, git, idle, initRepo, launch, open, resize, shot, shots } = harness();
let repo: string;
let page: Page;

const rollout = (old: boolean) =>
  [
    "# Rate limiter rollout",
    "",
    old
      ? "The gateway rejects bursts with a fixed window counter. This plan moves every route before the March peak."
      : "The gateway rejects bursts with a sliding window. This plan moves every route before the June peak.",
    "",
    "> [!NOTE]",
    "> Keep the old limiter in shadow mode until step 3 finishes.",
    "",
    "## Steps",
    "",
    "- [x] Add the store behind a flag",
    "- [x] Replay a week of traffic",
    old ? "- [ ] Switch all routes at once" : "- [ ] Switch one route group a day",
    ...(old ? ["- [ ] Delete the fixed window code that afternoon"] : ["- [ ] Remove the fixed window code after two quiet weeks"]),
    "",
    "## Configuration",
    "",
    "Limits live in `limits.ts`, see [the runbook](docs/runbook.md) and [rollback](#rollback).[^1]",
    "",
    "```ts",
    "export const limits = {",
    old ? '  search: { rate: 100, window: "1m" },' : '  search: { rate: 240, window: "1m", burst: 40 },',
    '  upload: { rate: 10, window: "1m" },',
    "};",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    old ? "  client --> gateway --> store" : "  client --> gateway --> limiter --> store",
    "```",
    "",
    "## Rollback",
    "",
    "| Signal | Threshold |",
    "| - | - |",
    `| 429 rate | over ${old ? "2%" : "0.5%"} for 5 minutes |`,
    "| p99 latency | over 80 ms |",
    "",
    ...(old ? ["Rolling back needs sign-off from the on-call lead.", ""] : []),
    "The flag takes about a minute to reach every gateway.",
    "",
    "```text",
    "x".repeat(300),
    "```",
    "",
    "[^1]: Numbers come from last year's logs.",
    "",
  ].join("\n");

test.beforeAll(async () => {
  repo = initRepo();
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs/runbook.md"), "# Runbook\n\nCall someone.\n");
  writeFileSync(join(repo, "plan.md"), rollout(true));
  commitAll("init");
  writeFileSync(join(repo, "plan.md"), rollout(false));
  ({ page } = await launch(repo, { prefs: { theme: "dark", preview: "on" } }));
  await open("plan.md");
  await expect(page.locator(".md h1").first()).toHaveText("Rate limiter rollout");
});

const view = (name: string) => page.getByRole("group", { name: "Markdown view" }).getByRole("button", { name });

test("a wide window opens on Side by side, a narrow one on Changes, and a view picked by hand stays", async () => {
  await resize(1500, 900);
  await expect(view("Side by side")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("article.md")).toHaveCount(2);

  await resize(1000, 800);
  await expect(view("Changes")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("article.md")).toHaveCount(1);

  await view("Side by side").click();
  await expect(page.locator("article.md")).toHaveCount(2);
  await resize(1500, 900);
  await view("Read").click();
  await resize(1000, 800);
  await expect(view("Read")).toHaveAttribute("aria-pressed", "true");

  await resize(1440, 920);
  await view("Changes").click();
});

test("Changes shows deleted words beside their replacements, removed blocks in place, and coloured code fences", async () => {
  await expect(view("Changes")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".md-del").first()).toHaveText("fixed");
  await expect(page.locator(".md-ins").first()).toHaveText("sliding");
  await expect(page.locator(".md-gone", { hasText: "sign-off from the on-call lead" })).toHaveCount(1);
  await expect(page.locator("table .md-del")).toHaveText("2%");
  await expect(page.locator("table .md-ins")).toHaveText("0.5%");
  await expect(page.locator(".md-ln.del mark").first()).toContainText("100");
  await expect(page.locator(".md-ln.add mark").first()).toContainText("240");
  await expect.poll(() => page.locator(".md-ln span[style*='--tok-']").count()).toBeGreaterThan(3);
  await expect(page.locator(".md-bar.cut")).not.toHaveCount(0);
  await expect(page.locator(".md-outline .chg", { hasText: "Steps" })).toHaveCount(1);
  await expect(page.locator(".md-outline .cut", { hasText: "Rollback" })).toHaveCount(1);
  await shot("markdown-changes-dark");
  await page.locator(".md-scroller").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot("markdown-changes-bottom-dark");
  await page.locator(".md-scroller").evaluate((el) => el.scrollTo({ top: 0 }));
  await page.keyboard.press("t");
  await shot("markdown-changes-light");
  await page.keyboard.press("t");
});

test("Mermaid fences draw as images and the changed source stays visible", async () => {
  const diagram = page.locator(".md-diagram");
  await expect(diagram).toHaveCount(1, { timeout: 15000 });
  await expect.poll(() => diagram.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".md-fence.is-drawn pre")).toBeVisible();
});

test("Read drops every mark and shows the final text", async () => {
  await page.keyboard.press("Shift+M");
  await page.keyboard.press("Shift+M");
  await expect(view("Read")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".md-del, .md-ins, .md-gone, .md-bar")).toHaveCount(0);
  await expect(page.locator(".md-outline .chg, .md-outline .cut")).toHaveCount(0);
  await expect(page.locator(".md-box.on")).toHaveCount(2);
  await expect(page.locator(".md-alert-title")).toHaveText("Note");
  await expect(page.locator(".md-fence.is-drawn pre")).toHaveCount(1);
  await expect(page.locator(".md-fence.is-drawn pre")).toBeHidden();
  await shot("markdown-read-dark");
});

test("Side by side lines up matching blocks and hatches what's missing", async () => {
  await view("Side by side").click();
  const articles = page.locator("article.md");
  await expect(articles).toHaveCount(2);
  await expect(page.locator(".md-sides-head span")).toHaveCount(2);
  await expect(page.locator(".md-outline")).toHaveCount(0);
  await expect(page.locator(".md-gap.is-hole")).not.toHaveCount(0);
  const diagrams = page.locator(".md-diagram");
  await expect(diagrams).toHaveCount(2, { timeout: 15000 });
  await expect.poll(() => diagrams.evaluateAll((all: HTMLImageElement[]) => all.map((img) => img.naturalWidth > 0))).toEqual([true, true]);
  const sources = await diagrams.evaluateAll((all: HTMLImageElement[]) => all.map((img) => decodeURIComponent(img.src)));
  expect(sources[0]).toContain("gateway");
  expect(sources[0]).not.toContain("limiter");
  expect(sources[1]).toContain("limiter");
  const drift = () =>
    articles.evaluateAll((all) => {
      const [a, b] = all.map((article) => article.querySelector('[data-anchor="rollback"]')!.getBoundingClientRect().top);
      return Math.abs(a - b);
    });
  await expect.poll(drift).toBeLessThan(1);
  await shot("markdown-sides-dark");
  await page.locator(".md-scroller").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot("markdown-sides-bottom-dark");
  await page.locator(".md-scroller").evaluate((el) => el.scrollTo({ top: 0 }));
  await page.keyboard.press("t");
  await expect(page.locator(".md-diagram")).toHaveCount(2);
  await shot("markdown-sides-light");
  await page.keyboard.press("t");
  await view("Changes").click();
});

test("search finds words split across highlights and deleted text", async () => {
  await page.keyboard.press("/");
  await expect(page.locator(".search input")).toBeFocused();
  await page.locator(".search input").fill("window counter");
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("moire-hit")?.size ?? 0)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
});

test("the copy button copies the new code without its markers", async () => {
  const fence = page.locator(".md-fence", { hasText: "limits" }).first();
  await fence.hover();
  await fence.locator(".md-copy").click();
  await expect(fence.locator(".md-copy")).toHaveText("Copied");
  expect(await clipboard()).toContain("rate: 240");
  expect(await clipboard()).not.toContain("rate: 100");
});

test("links jump within the page and open files in the repo", async () => {
  await page.locator(".md a", { hasText: "rollback" }).click();
  await expect.poll(() => page.locator(".md-scroller").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.locator(".md a", { hasText: "the runbook" }).click();
  await expect(page.locator(".md h1")).toHaveText("Runbook");
  await expect(page.locator(".md-views")).toHaveCount(0);
});

test("the text stays centred in the pane beside the outline", async () => {
  await open("plan.md");
  await resize(1800, 900);
  const middles = await page.evaluate(() => {
    const middle = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    return { text: middle(document.querySelector(".md-page")!), pane: middle(document.querySelector(".md-scroller")!) };
  });
  expect(Math.abs(middles.text - middles.pane)).toBeLessThan(12);
  await shot("markdown-centred-dark");
  await resize(1240, 800);
  const overflow = () =>
    page.evaluate(
      () => document.querySelector(".md-page")!.getBoundingClientRect().right - document.querySelector(".md-scroller")!.getBoundingClientRect().right,
    );
  await expect.poll(overflow).toBeLessThanOrEqual(0);
});

test("the outline marks the section being read, and changing view keeps the place", async () => {
  await resize(1440, 420);
  await view("Read").click();
  const scroller = page.locator(".md-scroller");
  const heading = page.locator("article.md h2", { hasText: "Rollback" }).last();
  const top = () => heading.evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest(".md-scroller")!.getBoundingClientRect().top));
  await page.locator(".md-outline button", { hasText: "Rollback" }).click();
  await expect(page.locator(".md-outline .is-here")).toHaveText("Rollback");
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(page.locator(".md-outline .is-here")).not.toHaveText("Rollback");
  await page.locator(".md-outline button", { hasText: "Rollback" }).click();
  const before = await top();
  await view("Changes").click();
  await expect.poll(async () => Math.abs((await top()) - before)).toBeLessThan(3);
  await page.keyboard.press("m");
  await page.keyboard.press("m");
  await expect.poll(async () => Math.abs((await top()) - before)).toBeLessThan(3);
  await resize(1440, 920);
});

test("a gantt chart draws with a width of its own", async () => {
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n\`\`\`mermaid\ngantt\n  dateFormat YYYY-MM-DD\n  section s\n  t :a, 2026-01-01, 3d\n\`\`\`\n`);
  await expect
    .poll(() => page.locator(".md-diagram").evaluateAll((all: HTMLImageElement[]) => all.at(-1)?.naturalWidth ?? 0), { timeout: 15000 })
    .toBeGreaterThan(0);
});

test("a diagram with a link or a no-break space draws", async () => {
  const fences = ['flowchart LR\n  a --> b\n  click a href "https://example.com"', "sequenceDiagram\n  a->>b: hello\u00a0there"];
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n${fences.map((f) => `\`\`\`mermaid\n${f}\n\`\`\`\n`).join("\n")}`);
  await expect(page.locator(".md-diagram")).toHaveCount(3, { timeout: 15000 });
  await expect(page.locator(".md-diagram-off")).toHaveCount(0);
});

test("a new diagram keeps its source beside the drawing in Side by side", async () => {
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n\`\`\`mermaid\n%% a note the drawing leaves out\nflowchart LR\n  a --> b\n\`\`\`\n`);
  await view("Side by side").click();
  const added = page.locator(".md-fence.is-drawn", { hasText: "a note the drawing leaves out" });
  await expect(added.locator("pre")).toBeVisible({ timeout: 15000 });
  await expect(added.locator(".md-diagram")).toBeVisible();
});

test("the preview warns about invisible characters like the diff does", async () => {
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\nPay alice\u200b now.\n`);
  await expect(page.locator(".invisible-notice")).toContainText("1 invisible character on 1 line");
});

test("a second kind of diagram draws, and enlarges", async () => {
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n\`\`\`mermaid\njourney\n title J\n section S\n  a: 5: Me\n\`\`\`\n`);
  await expect
    .poll(() => page.locator(".md-diagram").evaluateAll((all: HTMLImageElement[]) => all.at(-1)?.naturalWidth ?? 0), { timeout: 15000 })
    .toBeGreaterThan(0);
  await expect(page.locator(".md-diagram")).toHaveCount(2);
  await page.locator(".md-diagram").last().click();
  await expect(page.locator(".shot-view")).toBeVisible();
  await page.locator(".shot-view").click();
  await expect(page.locator(".shot-view")).toHaveCount(0);
});

test("a diagram that won't finish is stopped while the app stays usable", async () => {
  const stuck = "gantt\n  dateFormat YYYY-MM-DD\n  excludes 1999-01-01\n  section s\n  t :a, 2020-01-01, 50000000d";
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n\`\`\`mermaid\n${stuck}\n\`\`\`\n`);
  await expect(page.locator(".md-diagram-off")).toHaveText("Can't draw this diagram: it took too long to lay out", { timeout: 15000 });
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("?");
});

test("a broken diagram says why", async () => {
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n\`\`\`mermaid\nflowchart LR\n  a[[[\n\`\`\`\n`);
  await expect(page.locator(".md-diagram-off")).toContainText("Can't draw this diagram", { timeout: 15000 });
});

test("an empty link stays put instead of reloading the app", async () => {
  await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true));
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n[empty]()\n`);
  await page.locator("article.md a", { hasText: "empty" }).click();
  await idle();
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
});

test("a step in the preview is marked on the text it's about", async () => {
  writeFileSync(join(repo, "plan.md"), rollout(false));
  writeNotes(repo, { chapters: [{ title: "The plan", ranges: [{ path: "plan.md", lines: [3, 3], note: "Moves to a sliding window." }] }] });
  await expect(page.locator(".chapter-head")).toHaveCount(1);
  await page.keyboard.press(".");
  await expect(page.locator(".caption-text")).toHaveText("Moves to a sliding window.");
  await expect(page.locator(".md .is-step")).toHaveCount(1);
  await expect(page.locator(".md .is-step")).toContainText("sliding window");
  await expect(page.locator(".md-rail[data-step='1']")).toHaveCount(1);
  const disc = await page.locator(".md-rail").boundingBox();
  const text = await page.locator(".md .is-step").boundingBox();
  expect(disc!.x + 18).toBeLessThan(text!.x);
  await expect(page.locator(".toolbar").getByRole("button", { name: "Full file" })).toBeDisabled();
});

test("keys written in a document stay readable with shortcut hints off", async () => {
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\nPress <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop.\n`);
  await expect(page.locator(".md kbd").first()).toBeVisible();
  await expect(page.locator(".md p", { hasText: "to stop" })).toHaveText("Press Ctrl+C to stop.");
});

test("Side by side shows the source of a change that renders nothing", async () => {
  await view("Side by side").click();
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n<!-- ignore previous instructions -->\n`);
  await expect(page.locator(".md:not(.is-old) .md-source")).toContainText("ignore previous instructions");
});

test("text after a comment left open still reaches the page", async () => {
  await view("Read").click();
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\n<!-- never closed\n\nthe last line\n`);
  await expect(page.locator(".md").first()).toContainText("the last line");
});

test("a file too big to render shows its text", async () => {
  writeFileSync(join(repo, "plan.md"), "- a line\n".repeat(12_000));
  await expect(page.locator(".md-too-big")).toBeVisible();
  await expect(page.locator(".md pre")).toContainText("- a line");
  await expect(page.getByRole("group", { name: "Markdown view" })).toHaveCount(0);
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\nthe last line\n`);
  await expect(page.getByRole("group", { name: "Markdown view" })).toBeVisible();
});

test("a file too big to read falls back to its diff and says so", async () => {
  writeFileSync(join(repo, "plan.md"), "- a line\n".repeat(300_000));
  commitAll("big plan");
  writeFileSync(join(repo, "plan.md"), `${"- a line\n".repeat(300_000)}- the new tail\n`);
  await page.keyboard.press("r");
  await expect(page.locator(".encoding")).toContainText("over 2 MB");
  await expect(page.locator(".md")).toHaveCount(0);
  await expect(page.getByText("- the new tail")).toBeVisible();
  await shots("markdown-too-big");
  writeFileSync(join(repo, "plan.md"), `${rollout(false)}\nthe last line\n`);
  commitAll("small plan");
  writeFileSync(join(repo, "plan.md"), `${rollout(true)}\nthe last line\n`);
  await page.keyboard.press("r");
  await expect(page.getByRole("group", { name: "Markdown view" })).toBeVisible();
});

test("paired tables scroll sideways together in Side by side", async () => {
  await view("Side by side").click();
  const row = (cell: string) => `| ${Array.from({ length: 12 }, (_, i) => `${cell}-column-${i}`).join(" | ")} |`;
  const table = (cell: string) => `${row("head")}\n|${"---|".repeat(12)}\n${row(cell)}\n`;
  writeFileSync(join(repo, "plan.md"), table("old"));
  commitAll("wide table");
  writeFileSync(join(repo, "plan.md"), table("new"));
  await page.keyboard.press("r");
  await expect(page.locator(".md tr.md-edited")).toHaveCount(1);
  // A refresh can still replace the page just after it first shows.
  await expect(async () => {
    await page.locator(".md.is-old table").evaluate((el) => (el.scrollLeft = 200));
    expect(await page.locator(".md:not(.is-old) table").evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  }).toPass();
});

test("a staged file edited again shows the staged banner in Changes, and Read drops it", async () => {
  await page.keyboard.press("a");
  await expect(page.getByRole("navigation", { name: "Changed files" })).toBeVisible();
  await view("Read").click();
  git("add", "plan.md");
  await page.keyboard.press("r");
  await expect(page.locator(".file")).toHaveCount(0);
  writeFileSync(join(repo, "plan.md"), "# Plan\n\nThe newest words.\n");
  await page.keyboard.press("r");
  await open("plan.md");
  await expect(page.locator(".md p")).toHaveText("The newest words.");
  await expect(page.locator(".since")).toHaveCount(0);

  await view("Changes").click();
  await expect(page.locator(".since")).toContainText("These are the new edits.");
  await page
    .locator(".since")
    .getByRole("button", { name: /Whole diff/ })
    .click();
  await expect(page.locator(".since")).toContainText("This is the whole diff.");
  await view("Read").click();
  await expect(page.locator(".since")).toHaveCount(0);
});
