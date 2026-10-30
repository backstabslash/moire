import { describe, expect, it } from "vitest";
import { agentOf, hueOf, initials } from "./avatar";

describe("initials", () => {
  it.each([
    ["Ada Lovelace", "AL"],
    ["Mary Jane Watson", "MW"],
    ["backstabslash", "B"],
    ["jane.doe", "JD"],
    ["  ", "?"],
    ["Ёлка Ива", "ЁИ"],
  ])("%s becomes %s", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

describe("hueOf", () => {
  it("is the same for one author in any case, and within the colour wheel", () => {
    expect(hueOf("Ada@example.com")).toBe(hueOf("ada@example.com"));
    for (const key of ["ada@example.com", "noreply@anthropic.com"]) {
      expect(hueOf(key)).toBeGreaterThanOrEqual(0);
      expect(hueOf(key)).toBeLessThan(360);
    }
  });
});

describe("agentOf", () => {
  it.each([
    ["Claude Opus 5.5 <noreply@anthropic.com>", "Claude"],
    ["Codex <codex@openai.com>", "Codex"],
    ["Cursor Agent <cursoragent@cursor.com>", "Cursor"],
    ["copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>", "Copilot"],
    ["Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>", "Devin"],
    ["Ada Lovelace (aider) <ada@example.com>", "Aider"],
    ["gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>", "Gemini"],
  ])("%s is %s", (person, agent) => {
    expect(agentOf([person])).toBe(agent);
  });

  it("looks through every person on the commit", () => {
    expect(agentOf(["Ada <ada@example.com>", "Claude <noreply@anthropic.com>"])).toBe("Claude");
  });

  it("leaves people alone, even with a name that contains an agent's", () => {
    expect(agentOf(["Claudette Colvin <claudette@example.com>", "Ada <ada@example.com>"])).toBeNull();
  });

  it.each([
    "Devin Smith <devin@acme.com>",
    "Claude Monet <claude@example.org>",
    "Ada <ada@anthropic.com>",
    "Ada <ada@cursor.com>",
    "Gemini Ganesan <g@example.com>",
  ])("%s is a person", (person) => {
    expect(agentOf([person])).toBeNull();
  });
});
