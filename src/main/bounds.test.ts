import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE, restoredBounds } from "./bounds";

const laptop = { x: 0, y: 0, width: 1920, height: 1080 };
const external = { x: 1920, y: 0, width: 2560, height: 1440 };
const below = { x: 0, y: 28, width: 1920, height: 1052 };

describe("restoredBounds", () => {
  it.each([
    ["uses the default size the first time", undefined, [laptop], DEFAULT_SIZE],
    ["puts the window back where it was", { x: 2000, y: 40, width: 1600, height: 1000 }, [laptop, external], { x: 2000, y: 40, width: 1600, height: 1000 }],
    ["keeps the size but not the position when that screen is gone", { x: 2000, y: 40, width: 1600, height: 1000 }, [laptop], { width: 1600, height: 1000 }],
    ["shrinks a window that no longer fits", { x: 10, y: 10, width: 2500, height: 1400 }, [laptop], { x: 0, y: 0, width: 1920, height: 1080 }],
    [
      "sizes against the screen holding most of the window, not the first one it touches",
      { x: 1900, y: 100, width: 2000, height: 1300 },
      [laptop, external],
      { x: 1920, y: 100, width: 2000, height: 1300 },
    ],
    [
      "pulls a window back fully on-screen when only a sliver would show",
      { x: 1900, y: 100, width: 1200, height: 800 },
      [laptop],
      { x: 720, y: 100, width: 1200, height: 800 },
    ],
    [
      "keeps the title bar reachable when the window sits above the screen",
      { x: 100, y: -300, width: 1200, height: 800 },
      [laptop],
      { x: 100, y: 0, width: 1200, height: 800 },
    ],
    ["respects a work area that doesn't start at the origin", { x: 100, y: 0, width: 1200, height: 800 }, [below], { x: 100, y: 28, width: 1200, height: 800 }],
  ])("%s", (_, saved, screens, expected) => {
    expect(restoredBounds(saved, screens)).toEqual(expected);
  });
});
