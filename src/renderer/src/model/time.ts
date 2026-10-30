const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export function timeAgo(at: number, now = Date.now()): string {
  const s = (now - at) / 1000;
  const unit = UNITS.find(([, size]) => s >= size);
  return unit ? relative.format(-Math.round(s / unit[1]), unit[0]) : "just now";
}
