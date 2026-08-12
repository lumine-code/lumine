const assert = require("./assert");
const { systemPreferences } = require("electron");

const {
  getAccentColor,
  normalizeAccentColor,
  onDidChangeAccentColor,
} = require("../../src/accent-color");

describe("accent-color", () => {
  describe("normalizeAccentColor", () => {
    it("drops the alpha Electron appends and lowercases the rest", () => {
      // The shape Electron actually returns: RGBA hex, no leading `#`, alpha
      // last. Verified on Windows under Electron 43.4.0.
      assert.strictEqual(normalizeAccentColor("3A3A3AFF"), "#3a3a3a");
      assert.strictEqual(normalizeAccentColor("0078D4ff"), "#0078d4");
    });

    it("accepts a six-digit value and a leading hash", () => {
      assert.strictEqual(normalizeAccentColor("0078d4"), "#0078d4");
      assert.strictEqual(normalizeAccentColor("#0078D4"), "#0078d4");
    });

    it("reports anything it cannot use as no accent color at all", () => {
      // The empty string is what Linux returned intermittently before Electron
      // 43.4.0 fixed it, and is still what an unsupported platform may answer.
      assert.isNull(normalizeAccentColor(""));
      assert.isNull(normalizeAccentColor(undefined));
      assert.isNull(normalizeAccentColor(null));
      assert.isNull(normalizeAccentColor("transparent"));
      assert.isNull(normalizeAccentColor("0078d"));
      assert.isNull(normalizeAccentColor("0078d4ff00"));
      assert.isNull(normalizeAccentColor(0x0078d4));
    });
  });

  describe("getAccentColor", () => {
    // Asserted by shape, not by value: what each platform reports is the
    // operating system's business, and CI runs this on three of them.
    it("answers with a CSS color or nothing, never a raw Electron value", () => {
      const accentColor = getAccentColor();
      if (accentColor === null) return;
      assert.match(accentColor, /^#[0-9a-f]{6}$/);
    });

    it("survives a platform that cannot answer", () => {
      const original = systemPreferences.getAccentColor;
      systemPreferences.getAccentColor = () => {
        throw new Error("not available on this platform");
      };
      try {
        assert.isNull(getAccentColor());
      } finally {
        systemPreferences.getAccentColor = original;
      }
    });
  });

  describe("onDidChangeAccentColor", () => {
    // Windows and Linux report the change through this event; macOS goes
    // through a distributed notification, which cannot be faked this cheaply.
    const itOnEventPlatforms = process.platform === "darwin" ? it.skip : it;

    itOnEventPlatforms("normalizes what the change event carries", () => {
      const seen = [];
      const subscription = onDidChangeAccentColor((accentColor) => seen.push(accentColor));

      try {
        systemPreferences.emit("accent-color-changed", {}, "0078D4FF");
        systemPreferences.emit("accent-color-changed", {}, "");
        assert.deepStrictEqual(seen, ["#0078d4", null]);
      } finally {
        subscription.dispose();
      }
    });

    itOnEventPlatforms("stops delivering once the subscription is disposed", () => {
      const seen = [];
      onDidChangeAccentColor((accentColor) => seen.push(accentColor)).dispose();

      systemPreferences.emit("accent-color-changed", {}, "0078D4FF");
      assert.lengthOf(seen, 0);
    });
  });
});
