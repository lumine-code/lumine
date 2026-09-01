const { Emitter } = require("@lumine-code/event-kit");
const ContextViewManager = require("../src/context-view-manager");
const { showMenuPopup } = require("../src/menu-view");
const MenuBarView = require("../src/menu-bar-view");
const SelectBoxView = require("../src/select-box-view");

describe("HTML menu UI", () => {
  let contextViews, target;

  beforeEach(() => {
    contextViews = new ContextViewManager({ document, window });
    target = document.createElement("button");
    document.body.appendChild(target);
  });

  afterEach(() => {
    contextViews.destroy();
    target.remove();
  });

  it("anchors and clamps a context view inside the viewport", () => {
    spyOn(target, "getBoundingClientRect").and.returnValue({
      left: window.innerWidth - 5,
      right: window.innerWidth - 1,
      top: window.innerHeight - 5,
      bottom: window.innerHeight - 1,
      width: 4,
      height: 4,
    });
    const handle = contextViews.show({
      anchor: target,
      render(surface) {
        spyOn(surface, "getBoundingClientRect").and.returnValue({ width: 120, height: 80 });
      },
    });
    expect(parseFloat(handle.surface.style.left)).toBeLessThan(window.innerWidth - 120);
    expect(parseFloat(handle.surface.style.top)).toBeLessThan(window.innerHeight - 80);
    expect(handle.surface.dataset.placement).toBe("above");
  });

  it("keeps a fixed popup below its anchor and scrolls in the remaining space", () => {
    const bottom = window.innerHeight - 40;
    spyOn(target, "getBoundingClientRect").and.returnValue({
      left: 20,
      right: 220,
      top: bottom - 28,
      bottom,
      width: 200,
      height: 28,
    });
    const handle = contextViews.show({
      anchor: target,
      placement: "below",
      fixedPlacement: true,
      render(surface) {
        spyOn(surface, "getBoundingClientRect").and.returnValue({ width: 200, height: 300 });
      },
    });
    expect(handle.surface.dataset.placement).toBe("below");
    expect(handle.surface.style.top).toBe(`${bottom + 2}px`);
    expect(handle.surface.style.maxHeight).toBe("30px");
  });

  it("renders a command menu and dispatches against its explicit target", async () => {
    let dispatchCount = 0;
    const commands = lumine.commands.add(target, {
      "menu-ui-spec:run": () => dispatchCount++,
    });
    const popup = showMenuPopup(contextViews, {
      anchor: target,
      target,
      template: [{ label: "Run", command: "menu-ui-spec:run" }],
    });
    popup.element.querySelector(".menu-item").click();
    await Promise.resolve();
    expect(dispatchCount).toBe(1);
    expect(popup.element.isConnected).toBe(false);
    commands.dispose();
  });

  it("refreshes an open recent-project menu after removing an entry with RMB", async () => {
    const paths = ["C:\\projects\\one"];
    const remainingPaths = ["C:\\projects\\two"];
    const removeProject = spyOn(lumine.history, "removeProject").and.resolveTo();
    const popup = showMenuPopup(contextViews, {
      anchor: target,
      template: [
        {
          label: paths[0],
          command: "application:reopen-project",
          commandDetail: { paths },
        },
        {
          label: remainingPaths[0],
          command: "application:reopen-project",
          commandDetail: { paths: remainingPaths },
        },
      ],
    });
    const item = popup.element.querySelector(".menu-item");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    popup.rootList.selectItem(popup.rootList.items[0], { focus: true });

    item.dispatchEvent(event);
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await popup.rootList.items[0].removalPromise;

    expect(event.defaultPrevented).toBe(true);
    expect(removeProject).toHaveBeenCalledWith(paths);
    expect(removeProject).toHaveBeenCalledTimes(1);
    expect(popup.element.isConnected).toBe(true);
    expect(contextViews.activeHandle).toBe(popup.handle);
    expect(popup.rootList.items.length).toBe(1);
    expect(popup.rootList.items[0].template.commandDetail.paths).toBe(remainingPaths);
    expect(popup.rootList.selectedItem).toBeNull();
    expect(document.activeElement).toBe(popup.rootList.element);
    expect(popup.element.textContent).not.toContain(paths[0]);
    expect(popup.element.textContent).toContain(remainingPaths[0]);
  });

  it("opens nested submenus with the keyboard", () => {
    const popup = showMenuPopup(contextViews, {
      anchor: target,
      target,
      autoSelectFirstItem: true,
      template: [{ label: "Parent", submenu: [{ label: "Child", command: "spec:child" }] }],
    });
    const parent = popup.element.querySelector(".menu-item");
    parent.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(popup.element.querySelectorAll(".menu-popup-panel").length).toBe(2);
    expect(popup.element.querySelectorAll(".menu-item")[1].classList).toContain("selected");
  });

  it("delays pointer selection while crossing toward an open submenu", () => {
    const popup = showMenuPopup(contextViews, {
      anchor: target,
      target,
      template: [{ label: "Parent", submenu: [{ label: "Child", command: "spec:child" }] }],
    });
    const parent = popup.element.querySelector(".menu-item");
    parent.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    advanceClock(100);
    parent.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    advanceClock(200);
    expect(parent.classList).not.toContain("selected");
    expect(popup.element.querySelectorAll(".menu-popup-panel").length).toBe(1);

    parent.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    advanceClock(249);
    expect(parent.classList).not.toContain("selected");
    expect(popup.element.querySelectorAll(".menu-popup-panel").length).toBe(1);
    advanceClock(1);
    expect(parent.classList).not.toContain("selected");
    expect(parent.classList).toContain("open");
    expect(popup.element.querySelectorAll(".menu-popup-panel").length).toBe(2);
    parent.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    expect(parent.classList).toContain("open");
  });

  it("does not apply pointer selection to an item without a submenu", () => {
    const popup = showMenuPopup(contextViews, {
      anchor: target,
      target,
      template: [{ label: "Action", command: "spec:action" }],
    });
    const action = popup.element.querySelector(".menu-item");
    action.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    advanceClock(250);
    expect(action.classList).not.toContain("selected");
  });

  it("keeps keyboard selection on an item without a submenu", () => {
    const popup = showMenuPopup(contextViews, {
      anchor: target,
      target,
      autoSelectFirstItem: true,
      template: [{ label: "Action", command: "spec:action" }],
    });
    const action = popup.element.querySelector(".menu-item");
    expect(action.classList).toContain("selected");

    action.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));

    expect(action.classList).toContain("selected");
  });

  it("creates a menu bar from the canonical template", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [{ label: "&File", submenu: [{ label: "Open", command: "core:open" }] }],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager);
    document.body.appendChild(menuBar.element);
    expect(menuBar.element.querySelectorAll(".menu-label:not(.overflow-menu-label)").length).toBe(
      1,
    );
    menuBar.focus();
    menuBar.element
      .querySelector(".menu-label")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.querySelector("lumine-context-view.application-menu-popup")).not.toBeNull();
    menuBar.destroy();
    emitter.dispose();
  });

  it("keeps a tall application menu below the MenuBar", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [
        {
          label: "&Packages",
          submenu: Array.from({ length: 100 }, (_, index) => ({
            label: `Package ${index + 1}`,
            command: `spec:package-${index + 1}`,
          })),
        },
      ],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager);
    document.body.appendChild(menuBar.element);
    const label = menuBar.element.querySelector(".menu-label:not(.overflow-menu-label)");
    spyOn(label, "getBoundingClientRect").and.returnValue({
      left: 20,
      right: 120,
      top: 0,
      bottom: 32,
      width: 100,
      height: 32,
    });

    label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(document.querySelector("lumine-context-view.application-menu-popup")).toBeNull();
    label.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    label.click();
    const surface = document.querySelector("lumine-context-view.application-menu-popup .menu-box");

    expect(surface.dataset.placement).toBe("below");
    expect(surface.style.top).toBe("34px");
    expect(surface.style.maxHeight).toBe(`${window.innerHeight - 42}px`);
    menuBar.destroy();
    emitter.dispose();
  });

  it("keeps only the active MenuBar label highlighted when keyboard navigation switches menus", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [
        { label: "&File", submenu: [{ label: "Open", command: "core:open" }] },
        { label: "&Edit", submenu: [{ label: "Undo", command: "core:undo" }] },
        { label: "&View", submenu: [{ label: "Reload", command: "window:reload" }] },
      ],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager);
    document.body.appendChild(menuBar.element);
    const labels = menuBar.element.querySelectorAll(
      ".menu-label:not(.overflow-menu-label):not(.overflowed)",
    );

    menuBar.focus();
    labels[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    labels[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    document
      .querySelector("lumine-context-view.application-menu-popup .menu-box")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(menuBar.activeButton.element).toBe(labels[2]);
    expect(
      Array.from(labels).filter(
        (label) => label.classList.contains("focused") || label.classList.contains("open"),
      ),
    ).toEqual([labels[2]]);
    expect(labels[2].classList).toContain("open");
    expect(labels[2].classList).not.toContain("focused");
    menuBar.destroy();
    emitter.dispose();
  });

  it("returns focus to the MenuBar when ArrowUp leaves the first menu item", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [
        {
          label: "&File",
          submenu: [
            { label: "Open", command: "core:open" },
            { label: "Save", command: "core:save" },
          ],
        },
      ],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager);
    document.body.appendChild(menuBar.element);
    const label = menuBar.element.querySelector(".menu-label:not(.overflow-menu-label)");

    menuBar.focus();
    label.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const firstItem = document.querySelector(
      "lumine-context-view.application-menu-popup .menu-item",
    );
    expect(firstItem.classList).toContain("selected");
    expect(document.activeElement).toBe(firstItem);

    firstItem.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(document.querySelector(".application-menu-popup .menu-item.selected")).toBeNull();
    expect(document.activeElement).toBe(label);
    expect(label.classList).toContain("focused");
    expect(label.classList).toContain("open");
    expect(menuBar.element.classList).toContain("focused");
    menuBar.destroy();
    emitter.dispose();
  });

  it("does not activate a mnemonic directly from global Alt+key", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [{ label: "&File", submenu: [{ label: "Open", command: "core:open" }] }],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager);
    document.body.appendChild(menuBar.element);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", altKey: true, bubbles: true }),
    );
    expect(document.querySelector("lumine-context-view.application-menu-popup")).toBeNull();
    menuBar.destroy();
    emitter.dispose();
  });

  it("opens a mnemonic after standalone Alt activates the MenuBar", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [
        { label: "&File", submenu: [{ label: "Open", command: "core:open" }] },
        { label: "&Help", submenu: [{ label: "About", command: "application:about" }] },
      ],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager, {
      autoHide: true,
      altGivesFocus: true,
    });
    document.body.appendChild(menuBar.element);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }),
    );
    expect(menuBar.element.classList).toContain("no-menu-bar");
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));

    const labels = menuBar.element.querySelectorAll(
      ".menu-label:not(.overflow-menu-label):not(.overflowed)",
    );
    expect(document.activeElement).toBe(labels[0]);
    expect(menuBar.element.classList).toContain("focused");
    expect(menuBar.element.classList).not.toContain("no-menu-bar");

    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));

    expect(menuBar.activeButton.element).toBe(labels[1]);
    expect(menuBar.popup).not.toBeNull();
    menuBar.destroy();
    emitter.dispose();
  });

  it("does not activate the MenuBar after Alt+wheel scrolling", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [{ label: "&File", submenu: [{ label: "Open", command: "core:open" }] }],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager, { altGivesFocus: true });
    document.body.appendChild(menuBar.element);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }),
    );
    document.body.dispatchEvent(new WheelEvent("wheel", { altKey: true, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));

    expect(document.activeElement).not.toBe(
      menuBar.element.querySelector(".menu-label:not(.overflow-menu-label)"),
    );
    expect(menuBar.element.classList).not.toContain("focused");
    menuBar.destroy();
    emitter.dispose();
  });

  it("conceals an auto-hidden MenuBar after an outside click", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [{ label: "&File", submenu: [{ label: "Open", command: "core:open" }] }],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager, { autoHide: true });
    document.body.appendChild(menuBar.element);
    expect(menuBar.element.classList).toContain("no-menu-bar");

    menuBar.reveal();
    expect(menuBar.element.classList).not.toContain("no-menu-bar");
    target.click();

    expect(menuBar.element.classList).toContain("no-menu-bar");
    menuBar.destroy();
    emitter.dispose();
  });

  it("closes an open MenuBar menu when its active label is clicked again", () => {
    const emitter = new Emitter();
    const fakeManager = {
      getTemplate: () => [{ label: "&File", submenu: [{ label: "Open", command: "core:open" }] }],
      onDidChange: (callback) => emitter.on("change", callback),
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
    const menuBar = new MenuBarView(fakeManager);
    document.body.appendChild(menuBar.element);
    const label = menuBar.element.querySelector(".menu-label:not(.overflow-menu-label)");

    label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(menuBar.popup).toBeNull();
    label.click();
    expect(menuBar.popup).not.toBeNull();
    label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(menuBar.popup).not.toBeNull();
    label.click();

    expect(menuBar.popup).toBeNull();
    expect(document.querySelector("lumine-context-view.application-menu-popup")).toBeNull();
    menuBar.destroy();
    emitter.dispose();
  });

  it("loads and commits options through SelectBox", async () => {
    const fakeManager = { contextViewManager: contextViews };
    const selectBox = new SelectBoxView(fakeManager, {
      items: [{ value: "old", label: "Old" }],
      value: "old",
      matchTriggerFontSize: true,
      async onWillOpen(controller) {
        controller.setItems([
          { value: "old", label: "Old" },
          { value: "new", label: "New" },
        ]);
      },
    });
    document.body.appendChild(selectBox.element);
    selectBox.element.style.fontSize = "19px";
    spyOn(selectBox.element, "getBoundingClientRect").and.returnValue({
      left: 20,
      right: 340,
      top: 20,
      bottom: 48,
      width: 320,
      height: 28,
    });
    let change;
    selectBox.onDidChange((event) => (change = event));
    await selectBox.open();
    const list = document.querySelector(".select-box-list");
    expect(list.style.width).toBe("320px");
    expect(list.style.fontSize).toBe("19px");
    expect(getComputedStyle(list.querySelector(".select-box-option")).fontSize).toBe("19px");
    document.querySelectorAll(".select-box-option")[1].click();
    expect(selectBox.value).toBe("new");
    expect(change).toEqual(jasmine.objectContaining({ value: "new", index: 1 }));
    expect(selectBox.element.getAttribute("aria-expanded")).toBe("false");
    selectBox.destroy();
  });

  it("closes an open SelectBox when its trigger is clicked again", async () => {
    const fakeManager = { contextViewManager: contextViews };
    const selectBox = new SelectBoxView(fakeManager, {
      items: [{ value: "one", label: "One" }],
      value: "one",
    });
    document.body.appendChild(selectBox.element);
    await selectBox.open();
    const popup = selectBox.popup;

    selectBox.element.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(selectBox.popup).toBe(popup);

    selectBox.element.click();
    expect(selectBox.popup).toBeNull();
    expect(document.querySelector(".select-box-list")).toBeNull();
    selectBox.destroy();
  });
});
