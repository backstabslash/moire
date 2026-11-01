import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";
import { lineOf, makeDemoRepo } from "./repo";

const OUT = resolve(process.env.MOIRE_DEMO_OUT ?? "demo");
const SIZE = { width: 1200, height: 760 };
const SIDEBAR = 205;
const BAND = 38;
const SCENES = ["Read why.", "Keep what's right.", "Throw out what isn't.", "See it your way."];
const INKS = ["var(--ink)", "var(--b-ink)", "var(--a-ink)", "var(--ink)"];
const THEMES: Record<string, string[]> = { light: ["Ledger", "Lightbox", "Gypsum"], dark: ["Phosphor", "Cyanotype", "Safelight"] };

type Box = { x: number; y: number; width: number; height: number };
type Demo = {
  caption?: string;
  captionMs?: number;
  say?: (text: string, ms?: number) => void;
  scene?: (index: number) => void;
  spot?: (box: Box | null) => void;
};

let page: Page;
const REST = { x: 1050, y: 600 };
const QUIET = { x: 1065, y: 632 };
const SIDE = { x: 100, y: 590 };
let at = REST;

const hold = (ms: number) => page.waitForTimeout(ms);
const quietChrome = () => page.addStyleTag({ content: ".toast, .keys-list { visibility: hidden; }" });
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

async function glide(to: Locator | { x: number; y: number }, ms = 420) {
  const box = "boundingBox" in to ? (await to.boundingBox())! : { ...to, width: 0, height: 0 };
  const from = at;
  at = { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 };
  const start = Date.now();
  for (let t = 0; t < 1; t = Math.min(1, (Date.now() - start) / ms)) {
    await page.mouse.move(from.x + (at.x - from.x) * ease(t), from.y + (at.y - from.y) * ease(t));
    await hold(16);
  }
  await page.mouse.move(at.x, at.y);
}

async function click(to: Locator) {
  await to.scrollIntoViewIfNeeded();
  await glide(to);
  await page.mouse.down();
  await hold(90);
  await page.mouse.up();
}

const lineNumber = (line: number) => page.locator(".ln.b[data-line]", { hasText: new RegExp(`^${line}$`) });
const row = (line: number) =>
  page
    .locator(".row")
    .filter({ has: lineNumber(line) })
    .first();
const readTime = (text: string) => 1000 + text.trim().split(/\s+/).length * 280;

async function say(text: string, ms?: number) {
  await page.evaluate(([t, m]) => (window as unknown as Demo).say?.(t as string, m as number | undefined), [text, ms]);
}

async function spot(from: Locator, to: Locator) {
  const [a, b] = [(await from.boundingBox())!, (await to.boundingBox())!];
  await page.evaluate((box) => (window as unknown as Demo).spot?.(box), { x: a.x, y: a.y, width: a.width, height: b.y + b.height - a.y });
}

async function clearSpot() {
  await page.evaluate(() => (window as unknown as Demo).spot?.(null));
  await hold(350);
}

async function pickThemes(names: string[], each: (name: string) => Promise<void>) {
  const hidden = await page.addStyleTag({ content: ".theme-pop { opacity: 0; pointer-events: none; }" });
  await page.locator(".theme-btn").evaluate((el) => (el as HTMLElement).click());
  for (const name of names) {
    await page.locator(".theme-opt", { hasText: name }).evaluate((el) => (el as HTMLElement).click());
    await each(name);
  }
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await hidden.evaluate((el) => (el as HTMLElement).remove());
}

async function readStep() {
  await hold(readTime((await page.locator(".caption-text").textContent())!));
}

async function scene(index: number) {
  await page.evaluate((i) => (window as unknown as Demo).scene?.(i), index);
}

async function press(key: string, caption?: string, after = caption ? readTime(caption) : 0) {
  await page.evaluate(([c, ms]) => Object.assign(window, { caption: c, captionMs: ms }), [caption, caption && readTime(caption)] as const);
  await page.keyboard.press(key);
  await page.evaluate(() => delete (window as unknown as Demo).caption);
  await hold(after);
}

function windowControls(top: number) {
  const controls = document.createElement("div");
  Object.assign(controls.style, {
    position: "fixed",
    top: `${top}px`,
    right: "0",
    width: "140px",
    height: "51px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    pointerEvents: "none",
  });
  for (const d of ["M7 10.5l5 5 5-5", "M12 6.5l5.5 5.5-5.5 5.5L6.5 12z", "M7.5 7.5l9 9M16.5 7.5l-9 9"]) {
    const button = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    button.setAttribute("viewBox", "0 0 24 24");
    button.setAttribute("width", "28");
    button.setAttribute("height", "28");
    button.innerHTML = `<circle cx="12" cy="12" r="12" fill="color-mix(in srgb, var(--ink) 10%, var(--frame))"/><path d="${d}" fill="none" stroke="var(--ink)" stroke-width="1.3" stroke-linejoin="round"/>`;
    controls.append(button);
  }
  document.body.append(controls);
}

function overlay({ band, scenes, inks }: { band: number; scenes: string[]; inks: string[] }) {
  const style = document.createElement("style");
  style.textContent = `.app { height: calc(100vh - ${band}px); margin-top: ${band}px; }`;
  document.head.append(style);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "26");
  svg.setAttribute("height", "26");
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M3 2l7 19 2.6-7.4L20 11z");
  arrow.setAttribute("fill", "#fff");
  arrow.setAttribute("stroke", "#000");
  arrow.setAttribute("stroke-width", "1.5");
  arrow.setAttribute("stroke-linejoin", "round");
  svg.append(arrow);
  Object.assign(svg.style, { position: "fixed", left: "0", top: "0", zIndex: "99999", pointerEvents: "none", transition: "scale 90ms" });
  const strip = document.createElement("div");
  Object.assign(strip.style, {
    position: "fixed",
    inset: "0 0 auto 0",
    height: `${band}px`,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    background: "var(--frame)",
    borderBottom: "1px solid var(--rule)",
    pointerEvents: "none",
    zIndex: "99998",
  });
  const story = document.createElement("div");
  Object.assign(story.style, { display: "flex", gap: "14px", font: "500 19px var(--ui)" });
  const lines = scenes.map((text) => {
    const line = document.createElement("span");
    line.textContent = text;
    Object.assign(line.style, { color: "var(--faint)", opacity: "0.5", transition: "color 0.25s, opacity 0.25s" });
    return line;
  });
  story.append(...lines);
  (window as unknown as { scene(index: number): void }).scene = (index) =>
    lines.forEach((line, i) => {
      const on = index === i || index >= scenes.length;
      line.style.color = on ? inks[i] : "var(--faint)";
      line.style.opacity = on ? "1" : "0.5";
    });
  const caption = document.createElement("div");
  Object.assign(caption.style, {
    position: "fixed",
    left: "50%",
    bottom: "48px",
    translate: "-50% 0",
    zIndex: "99998",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "9px 18px",
    borderRadius: "6px",
    background: "var(--ink)",
    color: "var(--frame)",
    font: "500 21px var(--ui)",
    whiteSpace: "nowrap",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 0.18s ease-out",
  });
  const shade = document.createElement("div");
  Object.assign(shade.style, {
    position: "fixed",
    borderRadius: "6px",
    boxShadow: "0 0 0 2000px color-mix(in srgb, var(--frame) 70%, transparent)",
    opacity: "0",
    zIndex: "99997",
    pointerEvents: "none",
    transition: "opacity 0.3s",
  });
  (window as unknown as Demo).spot = (box) => {
    shade.style.opacity = box ? "1" : "0";
    if (box) Object.assign(shade.style, { left: `${box.x - 14}px`, top: `${box.y - 12}px`, width: `${box.width + 28}px`, height: `${box.height + 24}px` });
  };
  strip.append(story);
  document.body.append(strip, caption, shade, svg);
  addEventListener("mousemove", (e) => (svg.style.translate = `${e.clientX - 4}px ${e.clientY - 3}px`), true);
  addEventListener("mousedown", () => (svg.style.scale = "0.85"), true);
  addEventListener("mouseup", () => (svg.style.scale = "1"), true);
  let timer = 0;
  const show = (key: string | undefined, text: string, ms = 1500) => {
    const cap = document.createElement("span");
    cap.textContent = key ?? "";
    Object.assign(cap.style, {
      padding: "1px 8px",
      borderRadius: "3px",
      background: "color-mix(in srgb, var(--frame) 22%, transparent)",
      color: "var(--frame)",
      font: "400 18px/1.3 var(--code)",
    });
    caption.replaceChildren(...(key ? [cap] : []), text);
    caption.style.opacity = "1";
    clearTimeout(timer);
    timer = window.setTimeout(() => (caption.style.opacity = "0"), ms);
  };
  (window as unknown as Demo).say = (text, ms) => show(undefined, text, ms);
  addEventListener(
    "keydown",
    (e) => {
      const { caption: text, captionMs } = window as unknown as Demo;
      if (!text || ["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
      show([e.ctrlKey && "ctrl", e.shiftKey && "shift", e.key.toLowerCase()].filter(Boolean).join(" "), text, captionMs);
    },
    true,
  );
}

async function record(cdp: CDPSession, dir: string) {
  const frames: { file: string; t: number }[] = [];
  let paused = false;
  cdp.on("Page.screencastFrame", (frame) => {
    if (!paused) {
      const file = join(dir, `${String(frames.length).padStart(5, "0")}.png`);
      writeFileSync(file, Buffer.from(frame.data, "base64"));
      frames.push({ file, t: frame.metadata.timestamp ?? Date.now() / 1000 });
    }
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return {
    pause: (on: boolean) => (paused = on),
    stop: async () => {
      await cdp.send("Page.stopScreencast");
      return frames;
    },
  };
}

function encode(frames: { file: string; t: number }[], dir: string, name: string, mp4: boolean) {
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.4) - f.t).toFixed(4)}`);
  writeFileSync(join(dir, "frames.txt"), `${list.join("\n")}\nfile '${frames.at(-1)!.file}'\n`);
  const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt")];
  mkdirSync(OUT, { recursive: true });
  if (mp4)
    execFileSync("ffmpeg", [...input, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", join(OUT, "demo.mp4")]);
  const gif = "fps=15,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  execFileSync("ffmpeg", [...input, "-vf", gif, join(OUT, `${name}.gif`)]);
}

async function launch(theme: string) {
  const work = mkdtempSync(join(tmpdir(), "moire-demo-"));
  const repo = join(work, "ratelimit");
  makeDemoRepo(repo);
  const prefs = {
    theme,
    layout: "unified",
    scope: "changed",
    mode: "unstaged",
    file: "src/limiter.ts",
    sidebar: String(SIDEBAR),
    "notes-width": "270",
    markdownView: "changes",
  };
  const app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${join(work, "data")}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: JSON.stringify(prefs) },
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), SIZE);
  await expect(page.locator(".file.is-active .name")).toHaveText("limiter.ts");
  await expect(page.locator(".brief")).toBeVisible();
  await quietChrome();
  return { app, work };
}

async function demo(theme: string, name: string, mp4 = false) {
  const { app, work } = await launch(theme);
  const frames = join(work, "frames");
  mkdirSync(frames);
  at = REST;
  try {
    await page.evaluate(windowControls, BAND);
    await page.evaluate(overlay, { band: BAND, scenes: SCENES, inks: INKS });
    await scene(0);
    await page.mouse.move(at.x, at.y);
    await hold(400);

    const cdp = await page.context().newCDPSession(page);
    const { pause, stop } = await record(cdp, frames);
    await hold(500);

    await say("The agent's brief", 4000);
    await hold(readTime((await page.locator(".brief-lead").textContent())!));

    await click(page.getByRole("button", { name: "Start the walkthrough" }));
    await say("Start the walkthrough");
    await glide(QUIET, 350);
    await readStep();
    await press(".", "Next step", 0);
    await readStep();

    await scene(1);
    await click(page.getByRole("button", { name: "Stage this chapter" }));
    await say("Stage this chapter");
    await glide(QUIET, 300);
    await expect(page.locator(".file.is-active .name")).toHaveText("client.ts");
    await lineNumber(lineOf("src/client.ts", "return first")).waitFor();
    await spot(page.locator(".caption"), row(lineOf("src/client.ts", "return first")));
    await press("Shift+B", "Blink old and new", 0);
    await readStep();
    await press("Escape");
    await clearSpot();
    await press("Shift+C", "Stage the chapter", 800);

    await scene(2);
    await say("Not in any chapter", readTime("Not in any chapter"));
    await click(page.locator(".uncovered button", { hasText: "limiter.ts" }));
    const login = lineOf("src/limiter.ts", '"/login"');
    await lineNumber(login).waitFor();
    await hold(900);
    await click(lineNumber(login));
    await glide(QUIET, 300);
    await spot(row(login - 1), row(login + 1));
    await say("Nobody asked for this: login skips the limit", 2300);
    await hold(2400);
    await clearSpot();
    await press("x", "Discard it, u undoes it", 1100);

    await scene(3);
    await click(page.locator(".stop-where", { hasText: "README.md" }));
    await hold(200);
    await press("Shift+I");
    // The diagram shows its source until it renders, which only looks like a glitch.
    pause(true);
    await press("m", "Preview what changed", 0);
    await page.locator(".md-diagram").first().waitFor({ timeout: 8000 });
    pause(false);
    await glide(SIDE, 300);
    await hold(1500);
    await say("Twelve themes, or your own", readTime("Twelve themes, or your own"));
    await pickThemes(THEMES[theme], () => hold(900));
    await press("Shift+C", "Stage what you read", 1000);
    await press("Shift+S", "Stage the renames and tests", 300);
    await scene(SCENES.length);
    await hold(2800);
    const recorded = await stop();
    encode(recorded, work, name, mp4);
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  }
}

test("record the light demo", () => demo("light", "demo-light", true));
test("record the dark demo", () => demo("dark", "demo-dark"));
