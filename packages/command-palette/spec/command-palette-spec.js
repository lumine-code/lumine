const {
  activeSession,
  modalElement,
  isModalOpen,
  confirmItem,
  setQuery,
  settle,
} = require("../../../spec/helpers/modal-helpers");

describe("command-palette", () => {
  let workspaceElement, mainModule, palette, commandDisposables;

  beforeEach(async () => {
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);
    commandDisposables = [];
    commandDisposables.push(
      atom.commands.add("atom-workspace", "command-palette-spec:noop", {
        didDispatch() {},
      }),
      atom.commands.add("atom-workspace", "command-palette-spec:hidden", {
        didDispatch() {},
        hiddenInCommandPalette: true,
      }),
    );
    // The package defers activation until one of its commands is dispatched,
    // so trigger it with the side-effect-free clear-recent command.
    const activation = atom.packages.activatePackage("command-palette");
    atom.commands.dispatch(workspaceElement, "command-palette:clear-recent");
    const pack = await activation;
    mainModule = pack.mainModule;
    palette = mainModule.list;
  });

  afterEach(() => {
    palette?.hide();
    for (const disposable of commandDisposables) disposable.dispose();
  });

  async function openPalette(command = "command-palette:toggle") {
    atom.commands.dispatch(workspaceElement, command);
    await settle();
    return activeSession();
  }

  function listedCommandNames() {
    const items = modalElement().querySelectorAll("li[data-event-name]");
    return Array.from(items, (li) => li.dataset.eventName);
  }

  describe("command-palette:toggle", () => {
    it("shows the palette with the commands available for the focused element", async () => {
      await openPalette();
      expect(isModalOpen()).toBe(true);

      const names = listedCommandNames();
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain("command-palette-spec:noop");

      const visibleCommands = atom.commands
        .findCommands({ target: palette.activeElement })
        .filter((command) => !command.hiddenInCommandPalette);
      expect(names.length).toBe(visibleCommands.length);
    });

    it("hides the palette when it is already visible", async () => {
      await openPalette();
      expect(isModalOpen()).toBe(true);
      atom.commands.dispatch(workspaceElement, "command-palette:toggle");
      expect(isModalOpen()).toBe(false);
    });

    it("shows the keybindings bound to the listed commands", async () => {
      await openPalette();
      const toggleItem = modalElement().querySelector(
        "li[data-event-name='command-palette:toggle']",
      );
      expect(toggleItem).not.toBeNull();
      const binding = atom.keymaps
        .findKeyBindings({ target: workspaceElement })
        .find((keyBinding) => keyBinding.command === "command-palette:toggle");
      if (binding) {
        expect(toggleItem.querySelector("kbd.key-binding")).not.toBeNull();
      }
    });
  });

  describe("command-palette:show-hidden-commands", () => {
    it("lists only the commands hidden from the palette", async () => {
      await openPalette("command-palette:show-hidden-commands");
      const names = listedCommandNames();
      expect(names).toContain("command-palette-spec:hidden");
      expect(names).not.toContain("command-palette-spec:noop");
    });

    it("recomputes the list when toggling between hidden and visible commands", async () => {
      await openPalette();
      expect(listedCommandNames()).toContain("command-palette-spec:noop");
      palette.hide();

      await openPalette("command-palette:show-hidden-commands");
      expect(listedCommandNames()).toContain("command-palette-spec:hidden");
      palette.hide();

      await openPalette();
      const names = listedCommandNames();
      expect(names).toContain("command-palette-spec:noop");
      expect(names).not.toContain("command-palette-spec:hidden");
    });
  });

  describe("recently used commands", () => {
    it("records confirmed commands and serializes them", async () => {
      await openPalette();
      const item = palette.commands.find((command) => command.name === "command-palette-spec:noop");
      expect(item).toBeDefined();
      await confirmItem((command) => command === item);

      expect(palette.recentlyUsed[0]).toBe("command-palette-spec:noop");
      expect(mainModule.serialize()).toEqual({ recentlyUsed: ["command-palette-spec:noop"] });
    });

    it("dispatches the confirmed command on the previously focused element", async () => {
      let dispatched = false;
      commandDisposables.push(
        atom.commands.add("atom-workspace", "command-palette-spec:confirm-me", {
          didDispatch() {
            dispatched = true;
          },
        }),
      );
      await openPalette();
      const item = palette.commands.find(
        (command) => command.name === "command-palette-spec:confirm-me",
      );
      expect(item).toBeDefined();
      await confirmItem((command) => command === item);
      expect(dispatched).toBe(true);
    });

    it("caps the list at the configured recent count", async () => {
      atom.config.set("command-palette.recentCount", 2);
      for (const name of ["a", "b", "c"]) {
        commandDisposables.push(
          atom.commands.add("atom-workspace", `command-palette-spec:${name}`, {
            didDispatch() {},
          }),
        );
      }
      for (const name of ["a", "b", "c"]) {
        await openPalette();
        await confirmItem((command) => command.name === `command-palette-spec:${name}`);
      }
      expect(palette.recentlyUsed).toEqual(["command-palette-spec:c", "command-palette-spec:b"]);
    });

    it("marks recent commands in the rendered list", async () => {
      await openPalette();
      const item = palette.commands.find((command) => command.name === "command-palette-spec:noop");
      await confirmItem((command) => command === item);

      await openPalette();
      const li = modalElement().querySelector("li[data-event-name='command-palette-spec:noop']");
      expect(li.classList.contains("recent")).toBe(true);
      expect(listedCommandNames()[0]).toBe("command-palette-spec:noop");
    });

    it("clears the list with command-palette:clear-recent", async () => {
      await openPalette();
      const item = palette.commands.find((command) => command.name === "command-palette-spec:noop");
      await confirmItem((command) => command === item);
      expect(palette.recentlyUsed.length).toBe(1);

      atom.commands.dispatch(workspaceElement, "command-palette:clear-recent");
      expect(palette.recentlyUsed).toEqual([]);
    });

    it("restores recently used commands from serialized state", async () => {
      const CommandPalette = require("../lib/list");
      const restored = new CommandPalette(["command-palette-spec:noop"]);
      expect(restored.recentlyUsed).toEqual(["command-palette-spec:noop"]);
      await restored.destroy();
    });
  });

  describe("query handling", () => {
    it("resets the query on reopen by default", async () => {
      await openPalette();
      setQuery("noop");
      await settle();
      palette.hide();
      await settle();
      await openPalette();
      expect(activeSession().getQuery().raw).toBe("");
    });

    it("preserves the query when preserveQuery is enabled", async () => {
      atom.config.set("command-palette.preserveQuery", true);
      await openPalette();
      setQuery("noop");
      await settle();
      palette.hide();
      await settle();
      await openPalette();
      expect(activeSession().getQuery().raw).toBe("noop");
    });

    it("matches spaced display names when the query uses hyphens", async () => {
      await openPalette();
      setQuery("palette-spec-noop");
      await settle();
      expect(listedCommandNames()).toEqual(["command-palette-spec:noop"]);
    });
  });
});
