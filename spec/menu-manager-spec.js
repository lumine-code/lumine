const path = require("path");
const { CompositeDisposable } = require("@lumine-code/event-kit");
const MenuManager = require("../src/menu-manager");
const WindowEventHandler = require("../src/window-event-handler");

describe("MenuManager", function () {
  let menu = null;

  beforeEach(function () {
    menu = new MenuManager({
      keymapManager: lumine.keymaps,
      packageManager: lumine.packages,
      commandRegistry: lumine.commands,
    });
    spyOn(menu, "sendToBrowserProcess"); // Do not modify Lumine's actual menus
    menu.initialize({ resourcePath: lumine.application.getResourcePath() });
  });

  afterEach(() => menu.destroy());

  describe("::transactAsync(callback)", () => {
    let changed, scheduleNativeUpdate;

    beforeEach(() => {
      menu.destroy();
      menu = new MenuManager({
        keymapManager: lumine.keymaps,
        packageManager: lumine.packages,
      });
      changed = jasmine.createSpy("changed");
      menu.onDidChange(changed);
      scheduleNativeUpdate = spyOn(menu, "scheduleNativeUpdate");
    });

    it("keeps menu changes synchronous outside a transaction", () => {
      const registration = menu.add([{ label: "First" }]);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.calls.mostRecent().args[0]).toEqual(menu.getTemplate());
      registration.dispose();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(scheduleNativeUpdate).toHaveBeenCalledTimes(2);
    });

    it("publishes one final snapshot while template reads include every pending change", async () => {
      const result = await menu.transactAsync(async () => {
        const registration = menu.add([{ label: "First" }]);
        expect(menu.getTemplate().map((item) => item.label)).toEqual(["First"]);
        expect(changed).not.toHaveBeenCalled();
        await Promise.resolve();
        menu.add([{ label: "Second" }]);
        registration.dispose();
        expect(menu.getTemplate().map((item) => item.label)).toEqual(["Second"]);
        expect(changed).not.toHaveBeenCalled();
        expect(scheduleNativeUpdate).not.toHaveBeenCalled();
        return "finished";
      });

      expect(result).toBe("finished");
      expect(changed).toHaveBeenCalledOnceWith(menu.getTemplate());
      expect(scheduleNativeUpdate).toHaveBeenCalledTimes(1);
    });

    for (const asynchronous of [false, true]) {
      it(`publishes changes when the callback ${asynchronous ? "rejects" : "throws"}`, async () => {
        const failure = new Error("Menu transaction failed");
        const transaction = menu.transactAsync(() => {
          menu.add([{ label: "Retained" }]);
          if (asynchronous) return Promise.reject(failure);
          throw failure;
        });

        await expectAsync(transaction).toBeRejectedWith(failure);
        expect(changed).toHaveBeenCalledOnceWith(menu.getTemplate());
        expect(scheduleNativeUpdate).toHaveBeenCalledTimes(1);
        menu.add([{ label: "Afterwards" }]);
        expect(changed).toHaveBeenCalledTimes(2);
      });
    }

    it("waits for the outermost transaction after a nested rejection", async () => {
      await menu.transactAsync(async () => {
        menu.add([{ label: "Outer" }]);
        const failure = new Error("Nested transaction failed");
        await expectAsync(
          menu.transactAsync(async () => {
            menu.add([{ label: "Inner" }]);
            throw failure;
          }),
        ).toBeRejectedWith(failure);
        expect(changed).not.toHaveBeenCalled();
        expect(scheduleNativeUpdate).not.toHaveBeenCalled();
        menu.add([{ label: "After inner" }]);
      });

      expect(changed).toHaveBeenCalledOnceWith(menu.getTemplate());
      expect(scheduleNativeUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not publish when the transaction did not change the menu", async () => {
      await menu.transactAsync(async () => {});
      expect(changed).not.toHaveBeenCalled();
      expect(scheduleNativeUpdate).not.toHaveBeenCalled();
    });
  });

  describe("::add(items)", function () {
    it("shares package configuration files in the platform's configuration submenu", function () {
      for (const platform of ["win32", "linux", "darwin"]) {
        menu.clear();
        menu.platform = platform;
        const parent = platform === "darwin" ? "Lumine" : "File";
        menu.add([
          {
            label: parent,
            submenu: [
              {
                label: "Configuration Files",
                groupOrder: ["editor", "packages", "extensions"],
                submenu: [{ label: "Config", command: "config", group: "editor", order: 10 }],
              },
            ],
          },
        ]);
        const contribution = [
          {
            label: "File",
            submenu: [
              { label: "New Notebook", command: "new-notebook" },
              {
                label: "Configuration Files",
                submenu: [
                  {
                    label: "Project List",
                    command: "edit-projects",
                    group: "packages",
                    order: 10,
                  },
                ],
              },
            ],
          },
        ];
        const original = JSON.stringify(contribution);
        const registration = menu.add(contribution);
        const configuration = () =>
          menu
            .getTemplate()
            .find((item) => item.id === parent)
            .submenu.find((item) => item.id === "Configuration Files").submenu;
        expect(configuration().map((item) => item.command ?? item.type)).toEqual([
          "config",
          "separator",
          "edit-projects",
        ]);
        const file = menu.getTemplate().find((item) => item.id === "File");
        expect(file.submenu.some((item) => item.command === "new-notebook")).toBe(true);
        if (platform === "darwin")
          expect(file.submenu.some((item) => item.id === "Configuration Files")).toBe(false);
        expect(JSON.stringify(contribution)).toBe(original);
        registration.dispose();
        expect(configuration().map((item) => item.command)).toEqual(["config"]);
        if (platform === "darwin")
          expect(menu.getTemplate().some((item) => item.id === "File")).toBe(false);
      }
    });

    it("drops the positioning keys, which the application menu never reads", function () {
      // sortMenuItems is the context menu's; nothing applies these here. Left
      // in place they would reach Menu.buildFromTemplate, which reads the same
      // four keys against `id` rather than `command`.
      const items = [
        {
          label: "A",
          submenu: [{ label: "B", command: "b", after: ["c"], beforeGroupContaining: ["d"] }],
        },
      ];
      const disposable = menu.add(items);

      expect(menu.template).toEqual([
        { label: "A", id: "A", submenu: [{ label: "B", id: "B", command: "b" }] },
      ]);
      // The caller's own object is untouched — `add` clones before stripping.
      expect(items[0].submenu[0].after).toEqual(["c"]);
      disposable.dispose();
      expect(menu.template).toEqual([]);
    });

    it("can add new menus that can be removed with the returned disposable", function () {
      const disposable = menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      expect(menu.template).toEqual([
        {
          label: "A",
          id: "A",
          submenu: [{ label: "B", id: "B", command: "b" }],
        },
      ]);
      disposable.dispose();
      expect(menu.template).toEqual([]);
    });

    it("can add submenu items to existing menus that can be removed with the returned disposable", function () {
      const disposable1 = menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      const disposable2 = menu.add([
        {
          label: "A",
          submenu: [{ label: "C", submenu: [{ label: "D", command: "d" }] }],
        },
      ]);
      const disposable3 = menu.add([
        {
          label: "A",
          submenu: [{ label: "C", submenu: [{ label: "E", command: "e" }] }],
        },
      ]);

      expect(menu.template).toEqual([
        {
          label: "A",
          id: "A",
          submenu: [
            { label: "B", id: "B", command: "b" },
            {
              label: "C",
              id: "C",
              submenu: [
                { label: "D", id: "D", command: "d" },
                { label: "E", id: "E", command: "e" },
              ],
            },
          ],
        },
      ]);

      disposable3.dispose();
      expect(menu.template).toEqual([
        {
          label: "A",
          id: "A",
          submenu: [
            { label: "B", id: "B", command: "b" },
            {
              label: "C",
              id: "C",
              submenu: [{ label: "D", id: "D", command: "d" }],
            },
          ],
        },
      ]);

      disposable2.dispose();
      expect(menu.template).toEqual([
        {
          label: "A",
          id: "A",
          submenu: [{ label: "B", id: "B", command: "b" }],
        },
      ]);

      disposable1.dispose();
      expect(menu.template).toEqual([]);
    });

    it("does not add duplicate labels to the same menu", function () {
      const originalItemCount = menu.template.length;
      menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      expect(menu.template[originalItemCount]).toEqual({
        label: "A",
        id: "A",
        submenu: [{ label: "B", id: "B", command: "b" }],
      });
    });
  });

  describe("::update()", function () {
    let target, commands, bindings;

    beforeEach(() => {
      menu.platform = "darwin";
      target = document.createElement("button");
      target.className = "native-menu-target";
      document.body.appendChild(target);
      target.focus();
      commands = lumine.commands.add(target, { b() {}, c() {}, d() {} });
      bindings = [];
    });

    afterEach(() => {
      for (const binding of bindings) binding.dispose();
      commands.dispose();
      target.remove();
    });

    const addBindings = (keymap) => bindings.push(lumine.keymaps.add("native-menu-spec", keymap));
    const sentItems = () => menu.sendToBrowserProcess.calls.mostRecent().args[0][0].submenu;

    it("prepares one native snapshot when flushing a batch of changes", () => {
      spyOn(menu, "getTemplate").and.callThrough();
      menu.update();
      menu.update();
      expect(menu.getTemplate).not.toHaveBeenCalled();
      advanceClock(1);
      expect(menu.getTemplate).toHaveBeenCalledTimes(1);
    });

    it("delivers canonical change snapshots synchronously to observers", () => {
      const changed = jasmine.createSpy("changed");
      const subscription = menu.onDidChange(changed);
      menu.add([{ label: "Startup", submenu: [{ label: "Action", command: "spec:action" }] }]);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.calls.mostRecent().args[0]).toEqual(menu.getTemplate());
      subscription.dispose();
    });

    it("uses the real target for availability, scope, and effective shortcuts", () => {
      menu.add([
        {
          label: "Actions",
          submenu: [
            { label: "Available", command: "b", scope: ".native-menu-target" },
            { label: "Wrong Scope", command: "b", scope: ".other-target" },
            { label: "Missing", command: "missing" },
            { label: "Explicitly Disabled", command: "b", enabled: false },
            { label: "System", command: "application:quit" },
            { label: "Native", role: "hide" },
          ],
        },
      ]);
      addBindings({ ".native-menu-target": { "ctrl-b": "b" } });
      advanceClock(1);
      expect(sentItems().map((item) => item.enabled)).toEqual([
        true,
        false,
        false,
        false,
        true,
        true,
      ]);
      expect(
        sentItems()
          .slice(0, 4)
          .map((item) => item.keystrokes),
      ).toEqual([["ctrl-b"], [], [], []]);
      expect(sentItems()[5].keystrokes).toEqual([]);
    });

    it("does not infer an editor binding while an unrelated input has focus", () => {
      menu.add([{ label: "Actions", submenu: [{ label: "B", command: "b" }] }]);
      addBindings({ "lumine-text-editor": { "ctrl-b": "b" } });
      advanceClock(1);
      expect(sentItems()[0].keystrokes).toEqual([]);
    });

    it("disables native submenus when every visible action is unavailable", () => {
      menu.add([
        {
          label: "Actions",
          submenu: [
            { label: "Missing", command: "menu-manager:unregistered" },
            { type: "separator" },
            { label: "Hidden", command: "application:new-window", visible: false },
            { label: "Disabled", command: "application:new-window", enabled: false },
          ],
        },
      ]);
      expect(menu.prepareNativeTemplate(target)[0].enabled).toBe(false);
      menu.add([
        { label: "Actions", submenu: [{ label: "New Window", command: "application:new-window" }] },
      ]);
      expect(menu.prepareNativeTemplate(target)[0].enabled).toBe(true);
    });

    it("leaves native Services available for the operating system to populate", () => {
      menu.add([
        { label: "Services", role: "services", submenu: [] },
        { label: "Empty Extension", submenu: [] },
      ]);
      expect(menu.prepareNativeTemplate(target).map((item) => item.enabled)).toEqual([true, false]);
    });

    it("refreshes native availability without moving focus and passes variant details", () => {
      let available = false;
      const detail = { repository: "selected" };
      const handler = jasmine.createSpy("native conditional handler");
      const registration = lumine.commands.add(target, "menu-manager:conditional", {
        isAvailable: (context) => available && context.detail?.repository === detail.repository,
        didDispatch: handler,
      });
      menu.add([
        {
          label: "Git",
          submenu: [{ label: "Run", command: "menu-manager:conditional", commandDetail: detail }],
        },
      ]);
      try {
        advanceClock(1);
        expect(sentItems()[0].enabled).toBe(false);
        available = true;
        lumine.commands.invalidateAvailability();
        advanceClock(1);
        expect(sentItems()[0].enabled).toBe(true);
        available = false;
        expect(
          menu.dispatchNativeMenuCommand("menu-manager:conditional", detail, {}, document),
        ).toBeNull();
        expect(handler).not.toHaveBeenCalled();
      } finally {
        registration.dispose();
      }
    });

    it("keeps native editing commands available on supported Chromium inputs", () => {
      const subscriptions = new CompositeDisposable();
      const performWebContentsAction = jasmine.createSpy("performWebContentsAction");
      WindowEventHandler.prototype.handleNativeKeybindings.call({
        lumineEnvironment: lumine,
        subscriptions,
        applicationDelegate: { performWebContentsAction },
      });
      const input = document.createElement("input");
      input.className = "native-key-bindings";
      document.body.appendChild(input);
      menu.add([
        {
          label: "Edit",
          submenu: ["copy", "paste", "undo", "redo", "select-all", "cut"].map((name) => ({
            label: name,
            command: `core:${name}`,
          })),
        },
      ]);
      try {
        expect(menu.prepareNativeTemplate(input)[0].submenu.map((item) => item.enabled)).toEqual([
          true,
          true,
          true,
          true,
          true,
          true,
        ]);
        lumine.commands.dispatch(input, "core:copy");
        expect(performWebContentsAction).toHaveBeenCalledOnceWith("copy");
        input.className = "";
        expect(menu.prepareNativeTemplate(input)[0].submenu.map((item) => item.enabled)).toEqual([
          false,
          false,
          false,
          false,
          false,
          false,
        ]);
      } finally {
        subscriptions.dispose();
        input.remove();
      }
    });

    it("respects overrides and unset bindings only in the current target ancestry", () => {
      menu.add([{ label: "Actions", submenu: [{ label: "B", command: "b" }] }]);
      addBindings({ ".native-menu-target": { "ctrl-b": "b", "ctrl-c": "b" } });
      addBindings({ ".unrelated-target": { "ctrl-b": "unset!" } });
      addBindings({ ".native-menu-target": { "ctrl-c": "c" } });
      advanceClock(1);
      expect(sentItems()[0].keystrokes).toEqual(["ctrl-b"]);
      addBindings({ ".native-menu-target": { "ctrl-b": "unset!" } });
      menu.update();
      advanceClock(1);
      expect(sentItems()[0].keystrokes).toEqual([]);
    });

    it("scans bindings once for rows sharing the same target", () => {
      menu.add([
        {
          label: "Actions",
          submenu: [
            { label: "B", command: "b" },
            { label: "C", command: "c" },
          ],
        },
      ]);
      const find = spyOn(lumine.keymaps, "findKeyBindings").and.callThrough();
      menu.prepareNativeTemplate(target);
      expect(find).toHaveBeenCalledOnceWith({ target });
    });

    it("resolves explicit shortcut targets before sending serializable row state", () => {
      menu.add([
        {
          label: "Actions",
          submenu: [
            { label: "Plain", command: "b" },
            { label: "Variant", command: "b", commandDetail: { alternate: true } },
            {
              label: "Equivalent",
              command: "b",
              commandDetail: { alternate: true },
              keyBindingCommand: "c",
              keyBindingTarget: () => target,
            },
          ],
        },
      ]);
      addBindings({ ".native-menu-target": { "ctrl-b": "b", "ctrl-c": "c" } });
      advanceClock(1);
      expect(sentItems().map((item) => item.keystrokes)).toEqual([["ctrl-b"], [], ["ctrl-c"]]);
      expect(sentItems()[2].keyBindingTarget).toBeUndefined();
      expect(sentItems()[2].keyBindingCommand).toBeUndefined();
      expect(() => structuredClone(sentItems())).not.toThrow();
    });

    it("omits shortcuts that conflict with AltGraph characters on macOS", () => {
      menu.add([
        {
          label: "Actions",
          submenu: [
            { label: "B", command: "b" },
            { label: "C", command: "c" },
            { label: "D", command: "d" },
          ],
        },
      ]);
      addBindings({
        ".native-menu-target": { "alt-b": "b", "alt-shift-c": "c", "alt-cmd-d": "d" },
      });
      advanceClock(1);
      expect(sentItems().map((item) => item.keystrokes)).toEqual([[], [], ["alt-cmd-d"]]);
    });

    it("refreshes native availability after command registration and removal", () => {
      menu.add([{ label: "Actions", submenu: [{ label: "Later", command: "native-menu:later" }] }]);
      advanceClock(1);
      expect(sentItems()[0].enabled).toBe(false);
      const changed = jasmine.createSpy("changed");
      const subscription = menu.onDidChange(changed);
      const later = lumine.commands.add(target, "native-menu:later", () => {});
      advanceClock(1);
      expect(sentItems()[0].enabled).toBe(true);
      later.dispose();
      advanceClock(1);
      expect(sentItems()[0].enabled).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      subscription.dispose();
    });

    it("refreshes a focused row when its scope attributes change", async () => {
      menu.observeNativeDocument(document);
      menu.add([
        {
          label: "Actions",
          submenu: [{ label: "Scoped", command: "b", scope: ".native-menu-target" }],
        },
      ]);
      advanceClock(1);
      expect(sentItems()[0].enabled).toBe(true);
      target.className = "changed-context";
      await Promise.resolve();
      advanceClock(1);
      expect(sentItems()[0].enabled).toBe(false);
    });

    it("releases a cancelled session on a genuine later focus change", () => {
      menu.observeNativeDocument(document);
      menu.beginNativeMenu(document);
      menu.endNativeMenu();
      const other = document.createElement("button");
      document.body.appendChild(other);
      try {
        other.focus();
        expect(menu.getNativeMenuTarget(document)).toBe(other);
      } finally {
        other.remove();
      }
    });

    it("preserves the source target while the title-bar menubar owns focus", async () => {
      menu.add([{ label: "Actions", submenu: [{ label: "B", command: "b" }] }]);
      const menuBar = menu.createMenuBar({ document });
      menuBar.element.classList.add("title-bar-menu-bar");
      document.body.appendChild(menuBar.element);
      menu.observeNativeDocument(document);
      try {
        menuBar.focus();
        expect(document.activeElement).toBe(menuBar.buttons[0].element);
        await Promise.resolve();
        expect(menu.getNativeMenuTarget(document)).toBe(target);
        menu.beginNativeMenu(document);
        expect(menu.getNativeMenuTarget(document)).toBe(target);
        expect(
          menu.prepareNativeTemplate(menu.getNativeMenuTarget(document))[0].submenu[0].enabled,
        ).toBe(true);
      } finally {
        menuBar.destroy();
      }
    });

    it("cancels a pending browser-process update when destroyed", () => {
      menu.update();
      menu.destroy();
      advanceClock(1);
      expect(menu.sendToBrowserProcess).not.toHaveBeenCalled();
    });
  });
  describe("core-owned menu layout", () => {
    it("retains the core layout through extension insertion and disposal", () => {
      menu.loadPlatformItems();
      const fileMenu = () => menu.getTemplate().find((item) => item.id === "File").submenu;
      const initial = fileMenu();
      const quit = initial.find((item) => item.command === "application:quit");
      const disposable = menu.add([
        {
          label: "File",
          groupOrder: ["quit", "new", "close"],
          submenu: [
            { label: "New Fixture", command: "fixture:new", group: "new", order: 20 },
            { label: "Browse Fixture", command: "fixture:open", group: "files", order: 20 },
            { label: "Unclassified Fixture", command: "fixture:unknown" },
          ],
        },
      ]);
      const items = fileMenu();
      expect(items.at(-1).command).toBe(quit ? "application:quit" : "window:close");
      expect(items.findIndex((item) => item.command === "fixture:new")).toBeLessThan(
        items.findIndex((item) => item.command === "application:new-window"),
      );
      expect(items.findIndex((item) => item.command === "fixture:unknown")).toBeLessThan(
        items.findIndex((item) => item.command === "core:close"),
      );
      disposable.dispose();
      expect(fileMenu()).toEqual(initial);
      expect(JSON.stringify(menu.getTemplate())).not.toContain('"groupOrder"');
    });
  });

  it("updates the application menu when a keymap is reloaded", function () {
    spyOn(menu, "update");
    const keymapPath = path.join(
      __dirname,
      "fixtures",
      "packages",
      "package-with-keymaps",
      "keymaps",
      "keymap-1.json",
    );
    lumine.keymaps.reloadKeymap(keymapPath);
    expect(menu.update).toHaveBeenCalled();
  });
});
