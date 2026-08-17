const MenuHelpers = require("../src/menu-helpers");
const MenuManager = require("../src/menu-manager");

// The application-menu path normalizes nothing: `merge` only ever appends,
// `unmerge` can never match a separator, and the template goes straight to
// Electron. Every menu convention in the workspace CLAUDE.md follows from that,
// so pin the behaviour here rather than rediscovering it from a broken menu.
describe("MenuHelpers", function () {
  describe("::stripPositioningKeys", function () {
    it("removes all four keys at every depth and leaves everything else", function () {
      const items = [
        {
          label: "A",
          id: "A",
          before: ["x"],
          submenu: [
            { type: "separator" },
            { label: "B", id: "B", command: "b", after: ["y"], afterGroupContaining: ["z"] },
          ],
        },
        { label: "C", id: "C", command: "c", beforeGroupContaining: ["w"] },
      ];

      expect(MenuHelpers.stripPositioningKeys(items)).toEqual([
        {
          label: "A",
          id: "A",
          submenu: [{ type: "separator" }, { label: "B", id: "B", command: "b" }],
        },
        { label: "C", id: "C", command: "c" },
      ]);
    });
  });

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

    describe("specificity", function () {
      // `merge`'s third argument is a specificity, except for one value: `false`
      // means "never override", which ContextMenuManager passes when folding a
      // shallower element's items into a template a deeper one already filled.
      it("lets an equal specificity replace, so the later contributor wins", function () {
        const menu = [];
        MenuHelpers.merge(menu, { label: "A", command: "first" }, 10);
        MenuHelpers.merge(menu, { label: "A", command: "second" }, 10);
        expect(menu).toEqual([{ label: "A", id: "A", command: "second" }]);
      });

      it("keeps the more specific item when a less specific one follows", function () {
        const menu = [];
        MenuHelpers.merge(menu, { label: "A", command: "specific" }, 20);
        MenuHelpers.merge(menu, { label: "A", command: "vague" }, 10);
        expect(menu).toEqual([{ label: "A", id: "A", command: "specific" }]);
      });

      it("treats a specificity of zero as a specificity, not as the sentinel", function () {
        // `calculateSpecificity` legitimately answers 0 — for `*`, for a
        // selector whose first comma-branch is empty, for a bare combinator.
        // A truthiness check made such an item unable to override anything,
        // including another item scoring 0.
        const menu = [];
        MenuHelpers.merge(menu, { label: "A", command: "first" }, 0);
        MenuHelpers.merge(menu, { label: "A", command: "second" }, 0);
        expect(menu).toEqual([{ label: "A", id: "A", command: "second" }]);
      });

      it("never lets the false sentinel replace, even against a stored zero", function () {
        const menu = [];
        MenuHelpers.merge(menu, { label: "A", command: "kept" }, 0);
        MenuHelpers.merge(menu, { label: "A", command: "ignored" }, false);
        expect(menu).toEqual([{ label: "A", id: "A", command: "kept" }]);
      });
    });

    it("keeps the positioning keys, which the context menu's sort still has to read", function () {
      const menu = [];
      MenuHelpers.merge(menu, { label: "A", command: "a", after: ["b"] });
      expect(menu[0].after).toEqual(["b"]);
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
      keymapManager: lumine.keymaps,
      packageManager: lumine.packages,
    });
    spyOn(menu, "sendToBrowserProcess");
    menu.initialize({ resourcePath: lumine.application.getResourcePath() });
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
    lumine.packages.emitter.emit("did-activate-package", {});
    expect(labels()).toEqual(["Open Package Manager", "separator", "Alpha", "Zulu"]);
  });
});
