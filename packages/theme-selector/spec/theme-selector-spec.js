describe("theme-selector", () => {
  let selector;

  beforeEach(async () => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    atom.config.set("theme.mode", "light");
    atom.config.set("theme.light", ["one-day-ui", "one-day-syntax"]);
    atom.config.set("theme.dark", ["one-night-ui", "one-night-syntax"]);

    await atom.packages.activatePackage("one-theme");
    await atom.packages.activatePackage("aura-theme");
    await atom.packages.activatePackage("nova-theme");
    await atom.packages.activatePackage("vscode-theme");
    const pack = await atom.packages.activatePackage("theme-selector");
    selector = pack.mainModule.getSelector();
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("theme-selector");
    await atom.packages.deactivatePackage("vscode-theme");
    await atom.packages.deactivatePackage("nova-theme");
    await atom.packages.deactivatePackage("aura-theme");
    await atom.packages.deactivatePackage("one-theme");
  });

  it("lists registered packs and marks the configured pack as active", async () => {
    await selector.show();

    expect(selector.selectList.items.map(({ name }) => name)).toEqual([
      "One",
      "Aura",
      "Nova",
      "VS Code Modern",
    ]);
    const activeItem = selector.selectList.element.querySelector("li.active");
    expect(activeItem.textContent).toContain("One");
    const status = activeItem.querySelector(".primary-line > .theme-pack-status.icon.icon-check");
    const title = activeItem.querySelector(".primary-line > .theme-pack-title");
    expect(status).not.toBeNull();
    expect(title.textContent).toBe("One");
    expect(status.offsetTop).toBe(title.offsetTop);
    expect(getComputedStyle(status).visibility).toBe("visible");
    expect(activeItem.querySelector(".secondary-line.no-icon")).not.toBeNull();
    expect(
      getComputedStyle(
        selector.selectList.element.querySelector("li:not(.active) .theme-pack-status"),
      ).visibility,
    ).toBe("hidden");
  });

  it("previews packs while navigating and restores config when cancelled", async () => {
    await selector.show();
    const nova = atom.themes.getThemePacks().find(({ name }) => name === "Nova");

    await selector.selectList.selectItem(nova);
    expect(atom.config.get("theme.light")).toEqual(["nova-day-ui", "nova-day-syntax"]);
    expect(atom.config.get("theme.dark")).toEqual(["nova-night-ui", "nova-night-syntax"]);

    selector.selectList.cancelSelection();
    expect(atom.config.get("theme.light")).toEqual(["one-day-ui", "one-day-syntax"]);
    expect(atom.config.get("theme.dark")).toEqual(["one-night-ui", "one-night-syntax"]);
  });

  it("keeps the previewed pack when confirmed", async () => {
    await selector.show();
    const vscode = atom.themes.getThemePacks().find(({ name }) => name === "VS Code Modern");

    selector.selectList.props.didChangeSelection(vscode);
    selector.selectList.props.didConfirmSelection(vscode);

    expect(atom.config.get("theme.light")).toEqual(["vscode-day-ui", "vscode-day-syntax"]);
    expect(atom.config.get("theme.dark")).toEqual(["vscode-night-ui", "vscode-night-syntax"]);
    expect(selector.selectList.isVisible()).toBe(false);
  });

  it("keeps the selected mode when cancelled", async () => {
    await selector.show();
    const nova = atom.themes.getThemePacks().find(({ name }) => name === "Nova");

    await selector.selectList.selectItem(nova);
    atom.commands.dispatch(selector.selectList.element, "theme-selector:use-dark-mode");

    selector.selectList.cancelSelection();
    expect(atom.config.get("theme.mode")).toBe("dark");
    expect(atom.config.get("theme.light")).toEqual(["one-day-ui", "one-day-syntax"]);
    expect(atom.config.get("theme.dark")).toEqual(["one-night-ui", "one-night-syntax"]);
  });

  it("selects system, light, and dark modes with selector commands", async () => {
    await selector.show();

    const commandFor = (keystrokes) =>
      atom.keymaps.findKeyBindings({
        keystrokes,
        target: selector.selectList.element,
      })[0]?.command;
    expect(commandFor("ctrl-1")).toBe("theme-selector:use-system-mode");
    expect(commandFor("ctrl-2")).toBe("theme-selector:use-light-mode");
    expect(commandFor("ctrl-3")).toBe("theme-selector:use-dark-mode");

    atom.commands.dispatch(selector.selectList.element, "theme-selector:use-dark-mode");
    expect(atom.config.get("theme.mode")).toBe("dark");

    atom.commands.dispatch(selector.selectList.element, "theme-selector:use-light-mode");
    expect(atom.config.get("theme.mode")).toBe("light");

    atom.commands.dispatch(selector.selectList.element, "theme-selector:use-system-mode");
    expect(atom.config.get("theme.mode")).toBe("system");

    selector.selectList.cancelSelection();
    expect(atom.config.get("theme.mode")).toBe("system");
  });
});
