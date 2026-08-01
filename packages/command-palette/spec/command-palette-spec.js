describe("command-palette", () => {
  let workspaceElement, mainModule, palette, commandDisposables;

  beforeEach(async () => {
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);
    commandDisposables = [];
    commandDisposables.push(
      atom.commands.add("atom-workspace", "command-palette-spec:noop", {
        description: "A command with a description",
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
    await atom.views.getNextUpdatePromise();
    return palette.selectListView;
  }

  function listedCommandNames() {
    const items = palette.selectListView.element.querySelectorAll("li[data-event-name]");
    return Array.from(items, (li) => li.dataset.eventName);
  }

  describe("command-palette:toggle", () => {
    it("shows the palette with the commands available for the focused element", async () => {
      const selectListView = await openPalette();
      expect(selectListView.isVisible()).toBe(true);

      const names = listedCommandNames();
      expect(names.length).toBeGreaterThan(0);

      const visibleCommands = atom.commands
        .findCommands({ target: palette.activeElement })
        .filter((command) => !command.hiddenInCommandPalette);
      // Every available command is in the list; the view renders them in
      // 99-row batches behind the library's Show more row.
      expect(selectListView.props.items.length).toBe(visibleCommands.length);
      expect(
        selectListView.props.items.some((command) => command.name === "command-palette-spec:noop"),
      ).toBe(true);
      expect(names.length).toBe(Math.min(visibleCommands.length, 99));
      if (visibleCommands.length > 99) {
        expect(selectListView.element.querySelector(".show-more-item")).not.toBeNull();
      }
    });

    it("hides the palette when it is already visible", async () => {
      const selectListView = await openPalette();
      expect(selectListView.isVisible()).toBe(true);
      atom.commands.dispatch(workspaceElement, "command-palette:toggle");
      expect(selectListView.isVisible()).toBe(false);
    });

    it("shows the keybindings bound to the listed commands", async () => {
      await openPalette();
      const toggleItem = palette.selectListView.element.querySelector(
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

    it("renders command descriptions when the query has no match indices", async () => {
      await openPalette();
      const item = palette.selectListView.element.querySelector(
        "li[data-event-name='command-palette-spec:noop']",
      );

      expect(item.querySelector(".secondary-line").textContent).toBe(
        "A command with a description",
      );
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
      palette.selectListView.props.didConfirmSelection(item);

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
      // Focus a fresh element so the cached command list is recomputed.
      palette.lastActiveElement = null;
      await openPalette();
      const item = palette.commands.find(
        (command) => command.name === "command-palette-spec:confirm-me",
      );
      expect(item).toBeDefined();
      palette.selectListView.props.didConfirmSelection(item);
      expect(dispatched).toBe(true);
    });

    it("caps the list at the configured recent count", async () => {
      atom.config.set("command-palette.recentCount", 2);
      await openPalette();
      for (const name of ["a", "b", "c"]) {
        palette.selectListView.props.didConfirmSelection({ name: `command-palette-spec:${name}` });
      }
      expect(palette.recentlyUsed).toEqual(["command-palette-spec:c", "command-palette-spec:b"]);
    });

    it("separates recent commands from the rest of the rendered list", async () => {
      await openPalette();
      const item = palette.commands.find((command) => command.name === "command-palette-spec:noop");
      palette.selectListView.props.didConfirmSelection(item);

      const selectListView = await openPalette();
      const separator = selectListView.element.querySelector(".select-list-separator");
      expect(separator.previousElementSibling.dataset.eventName).toBe("command-palette-spec:noop");
      expect(separator.nextElementSibling.dataset.eventName).toBeTruthy();
      expect(listedCommandNames()[0]).toBe("command-palette-spec:noop");

      selectListView.refs.queryEditor.setText("noop");
      await atom.views.getNextUpdatePromise();
      expect(selectListView.element.querySelector(".select-list-separator")).toBeNull();
    });

    it("clears the list with command-palette:clear-recent", async () => {
      await openPalette();
      const item = palette.commands.find((command) => command.name === "command-palette-spec:noop");
      palette.selectListView.props.didConfirmSelection(item);
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
      const selectListView = await openPalette();
      selectListView.refs.queryEditor.setText("noop");
      palette.hide();
      // The query is reset synchronously by the willShow hook.
      palette.show();
      expect(selectListView.getQuery()).toBe("");
    });

    it("preserves the query when preserveQuery is enabled", async () => {
      atom.config.set("command-palette.preserveQuery", true);
      const selectListView = await openPalette();
      selectListView.refs.queryEditor.setText("noop");
      palette.hide();
      palette.show();
      expect(selectListView.getQuery()).toBe("noop");
    });

    it("matches spaced display names when the query uses hyphens", async () => {
      const selectListView = await openPalette();
      selectListView.refs.queryEditor.setText("palette-spec-noop");
      await atom.views.getNextUpdatePromise();
      expect(listedCommandNames()).toEqual(["command-palette-spec:noop"]);
    });
  });

  describe("item actions", () => {
    it("derives its actions from the command registration", () => {
      const actions = palette.selectListView.itemActions();
      const byCommand = new Map(actions.map((action) => [action.command, action]));

      const toggleHidden = byCommand.get("command-palette:toggle-hidden-commands");
      expect(toggleHidden.name).toBe("Toggle Hidden Commands");
      expect(toggleHidden.description).toBe(
        "Include the commands hidden from the palette by their packages",
      );
      expect(toggleHidden.keystrokes).toEqual([]);

      // Every action explains itself with more than a restated title.
      for (const action of actions) {
        expect(action.description).toBeTruthy();
      }

      // Chrome and workspace-scope commands stay out: the actions list shows
      // only what the dialog contributes itself.
      expect(byCommand.has("core:confirm")).toBe(false);
      expect(byCommand.has("select-list:actions")).toBe(false);
      expect(byCommand.has("command-palette:toggle")).toBe(false);
      expect(byCommand.has("command-palette:show-hidden-commands")).toBe(false);
      expect(byCommand.has("command-palette:clear-recent")).toBe(false);
    });

    it("shows the actions as a flow step and toggles the hidden commands", async () => {
      await openPalette();
      expect(listedCommandNames()).toContain("command-palette-spec:noop");

      await palette.selectListView.showItemActions();

      const actionsList = palette.selectListView.itemActionsList;
      expect(actionsList.isVisible()).toBe(true);
      expect(atom.workspace.getModalTrail()).toEqual(["Commands", "Actions"]);
      // The actions list wears the package class, so its styling applies there.
      expect(actionsList.element.classList.contains("command-palette")).toBe(true);

      const index = actionsList.items.findIndex(
        (item) => item.command === "command-palette:toggle-hidden-commands",
      );
      actionsList.selectIndex(index);
      actionsList.confirmSelection();

      expect(palette.selectListView.isVisible()).toBe(true);
      expect(actionsList.isVisible()).toBe(false);
      expect(palette.showHiddenCommands).toBe(true);
      await atom.views.getNextUpdatePromise();
      const names = listedCommandNames();
      expect(names).toContain("command-palette-spec:hidden");
      expect(names).not.toContain("command-palette-spec:noop");
    });

    it("toggles back to the visible commands on a second dispatch", async () => {
      const selectListView = await openPalette();
      const queryElement = selectListView.refs.queryEditor.element;

      atom.commands.dispatch(queryElement, "command-palette:toggle-hidden-commands");
      await atom.views.getNextUpdatePromise();
      expect(listedCommandNames()).toContain("command-palette-spec:hidden");

      atom.commands.dispatch(queryElement, "command-palette:toggle-hidden-commands");
      await atom.views.getNextUpdatePromise();
      const names = listedCommandNames();
      expect(names).toContain("command-palette-spec:noop");
      expect(names).not.toContain("command-palette-spec:hidden");
    });
  });
});
