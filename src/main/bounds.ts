import type { Rectangle } from "electron";

export const DEFAULT_SIZE = { width: 1440, height: 920 };

export interface SavedWindow extends Rectangle {
  maximized?: boolean;
}

const span = (aStart: number, aSize: number, bStart: number, bSize: number) => Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart));
const sharedArea = (a: Rectangle, b: Rectangle) => span(a.x, a.width, b.x, b.width) * span(a.y, a.height, b.y, b.height);
const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);

export function restoredBounds(saved: SavedWindow | undefined, screens: Rectangle[]): Partial<Rectangle> {
  if (!saved) return DEFAULT_SIZE;
  const screen = screens.filter((s) => sharedArea(saved, s) > 0).sort((a, b) => sharedArea(saved, b) - sharedArea(saved, a))[0];
  const fit = screen ?? screens[0];
  const size = { width: Math.min(saved.width, fit?.width ?? saved.width), height: Math.min(saved.height, fit?.height ?? saved.height) };
  if (!screen) return size;
  return { x: clamp(saved.x, screen.x, screen.x + screen.width - size.width), y: clamp(saved.y, screen.y, screen.y + screen.height - size.height), ...size };
}
