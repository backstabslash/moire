export type Palette = Record<string, string>;
type Vision = "deutan" | "protan";

const READING = ["ink", "kw", "str", "ty", "num", "com", "fn", "prop", "param", "re"].map((k) => `tok-${k}`);
const HUES = ["tok-str", "tok-num", "tok-fn", "tok-prop", "tok-re"];
const SEARCH_INK = "#17130a";

// Machado 2009 at full severity.
const VISION: Record<Vision, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

const srgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (rgb: number[]) => rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));

const luminance = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

function wcag(a: string, b: string) {
  const [hi, lo] = [luminance(linear(srgb(a))), luminance(linear(srgb(b)))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// APCA-W3 0.1.9, a reading target beside WCAG 2 since it left the WCAG 3 draft.
function lc(text: string, ground: string) {
  const y = (hex: string) => {
    const v = srgb(hex).map((c) => c ** 2.4);
    const out = 0.2126729 * v[0] + 0.7151522 * v[1] + 0.072175 * v[2];
    return out > 0.022 ? out : out + (0.022 - out) ** 1.414;
  };
  const [t, g] = [y(text), y(ground)];
  const out = g > t ? (g ** 0.56 - t ** 0.57) * 1.14 - 0.027 : (g ** 0.65 - t ** 0.62) * 1.14 + 0.027;
  return Math.abs(out) * 100;
}

function oklab(rgb: number[]) {
  const [r, g, b] = rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const lab = (hex: string) => oklab(linear(srgb(hex)));
export const lightness = (hex: string) => lab(hex)[0];
const chroma = (hex: string) => Math.hypot(...lab(hex).slice(1));
const gap = (x: number[], y: number[]) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;

function delta(a: string, b: string, vision?: Vision) {
  const see = (hex: string) => {
    const rgb = linear(srgb(hex));
    const seen = vision ? VISION[vision].map((row) => Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])) : rgb;
    return oklab(seen);
  };
  return gap(see(a), see(b));
}

const atLeast = (min: number, ...checks: [string, number][]) =>
  checks.filter(([, got]) => got < min).map(([what, got]) => `${what} ${got.toFixed(1)} < ${min}`);

export function contrast(t: Palette, tone: string) {
  const [ground, line, word] = [["plate"], ["a-line", "b-line"], ["a-word", "b-word", "hit"]];
  const pairs = (fg: string[], bg: string[], score: (f: string, b: string) => number) =>
    fg.flatMap((f) => bg.map((b) => [`${f} on ${b}`, score(t[f], t[b])] as [string, number]));
  const a = lightness(t["a-line"]);
  const b = lightness(t["b-line"]);
  return [
    ...atLeast(75, ...pairs(READING, ground, lc)),
    ...atLeast(5.2, ...pairs(READING, line, wcag)),
    ...atLeast(4.5, ...pairs(READING, word, wcag)),
    ...atLeast(60, ...pairs(["tok-pun"], ground, lc), ...pairs(["graphite"], ["plate", "frame"], lc)),
    ...atLeast(4.5, ...pairs(["tok-pun"], ground, wcag)),
    ...atLeast(4, ...pairs(["tok-pun"], line, wcag)),
    ...atLeast(3.2, ...pairs(["tok-pun"], word, wcag)),
    ...atLeast(45, ...pairs(["faint"], ["plate", "frame"], lc)),
    ...atLeast(4.5, ...pairs(["faint"], ["plate", "frame", "frame-2"], wcag)),
    ...atLeast(
      4.5,
      ...pairs(["a-ink", "b-ink"], ["plate", "frame", "frame-2"], wcag),
      ...pairs(["a-ink"], ["a-line"], wcag),
      ...pairs(["b-ink"], ["b-line"], wcag),
    ),
    ...atLeast(3, ...pairs(["a", "b", "focus"], ["plate", "frame"], wcag)),
    ...atLeast(4.5, ...pairs(["plate"], ["a", "b"], wcag)),
    ...atLeast(7, ["search ink on hit-now", wcag(SEARCH_INK, t["hit-now"])]),
    ...atLeast(10, ["hit from plate", delta(t.hit, t.plate)]),
    ...atLeast(5, ["word from line, A", delta(t["a-word"], t["a-line"])], ["word from line, B", delta(t["b-word"], t["b-line"])]),
    ...atLeast(5, ["hit on A", delta(t.hit, t["a-line"])], ["hit on B", delta(t.hit, t["b-line"])]),
    ...atLeast(0.02, ["line tint lightness gap", Math.abs(a - b)]),
    ...atLeast(7, ["ink over graphite", lc(t.ink, t.plate) - lc(t.graphite, t.plate)], ["graphite over faint", lc(t.graphite, t.plate) - lc(t.faint, t.plate)]),
    ...atLeast(7, ["ink over punctuation", lc(t["tok-ink"], t.plate) - lc(t["tok-pun"], t.plate)]),
    ...(tone === "dark" ? darkTints(t) : []),
    ...surfaces(t, tone),
  ];
}

// Saturated fills vibrate on dark grounds, so tints stay muted and just above the plate.
function darkTints(t: Palette) {
  const roof = Math.max(0.32, lightness(t.plate) + 0.105);
  return ["a", "b"].flatMap((s) => {
    const [line, word] = [t[`${s}-line`], t[`${s}-word`]];
    const bad = chroma(line) > 0.05 || chroma(word) > 0.08 || lightness(line) < 0.24 || lightness(line) > roof;
    return bad ? [`${s} tints outside the dark budget`] : [];
  });
}

function surfaces(t: Palette, tone: string) {
  const steps = ["plate", "frame", "frame-2", "rule"].map((k) => lightness(t[k]) * (tone === "dark" ? 1 : -1));
  return steps.slice(1).some((step, i) => step - steps[i] < 0.012) ? ["surfaces don't step away from the plate"] : [];
}

export function plates(t: Palette, safe: boolean) {
  const [strong, lines] = safe ? [20, 5] : [10, 4];
  return [
    ...atLeast(15, ["A from B", delta(t.a, t.b)]),
    ...atLeast(5, ["line tints", delta(t["a-line"], t["b-line"])]),
    ...(["deutan", "protan"] as const).flatMap((vision) => [
      ...atLeast(strong, [`A from B, ${vision}`, delta(t.a, t.b, vision)]),
      ...atLeast(lines, [`line tints, ${vision}`, delta(t["a-line"], t["b-line"], vision)]),
    ]),
  ];
}

export function tints(t: Palette) {
  const plate = lab(t.plate);
  return atLeast(
    2,
    ...["a", "b"].flatMap((s) => {
      const line = lab(t[`${s}-line`]);
      // --a-half and --b-half: color-mix in oklab at 50%, not the sRGB mix in presets.ts.
      const half = line.map((v, i) => (v + plate[i]) / 2);
      return [
        [`${s}-line from plate`, gap(line, plate)],
        [`${s}-half from plate`, gap(half, plate)],
      ] as [string, number][];
    }),
  );
}

export function syntax(t: Palette) {
  const out: string[] = [];
  const [a, b] = [chroma(t.a), chroma(t.b)];
  if (Math.abs(a - b) > 0.06) out.push("A and B differ in weight");
  const ratio = wcag(t.a, t.plate) / wcag(t.b, t.plate);
  if (ratio > 2 || ratio < 0.5) out.push("A and B differ in contrast");
  if (Math.max(...HUES.map((k) => chroma(t[k]))) > (a + b) / 2) out.push("syntax is louder than the diff");
  if (delta(t["tok-str"], t.focus) < 8) out.push("strings look like the selection");
  HUES.forEach((k, i) => {
    if (delta(t[k], t["a-ink"]) < 6 || delta(t[k], t["b-ink"]) < 6) out.push(`${k} reads as a diff colour`);
    for (const other of HUES.slice(i + 1)) if (delta(t[k], t[other]) < 5) out.push(`${k} and ${other} look alike`);
  });
  return out;
}

export const ALERTS = ["note", "tip", "important", "warning", "caution"].map((k) => `alert-${k}`);

// Added and removed are the only meanings the diff colours carry, so a Caution mustn't read as a deletion.
export function alerts(t: Palette) {
  const out = atLeast(4.5, ...ALERTS.flatMap((k) => ["plate", "frame"].map((bg) => [`${k} on ${bg}`, wcag(t[k], t[bg])] as [string, number])));
  ALERTS.forEach((k, i) => {
    for (const side of ["a", "b", "a-ink", "b-ink"]) if (delta(t[k], t[side]) < 7) out.push(`${k} reads as ${side}`);
    for (const other of ALERTS.slice(i + 1)) if (delta(t[k], t[other]) < 10) out.push(`${k} and ${other} look alike`);
  });
  return out;
}

const IN_WORDS: Palette = {
  "tok-ink": "code",
  "tok-kw": "keywords",
  "tok-str": "strings",
  "tok-ty": "types",
  "tok-num": "numbers",
  "tok-com": "comments",
  "tok-fn": "functions",
  "tok-prop": "properties",
  "tok-param": "parameters",
  "tok-re": "regexes",
  "a-ink": "A text",
  "b-ink": "B text",
  plate: "the background",
  "a-line": "removed lines",
  "b-line": "added lines",
};

// Softer floor for custom themes; the rules above bind themes that ship.
export function hardToRead(t: Palette) {
  const check = (min: number, fg: string[], bg: string) =>
    fg.flatMap((k) => {
      const got = wcag(t[k], t[bg]);
      return got < min ? [`${IN_WORDS[k]} on ${IN_WORDS[bg]} ${got.toFixed(1)}:1, needs ${min}:1`] : [];
    });
  return [
    ...check(4.5, READING, "plate"),
    ...check(3.5, READING, "a-line"),
    ...check(3.5, READING, "b-line"),
    ...check(3, ["a-ink", "b-ink"], "plate"),
    ...(delta(t.a, t.b) < 10 ? ["A and B look too alike"] : []),
  ];
}

export const PALETTE_VARS = [
  "plate",
  "frame",
  "frame-2",
  "rule",
  "ink",
  "graphite",
  "faint",
  "a",
  "a-line",
  "a-word",
  "a-ink",
  "b",
  "b-line",
  "b-word",
  "b-ink",
  "focus",
  "hit",
  "hit-now",
  "tok-ink",
  "tok-kw",
  "tok-str",
  "tok-ty",
  "tok-num",
  "tok-com",
  "tok-pun",
  "tok-fn",
  "tok-prop",
  "tok-param",
  "tok-re",
  ...ALERTS,
];
