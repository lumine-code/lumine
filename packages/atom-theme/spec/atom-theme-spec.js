const path = require("path");

describe("atom-theme", () => {
  afterEach(async () => {
    await atom.packages.deactivatePackage("atom-day-ui");
    await atom.packages.deactivatePackage("atom-day-syntax");
    await atom.packages.deactivatePackage("atom-theme");
  });

  it("registers its light and dark themes as a pack", async () => {
    await atom.packages.activatePackage("atom-theme");

    const themePack = atom.themes.getThemePacks().find(({ name }) => name === "Atom");

    expect(themePack.light).toEqual(["atom-day-ui", "atom-day-syntax"]);
    expect(themePack.dark).toEqual(["atom-night-ui", "atom-night-syntax"]);
  });

  it("loads a self-contained style layer, palette last", async () => {
    await atom.packages.activatePackage("atom-theme");

    const uiPaths = atom.packages.getLoadedPackage("atom-day-ui").getStylesheetPaths();
    const syntaxPaths = atom.packages.getLoadedPackage("atom-day-syntax").getStylesheetPaths();

    // Nothing is inherited from another theme package.
    for (const stylePath of [...uiPaths, ...syntaxPaths]) {
      expect(stylePath).toContain(`${path.sep}atom-theme${path.sep}`);
    }

    const uiNames = uiPaths.map((stylePath) => path.basename(stylePath));
    expect(uiNames).toContain("15-tabs.css");
    expect(uiNames.indexOf("15-tabs.css")).toBeLessThan(uiNames.indexOf("variables.css"));

    const syntaxNames = syntaxPaths.map((stylePath) => path.basename(stylePath));
    expect(syntaxNames).toContain("syntax.atom-text-editor.css");
    expect(syntaxNames).toContain("variables.css");
  });

  it("applies its stylesheets once the themes activate", async () => {
    await atom.packages.activatePackage("atom-theme");
    await atom.packages.activatePackage("atom-day-ui");
    await atom.packages.activatePackage("atom-day-syntax");

    const tabsPath = atom.packages
      .getLoadedPackage("atom-day-ui")
      .getStylesheetPaths()
      .find((stylePath) => path.basename(stylePath) === "15-tabs.css");

    expect(atom.themes.stylesheetElementForId(tabsPath)).not.toBeNull();
  });
});
