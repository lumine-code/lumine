const path = require("path");
const MenuManager = require("../src/menu-manager");

describe("MenuManager", function () {
  let menu = null;

  beforeEach(function () {
    menu = new MenuManager({
      keymapManager: lumine.keymaps,
      packageManager: lumine.packages,
    });
    spyOn(menu, "sendToBrowserProcess"); // Do not modify Lumine's actual menus
    menu.initialize({ resourcePath: lumine.application.getResourcePath() });
  });

  afterEach(() => menu.destroy());

  describe("::add(items)", function () {
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
    beforeEach(() => (menu.platform = "darwin"));

    it("sends the current menu template and associated key bindings to the browser process", function () {
      menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      lumine.keymaps.add("test", { "lumine-workspace": { "ctrl-b": "b" } });
      menu.update();
      advanceClock(1);
      expect(menu.sendToBrowserProcess.calls.argsFor(0)[1]["b"]).toEqual(["ctrl-b"]);
    });

    it("cancels a pending browser-process update when destroyed", function () {
      menu.update();
      menu.destroy();
      advanceClock(1);
      expect(menu.sendToBrowserProcess).not.toHaveBeenCalled();
    });

    it("omits key bindings that are mapped to unset! in any context", function () {
      // it would be nice to be smarter about omitting, but that would require a much
      // more dynamic interaction between the currently focused element and the menu
      menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      lumine.keymaps.add("test", { "lumine-workspace": { "ctrl-b": "b" } });
      lumine.keymaps.add("test", { "lumine-text-editor": { "ctrl-b": "unset!" } });
      advanceClock(1);
      expect(menu.sendToBrowserProcess.calls.argsFor(0)[1]["b"]).toBeUndefined();
    });

    it("omits key bindings that could conflict with AltGraph characters on macOS", function () {
      menu.add([
        {
          label: "A",
          submenu: [
            { label: "B", command: "b" },
            { label: "C", command: "c" },
            { label: "D", command: "d" },
          ],
        },
      ]);

      lumine.keymaps.add("test", {
        "lumine-workspace": {
          "alt-b": "b",
          "alt-shift-c": "c",
          "alt-cmd-d": "d",
        },
      });

      advanceClock(1);
      expect(menu.sendToBrowserProcess.calls.argsFor(0)[1]["b"]).toBeUndefined();
      expect(menu.sendToBrowserProcess.calls.argsFor(0)[1]["c"]).toBeUndefined();
      expect(menu.sendToBrowserProcess.calls.argsFor(0)[1]["d"]).toEqual(["alt-cmd-d"]);
    });

    it("collects a command that names something on Object.prototype", function () {
      // A command is whatever a keymap file says. Against a plain object the
      // `== null` guard in `update` reads `Object.prototype.constructor`, finds
      // it non-null, and unshifts onto `Object` — a TypeError inside the
      // timeout, which takes every later menu update with it.
      menu.add([
        {
          label: "A",
          submenu: [
            { label: "B", command: "constructor" },
            { label: "C", command: "hasOwnProperty" },
          ],
        },
      ]);
      lumine.keymaps.add("test", {
        "lumine-workspace": { "ctrl-b": "constructor", "ctrl-c": "hasOwnProperty" },
      });

      advanceClock(1);
      const keystrokesByCommand = menu.sendToBrowserProcess.calls.argsFor(0)[1];
      expect(keystrokesByCommand["constructor"]).toEqual(["ctrl-b"]);
      expect(keystrokesByCommand["hasOwnProperty"]).toEqual(["ctrl-c"]);
      expect(Object.getPrototypeOf(keystrokesByCommand)).toBeNull();
    });

    it("measures every binding against the body classes the pass started with", function () {
      // The simulated tree used to be built once and kept for the life of the
      // manager, so a selector qualified by a body class answered for whatever
      // classes were on the body when the first menu was built.
      menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      lumine.keymaps.add("test", { ".theme-under-test lumine-text-editor": { "ctrl-b": "b" } });

      menu.update();
      advanceClock(1);
      expect(menu.sendToBrowserProcess.calls.argsFor(0)[1]["b"]).toBeUndefined();

      document.body.classList.add("theme-under-test");
      try {
        menu.update();
        advanceClock(1);
        expect(menu.sendToBrowserProcess.calls.argsFor(1)[1]["b"]).toEqual(["ctrl-b"]);
      } finally {
        document.body.classList.remove("theme-under-test");
      }
    });

    it("builds one simulated tree per pass and keeps none of it", function () {
      spyOn(menu, "buildTestEditor").and.callThrough();
      menu.add([{ label: "A", submenu: [{ label: "B", command: "b" }] }]);
      lumine.keymaps.add("test", { "lumine-workspace": { "ctrl-b": "b" } });

      menu.update();
      advanceClock(1);

      expect(menu.buildTestEditor.calls.count()).toBe(1);
      expect(menu.testEditor).toBeNull();
    });
  });

  describe("::includeSelector(selector)", function () {
    it("answers against the body's classes as they are now", function () {
      expect(menu.includeSelector(".theme-under-test lumine-text-editor")).toBe(false);

      document.body.classList.add("theme-under-test");
      try {
        expect(menu.includeSelector(".theme-under-test lumine-text-editor")).toBe(true);
      } finally {
        document.body.classList.remove("theme-under-test");
      }

      expect(menu.includeSelector(".theme-under-test lumine-text-editor")).toBe(false);
    });

    it("refuses a selector it cannot parse", function () {
      expect(menu.includeSelector("<not a selector>")).toBe(false);
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
