import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type CDPSession, expect, type Locator, type Page, test } from "@playwright/test";
import { makeDemoRepo } from "./repo";

const OUT = resolve(process.env.MOIRE_DEMO_OUT ?? "demo");
const SIZE = { width: 1200, height: 750 };

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
  await to.scrollIntoViewIfNeeded();
  await glide(to);
  await page.mouse.down();
  await hold(90);
  await page.mouse.up();
}

async function press(key: string, caption?: string, after = 900) {
  await page.evaluate((c) => ((window as { caption?: string }).caption = c), caption);
  await page.keyboard.press(key);
  await page.evaluate(() => delete (window as { caption?: string }).caption);
  await hold(after);
}

// A pointer and a caption of the key pressed and what it does, since the recording has neither.
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
  const caption = document.createElement("div");
  Object.assign(caption.style, {
    position: "fixed",
    left: "50%",
    bottom: "120px",
    translate: "-50% 0",
    zIndex: "99999",
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "9px 16px 9px 10px",
    borderRadius: "10px",
    background: "rgba(20, 22, 26, 0.86)",
    color: "#fff",
    font: "500 19px var(--ui)",
    opacity: "0",
    transition: "opacity 180ms",
  });
  document.body.append(svg, caption);
  addEventListener("mousemove", (e) => (svg.style.translate = `${e.clientX - 4}px ${e.clientY - 3}px`), true);
  addEventListener("mousedown", () => (svg.style.scale = "0.85"), true);
  addEventListener("mouseup", () => (svg.style.scale = "1"), true);
  let timer = 0;
  addEventListener(
    "keydown",
    (e) => {
      const text = (window as { caption?: string }).caption;
      if (!text || ["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
      const cap = (label: string) => {
        const kbd = document.createElement("span");
        kbd.textContent = label;
        Object.assign(kbd.style, {
          minWidth: "16px",
          padding: "2px 8px",
          borderRadius: "6px",
          background: "rgba(255, 255, 255, 0.16)",
          border: "1px solid rgba(255, 255, 255, 0.28)",
          font: "600 18px var(--code)",
          textAlign: "center",
        });
        return kbd;
      };
      const keys = [e.shiftKey && "Shift", e.key.length === 1 ? e.key.toLowerCase() : e.key].filter((k): k is string => !!k);
      caption.replaceChildren(...keys.map(cap), text);
      caption.style.opacity = "1";
      clearTimeout(timer);
      timer = window.setTimeout(() => (caption.style.opacity = "0"), 1300);
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
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 2) - f.t).toFixed(4)}`);
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
  const prefs = { theme, layout: "unified", scope: "changed", mode: "unstaged", file: "src/limiter.ts" };
  const app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${join(work, "data")}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: JSON.stringify(prefs) },
  });
  at = { x: SIZE.width / 2, y: SIZE.height / 2 };
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
    await hold(1600);

    await press(".", "Next note", 1300);
    await press(".", "Next note", 2600);
    await press(".", "Next note", 1200);
    await click(page.getByRole("button", { name: "Stage this chapter" }));
    await glide({ x: 640, y: 560 }, 500);
    await hold(1300);

    await press("Shift+B", "Blink old and new", 2600);
    await press("Escape", undefined, 400);

    await click(page.locator(".uncovered button", { hasText: "server.ts" }));
    await hold(900);
    const debug = page.locator(".ln.b[data-line]", { hasText: /^11$/ });
    await click(debug);
    await hold(500);
    await press("x", "Discard", 1500);

    await press("2", "Staged changes", 1000);
    const message = page.getByPlaceholder("Commit message");
    await click(message);
    await glide({ x: 420, y: 520 }, 500);
    await page.keyboard.type("Token bucket per client", { delay: 45 });
    await hold(2200);
    const recorded = await stop();
    encode(recorded, work, name, mp4);
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  }
}

test("record the light demo", () => demo("light", "demo-light", true));
test("record the dark demo", () => demo("dark", "demo-dark"));
