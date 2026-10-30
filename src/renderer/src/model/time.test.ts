import { describe, expect, it } from "vitest";
import { timeAgo } from "./time";

const now = Date.UTC(2026, 9, 30, 12);
const before = (seconds: number) => now - seconds * 1000;

describe("timeAgo", () => {
  it("says just now for under a minute and for clocks ahead of ours", () => {
    expect(timeAgo(before(20), now)).toBe("just now");
    expect(timeAgo(before(-20), now)).toBe("just now");
  });

  it("picks the largest unit that fits", () => {
    expect(timeAgo(before(5 * 60), now)).toBe("5 minutes ago");
    expect(timeAgo(before(3 * 3600), now)).toBe("3 hours ago");
    expect(timeAgo(before(86400), now)).toBe("yesterday");
    expect(timeAgo(before(3 * 86400), now)).toBe("3 days ago");
    expect(timeAgo(before(14 * 86400), now)).toBe("2 weeks ago");
    expect(timeAgo(before(90 * 86400), now)).toBe("3 months ago");
    expect(timeAgo(before(800 * 86400), now)).toBe("2 years ago");
  });
});
