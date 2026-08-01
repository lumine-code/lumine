const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

describe("fuzzy-files recent files", () => {
  let dir, main, workspaceElement;

  beforeEach(async () => {
    dir = fs.realpathSync.native(temp.mkdirSync("fuzzy-files-recent-"));
    for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
      fs.writeFileSync(path.join(dir, name), `${name}\n`);
    }
    atom.project.setPaths([dir]);
    atom.config.set("fuzzy-files.recentCount", 10);
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);

    const activation = atom.packages.activatePackage("fuzzy-files");
    atom.commands.dispatch(workspaceElement, "fuzzy-files:toggle");
    main = (await activation).mainModule;
    await new Promise((resolve, reject) => {
      main.cache((error) => (error ? reject(error) : resolve()));
    });
    main.selectList.hide();
    main.clearRecent();
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("fuzzy-files");
  });

  function itemNamed(name) {
    return main.items.find((item) => item.fPath === name);
  }

  async function showList() {
    main.selectList.show();
    await atom.views.getNextUpdatePromise();
    return main.selectList;
  }

  it("remembers opened files and separates them from the ordinary results", async () => {
    const beta = itemNamed("beta.txt");
    const open = spyOn(atom.workspace, "open").and.returnValue(Promise.resolve());
    const selectList = await showList();
    await selectList.selectItem(beta);

    main.performAction("open");

    expect(open).toHaveBeenCalled();
    expect(open.calls.mostRecent().args[0]).toBe(beta.aPath);
    expect(main.recentlyUsed).toEqual([beta.aPath]);
    expect(main.serialize()).toEqual({ recentlyUsed: [beta.aPath] });

    await showList();
    expect(selectList.items[0].aPath).toBe(beta.aPath);
    const separator = selectList.element.querySelector(".select-list-separator");
    expect(separator.previousElementSibling.textContent).toContain("beta.txt");
    expect(separator.nextElementSibling.textContent).not.toContain("beta.txt");

    selectList.refs.queryEditor.setText("alpha");
    await atom.views.getNextUpdatePromise();
    expect(selectList.getIdForItem(beta)).toBeNull();
    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();

    selectList.refs.queryEditor.setText("");
    await atom.views.getNextUpdatePromise();
    atom.commands.dispatch(workspaceElement, "fuzzy-files:clear-recent");
    await atom.views.getNextUpdatePromise();
    expect(main.recentlyUsed).toEqual([]);
    expect(selectList.element.querySelector(".select-list-separator")).toBeNull();
  });

  it("caps recent files at the configured count", () => {
    atom.config.set("fuzzy-files.recentCount", 2);
    main.recordRecent(itemNamed("alpha.txt"));
    main.recordRecent(itemNamed("beta.txt"));
    main.recordRecent(itemNamed("gamma.txt"));

    expect(main.recentlyUsed).toEqual([itemNamed("gamma.txt").aPath, itemNamed("beta.txt").aPath]);
  });

  it("restores recent files from serialized package state", () => {
    const betaPath = itemNamed("beta.txt").aPath;
    main.recordRecent(itemNamed("beta.txt"));
    const state = main.serialize();
    main.deactivate();

    main.activate(state);

    expect(main.recentlyUsed).toEqual([betaPath]);
  });
});
