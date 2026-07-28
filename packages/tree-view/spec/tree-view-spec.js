const path = require("path");
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
    treeView.maxMeasuredContentWidth = 0;
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
    list.appendChild(file);
    scroller.appendChild(list);

    const stickyLayer = document.createElement("div");
    stickyLayer.classList.add("tree-view-sticky-header-layer");
    const stickyList = document.createElement("ol");
    stickyList.classList.add("tree-view-sticky-header-list", "list-tree");
    stickyList.style.height = "24px";
    const stickyEntry = document.createElement("li");
    stickyEntry.classList.add(
      "tree-view-sticky-header",
      "directory",
      "list-nested-item",
      "selected",
    );
    const stickyRow = document.createElement("div");
    stickyRow.classList.add("tree-view-sticky-header-row", "header", "list-item");
    stickyRow.textContent = "Source";
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
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(220, 225, 235)");

      tree.focus();
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(90, 138, 233)");
    } finally {
      stylesheet.dispose();
    }
  });
});
