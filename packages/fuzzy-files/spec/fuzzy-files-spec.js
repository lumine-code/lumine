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

describe("fuzzy-files", () => {
  let main;

  const itemFor = (relative) => ({
    aPath: path.join(__dirname, relative),
    fPath: relative,
    pPath: __dirname,
    distance: 1,
  });

  beforeEach(() => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    // With no project paths, the index short-circuits instead of starting a
    // real crawl, so activation cannot race these cases.
    atom.project.setPaths([]);

    // The package defers activation until one of its commands is dispatched.
    waitsForPromise(async () => {
      const activation = atom.packages.activatePackage("fuzzy-files");
      atom.commands.dispatch(atom.views.getView(atom.workspace), "fuzzy-files:toggle");
      main = (await activation).mainModule;

      // The crawl itself is covered by path-loader-spec; these cases are about
      // what the list does with its results, so stub it out before the
      // activation's own open can start one.
      main.needRebuild = false;
      main.projectCount = 1;
      main.items = [itemFor("fuzzy-files-spec.js"), itemFor("path-loader-spec.js")];
      spyOn(main, "relativize");
      spyOn(main, "cache").andCallFake((done) => done && done());

      await settle();
      if (atom.modals.isOpen()) atom.modals.cancel("api");
      await settle();
    });
  });

  afterEach(() => {
    if (atom.modals.isOpen()) atom.modals.cancel("api");
  });

  const open = async () => {
    atom.commands.dispatch(atom.views.getView(atom.workspace), "fuzzy-files:toggle");
    await settle();
  };

  it("lists the indexed paths and filters them", () => {
    waitsForPromise(async () => {
      await open();
      expect(visibleLabels().length).toBe(2);

      setQuery("path-loader");
      await settle();
      expect(visibleLabels()).toEqual(["path-loader-spec.js"]);
    });
  });

  it("splits a trailing :line off the query before matching", () => {
    waitsForPromise(async () => {
      await open();
      setQuery("path-loader:42");
      await settle();

      const query = activeSession().getQuery();
      expect(query.text).toBe("path-loader");
      expect(query.initialLine).toBe(41);
      // The line suffix must not reach the matcher, or nothing would match.
      expect(visibleLabels()).toEqual(["path-loader-spec.js"]);
    });
  });

  it("opens the confirmed file at the requested line", () => {
    waitsForPromise(async () => {
      spyOn(atom.workspace, "open").andReturn(Promise.resolve());
      await open();
      setQuery("path-loader:7");
      await settle();
      confirm();
      await settle();

      expect(atom.workspace.open).toHaveBeenCalled();
      const [openedPath, options] = atom.workspace.open.mostRecentCall.args;
      expect(openedPath).toBe(path.join(__dirname, "path-loader-spec.js"));
      expect(options.initialLine).toBe(6);
      expect(isModalOpen()).toBe(false);
    });
  });

  it("drills into a directory instead of trying to open it", () => {
    waitsForPromise(async () => {
      main.items = [
        { aPath: __dirname, fPath: path.basename(__dirname), pPath: __dirname, distance: 1 },
      ];
      await open();
      confirm();
      await settle();

      expect(isModalOpen()).toBe(true);
      expect(activeSession().getQuery().raw).toBe(path.basename(__dirname) + path.sep);
    });
  });

  it("re-indexes without closing the list", () => {
    waitsForPromise(async () => {
      await open();

      dispatch("modals:refresh-index");
      await settle();

      expect(main.cache).toHaveBeenCalled();
      expect(isModalOpen()).toBe(true);
    });
  });

  it("registers each action's keystroke under its own view scope", () => {
    waitsForPromise(async () => {
      await open();
      const bindings = atom.keymaps.findKeyBindings({
        command: "modals:trash",
        target: activeSession().element,
      });
      expect(bindings.length).toBe(1);
      expect(bindings[0].keystrokes).toBe("alt-delete");
    });
  });
});
