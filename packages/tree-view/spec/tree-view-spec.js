const path = require("path");
const { webUtils } = require("electron");
const TreeView = require("../lib/tree-view");
const TreeEntry = require("../lib/tree-entry");

describe("TreeView.entryForPath", () => {
  function makeEntry(entryPath, { realPath = entryPath, containedPaths = [] } = {}) {
    const entry = document.createElement("li");
    entry.classList.add("entry");
    entry.getPath = () => entryPath;
    entry.isPathEqual = (pathToCompare) =>
      pathToCompare === entryPath || pathToCompare === realPath;
    if (containedPaths.length > 0) {
      entry.directory = { contains: (p) => containedPaths.includes(p) };
    }
    return entry;
  }

  function entryForPath(entries, entryPath) {
    const list = document.createElement("ol");
    for (const entry of entries) list.appendChild(entry);
    return TreeView.prototype.entryForPath.call({ list }, entryPath);
  }

  it("prefers an exact path match over an earlier symlink whose realpath matches", () => {
    const symlink = makeEntry("/root/AGENTS.md", { realPath: "/root/CLAUDE.md" });
    const target = makeEntry("/root/CLAUDE.md");

    expect(entryForPath([symlink, target], "/root/CLAUDE.md")).toBe(target);
    expect(entryForPath([symlink, target], "/root/AGENTS.md")).toBe(symlink);
  });

  it("resolves a realpath alias when no exact entry exists", () => {
    const symlink = makeEntry("/root/AGENTS.md", { realPath: "/elsewhere/CLAUDE.md" });
    const other = makeEntry("/root/README.md");

    expect(entryForPath([symlink, other], "/elsewhere/CLAUDE.md")).toBe(symlink);
  });

  it("falls back to the deepest directory containing the path", () => {
    const shallow = makeEntry("/root", { containedPaths: ["/root/sub/missing.md"] });
    const deep = makeEntry("/root/sub", { containedPaths: ["/root/sub/missing.md"] });

    expect(entryForPath([shallow, deep], "/root/sub/missing.md")).toBe(deep);
    expect(entryForPath([shallow], "/nowhere/missing.md")).toBeNull();
  });

  it("returns the mounted row for a logical entry", () => {
    const logicalEntry = { getPath: () => "/root/file.js" };
    const element = document.createElement("li");
    const treeView = {
      treeEntries: new Set([logicalEntry]),
      treeEntryForPath: jasmine.createSpy("treeEntryForPath").and.returnValue(logicalEntry),
      elementForTreeEntry: jasmine.createSpy("elementForTreeEntry").and.returnValue(element),
    };

    expect(TreeView.prototype.entryForPath.call(treeView, "/root/file.js")).toBe(element);
    expect(treeView.elementForTreeEntry).toHaveBeenCalledWith(logicalEntry);
  });
});

describe("TreeView root updates", () => {
  it("ignores updates after the project has been cleared during teardown", () => {
    const project = atom.project;
    const treeView = { selectedPaths: jasmine.createSpy("selectedPaths") };

    try {
      atom.project = null;
      expect(() => TreeView.prototype.updateRoots.call(treeView)).not.toThrow();
      expect(treeView.selectedPaths).not.toHaveBeenCalled();
    } finally {
      atom.project = project;
    }
  });
});

describe("TreeView OS file drops", () => {
  it("uses Electron's native path when adding a dropped folder as a project root", () => {
    const droppedFolder = {};
    const nativePath = path.resolve(__dirname, "..");
    spyOn(webUtils, "getPathForFile").and.callFake((file) =>
      file === droppedFolder ? nativePath : "",
    );
    spyOn(atom.project, "addPath");
    const event = {
      target: { closest: () => null },
      dataTransfer: { files: [droppedFolder] },
    };
    const treeView = {
      treeEntryForElement: () => null,
    };

    TreeView.prototype.onDrop.call(treeView, event);

    expect(atom.project.addPath).toHaveBeenCalledWith(nativePath);
  });

  it("ignores a dropped file when Electron cannot resolve its path", () => {
    spyOn(webUtils, "getPathForFile").and.returnValue("");
    spyOn(atom.project, "addPath");
    const event = {
      target: { closest: () => null },
      dataTransfer: { files: [{}] },
    };
    const treeView = {
      treeEntryForElement: () => null,
    };

    expect(() => TreeView.prototype.onDrop.call(treeView, event)).not.toThrow();
    expect(atom.project.addPath).not.toHaveBeenCalled();
  });
});

describe("TreeView construction", () => {
  let originalProjectPaths;
  let treeView;

  beforeEach(() => {
    originalProjectPaths = atom.project.getPaths();
    atom.project.setPaths([path.resolve(__dirname, "..")]);
  });

  afterEach(() => {
    treeView?.destroy();
    atom.project.setPaths(originalProjectPaths);
  });

  it("mounts project rows inside the scroller and keeps stickies outside it", () => {
    treeView = new TreeView({});

    expect(treeView.roots.length).toBe(1);
    expect(treeView.visibleRows[0]).toBe(treeView.roots[0]);
    expect(treeView.rowViews.has(treeView.roots[0])).toBe(true);
    expect(treeView.scroller.contains(treeView.elementForTreeEntry(treeView.roots[0]))).toBe(true);
    expect(treeView.scroller.contains(treeView.stickyHeaderLayer)).toBe(false);
    expect(treeView.stickyHeaderLayer.parentElement).toBe(treeView.viewport);
    expect(treeView.operationStatus.parentElement).toBe(treeView.element);
    expect(treeView.operationStatus.hidden).toBe(true);
    expect(treeView.fileOperationProcess.childProcess).toBeUndefined();
  });

  it("reports long-running cross-volume moves through the busy service", () => {
    treeView = new TreeView({});
    const provider = {
      add: jasmine.createSpy("add"),
      changeTitle: jasmine.createSpy("changeTitle"),
      dispose: jasmine.createSpy("dispose"),
    };
    treeView.setBusySignal({ create: () => provider });
    const sourcePath = path.join("root", "large.bin");

    treeView.beginOperationStatus({ id: 7, operation: "move", sourcePath });
    expect(provider.add).toHaveBeenCalledWith("tree-view: Moving large.bin");

    treeView.updateOperationStatus({ id: 7, phase: "copying-to-move" });
    expect(provider.changeTitle).toHaveBeenCalledWith(
      "tree-view: Copying to move large.bin",
      "tree-view: Moving large.bin",
    );

    treeView.finishOperationStatus();
    expect(provider.dispose).toHaveBeenCalled();
  });

  it("renders the current operation and queue with cancel buttons", () => {
    treeView = new TreeView({});
    const sourcePath = path.join("root", "large.bin");
    const nextPath = path.join("root", "next.bin");
    treeView.currentFileOperation = {
      id: 1,
      operation: "copy",
      sourcePath,
      phase: "copying",
      startedAt: Date.now(),
    };
    spyOn(treeView.fileOperationProcess, "getOperations").and.returnValue([
      {
        id: 1,
        operation: "copy",
        sourcePath,
        destinationPath: sourcePath + ".copy",
        state: "running",
      },
      {
        id: 2,
        operation: "copy",
        sourcePath: nextPath,
        destinationPath: nextPath + ".copy",
        state: "queued",
      },
    ]);
    spyOn(treeView.fileOperationProcess, "cancel").and.returnValue(true);

    treeView.showOperationStatus();

    const rows = treeView.operationStatus.querySelectorAll(".tree-view-operation-row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Copying large.bin");
    expect(rows[1].textContent).toContain("Next · Copy · next.bin");
    expect(rows[0].querySelector("button")).toHaveClass("tree-view-operation-cancel");
    rows[0].querySelector("button").click();
    rows[1].querySelector("button").click();
    expect(treeView.fileOperationProcess.cancel).toHaveBeenCalledWith(1);
    expect(treeView.fileOperationProcess.cancel).toHaveBeenCalledWith(2);
  });

  it("keeps editor path tracking isolated between queued moves", () => {
    treeView = new TreeView({});
    const firstPath = path.join("root", "first.txt");
    const secondPath = path.join("root", "second.txt");
    const firstBuffer = { setPath: jasmine.createSpy("firstSetPath") };
    const secondBuffer = { setPath: jasmine.createSpy("secondSetPath") };
    const editors = [
      { getPath: () => firstPath, getBuffer: () => firstBuffer },
      { getPath: () => secondPath, getBuffer: () => secondBuffer },
    ];
    spyOn(atom.workspace, "getTextEditors").and.returnValue(editors);

    treeView.emitter.emit("will-move-entry", { initialPath: firstPath });
    treeView.emitter.emit("will-move-entry", { initialPath: secondPath });
    treeView.emitter.emit("entry-moved", {
      initialPath: firstPath,
      newPath: path.join("root", "moved-first.txt"),
    });

    expect(firstBuffer.setPath).toHaveBeenCalledWith(path.join("root", "moved-first.txt"));
    expect(secondBuffer.setPath).not.toHaveBeenCalled();
    expect(treeView.editorsToMove.has(secondPath)).toBe(true);
  });

  it("keeps registered root sections before mounted project rows", () => {
    treeView = new TreeView({});
    const section = treeView.addSpecialRoot({
      name: "Recent",
      className: "recent",
      entryClassName: "recent-entry",
      iconClass: "icon-history",
      getEntries: () => [__filename],
    });

    expect(treeView.list.firstElementChild).toBe(section.element);
    expect(section.element.nextElementSibling).toBe(
      treeView.elementForTreeEntry(treeView.roots[0]),
    );
  });

  describe("when a root section stops showing its entries", () => {
    function sectionWithSelectedEntry() {
      treeView = new TreeView({});
      const section = treeView.addSpecialRoot({
        name: "Recent",
        className: "recent",
        entryClassName: "recent-entry",
        iconClass: "icon-history",
        getEntries: () => [__filename],
      });
      treeView.selectEntry(section.entries[0]);
      expect(treeView.getSelectedEntries()).toEqual([section.entries[0]]);
      return section;
    }

    // A closed section keeps its entries registered, so nothing drops them out
    // of the selection on its own — the selection would stay on a row that is
    // no longer rendered, and every command reading it would act on that row.
    it("hands the selection to the section root when it collapses", () => {
      const section = sectionWithSelectedEntry();

      section.collapse();

      expect(treeView.selectedEntries.has(section.entries[0])).toBe(false);
      expect(treeView.getSelectedEntries()).toEqual([section.root]);
      expect(treeView.lastFocusedEntry).toBe(section.root);
    });

    it("falls back to a project row when the section itself is hidden", () => {
      const section = sectionWithSelectedEntry();

      section.toggleVisible();

      expect(treeView.selectedEntries.has(section.entries[0])).toBe(false);
      expect(treeView.getSelectedEntries()).toEqual([treeView.roots[0]]);
    });

    it("leaves a selection outside the section alone", () => {
      const section = sectionWithSelectedEntry();
      treeView.selectEntry(treeView.roots[0]);

      section.collapse();

      expect(treeView.getSelectedEntries()).toEqual([treeView.roots[0]]);
    });
  });
});

describe("TreeView row model and sticky headers", () => {
  function item(name) {
    const entryPath = path.join("/root", name);
    return {
      name,
      path: entryPath,
      status: null,
      isPathEqual: (candidate) => candidate === entryPath,
      contains: () => false,
    };
  }

  function entry(treeView, name, kind, parent = null, options = {}) {
    const result = new TreeEntry(treeView, {
      item: item(name),
      kind,
      parent,
      ...options,
    });
    if (parent) parent.children.push(result);
    result.isExpanded = kind === "directory";
    return result;
  }

  function layout(treeView, roots, regularHeight = 24, rootHeight = 32) {
    const rows = [];
    const tops = [0];
    const append = (current, depth) => {
      current.depth = depth;
      current.index = rows.length;
      current.top = tops[tops.length - 1];
      current.height = current.projectRoot ? rootHeight : regularHeight;
      rows.push(current);
      tops.push(current.top + current.height);
      if (current.kind === "directory" && current.isExpanded) {
        for (const child of current.children) append(child, depth + 1);
      }
      current.subtreeEndIndex = rows.length;
    };
    for (const root of roots) append(root, 0);
    treeView.visibleRows = rows;
    treeView.rowTops = tops;
  }

  function stickyHarness() {
    const treeView = Object.create(TreeView.prototype);
    treeView.stickyHeadersEnabled = true;
    treeView.scroller = document.createElement("div");
    Object.defineProperties(treeView.scroller, {
      scrollTop: { value: 0, writable: true },
      scrollLeft: { value: 0, writable: true },
    });
    treeView.list = document.createElement("ol");
    treeView.list.style.width = "300px";
    treeView.selectedEntries = new Set();
    return treeView;
  }

  it("keeps the root stable from the first scroll position and derives nested stickies from offsets", () => {
    const treeView = stickyHarness();
    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const source = entry(treeView, "source", "directory", root);
    const components = entry(treeView, "components", "directory", source);
    entry(treeView, "button.js", "file", components);
    layout(treeView, [root]);

    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual(["root"]);

    treeView.scroller.scrollTop = 1;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual([
      "root",
      "source",
      "components",
    ]);
  });

  it("unpins a directory exactly when its final descendant leaves its sticky slot", () => {
    const treeView = stickyHarness();
    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const directory = entry(treeView, "source", "directory", root);
    entry(treeView, "last.js", "file", directory);
    layout(treeView, [root]);

    treeView.scroller.scrollTop = 47;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual([
      "root",
      "source",
    ]);

    treeView.scroller.scrollTop = 48;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual(["root"]);
  });

  it("pushes an ending sticky directory upward before its next sibling", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const directory = entry(treeView, "source", "directory", root);
    entry(treeView, "last.js", "file", directory);
    entry(treeView, "next-directory", "directory", root);
    layout(treeView, [root]);

    treeView.scroller.scrollTop = 25;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());

    expect(treeView.stickyHeaderList.children.length).toBe(2);
    expect(treeView.stickyHeaderList.children[1].style.top).toBe("-1px");
    expect(treeView.stickyHeaderList.children[0].style.zIndex).toBe("2");
    expect(treeView.stickyHeaderList.children[1].style.zIndex).toBe("1");

    treeView.scroller.scrollTop = 47;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());
    expect(treeView.stickyHeaderList.children[1].style.top).toBe("-23px");

    treeView.scroller.scrollTop = 48;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());
    expect(treeView.stickyHeaderList.children.length).toBe(1);
    treeView.clearStickyHeaderViews();
  });

  it("shrinks the sticky list with a departing header instead of covering the reveal", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const documents = entry(treeView, "documents", "directory", root);
    entry(treeView, "a.txt", "file", documents);
    entry(treeView, "b.txt", "file", documents);
    const sibling = entry(treeView, "bcdr", "directory", root);
    entry(treeView, "main.ipy", "file", sibling);
    layout(treeView, [root]);

    treeView.scroller.scrollTop = 60;
    treeView.renderStickyHeaderEntries(treeView.collectStickyHeaderEntries());

    expect(treeView.stickyHeaderList.children.length).toBe(2);
    expect(treeView.stickyHeaderList.children[1].style.top).toBe("-12px");
    // The departing header's subtree ends 44px below the viewport top, so the
    // opaque list must end there too. At the summed 56px, a dead band below
    // the pushed header blankets the top of the sibling row sliding in — one
    // band per simultaneously departing header.
    expect(treeView.stickyHeaderList.style.height).toBe("44px");
    treeView.clearStickyHeaderViews();
  });

  it("switches roots from logical row boundaries without reading layout geometry", () => {
    const treeView = stickyHarness();
    const first = entry(treeView, "first", "directory", null, { projectRoot: true });
    entry(treeView, "one.js", "file", first);
    const second = entry(treeView, "second", "directory", null, { projectRoot: true });
    entry(treeView, "two.js", "file", second);
    layout(treeView, [first, second]);

    treeView.scroller.scrollTop = second.top;
    expect(treeView.collectStickyHeaderEntries().map((row) => row.name)).toEqual(["second"]);
  });

  it("updates immediately on scroll instead of waiting for another animation frame", () => {
    const treeView = {
      stickyHeadersEnabled: true,
      stickyHeaderUpdateFrame: 42,
      updateStickyHeaderOverlay: jasmine.createSpy("updateStickyHeaderOverlay"),
    };
    spyOn(window, "cancelAnimationFrame");

    TreeView.prototype.updateStickyHeadersOnScroll.call(treeView);

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(treeView.stickyHeaderUpdateFrame).toBeNull();
    expect(treeView.updateStickyHeaderOverlay).toHaveBeenCalled();
  });

  it("clips sticky paint to the scrollport before the scrollbar", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.contentWidth = 300;
    treeView.scrollportWidth = 284;
    treeView.renderStickyHeaderEntries = jasmine.createSpy("renderStickyHeaderEntries");
    treeView.collectStickyHeaderEntries = jasmine
      .createSpy("collectStickyHeaderEntries")
      .and.returnValue([]);

    treeView.updateStickyHeaderOverlay();

    expect(treeView.stickyHeaderList.style.left).toBe("0px");
    expect(treeView.stickyHeaderList.style.width).toBe("300px");
    expect(treeView.stickyHeaderList.style.clipPath).toBe("inset(0px 16px 0px 0px)");

    treeView.contentWidth = 400;
    treeView.scroller.scrollLeft = 30;
    treeView.updateStickyHeaderOverlay();

    expect(treeView.stickyHeaderList.style.left).toBe("-30px");
    expect(treeView.stickyHeaderList.style.width).toBe("400px");
    expect(treeView.stickyHeaderList.style.clipPath).toBe("inset(0px 86px 0px 30px)");
  });

  it("renders sticky rows from the same logical entry without source-row handoffs", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    root.height = 32;
    root.depth = 0;

    treeView.renderStickyHeaderEntries([root]);
    const stickyElement = treeView.stickyHeaderList.firstElementChild;
    expect(stickyElement.treeEntry).toBe(root);
    expect(stickyElement.classList.contains("tree-view-sticky-header")).toBe(true);
    expect(treeView.treeEntryForElement(stickyElement.firstElementChild)).toBe(root);

    treeView.selectedEntries.add(root);
    root.item.status = "modified";
    treeView.renderStickyHeaderEntries([root]);
    expect(treeView.stickyHeaderList.firstElementChild).toBe(stickyElement);
    expect(stickyElement.classList.contains("selected")).toBe(true);
    expect(stickyElement.classList.contains("status-modified")).toBe(true);

    treeView.renderStickyHeaderEntries([]);
    expect(treeView.stickyHeaderLayer.hidden).toBe(true);
    expect(root.views.size).toBe(0);
  });

  it("refreshes a reused sticky row when the measured row grid changes", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    root.height = 32;
    root.depth = 0;

    treeView.renderStickyHeaderEntries([root]);
    const stickyElement = treeView.stickyHeaderList.firstElementChild;
    expect(stickyElement.style.height).toBe("32px");
    expect(treeView.stickyHeaderList.style.height).toBe("32px");

    // A stylesheet arriving after the sticky mounted re-measured the rows.
    // The copy is in the stable prefix, so it is reused, not recreated — it
    // must follow the new grid the way renderVisibleRows refreshes real rows.
    root.height = 24;
    treeView.renderStickyHeaderEntries([root]);

    expect(treeView.stickyHeaderList.firstElementChild).toBe(stickyElement);
    expect(stickyElement.style.height).toBe("24px");
    expect(treeView.stickyHeaderList.style.height).toBe("24px");
    treeView.clearStickyHeaderViews();
  });

  it("keeps the stable sticky prefix mounted when a nested directory joins the stack", () => {
    const treeView = stickyHarness();
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    const source = entry(treeView, "source", "directory", root);
    root.height = 32;
    source.height = 24;

    treeView.renderStickyHeaderEntries([root]);
    const rootElement = treeView.stickyHeaderList.firstElementChild;
    treeView.renderStickyHeaderEntries([root, source]);

    expect(treeView.stickyHeaderList.firstElementChild).toBe(rootElement);
    expect(treeView.stickyHeaderList.lastElementChild.treeEntry).toBe(source);
    treeView.clearStickyHeaderViews();
  });

  it("keeps every visible row mounted while scrolling", () => {
    const treeView = stickyHarness();
    treeView.stickyHeadersEnabled = false;
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];
    treeView.rowViews = new Map();
    treeView.specialRoots = [];
    treeView.contentWidth = 0;
    treeView.regularRowHeight = 24;
    treeView.list = document.createElement("ol");
    Object.defineProperty(treeView.scroller, "clientWidth", { value: 300 });

    const root = entry(treeView, "root", "directory", null, { projectRoot: true });
    for (let index = 0; index < 100; index++) {
      entry(treeView, `file-${index}.js`, "file", root);
    }
    layout(treeView, [root]);

    treeView.renderVisibleRows();
    const initialElements = new Map(
      Array.from(treeView.rowViews, ([row, view]) => [row, view.element]),
    );
    expect(treeView.rowViews.size).toBe(treeView.visibleRows.length);

    treeView.scroller.scrollTop = 12000;
    treeView.updateStickyHeaderOverlay();
    expect(treeView.rowViews.size).toBe(treeView.visibleRows.length);
    for (const [row, element] of initialElements) {
      expect(treeView.rowViews.get(row).element).toBe(element);
    }
    treeView.destroyRowViews();
  });

  it("keeps the package-owned state and clears the overlay when disabled", () => {
    const treeView = {
      element: document.createElement("div"),
      scheduleStickyHeadersUpdate: jasmine.createSpy("scheduleStickyHeadersUpdate"),
      renderStickyHeaderEntries: jasmine.createSpy("renderStickyHeaderEntries"),
    };

    TreeView.prototype.setStickyHeadersEnabled.call(treeView, true);
    expect(treeView.element.classList.contains("sticky-headers")).toBe(true);
    expect(treeView.scheduleStickyHeadersUpdate).toHaveBeenCalled();

    TreeView.prototype.setStickyHeadersEnabled.call(treeView, false);
    expect(treeView.element.classList.contains("sticky-headers")).toBe(false);
    expect(treeView.renderStickyHeaderEntries).toHaveBeenCalledWith([]);
  });

  it("keeps scrolling and sticky paint in separate surfaces", () => {
    const stylesheet = atom.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "tree-view-plus.css"),
    );
    const tree = document.createElement("div");
    tree.classList.add("tree-view");
    tree.tabIndex = -1;
    tree.style.cssText = `
      --tree-view-background-color: rgb(242, 242, 242);
      --tree-view-sticky-background: rgb(242, 242, 242);
      --background-color-selected: rgb(220, 225, 235);
      --button-background-color-selected: rgb(90, 138, 233);
      --ui-line-height: 24px;
      --ui-tab-height: 32px;
      --ui-size: 12px;
      --component-padding: 8px;
      --component-icon-padding: 5px;
      --disclosure-arrow-size: 12px;
      --tree-view-row-inset: 4px;
      --tree-view-row-border-radius: 6px;
    `;

    const viewport = document.createElement("div");
    viewport.classList.add("tree-view-viewport");
    const scroller = document.createElement("div");
    scroller.classList.add("tree-view-scroller");
    const list = document.createElement("ol");
    list.classList.add("tree-view-root", "list-tree", "has-collapsable-children");
    const file = document.createElement("li");
    file.classList.add("file", "entry", "list-item", "tree-view-row", "selected");
    file.style.setProperty("--tree-view-depth", "1");
    const fileName = document.createElement("span");
    fileName.classList.add("name");
    fileName.textContent = "styles.css";
    file.appendChild(fileName);

    const directory = document.createElement("li");
    directory.classList.add("directory", "entry", "list-nested-item", "tree-view-row", "expanded");
    directory.style.setProperty("--tree-view-depth", "1");
    const directoryRow = document.createElement("div");
    directoryRow.classList.add("header", "list-item");
    const directoryName = document.createElement("span");
    directoryName.classList.add("name");
    directoryName.textContent = "Source";
    directoryRow.appendChild(directoryName);
    directory.appendChild(directoryRow);

    const root = document.createElement("li");
    root.classList.add(
      "directory",
      "entry",
      "list-nested-item",
      "tree-view-row",
      "project-root",
      "expanded",
    );
    root.style.setProperty("--tree-view-depth", "0");
    const rootHeader = document.createElement("div");
    rootHeader.classList.add("header", "list-item", "project-root-header");
    const rootName = document.createElement("span");
    rootName.classList.add("name");
    rootName.textContent = "project";
    rootHeader.appendChild(rootName);
    root.appendChild(rootHeader);

    list.append(root, file, directory);
    scroller.appendChild(list);

    const stickyLayer = document.createElement("div");
    stickyLayer.classList.add("tree-view-sticky-header-layer");
    const stickyList = document.createElement("ol");
    stickyList.classList.add(
      "tree-view-sticky-header-list",
      "list-tree",
      "has-collapsable-children",
    );
    stickyList.style.height = "24px";
    const stickyEntry = document.createElement("li");
    stickyEntry.classList.add(
      "tree-view-sticky-header",
      "directory",
      "list-nested-item",
      "selected",
    );
    stickyEntry.style.setProperty("--tree-view-depth", "1");
    const stickyRow = document.createElement("div");
    stickyRow.classList.add("tree-view-sticky-header-row", "header", "list-item");
    const stickyName = document.createElement("span");
    stickyName.classList.add("name");
    stickyName.textContent = "Source";
    stickyRow.appendChild(stickyName);
    stickyEntry.appendChild(stickyRow);
    stickyList.appendChild(stickyEntry);
    stickyLayer.appendChild(stickyList);
    viewport.append(scroller, stickyLayer);
    tree.appendChild(viewport);
    jasmine.attachToDOM(tree);

    try {
      expect(getComputedStyle(tree).overflow).toBe("hidden");
      expect(getComputedStyle(scroller).overflow).toBe("auto");
      expect(getComputedStyle(file).marginLeft).toBe("0px");
      expect(getComputedStyle(fileName).position).toBe("relative");
      expect(getComputedStyle(file, "::before").backgroundColor).toBe("rgb(220, 225, 235)");
      expect(getComputedStyle(stickyLayer).position).toBe("absolute");
      expect(getComputedStyle(stickyLayer).height).toBe("0px");
      expect(getComputedStyle(stickyList).overflow).toBe("hidden");
      expect(getComputedStyle(stickyList).contain).toBe("paint");
      expect(getComputedStyle(stickyList).transform).toBe("none");
      expect(getComputedStyle(stickyList).backgroundColor).toBe("rgb(242, 242, 242)");
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(220, 225, 235)");
      const directoryRowStyle = getComputedStyle(directoryRow);
      const stickyRowStyle = getComputedStyle(stickyRow);
      const directoryDisclosureLeft =
        directoryRow.getBoundingClientRect().left + parseFloat(directoryRowStyle.paddingLeft);
      const stickyDisclosureLeft =
        stickyRow.getBoundingClientRect().left + parseFloat(stickyRowStyle.paddingLeft);
      // The indent lives on the row `li` as padding, not on the header — the
      // header itself starts at the li's content edge.
      expect(getComputedStyle(directory).paddingLeft).toBe("22px");
      expect(directoryRowStyle.marginLeft).toBe("0px");
      expect(stickyDisclosureLeft).toBe(directoryDisclosureLeft);
      // The root header takes its height from --tree-view-root-header-height
      // (tab height here), not from the generic list line-height — the rule
      // reading the variable loses that fight without the :not(.project-root)
      // exclusion, and the variable is silently dead.
      expect(getComputedStyle(rootHeader).lineHeight).toBe("32px");
      expect(rootHeader.getBoundingClientRect().height).toBe(32);
      expect(getComputedStyle(directoryRow).lineHeight).toBe("24px");
      expect(stickyName.getBoundingClientRect().top - stickyEntry.getBoundingClientRect().top).toBe(
        directoryName.getBoundingClientRect().top - directory.getBoundingClientRect().top,
      );
      expect(stickyRow.getBoundingClientRect().height).toBe(
        directoryRow.getBoundingClientRect().height,
      );

      tree.focus();
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(90, 138, 233)");
    } finally {
      stylesheet.dispose();
    }
  });

  it("joins adjacent rounded selections into continuous areas", () => {
    const stylesheet = atom.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "tree-view-plus.css"),
    );
    const tree = document.createElement("div");
    tree.classList.add("tree-view");
    tree.style.cssText = `
      --tree-view-row-border-radius: 6px;
      --tree-view-row-inset: 4px;
      --ui-line-height: 24px;
    `;
    const list = document.createElement("ol");
    list.classList.add("tree-view-root", "list-tree");

    const row = (...classNames) => {
      const element = document.createElement("li");
      element.classList.add("entry", "tree-view-row", ...classNames);
      return element;
    };
    const first = row("selected");
    const middle = row("selected");
    const last = row("selected");
    const isolated = row("selected");
    const dragTarget = row("selected", "drag-over");
    const afterDragTarget = row("selected");
    list.append(first, middle, last, row(), isolated, row(), dragTarget, afterDragTarget);

    const stickyList = document.createElement("ol");
    stickyList.classList.add("tree-view-sticky-header-list", "list-tree");
    const sticky = () => {
      const entry = document.createElement("li");
      entry.classList.add("entry", "tree-view-sticky-header", "selected");
      const header = document.createElement("div");
      header.classList.add("tree-view-sticky-header-row");
      entry.appendChild(header);
      return { entry, header };
    };
    const firstSticky = sticky();
    const lastSticky = sticky();
    stickyList.append(firstSticky.entry, lastSticky.entry);
    tree.append(list, stickyList);
    jasmine.attachToDOM(tree);

    try {
      const selectionStyle = (entry) => getComputedStyle(entry, "::before");

      expect(selectionStyle(first).borderTopLeftRadius).toBe("6px");
      expect(selectionStyle(first).borderBottomLeftRadius).toBe("0px");
      expect(selectionStyle(middle).borderTopLeftRadius).toBe("0px");
      expect(selectionStyle(middle).borderBottomLeftRadius).toBe("0px");
      expect(selectionStyle(last).borderTopLeftRadius).toBe("0px");
      expect(selectionStyle(last).borderBottomLeftRadius).toBe("6px");
      expect(selectionStyle(isolated).borderRadius).toBe("6px");
      expect(selectionStyle(dragTarget).borderRadius).toBe("6px");
      expect(selectionStyle(afterDragTarget).borderRadius).toBe("6px");

      expect(getComputedStyle(firstSticky.header).borderTopLeftRadius).toBe("6px");
      expect(getComputedStyle(firstSticky.header).borderBottomLeftRadius).toBe("0px");
      expect(getComputedStyle(lastSticky.header).borderTopLeftRadius).toBe("0px");
      expect(getComputedStyle(lastSticky.header).borderBottomLeftRadius).toBe("6px");
    } finally {
      tree.remove();
      stylesheet.dispose();
    }
  });

  // The list sizes itself, rather than script writing back the widest row it
  // measured: a row is `min-width: 100%` of the list, so a measured maximum
  // fed back into the list width can only ever grow.
  it("follows a long row's width back down when the row goes away", () => {
    const stylesheet = atom.themes.requireStylesheet(
      path.join(__dirname, "..", "styles", "tree-view-plus.css"),
    );
    const tree = document.createElement("div");
    tree.classList.add("tree-view");
    tree.style.cssText = `
      width: 200px;
      height: 300px;
      --ui-line-height: 24px;
      --ui-size: 12px;
      --component-padding: 8px;
      --component-icon-padding: 5px;
      --disclosure-arrow-size: 12px;
    `;

    const viewport = document.createElement("div");
    viewport.classList.add("tree-view-viewport");
    const scroller = document.createElement("div");
    scroller.classList.add("tree-view-scroller");
    const list = document.createElement("ol");
    list.classList.add("tree-view-root", "list-tree", "has-collapsable-children");

    function row(name) {
      const element = document.createElement("li");
      element.classList.add("file", "entry", "list-item", "tree-view-row");
      element.style.setProperty("--tree-view-depth", "0");
      const label = document.createElement("span");
      label.classList.add("name");
      label.textContent = name;
      element.appendChild(label);
      return element;
    }

    // A root section is its own list nested in the tree, and it no longer gets
    // a width written onto it either.
    const section = document.createElement("ol");
    section.classList.add("recent", "tree-view-special", "list-tree", "has-collapsable-children");
    const sectionRow = row("b.js");
    section.appendChild(sectionRow);

    const short = row("a.js");
    const long = row(`${"long-".repeat(20)}name.js`);
    list.append(section, short, long);
    scroller.appendChild(list);
    viewport.appendChild(scroller);
    tree.appendChild(viewport);
    jasmine.attachToDOM(tree);

    try {
      const available = scroller.clientWidth;
      const overflowing = list.getBoundingClientRect().width;
      expect(overflowing).toBeGreaterThan(available);
      // Short rows still stretch across the whole scrollable width, so hover
      // and selection do not stop at the end of the name.
      expect(short.getBoundingClientRect().width).toBe(overflowing);
      expect(section.getBoundingClientRect().width).toBe(overflowing);
      expect(sectionRow.getBoundingClientRect().width).toBe(overflowing);

      long.remove();

      expect(list.getBoundingClientRect().width).toBe(available);
      expect(short.getBoundingClientRect().width).toBe(available);
      expect(sectionRow.getBoundingClientRect().width).toBe(available);
    } finally {
      stylesheet.dispose();
    }
  });
});
