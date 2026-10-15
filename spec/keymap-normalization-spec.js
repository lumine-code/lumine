const { normalizeKeystroke, normalizeKeystrokes } = require("../src/keymap-normalization");

describe("platform-independent keystroke normalization", () => {
  it("resolves portable modifiers for an explicit platform without changing the process", () => {
    for (const [platform, primary] of [
      ["win32", "ctrl"],
      ["linux", "ctrl"],
      ["darwin", "cmd"],
    ]) {
      expect(normalizeKeystrokes("CmdOrCtrl-K CmdOrCtrl-SHIFT-F", platform)).toBe(
        `${primary}-k ${platform === "darwin" ? "shift-cmd" : "ctrl-shift"}-f`,
      );
    }
  });

  it("keeps canonical modifier order, removes duplicates and normalizes release strokes", () => {
    expect(normalizeKeystroke("cmd-shift-alt-ctrl-ctrl-A", "linux")).toBe("ctrl-alt-shift-cmd-a");
    expect(normalizeKeystrokes("ctrl-tab ^ctrl-tab ^shift-ctrl", "linux")).toBe(
      "ctrl-tab ^tab ^ctrl-shift",
    );
    expect(normalizeKeystroke("^", "darwin")).toBe("^");
  });

  it("preserves minus and punctuation keys while rejecting malformed sequences", () => {
    expect(normalizeKeystrokes("cmdorctrl-- cmdorctrl-|", "win32")).toBe("ctrl-- ctrl-|");
    for (const keys of ["ctrl-", "ctrl-a-b", "ctrl-a shift-", ""]) {
      expect(normalizeKeystrokes(keys, "win32")).toBe(false);
    }
  });
});
