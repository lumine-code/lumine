const path = require("path");

describe("aura-theme", () => {
  afterEach(async () => {
    await atom.packages.deactivatePackage("aura-day-ui");
    await atom.packages.deactivatePackage("aura-day-syntax");
    await atom.packages.deactivatePackage("aura-night-ui");
    await atom.packages.deactivatePackage("aura-night-syntax");
    await atom.packages.deactivatePackage("aura-theme");
  });

  it("registers its light and dark themes as a pack", async () => {
    await atom.packages.activatePackage("aura-theme");

    const themePack = atom.themes.getThemePacks().find(({ name }) => name === "Aura");

    expect(themePack.light).toEqual(["aura-day-ui", "aura-day-syntax"]);
    expect(themePack.dark).toEqual(["aura-night-ui", "aura-night-syntax"]);
  });

  it("loads One first and keeps only Aura overrides locally", async () => {
    await atom.packages.activatePackage("aura-theme");

    const uiPaths = atom.packages.getLoadedPackage("aura-day-ui").getStylesheetPaths();
    const syntaxPaths = atom.packages.getLoadedPackage("aura-day-syntax").getStylesheetPaths();
    const oneUiPath = uiPaths.find(
      (stylePath) =>
        stylePath.includes("one-theme") && path.basename(stylePath) === "03-buttons.css",
    );
    const oneUiPalette = uiPaths.find(
      (stylePath) =>
        stylePath.includes("one-theme") &&
        stylePath.includes(`${path.sep}day-ui${path.sep}`) &&
        path.basename(stylePath) === "variables.css",
    );
    const auraUiOverride = uiPaths.find(
      (stylePath) =>
        stylePath.includes("aura-theme") && path.basename(stylePath) === "overrides.css",
    );
    const auraUiPalette = uiPaths.find(
      (stylePath) =>
        stylePath.includes("aura-theme") &&
        stylePath.includes(`${path.sep}day-ui${path.sep}`) &&
        path.basename(stylePath) === "variables.css",
    );

    expect(oneUiPath).toBeDefined();
    expect(oneUiPalette).toBeDefined();
    expect(auraUiOverride).toBeDefined();
    expect(auraUiPalette).toBeDefined();
    expect(uiPaths.indexOf(oneUiPath)).toBeLessThan(uiPaths.indexOf(auraUiOverride));
    expect(uiPaths.indexOf(oneUiPalette)).toBeLessThan(uiPaths.indexOf(auraUiPalette));
    expect(uiPaths.some((stylePath) => path.basename(stylePath) === "26-config.css")).toBe(false);
    expect(
      syntaxPaths.some(
        (stylePath) =>
          stylePath.includes("one-theme") &&
          path.basename(stylePath) === "syntax.atom-text-editor.css",
      ),
    ).toBe(true);

    await atom.packages.activatePackage("aura-day-ui");
    await atom.packages.activatePackage("aura-day-syntax");
    expect(atom.themes.stylesheetElementForId(auraUiOverride)).not.toBeNull();
    expect(atom.themes.stylesheetElementForId(auraUiPalette)).not.toBeNull();

    const rootStyle = getComputedStyle(document.documentElement);
    expect(rootStyle.getPropertyValue("--app-background-color").trim()).toBe("#f2f2f2");
    expect(rootStyle.getPropertyValue("--tool-panel-background-color").trim()).toBe("#f2f2f2");
    expect(rootStyle.getPropertyValue("--base-border-color").trim()).toBe("hsl(228, 12%, 88%)");
    expect(rootStyle.getPropertyValue("--accent-color").trim()).toBe("#5a8ae9");
    expect(rootStyle.getPropertyValue("--syntax-background-color").trim()).toBe("hsl(0, 0%, 100%)");
    expect(rootStyle.getPropertyValue("--component-border-radius").trim()).toBe("6px");

    const gitList = document.createElement("div");
    gitList.className = "git-panel-FilePatchListView";
    const gitListItem = document.createElement("div");
    gitListItem.className = "git-panel-FilePatchListView-item is-selected";
    gitList.appendChild(gitListItem);
    document.body.appendChild(gitList);

    expect(getComputedStyle(gitListItem).borderRadius).toBe("6px");
    gitList.remove();

    const recentCommits = document.createElement("ul");
    recentCommits.className = "git-panel-RecentCommits-list";
    const recentCommit = document.createElement("li");
    recentCommit.className = "git-panel-RecentCommit most-recent is-selected";
    recentCommits.appendChild(recentCommit);
    document.body.appendChild(recentCommits);

    expect(getComputedStyle(recentCommit).borderRadius).toBe("6px");
    recentCommits.remove();

    const dock = document.createElement("atom-dock");
    const dockTabBar = document.createElement("ul");
    dockTabBar.className = "tab-bar";
    const dockTab = document.createElement("li");
    dockTab.className = "tab active";
    dockTabBar.appendChild(dockTab);
    dock.appendChild(dockTabBar);
    document.body.appendChild(dock);

    const dockTabStyle = getComputedStyle(dockTab);
    expect(dockTabStyle.flexGrow).toBe("1");
    expect(dockTabStyle.flexShrink).toBe("1");
    expect(dockTabStyle.maxWidth).toBe("none");
    dock.remove();
  });

  it("uses the deeper Aura surfaces in its night pair", async () => {
    await atom.packages.activatePackage("aura-theme");
    await atom.packages.activatePackage("aura-night-ui");
    await atom.packages.activatePackage("aura-night-syntax");

    const rootStyle = getComputedStyle(document.documentElement);
    expect(rootStyle.getPropertyValue("--app-background-color").trim()).toBe("hsl(228, 22%, 6%)");
    expect(rootStyle.getPropertyValue("--base-border-color").trim()).toBe("hsl(228, 22%, 4%)");
    expect(rootStyle.getPropertyValue("--syntax-background-color").trim()).toBe(
      "hsl(228, 20%, 10%)",
    );
    expect(rootStyle.getPropertyValue("--accent-color").trim()).toBe("#5a8ae9");
  });
});
