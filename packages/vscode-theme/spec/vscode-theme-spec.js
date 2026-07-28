const path = require("path");

describe("vscode-theme", () => {
  afterEach(async () => {
    await atom.packages.deactivatePackage("vscode-day-ui");
    await atom.packages.deactivatePackage("vscode-day-syntax");
    await atom.packages.deactivatePackage("vscode-theme");
  });

  it("registers its light and dark themes as a pack", async () => {
    await atom.packages.activatePackage("vscode-theme");

    const themePack = atom.themes.getThemePacks().find(({ name }) => name === "VS Code Modern");

    expect(themePack.light).toEqual(["vscode-day-ui", "vscode-day-syntax"]);
    expect(themePack.dark).toEqual(["vscode-night-ui", "vscode-night-syntax"]);
  });

  it("inherits unchanged One styles and keeps its own overrides", async () => {
    await atom.packages.activatePackage("vscode-theme");

    const uiPaths = atom.packages.getLoadedPackage("vscode-day-ui").getStylesheetPaths();
    const syntaxPaths = atom.packages.getLoadedPackage("vscode-day-syntax").getStylesheetPaths();
    const uiPathByName = new Map(uiPaths.map((stylePath) => [path.basename(stylePath), stylePath]));
    const syntaxPathByName = new Map(
      syntaxPaths.map((stylePath) => [path.basename(stylePath), stylePath]),
    );

    expect(uiPathByName.get("02-badges.css")).toContain("one-theme");
    expect(uiPathByName.get("03-buttons.css")).toContain("one-theme");
    expect(uiPathByName.get("overrides.css")).toContain("vscode-theme");
    expect(uiPathByName.has("26-config.css")).toBe(false);
    expect(syntaxPathByName.get("syntax.atom-text-editor.css")).toContain("one-theme");
    expect(syntaxPathByName.get("variables.css")).toContain("vscode-theme");
    expect(syntaxPathByName.get("overrides.css")).toContain("vscode-theme");

    expect(uiPaths.indexOf(uiPathByName.get("03-buttons.css"))).toBeLessThan(
      uiPaths.indexOf(uiPathByName.get("overrides.css")),
    );
    expect(syntaxPaths.indexOf(syntaxPathByName.get("syntax.atom-text-editor.css"))).toBeLessThan(
      syntaxPaths.indexOf(syntaxPathByName.get("overrides.css")),
    );

    await atom.packages.activatePackage("vscode-day-ui");
    await atom.packages.activatePackage("vscode-day-syntax");
    expect(atom.themes.stylesheetElementForId(uiPathByName.get("03-buttons.css"))).not.toBeNull();
    expect(atom.themes.stylesheetElementForId(uiPathByName.get("overrides.css"))).not.toBeNull();
  });
});
