const path = require("path");
const {
  activeSession,
  isModalOpen,
  visibleLabels,
  setQuery,
  confirm,
  dispatch,
  settle,
} = require("../../../spec/helpers/modal-helpers");

describe("fuzzy-explorer", () => {
  let main;

  const FILES = [
    path.normalize("/project/src/main.js"),
    path.normalize("/project/src/util.js"),
    path.normalize("/project/README.md"),
  ];

  beforeEach(() => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));

    // The package defers activation until one of its commands is dispatched.
    waitsForPromise(async () => {
      const activation = atom.packages.activatePackage("fuzzy-explorer");
      atom.commands.dispatch(atom.views.getView(atom.workspace), "fuzzy-explorer:toggle");
      main = (await activation).mainModule;
      await settle();
      if (atom.modals.isOpen()) atom.modals.cancel("api");
      await settle();

      // The index itself is covered by search-pattern-spec; these cases are
      // about what the list does with it.
      main.items = FILES.slice();
      spyOn(main, "build");
    });
  });

  afterEach(() => {
    if (atom.modals.isOpen()) atom.modals.cancel("api");
  });

  const open = async () => {
    atom.commands.dispatch(atom.views.getView(atom.workspace), "fuzzy-explorer:toggle");
    await settle();
  };

  it("lists the indexed paths and filters them", () => {
    waitsForPromise(async () => {
      await open();
      expect(visibleLabels().length).toBe(3);

      setQuery("util");
      await settle();
      expect(visibleLabels()).toEqual([path.normalize("/project/src/util.js")]);
    });
  });

  it("toggles closed when triggered again", () => {
    waitsForPromise(async () => {
      await open();
      await open();
      expect(isModalOpen()).toBe(false);
    });
  });

  it("drills into a directory instead of trying to open it", () => {
    waitsForPromise(async () => {
      // A real directory: the action stats the path to decide.
      const directory = __dirname;
      main.items = [directory];
      await open();
      confirm();
      await settle();

      // Still open, with the query seeded for the next segment.
      expect(isModalOpen()).toBe(true);
      expect(activeSession().getQuery().raw).toBe(directory + path.sep);
    });
  });

  it("copies the file name of the focused row", () => {
    waitsForPromise(async () => {
      await open();
      setQuery("README");
      await settle();

      const { clipboard } = require("electron");
      dispatch("modals:copy-file-name");
      await settle();

      expect(clipboard.readText()).toBe("README.md");
      expect(isModalOpen()).toBe(false);
    });
  });

  it("changes the separator without closing the list", () => {
    waitsForPromise(async () => {
      atom.config.set("fuzzy-explorer.separator", 0);
      await open();

      dispatch("modals:use-forward-slashes");
      await settle();

      expect(atom.config.get("fuzzy-explorer.separator")).toBe(1);
      expect(isModalOpen()).toBe(true);
    });
  });

  it("re-indexes without closing the list", () => {
    waitsForPromise(async () => {
      await open();

      dispatch("modals:refresh-index");
      await settle();

      expect(main.build).toHaveBeenCalled();
      expect(isModalOpen()).toBe(true);
    });
  });

  it("registers each action's keystroke under its own view scope", () => {
    waitsForPromise(async () => {
      await open();
      const bindings = atom.keymaps.findKeyBindings({
        command: "modals:show-in-folder",
        target: activeSession().element,
      });
      expect(bindings.length).toBe(1);
      expect(bindings[0].keystrokes).toBe("ctrl-enter");
    });
  });
});
