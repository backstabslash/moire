import { fenceSource } from "./model/redline";

const VIEW_BOX = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/;
// A diagram this long wouldn't be readable, and it would hold up the others behind it.
const MAX_LINES = 500;

// An image can't run the diagram's scripts or leak its styles into the page, whatever the file holds.
function imageOf(svg: string) {
  const size = VIEW_BOX.exec(svg);
  const sized = size
    ? svg.replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, "").replace("<svg", `<svg width="${size[1]}" height="${size[2]}"`))
    : svg;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
}

// Scaling each image by its own share of the widest and tallest keeps both sides at one scale at any column width.
function shareScale(root: HTMLElement) {
  const pairs = new Map<string, HTMLImageElement[]>();
  for (const img of root.querySelectorAll<HTMLImageElement>(".md-diagram")) {
    const pair = img.closest(".md-fence")?.querySelector("code")?.dataset.pair;
    if (pair !== undefined) pairs.set(pair, [...(pairs.get(pair) ?? []), img]);
  }
  for (const imgs of pairs.values()) {
    if (imgs.length !== 2) continue;
    const width = Math.max(...imgs.map((img) => img.naturalWidth));
    const height = Math.max(...imgs.map((img) => img.naturalHeight));
    for (const img of imgs) {
      img.style.maxWidth = `${(img.naturalWidth / width) * 100}%`;
      img.style.maxHeight = `calc(var(--diagram-h) * ${img.naturalHeight / height})`;
    }
  }
}

export async function drawDiagrams(root: HTMLElement, signal: AbortSignal) {
  const codes = [...root.querySelectorAll<HTMLElement>('code[data-lang="mermaid"]')];
  if (!codes.length) return;
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const pie = ["--b", "--a", "--tok-fn", "--tok-str", "--tok-num", "--tok-prop", "--tok-re", "--graphite", "--tok-ty", "--tok-com", "--faint", "--rule"];
  const theme = {
    background: token("--plate"),
    primaryColor: token("--frame"),
    primaryTextColor: token("--ink"),
    primaryBorderColor: token("--faint"),
    secondaryColor: token("--frame-2"),
    tertiaryColor: token("--plate"),
    lineColor: token("--graphite"),
    fontFamily: '"IBM Plex Sans Condensed", sans-serif',
    fontSize: "14px",
    edgeLabelBackground: token("--plate"),
    darkMode: document.documentElement.dataset.tone === "dark",
    noteBkgColor: token("--frame-2"),
    noteTextColor: token("--ink"),
    noteBorderColor: token("--graphite"),
    titleColor: token("--ink"),
    taskBkgColor: token("--frame-2"),
    taskBorderColor: token("--graphite"),
    taskTextColor: token("--ink"),
    taskTextDarkColor: token("--ink"),
    taskTextLightColor: token("--ink"),
    taskTextOutsideColor: token("--ink"),
    activeTaskBkgColor: token("--b-line"),
    activeTaskBorderColor: token("--b"),
    doneTaskBkgColor: token("--frame"),
    doneTaskBorderColor: token("--faint"),
    critBkgColor: token("--a-line"),
    critBorderColor: token("--a"),
    todayLineColor: token("--a"),
    gridColor: token("--rule"),
    sectionBkgColor: token("--frame"),
    sectionBkgColor2: token("--frame-2"),
    altSectionBkgColor: token("--plate"),
    pieTitleTextColor: token("--ink"),
    pieLegendTextColor: token("--ink"),
    pieSectionTextColor: token("--plate"),
    pieStrokeColor: token("--plate"),
    pieOpacity: "1",
    pieOuterStrokeColor: token("--rule"),
    ...Object.fromEntries(pie.map((name, i) => [`pie${i + 1}`, token(name)])),
  };
  for (const code of codes) {
    if (signal.aborted) return;
    const box = code.closest<HTMLElement>(".md-fence")!;
    try {
      const source = fenceSource(code);
      const lines = source.split("\n").length;
      if (lines > MAX_LINES) throw new Error(`it has ${lines} lines, and the limit is ${MAX_LINES}`);
      const drawn = await window.moire.drawDiagram(source, theme);
      if (signal.aborted) return;
      if ("error" in drawn) throw new Error(drawn.error);
      const img = new Image();
      img.className = "md-diagram";
      img.alt = "Diagram";
      img.dataset.tip = "Click to enlarge";
      img.src = imageOf(drawn.svg);
      await img.decode();
      if (signal.aborted) return;
      box.querySelector(".md-diagram, .md-diagram-off")?.remove();
      box.append(img);
      box.classList.add("is-drawn");
    } catch (e) {
      if (signal.aborted) return;
      const off = document.createElement("p");
      off.className = "md-diagram-off";
      off.textContent = `Can't draw this diagram: ${(e as Error).message}`;
      box.querySelector(".md-diagram, .md-diagram-off")?.remove();
      box.classList.remove("is-drawn");
      box.append(off);
    }
  }
  shareScale(root);
}
