import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";
import { makeDemoRepo } from "./repo";

const OUT = resolve(process.env.MOIRE_DEMO_OUT ?? "demo");
const SIZE = { width: 1440, height: 900 };

let page: Page;
let at = { x: SIZE.width / 2, y: SIZE.height / 2 };

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
  await glide(to);
  await page.mouse.down();
  await hold(90);
  await page.mouse.up();
}

async function press(key: string, after = 900) {
  await page.keyboard.press(key);
  await hold(after);
}

// A pointer and a caption of the keys pressed, since the recording has neither.
function overlay() {
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
  const keys = document.createElement("div");
  Object.assign(keys.style, {
    position: "fixed",
    left: "50%",
    bottom: "64px",
    translate: "-50% 0",
    zIndex: "99999",
    pointerEvents: "none",
    padding: "10px 18px",
    borderRadius: "8px",
    background: "rgba(0, 0, 0, 0.78)",
    color: "#fff",
    font: "600 22px var(--ui)",
    letterSpacing: "0.04em",
    opacity: "0",
    transition: "opacity 160ms",
  });
  document.body.append(svg, keys);
  addEventListener("mousemove", (e) => (svg.style.translate = `${e.clientX - 4}px ${e.clientY - 3}px`), true);
  addEventListener("mousedown", () => (svg.style.scale = "0.85"), true);
  addEventListener("mouseup", () => (svg.style.scale = "1"), true);
  let timer = 0;
  addEventListener(
    "keydown",
    (e) => {
      if (["Shift", "Control", "Meta", "Alt"].includes(e.key) || (e.target as HTMLElement).closest("input")) return;
      const name = e.key === "Escape" ? "Esc" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
      keys.textContent = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", name].filter(Boolean).join(" + ");
      keys.style.opacity = "1";
      clearTimeout(timer);
      timer = window.setTimeout(() => (keys.style.opacity = "0"), 900);
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

function encode(frames: { file: string; t: number }[], dir: string) {
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 2) - f.t).toFixed(4)}`);
  writeFileSync(join(dir, "frames.txt"), `${list.join("\n")}\nfile '${frames.at(-1)!.file}'\n`);
  const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt")];
  mkdirSync(OUT, { recursive: true });
  execFileSync("ffmpeg", [...input, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", join(OUT, "demo.mp4")]);
  const gif = "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none";
  execFileSync("ffmpeg", [...input, "-vf", gif, join(OUT, "demo.gif")]);
}

test("record the demo", async () => {
  const work = mkdtempSync(join(tmpdir(), "moire-demo-"));
  const repo = join(work, "ratelimit");
  const frames = join(work, "frames");
  mkdirSync(frames);
  makeDemoRepo(repo);
  const prefs = { theme: "p7", layout: "split", scope: "changed", mode: "unstaged", file: "src/limiter.ts" };
  const app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${join(work, "data")}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: JSON.stringify(prefs) },
  });
  try {
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), SIZE);
    await expect(page.locator(".file.is-active .name")).toHaveText("limiter.ts");
    await expect(page.locator('.cell span[style*="color"]').first()).toBeVisible();
    await page.evaluate(overlay);
    await page.mouse.move(at.x, at.y);
    await hold(400);

    const cdp = await page.context().newCDPSession(page);
    const stop = await record(cdp, frames);
    await hold(1500);

    await press("j");
    await press("j", 1200);

    const row = (text: string) => page.locator(".row.split", { hasText: text }).locator(".ln.b");
    await glide(row("const seconds"));
    await page.mouse.down();
    await glide(row("Retry-After"), 500);
    await page.mouse.up();
    await hold(700);
    await press("c", 1600);
    await press("s", 1600);

    await press("Shift+B", 2600);
    await press("Escape", 600);

    await press("v", 1400);
    await press("v", 800);

    await click(page.locator(".file", { hasText: "README.md" }));
    await hold(900);
    await press("m", 1600);
    await click(page.getByRole("button", { name: "Stage file" }));
    await glide({ x: 900, y: 560 }, 700);
    await hold(1000);

    await press("Control+f", 300);
    await page.keyboard.type("bucket", { delay: 110 });
    await hold(800);
    await press("Enter", 800);
    await press("Enter", 1000);
    await press("Escape", 500);

    await press("3", 1600);
    await press("j", 700);
    await press("j", 2600);
    const recorded = await stop();
    encode(recorded, work);
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  }
});
