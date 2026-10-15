import { describe, expect, it } from "vitest";
import { accelerator, COMMAND_IDS, DEFAULT_KEYS, defaultKeysFile, parseKey, resolveKeys, strokeLabel } from "./keymap";

describe("parseKey", () => {
  it("reads letters, symbols, named keys and modifiers", () => {
    expect(parseKey("s")).toBe("s");
    expect(parseKey("S")).toBe("S");
    expect(parseKey("shift+s")).toBe("S");
    expect(parseKey("?")).toBe("?");
    expect(parseKey("esc")).toBe("Escape");
    expect(parseKey("Shift+Down")).toBe("Shift+ArrowDown");
    expect(parseKey("ctrl+Z")).toBe("Mod+z");
    expect(parseKey("Cmd+Shift+z")).toBe("Mod+Shift+z");
    expect(parseKey("Mod++")).toBe("Mod++");
    expect(parseKey("g g")).toBe("g g");
  });

  it("refuses what the matcher can't produce", () => {
    for (const bad of ["", "alt+s", "shift+/", "ы", "a b c", "Hyper+x", "tab"]) expect(parseKey(bad)).toBeNull();
  });
});

describe("resolveKeys", () => {
  it("has no clashes in the defaults", () => {
    expect(resolveKeys(defaultKeysFile())).toEqual({ keys: DEFAULT_KEYS, problems: [] });
    expect(resolveKeys(null).problems).toEqual([]);
  });

  it("applies overrides on top of the defaults", () => {
    const { keys, problems } = resolveKeys(JSON.stringify({ stage: "w", nextFile: ["n", "Shift+Right"], copyCode: "" }));
    expect(problems).toEqual(["nextFile and nextHit both use n, so nextFile keeps its default."]);
    expect(keys.stage).toEqual(["w"]);
    expect(keys.nextFile).toEqual(["]"]);
    expect(keys.copyCode).toEqual([]);
  });

  it("lets two commands swap keys", () => {
    const { keys, problems } = resolveKeys(JSON.stringify({ stage: "x", discard: "s" }));
    expect(problems).toEqual([]);
    expect([keys.stage, keys.discard]).toEqual([["x"], ["s"]]);
  });

  it("reports unknown ids, bad keys and fixed commands, and keeps those defaults", () => {
    const { keys, problems } = resolveKeys(JSON.stringify({ stge: "S", "//": "note", stage: "alt+s", discard: 3, zoomIn: "Mod+i" }));
    expect(problems).toEqual([
      'No command is called "stge".',
      '"alt+s" isn\'t a key moire can read, so stage keeps its default.',
      "discard should be a key or a list of keys, so it keeps its default.",
      "zoomIn can't be changed.",
    ]);
    expect(keys).toEqual(DEFAULT_KEYS);
  });

  it("treats a single key and a sequence starting with it as a clash", () => {
    const { keys, problems } = resolveKeys(JSON.stringify({ refresh: "g" }));
    expect(problems).toEqual(["firstHunk and refresh both use g, so refresh keeps its default."]);
    expect(keys.refresh).toEqual(["r"]);
    expect(resolveKeys(JSON.stringify({ refresh: "g r" })).problems).toEqual([]);
  });

  it("falls back to every default when the file isn't an object", () => {
    expect(resolveKeys("{ stage: S }").problems[0]).toMatch(/^It isn't valid JSON, so every key has its default/);
    expect(resolveKeys("[]").problems).toHaveLength(1);
  });

  it("writes every remappable command into the starter file", () => {
    const written = JSON.parse(defaultKeysFile()) as Record<string, unknown>;
    expect(Object.keys(written).filter((k) => k !== "//")).toEqual(COMMAND_IDS.filter((id) => !id.startsWith("zoom")));
  });
});

describe("labels", () => {
  it("formats key caps and sentences per platform", () => {
    expect(strokeLabel("B", false)).toBe("shift b");
    expect(strokeLabel("B", false, "text")).toBe("Shift+B");
    expect(strokeLabel("Mod+z", false)).toBe("ctrl z");
    expect(strokeLabel("Mod+z", true)).toBe("⌘z");
    expect(strokeLabel("Mod+0", true, "text")).toBe("Cmd+0");
    expect(strokeLabel("Mod+=", false)).toBe("ctrl +");
    expect(strokeLabel("Escape", false)).toBe("esc");
    expect(strokeLabel("g g", false)).toBe("g g");
  });

  it("turns single keys into Electron accelerators", () => {
    expect(accelerator("s")).toBe("S");
    expect(accelerator("N")).toBe("Shift+N");
    expect(accelerator("Mod+=")).toBe("CmdOrCtrl+Plus");
    expect(accelerator("[")).toBe("[");
    expect(accelerator("Escape")).toBe("Esc");
    expect(accelerator("g g")).toBeNull();
  });
});
