const MenuHelpers = require("../src/menu-helpers");
const MenuManager = require("../src/menu-manager");

// The application-menu path normalizes nothing: `merge` only ever appends,
// `unmerge` can never match a separator, and the template goes straight to
// Electron. Every menu convention in the workspace CLAUDE.md follows from that,
// so pin the behaviour here rather than rediscovering it from a broken menu.
describe("MenuHelpers", function () {
  describe("::merge", function () {
    it("appends rather than inserting", function () {
      const menu = [
        { label: "A", id: "A" },
        { label: "B", id: "B" },
      ];
      MenuHelpers.merge(menu, { label: "C", command: "c" });
      expect(menu.map(({ label }) => label)).toEqual(["A", "B", "C"]);
    });

    it("merges by id, which defaults to the label with mnemonics stripped", function () {
      const menu = [];
      MenuHelpers.merge(menu, {
        label: process.platform === "darwin" ? "Packages" : "&Packages",
        submenu: [{ label: "One", command: "one" }],
      });
      MenuHelpers.merge(menu, {
        label: "Packages",
        submenu: [{ label: "Two", command: "two" }],
      });
      expect(menu.length).toBe(1);
      expect(menu[0].submenu.map(({ label }) => label)).toEqual(["One", "Two"]);
    });

    it("never matches a separator, so consecutive merges keep every one", function () {
      const menu = [];
      MenuHelpers.merge(menu, { label: "A", command: "a" });
      MenuHelpers.merge(menu, { type: "separator" });
      MenuHelpers.merge(menu, { label: "B", command: "b" });
      MenuHelpers.merge(menu, { type: "separator" });
      expect(menu.map((item) => item.label || item.type)).toEqual([
        "A",
        "separator",
        "B",
        "separator",
      ]);
    });

    it("refuses a separator only when the menu already ends in one", function () {
      const menu = [{ label: "A", id: "A" }, { type: "separator" }];
      MenuHelpers.merge(menu, { type: "separator" });
      expect(menu.length).toBe(2);
    });

    it("drops keys outside the whitelist, including functions", function () {
      const menu = [];
      MenuHelpers.merge(menu, {
        label: "A",
        command: "a",
        shouldDisplay: () => true,
        created: () => {},
      });
      expect(menu[0].shouldDisplay).toBeUndefined();
      expect(menu[0].created).toBeUndefined();
    });
  });

  describe("::unmerge", function () {
    it("never removes a separator", function () {
      const menu = [{ label: "A", id: "A" }, { type: "separator" }];
      MenuHelpers.unmerge(menu, { type: "separator" });
      expect(menu.length).toBe(2);
    });

    it("splices a parent once its non-separator children are gone", function () {
      const menu = [];
      MenuHelpers.merge(menu, {
        label: "Search",
        submenu: [{ label: "Find", command: "find" }, { type: "separator" }],
      });
      MenuHelpers.unmerge(menu, {
        label: "Search",
        submenu: [{ label: "Find", command: "find" }],
      });
      expect(menu).toEqual([]);
    });

    it("keeps a structural id in place when it empties", function () {
      const menu = [];
      MenuHelpers.merge(menu, { label: "Search", submenu: [{ label: "Find", command: "find" }] });
      MenuHelpers.merge(menu, { label: "Packages", submenu: [{ label: "Manage", command: "m" }] });
      const structuralIds = new Set(["Search", "Packages"]);

      MenuHelpers.unmerge(
        menu,
        { label: "Search", submenu: [{ label: "Find", command: "find" }] },
        structuralIds,
      );

      expect(menu.map(({ label }) => label)).toEqual(["Search", "Packages"]);
      expect(menu[0].submenu).toEqual([]);
    });

    it("only protects the top level, never a nested item", function () {
      const menu = [];
      MenuHelpers.merge(menu, {
        label: "Packages",
        submenu: [{ label: "Search", submenu: [{ label: "Find", command: "find" }] }],
      });

      MenuHelpers.unmerge(
        menu,
        {
          label: "Packages",
          submenu: [{ label: "Search", submenu: [{ label: "Find", command: "find" }] }],
        },
        new Set(["Packages", "Search"]),
      );

      expect(menu.map(({ label }) => label)).toEqual(["Packages"]);
      expect(menu[0].submenu).toEqual([]);
    });
  });

  describe("::normalizeLabel", function () {
    it("strips mnemonics everywhere but darwin", function () {
      const normalized = MenuHelpers.normalizeLabel("&Packages");
      if (process.platform === "darwin") {
        expect(normalized).toBe("&Packages");
      } else {
        expect(normalized).toBe("Packages");
      }
    });

    it("returns undefined for a missing label", function () {
      expect(MenuHelpers.normalizeLabel(null)).toBeUndefined();
    });
  });
});

describe("MenuManager::sortPackagesMenu", function () {
  let menu = null;

  beforeEach(function () {
    menu = new MenuManager({
      keymapManager: atom.keymaps,
      packageManager: atom.packages,
    });
    spyOn(menu, "sendToBrowserProcess");
    menu.initialize({ resourcePath: atom.getLoadSettings().resourcePath });
    menu.template = [
      {
        label: "Packages",
        id: "Packages",
        submenu: [
          { label: "Open Package Manager", id: "Open Package Manager", command: "s" },
          { type: "separator" },
        ],
      },
    ];
  });

  const labels = () => menu.template[0].submenu.map((item) => item.label || item.type);

  it("sorts only the items after the platform file's separator", function () {
    menu.add([{ label: "Packages", submenu: [{ label: "Zulu", command: "z" }] }]);
    menu.add([{ label: "Packages", submenu: [{ label: "Alpha", command: "a" }] }]);
    menu.sortPackagesMenu();
    expect(labels()).toEqual(["Open Package Manager", "separator", "Alpha", "Zulu"]);
  });

  it("re-sorts a package that arrives after the initial activation", function () {
    menu.add([{ label: "Packages", submenu: [{ label: "Alpha", command: "a" }] }]);
    menu.add([{ label: "Packages", submenu: [{ label: "Zulu", command: "z" }] }]);
    menu.sortPackagesMenu();

    menu.add([{ label: "Packages", submenu: [{ label: "Mike", command: "m" }] }]);
    expect(labels()).toEqual(["Open Package Manager", "separator", "Alpha", "Zulu", "Mike"]);

    menu.sortPackagesMenu();
    expect(labels()).toEqual(["Open Package Manager", "separator", "Alpha", "Mike", "Zulu"]);
  });

  it("sorts when a package activates after startup", function () {
    menu.add([{ label: "Packages", submenu: [{ label: "Zulu", command: "z" }] }]);
    menu.add([{ label: "Packages", submenu: [{ label: "Alpha", command: "a" }] }]);
    atom.packages.emitter.emit("did-activate-package", {});
    expect(labels()).toEqual(["Open Package Manager", "separator", "Alpha", "Zulu"]);
  });
});
