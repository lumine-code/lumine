const path = require("path");

describe("nova-theme", () => {
  afterEach(async () => {
    await atom.packages.deactivatePackage("nova-day-ui");
    await atom.packages.deactivatePackage("nova-day-syntax");
    await atom.packages.deactivatePackage("nova-theme");
  });

  it("selects its theme pairs with the select command", async () => {
    await atom.packages.activatePackage("nova-theme");

    atom.commands.dispatch(atom.views.getView(atom.workspace), "nova-theme:select");

    expect(atom.config.get("theme.light")).toEqual(["nova-day-ui", "nova-day-syntax"]);
    expect(atom.config.get("theme.dark")).toEqual(["nova-night-ui", "nova-night-syntax"]);
  });

  it("inherits unchanged One styles and keeps its own overrides", async () => {
    await atom.packages.activatePackage("nova-theme");

    const uiPaths = atom.packages.getLoadedPackage("nova-day-ui").getStylesheetPaths();
    const syntaxPaths = atom.packages.getLoadedPackage("nova-day-syntax").getStylesheetPaths();
    const uiPathByName = new Map(uiPaths.map((stylePath) => [path.basename(stylePath), stylePath]));
    const syntaxPathByName = new Map(
      syntaxPaths.map((stylePath) => [path.basename(stylePath), stylePath]),
    );

    expect(uiPathByName.get("02-badges.css")).toContain("one-theme");
    expect(uiPathByName.get("03-buttons.css")).toContain("one-theme");
    expect(uiPathByName.get("overrides.css")).toContain("nova-theme");
    expect(uiPathByName.has("26-config.css")).toBe(false);
    expect(syntaxPathByName.get("syntax.atom-text-editor.css")).toContain("one-theme");
    expect(syntaxPathByName.get("variables.css")).toContain("nova-theme");
    expect(syntaxPathByName.get("overrides.css")).toContain("nova-theme");

    expect(uiPaths.indexOf(uiPathByName.get("03-buttons.css"))).toBeLessThan(
      uiPaths.indexOf(uiPathByName.get("overrides.css")),
    );
    expect(syntaxPaths.indexOf(syntaxPathByName.get("syntax.atom-text-editor.css"))).toBeLessThan(
      syntaxPaths.indexOf(syntaxPathByName.get("overrides.css")),
    );

    await atom.packages.activatePackage("nova-day-ui");
    await atom.packages.activatePackage("nova-day-syntax");
    expect(atom.themes.stylesheetElementForId(uiPathByName.get("03-buttons.css"))).not.toBeNull();
    expect(atom.themes.stylesheetElementForId(uiPathByName.get("overrides.css"))).not.toBeNull();
  });
});
