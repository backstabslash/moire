import { describe, expect, it } from "vitest";
import { modeNote } from "./modes";

describe("modeNote", () => {
  it("describes mode changes in plain words, with a short tag", () => {
    expect(modeNote({ oldMode: "100644", newMode: "100755" })).toEqual({ words: "now executable", tag: "+x" });
    expect(modeNote({ oldMode: "100644", newMode: "120000" })).toEqual({ words: "file type changed to symlink", tag: "link" });
    expect(modeNote({ oldMode: "120000", newMode: "100755" })).toEqual({ words: "file type changed to file", tag: "file" });
    expect(modeNote({ oldMode: "120000", newMode: "120000" })).toEqual({ words: "symlink", tag: "link" });
    expect(modeNote({ newMode: "100755" })).toEqual({ words: "executable", tag: "+x" });
    expect(modeNote({ oldMode: "100755" })).toBeNull();
    expect(modeNote({})).toBeNull();
  });
});
