import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";
import { lineOf, makeDemoRepo } from "./repo";

const OUT = resolve(process.env.MOIRE_DEMO_OUT ?? "demo");
const SIZE = { width: 1360, height: 860 };
const SIDEBAR = 200;
const BAND = 38;
const SCENES = ["Read why.", "Keep what's right.", "Throw out what isn't."];
const INKS = ["var(--ink)", "var(--b-ink)", "var(--a-ink)"];

type Demo = { caption?: string; say?: (text: string) => void; scene?: (index: number) => void };

let page: Page;
const REST = { x: 1200, y: 650 };
let at = REST;

const hold = (ms: number) => page.waitForTimeout(ms);
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

async function glide(to: Locator | { x: number; y: number }, ms = 600) {
  const box = "boundingBox" in to ? (await to.boundingBox())! : { ...to, width: 0, height: 0 };
  const from = at;
  at = { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 };
  const steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(from.x + (at.x - from.x) * t, from.y + (at.y - from.y) * t);
    await hold(16);
  }
}

async function click(to: Locator) {
  await to.scrollIntoViewIfNeeded();
  await glide(to);
  await page.mouse.down();
  await hold(90);
  await page.mouse.up();
}

const lineNumber = (line: number) => page.locator(".ln.b[data-line]", { hasText: new RegExp(`^${line}$`) });

async function say(text: string) {
  await page.evaluate((t) => (window as unknown as Demo).say?.(t), text);
}

async function scene(index: number) {
  await page.evaluate((i) => (window as unknown as Demo).scene?.(i), index);
}

async function press(key: string, caption?: string, after = 900) {
  await page.evaluate((c) => ((window as unknown as Demo).caption = c), caption);
  await page.keyboard.press(key);
  await page.evaluate(() => delete (window as unknown as Demo).caption);
  await hold(after);
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
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: "var(--graphite)",
    font: "400 16px var(--ui)",
    opacity: "0",
    transition: "opacity 0.18s ease-out",
  });
  strip.append(story, caption);
  const controls = document.createElement("div");
  Object.assign(controls.style, {
    position: "fixed",
    top: `${band}px`,
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
  document.body.append(strip, controls, svg);
  addEventListener("mousemove", (e) => (svg.style.translate = `${e.clientX - 4}px ${e.clientY - 3}px`), true);
  addEventListener("mousedown", () => (svg.style.scale = "0.85"), true);
  addEventListener("mouseup", () => (svg.style.scale = "1"), true);
  let timer = 0;
  const show = (key: string | undefined, text: string) => {
    const cap = document.createElement("span");
    cap.textContent = key ?? "";
    Object.assign(cap.style, {
      padding: "1px 7px",
      borderRadius: "3px",
      background: "color-mix(in srgb, var(--ink) 10%, transparent)",
      color: "var(--ink)",
      font: "400 14px/1.3 var(--code)",
    });
    caption.replaceChildren(...(key ? [cap] : []), text);
    caption.style.opacity = "1";
    clearTimeout(timer);
    timer = window.setTimeout(() => (caption.style.opacity = "0"), 1500);
  };
  (window as unknown as { say(text: string): void }).say = (text) => show(undefined, text);
  addEventListener(
    "keydown",
    (e) => {
      const text = (window as unknown as { caption?: string }).caption;
      if (!text || ["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
      show([e.ctrlKey && "ctrl", e.shiftKey && "shift", e.key.toLowerCase()].filter(Boolean).join(" "), text);
    },
    true,
  );
}

async function record(cdp: CDPSession, dir: string) {
  const frames: { file: string; t: number }[] = [];
  cdp.on("Page.screencastFrame", (frame) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    frames.push({ file, t: frame.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast");
    return frames;
  };
}

function encode(frames: { file: string; t: number }[], dir: string, name: string, mp4: boolean) {
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 0.4) - f.t).toFixed(4)}`);
  writeFileSync(join(dir, "frames.txt"), `${list.join("\n")}\nfile '${frames.at(-1)!.file}'\n`);
  const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt")];
  mkdirSync(OUT, { recursive: true });
  if (mp4)
    execFileSync("ffmpeg", [...input, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", join(OUT, "demo.mp4")]);
  const gif = "fps=15,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  execFileSync("ffmpeg", [...input, "-vf", gif, join(OUT, `${name}.gif`)]);
}

async function demo(theme: string, name: string, mp4 = false) {
  const work = mkdtempSync(join(tmpdir(), "moire-demo-"));
  const repo = join(work, "ratelimit");
  const frames = join(work, "frames");
  mkdirSync(frames);
  makeDemoRepo(repo);
  const prefs = { theme, layout: "unified", scope: "changed", mode: "unstaged", file: "src/limiter.ts", sidebar: String(SIDEBAR), "notes-width": "300" };
  const app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${join(work, "data")}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: JSON.stringify(prefs) },
  });
  at = REST;
  try {
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), SIZE);
    await expect(page.locator(".file.is-active .name")).toHaveText("limiter.ts");
    await expect(page.locator('.cell span[style*="color"]').first()).toBeVisible();
    await page.evaluate(overlay, { band: BAND, scenes: SCENES, inks: INKS });
    await scene(0);
    await page.mouse.move(at.x, at.y);
    await hold(400);

    const cdp = await page.context().newCDPSession(page);
    const stop = await record(cdp, frames);
    await hold(900);

    await press(".", "Next note", 1400);
    await press(".", "Next note", 2300);

    await scene(1);
    await click(page.getByRole("button", { name: "Stage this chapter" }));
    await say("Stage this chapter");
    await glide({ x: 700, y: 560 }, 400);
    await hold(800);

    // The blink toast explains keys the caption already shows.
    const quiet = await page.addStyleTag({ content: ".toast { visibility: hidden; }" });
    await press("Shift+B", "Blink old and new", 1800);
    await press("Escape", undefined, 200);

    await scene(2);
    await say("Not in any chapter");
    await click(page.locator(".uncovered button", { hasText: "server.ts" }));
    await hold(500);
    await click(lineNumber(lineOf("src/server.ts", "DEBUG")));
    await glide({ x: 740, y: 700 }, 350);
    await press("x", "Discard the line", 0);
    await quiet.evaluate((el) => (el as HTMLElement).remove());
    await hold(1300);

    await scene(SCENES.length);
    await press("Shift+S", "Stage the rest", 2600);
    const recorded = await stop();
    encode(recorded, work, name, mp4);
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  }
}

test("record the light demo", () => demo("light", "demo-light", true));
test("record the dark demo", () => demo("dark", "demo-dark"));
