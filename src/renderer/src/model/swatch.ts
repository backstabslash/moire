export interface Swatch {
  at: number;
  color: string;
}

const HEX = "#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])";
const FUNCTION = "\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\\([^()]*\\)";
const IN_STYLES = new RegExp(`${HEX}|${FUNCTION}`, "gi");
// Outside stylesheets a bare "#123" is usually an issue number, so only a whole quoted string counts.
const QUOTED = new RegExp(`(?<=["'\`])(?:${HEX}|${FUNCTION})(?=["'\`])`, "gi");

export function swatches(text: string, styles: boolean): Swatch[] {
  if (!text.includes("#") && !text.includes("(")) return [];
  return [...text.matchAll(styles ? IN_STYLES : QUOTED)].map((m) => ({ at: m.index, color: m[0] }));
}
