const ACCENT_SOURCE_PATH = "lumine://accent-color";

function accentStyleElement() {
  return lumine.styles
    .getStyleElements()
    .find((element) => element.sourcePath === ACCENT_SOURCE_PATH);
}

// The renderer half of the system accent color: what `theme.accentSource` does
// to the theme variable contract. The main-process half — reading the color out
// of the operating system and normalizing it — is covered by
// spec/main-process/accent-color.test.js.
describe("the system accent color", () => {
  beforeEach(() => {
    // Nothing here should reach the main process; every test decides for itself
    // what the platform reports.
    spyOn(lumine.themes.applicationDelegate, "invokeApp").and.returnValue(Promise.resolve(null));
    lumine.themes.systemAccentColor = null;
  });

  afterEach(() => {
    lumine.config.set("theme.accentSource", "theme");
    lumine.themes.systemAccentColor = null;
    lumine.themes.applyAccentColor();
  });

  describe("when the accent source is the theme", () => {
    it("adds no stylesheet, even with a color available", () => {
      lumine.config.set("theme.accentSource", "theme");
      lumine.themes.systemAccentColor = "#0078d4";
      lumine.themes.applyAccentColor();

      expect(accentStyleElement()).toBeUndefined();
    });

    it("never asks the main process for a color", async () => {
      lumine.config.set("theme.accentSource", "theme");
      await lumine.themes.refreshSystemAccentColor();

      expect(lumine.themes.applicationDelegate.invokeApp).not.toHaveBeenCalled();
    });
  });

  describe("when the accent source is the system", () => {
    beforeEach(() => {
      lumine.config.set("theme.accentSource", "system");
    });

    it("overrides the fills and derives the text colors from them", () => {
      lumine.themes.systemAccentColor = "#0078d4";
      lumine.themes.applyAccentColor();

      const element = accentStyleElement();
      expect(element).not.toBeUndefined();
      expect(element.textContent).toContain("--accent-color: #0078d4;");
      expect(element.textContent).toContain("--accent-bg-color: #0078d4;");
      expect(element.textContent).toContain("--accent-text-color: lch(from var(--accent-color)");
      expect(element.textContent).toContain(
        "--accent-bg-text-color: lch(from var(--accent-bg-color)",
      );
    });

    // The theme has already tuned this one against its own background, where an
    // arbitrary system color can fail contrast outright.
    it("leaves the accent-as-text color to the theme", () => {
      lumine.themes.systemAccentColor = "#0078d4";
      lumine.themes.applyAccentColor();

      expect(accentStyleElement().textContent).not.toContain("--accent-only-text-color");
    });

    // Above every theme stylesheet (0), still below the user stylesheet (2), so
    // a user's own `--accent-color` keeps winning.
    it("sits between the themes and the user stylesheet", () => {
      lumine.themes.systemAccentColor = "#0078d4";
      lumine.themes.applyAccentColor();

      expect(accentStyleElement().priority).toBe(1);
    });

    it("reuses the same style element when the color changes", () => {
      lumine.themes.systemAccentColor = "#0078d4";
      lumine.themes.applyAccentColor();
      const first = accentStyleElement();

      lumine.themes.systemAccentColor = "#3a3a3a";
      lumine.themes.applyAccentColor();

      expect(accentStyleElement()).toBe(first);
      expect(first.textContent).toContain("--accent-color: #3a3a3a;");
    });

    it("adds nothing when the platform reports no accent color", () => {
      lumine.themes.systemAccentColor = null;
      lumine.themes.applyAccentColor();

      expect(accentStyleElement()).toBeUndefined();
    });

    // The value is normalized in the main process, so anything else here did
    // not come from there and must never reach a stylesheet.
    it("refuses a value that is not a normalized color", () => {
      for (const value of ["red", "#0078d4; } body { display: none", "0078d4", 123]) {
        lumine.themes.systemAccentColor = value;
        lumine.themes.applyAccentColor();
        expect(accentStyleElement()).toBeUndefined();
      }
    });

    it("drops the stylesheet again when the source goes back to the theme", () => {
      lumine.themes.systemAccentColor = "#0078d4";
      lumine.themes.applyAccentColor();
      expect(accentStyleElement()).not.toBeUndefined();

      lumine.config.set("theme.accentSource", "theme");
      lumine.themes.applyAccentColor();

      expect(accentStyleElement()).toBeUndefined();
    });

    it("reads the starting color from the main process", async () => {
      lumine.themes.applicationDelegate.invokeApp.and.returnValue(Promise.resolve("#0078d4"));

      await lumine.themes.refreshSystemAccentColor();

      expect(lumine.themes.applicationDelegate.invokeApp).toHaveBeenCalledWith("getAccentColor");
      expect(accentStyleElement().textContent).toContain("--accent-color: #0078d4;");
    });

    it("keeps the theme's accent when the main process cannot answer", async () => {
      spyOn(console, "warn");
      lumine.themes.applicationDelegate.invokeApp.and.returnValue(
        Promise.reject(new Error("no accent color here")),
      );

      await lumine.themes.refreshSystemAccentColor();

      expect(accentStyleElement()).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });
  });
});
