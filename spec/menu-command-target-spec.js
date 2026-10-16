const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const ContextViewManager = require("../src/context-view-manager");
const ContextMenuManager = require("../src/context-menu-manager");
const MenuBarView = require("../src/menu-bar-view");
const { showMenuPopup } = require("../src/menu-view");

describe("application menu command targets", () => {
  let contextViews, menuBar, container, subscriptions, emitter;

  beforeEach(() => {
    contextViews = new ContextViewManager({ document, window });
    subscriptions = new CompositeDisposable();
    emitter = new Emitter();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    menuBar?.destroy();
    contextViews.destroy();
    subscriptions.dispose();
    emitter.dispose();
    container.remove();
  });

  function createMenu(item) {
    menuBar = new MenuBarView({
      getTemplate: () => [{ label: "Actions", submenu: [item] }],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    });
    container.append(menuBar.element);
    return menuBar;
  }

  it("keeps workspace commands available when the body had focus", async () => {
    let workspace = document.querySelector("lumine-workspace");
    if (!workspace) {
      // A non-HTML namespace avoids constructing another editor workspace.
      workspace = document.createElementNS("urn:menu-command-target-spec", "lumine-workspace");
      container.append(workspace);
    }
    const handler = jasmine.createSpy("workspace handler");
    subscriptions.add(lumine.commands.add(workspace, "menu-command-target:workspace", handler));
    createMenu({ label: "Workspace Action", command: "menu-command-target:workspace" });
    const input = document.createElement("button");
    container.append(input);
    input.focus();
    input.blur();
    expect(document.activeElement).toBe(document.body);

    menuBar.openButton(menuBar.buttons[0], { selectFirst: true });
    const item = menuBar.popup.rootList.items[0];
    expect(item.enabled).toBe(true);
    expect(item.commandTarget).toBe(workspace);
    item.activate();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.calls.mostRecent().args[0].target).toBe(workspace);
  });

  it("uses the saved focus for an explicit focus row after the menu button takes focus", async () => {
    const editor = document.createElement("button");
    editor.className = "menu-command-target-editor";
    container.append(editor);
    const handler = jasmine.createSpy("editor handler");
    subscriptions.add(
      lumine.commands.add(".menu-command-target-editor", "menu-command-target:editor", handler),
    );
    createMenu({
      label: "Editor Action",
      command: "menu-command-target:editor",
      commandTarget: "focus",
    });
    editor.focus();

    menuBar.openButton(menuBar.buttons[0], { selectFirst: true });
    const item = menuBar.popup.rootList.items[0];
    expect(document.activeElement).toBe(item.element);
    expect(item.enabled).toBe(true);
    expect(item.commandTarget).toBe(editor);
    item.activate();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.calls.mostRecent().args[0].target).toBe(editor);
  });

  it("does not select another open editor when focus came from a different surface", () => {
    const editor = document.createElement("button");
    editor.className = "menu-command-target-editor";
    const tree = document.createElement("button");
    container.append(editor, tree);
    subscriptions.add(
      lumine.commands.add(".menu-command-target-editor", "menu-command-target:editor", () => {}),
    );
    createMenu({
      label: "Editor Action",
      command: "menu-command-target:editor",
      commandTarget: "focus",
    });
    tree.focus();

    menuBar.openButton(menuBar.buttons[0], { selectFirst: true });
    const item = menuBar.popup.rootList.items[0];
    expect(item.commandTarget).toBe(tree);
    expect(item.enabled).toBe(false);
    expect(item.element.getAttribute("aria-disabled")).toBe("true");
  });

  it("disables a submenu with no visible available action", () => {
    const target = document.createElement("button");
    target.className = "menu-command-target-editor";
    container.append(target);
    subscriptions.add(lumine.commands.add(target, "menu-command-target:available", () => {}));
    const template = {
      label: "Editor Actions",
      submenu: [
        { label: "Missing", command: "menu-command-target:missing" },
        { type: "separator" },
        { label: "Hidden", command: "menu-command-target:available", visible: false },
        { label: "Disabled", command: "menu-command-target:available", enabled: false },
      ],
    };
    createMenu(template);
    target.focus();
    menuBar.openButton(menuBar.buttons[0]);
    expect(menuBar.popup.rootList.items[0].enabled).toBe(false);
    menuBar.blur();
    template.submenu.push({ label: "Available", command: "menu-command-target:available" });
    target.focus();
    menuBar.openButton(menuBar.buttons[0]);
    expect(menuBar.popup.rootList.items[0].enabled).toBe(true);
  });

  it("keeps a removed session target disabled when its submenu is created later", async () => {
    const editor = document.createElement("button");
    editor.className = "menu-command-target-editor";
    container.append(editor);
    const handler = jasmine.createSpy("removed editor handler");
    subscriptions.add(
      lumine.commands.add(".menu-command-target-editor", "menu-command-target:editor", handler),
    );
    createMenu({
      label: "Nested Actions",
      submenu: [{ label: "Editor Action", command: "menu-command-target:editor" }],
    });
    editor.focus();
    menuBar.openButton(menuBar.buttons[0], { selectFirst: true });
    const popup = menuBar.popup;
    const parentItem = popup.rootList.items[0];
    editor.remove();

    parentItem.activate();
    const item = popup.lists[1].items[0];
    expect(item.commandTarget).toBe(editor);
    expect(item.enabled).toBe(false);
    item.activate();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });

  it("retains the original focus when a pointer gesture replaces an open status menu", async () => {
    const editor = document.createElement("button");
    editor.className = "menu-command-target-editor";
    const status = document.createElement("button");
    status.className = "menu-command-target-status";
    container.append(editor, status);
    const handler = jasmine.createSpy("original editor handler");
    subscriptions.add(
      lumine.commands.add(".menu-command-target-editor", "menu-command-target:editor", handler),
    );
    const contextMenus = new ContextMenuManager({
      keymapManager: lumine.keymaps,
      menuManager: {
        ensureContextViewManager: () => contextViews,
        showPopup: (options) => showMenuPopup(contextViews, options),
      },
    });
    subscriptions.add(
      contextMenus.add({
        ".menu-command-target-status": {
          commandTarget: "focus",
          items: [{ label: "Editor Action", command: "menu-command-target:editor" }],
        },
      }),
    );
    editor.focus();
    const first = contextMenus.showForEvent({ target: status });
    expect(first.element.contains(document.activeElement)).toBe(true);

    status.dispatchEvent(new PointerEvent("pointerdown", { button: 2, bubbles: true }));
    status.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
    status.focus();
    const second = contextMenus.showForEvent({ target: status });
    const item = second.rootList.items[0];
    expect(first.closed).toBe(true);
    expect(item.commandTarget).toBe(editor);
    expect(item.enabled).toBe(true);
    item.activate();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.calls.mostRecent().args[0].target).toBe(editor);
  });
});
