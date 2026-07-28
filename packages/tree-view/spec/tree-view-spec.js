const path = require("path");
const TreeView = require("../lib/tree-view");

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

describe("TreeView sticky headers", () => {
  function rect(top, bottom, left = 0, width = 300) {
    return {
      top,
      right: left + width,
      bottom,
      left,
      width,
      height: bottom - top,
    };
  }

  function directory({ top, bottom, headerTop, headerHeight, left = 0, projectRoot = false }) {
    const entry = document.createElement("li");
    entry.classList.add("directory", "entry", "list-nested-item", "expanded");
    if (projectRoot) entry.classList.add("project-root");

    const header = document.createElement("div");
    header.classList.add("header", "list-item");
    if (projectRoot) header.classList.add("project-root-header");
    header.textContent = projectRoot ? "Project" : "Directory";

    const entries = document.createElement("ol");
    entries.classList.add("entries", "list-tree");
    entry.append(header, entries);
    entry.header = header;
    entry.entries = entries;
    entry.getBoundingClientRect = () => rect(top, bottom, left);
    header.getBoundingClientRect = () => rect(headerTop, headerTop + headerHeight, left);
    return entry;
  }

  it("toggles the package-owned state and clears the overlay when disabled", () => {
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

  it("collects only the expanded ancestor chain that has crossed each sticky slot", () => {
    const treeView = Object.create(TreeView.prototype);
    treeView.stickyHeadersEnabled = true;
    treeView.element = document.createElement("div");
    treeView.element.getBoundingClientRect = () => rect(0, 220);
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.element.appendChild(treeView.stickyHeaderLayer);

    const root = directory({
      top: -80,
      bottom: 300,
      headerTop: -80,
      headerHeight: 32,
      projectRoot: true,
    });
    const source = directory({
      top: -48,
      bottom: 260,
      headerTop: -48,
      headerHeight: 24,
      left: 18,
    });
    const components = directory({
      top: -24,
      bottom: 180,
      headerTop: -24,
      headerHeight: 24,
      left: 36,
    });
    root.entries.appendChild(source);
    source.entries.appendChild(components);
    treeView.element.appendChild(root);

    expect(treeView.collectStickyHeaderEntries()).toEqual([root, source, components]);

    root.header.getBoundingClientRect = () => rect(0, 32);
    expect(treeView.collectStickyHeaderEntries()).toEqual([]);
  });

  it("keeps a directory pinned until its final descendant has passed the sticky slot", () => {
    const treeView = Object.create(TreeView.prototype);
    treeView.stickyHeadersEnabled = true;
    treeView.element = document.createElement("div");
    treeView.element.getBoundingClientRect = () => rect(0, 220);
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.element.appendChild(treeView.stickyHeaderLayer);

    const root = directory({
      top: -40,
      bottom: 200,
      headerTop: -40,
      headerHeight: 32,
      projectRoot: true,
    });
    const directoryWithFinalFile = directory({
      top: -8,
      bottom: 40,
      headerTop: -8,
      headerHeight: 24,
      left: 18,
    });
    root.entries.appendChild(directoryWithFinalFile);
    treeView.element.appendChild(root);

    expect(treeView.collectStickyHeaderEntries()).toEqual([root, directoryWithFinalFile]);

    directoryWithFinalFile.getBoundingClientRect = () => rect(-8, 32, 18);
    expect(treeView.collectStickyHeaderEntries()).toEqual([root]);
  });

  it("keeps rendered header elements stable while synchronizing selection and status", () => {
    const treeView = Object.create(TreeView.prototype);
    treeView.element = document.createElement("div");
    treeView.element.getBoundingClientRect = () => rect(0, 220);
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderLayer.hidden = true;
    treeView.stickyHeaderLayer.getBoundingClientRect = () =>
      treeView.stickyHeaderLayer.hidden ? rect(0, 0, 0, 0) : rect(0, 0, 10);
    treeView.stickyHeaderEntries = [];
    treeView.stickyHeaderOriginals = new WeakMap();

    const root = directory({
      top: -32,
      bottom: 300,
      headerTop: -32,
      headerHeight: 32,
      left: 15,
      projectRoot: true,
    });
    treeView.element.append(root, treeView.stickyHeaderLayer);

    treeView.renderStickyHeaderEntries([root]);
    const stickyEntry = treeView.stickyHeaderList.firstElementChild;
    expect(root.classList.contains("tree-view-sticky-header-source")).toBe(true);
    expect(stickyEntry.classList.contains("entry")).toBe(false);
    expect(stickyEntry.textContent).toBe("Project");
    expect(stickyEntry.style.getPropertyValue("--tree-view-sticky-content-offset")).toBe("5px");
    expect(treeView.stickyHeaderList.style.height).toBe("32px");

    root.classList.add("selected", "status-modified");
    treeView.renderStickyHeaderEntries([root]);
    expect(treeView.stickyHeaderList.firstElementChild).toBe(stickyEntry);
    expect(stickyEntry.classList.contains("selected")).toBe(true);
    expect(stickyEntry.classList.contains("status-modified")).toBe(true);

    root.header.textContent = "Renamed Project";
    treeView.renderStickyHeaderEntries([root]);
    expect(treeView.stickyHeaderList.firstElementChild).toBe(stickyEntry);
    expect(stickyEntry.textContent).toBe("Renamed Project");

    treeView.renderStickyHeaderEntries([]);
    expect(root.classList.contains("tree-view-sticky-header-source")).toBe(false);
    expect(treeView.stickyHeaderLayer.hidden).toBe(true);
    expect(treeView.stickyHeaderList.style.height).toBe("");
  });

  it("keeps the sticky stack fully backed without transforming its rows", () => {
    const treeView = Object.create(TreeView.prototype);
    treeView.element = document.createElement("div");
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderLayer.getBoundingClientRect = () => rect(0, 0);
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];
    treeView.stickyHeaderOriginals = new WeakMap();

    const root = directory({
      top: -40,
      bottom: 200,
      headerTop: -40,
      headerHeight: 32,
      projectRoot: true,
    });
    const endingDirectory = directory({
      top: -8,
      bottom: 40,
      headerTop: -8,
      headerHeight: 24,
      left: 18,
    });

    treeView.renderStickyHeaderEntries([root, endingDirectory]);

    const stickyEntries = treeView.stickyHeaderList.children;
    expect(stickyEntries[0].style.transform).toBe("");
    expect(stickyEntries[1].style.transform).toBe("");
    expect(treeView.stickyHeaderList.style.height).toBe("56px");

    endingDirectory.getBoundingClientRect = () => rect(-8, 33, 18);
    treeView.renderStickyHeaderEntries([root, endingDirectory]);
    expect(treeView.stickyHeaderList.children[1]).toBe(stickyEntries[1]);
    expect(treeView.stickyHeaderList.style.height).toBe("56px");
  });

  it("forwards pointer actions to the original directory header", () => {
    const treeView = Object.create(TreeView.prototype);
    treeView.element = document.createElement("div");
    treeView.element.getBoundingClientRect = () => rect(0, 220);
    treeView.stickyHeaderLayer = document.createElement("div");
    treeView.stickyHeaderList = document.createElement("ol");
    treeView.stickyHeaderLayer.appendChild(treeView.stickyHeaderList);
    treeView.stickyHeaderEntries = [];
    treeView.stickyHeaderOriginals = new WeakMap();

    const root = directory({
      top: -32,
      bottom: 300,
      headerTop: -32,
      headerHeight: 32,
      left: 5,
      projectRoot: true,
    });
    treeView.element.append(root, treeView.stickyHeaderLayer);
    jasmine.attachToDOM(treeView.element);
    treeView.renderStickyHeaderEntries([root]);

    const stickyHeader = treeView.stickyHeaderList.querySelector(".tree-view-sticky-header-row");
    stickyHeader.getBoundingClientRect = () => rect(0, 32);
    treeView.stickyHeaderLayer.addEventListener("click", (event) => {
      treeView.forwardStickyHeaderEvent(event);
    });
    const originalClick = jasmine.createSpy("originalClick");
    root.header.addEventListener("click", originalClick);

    stickyHeader.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 7,
        ctrlKey: true,
        detail: 1,
      }),
    );

    expect(originalClick).toHaveBeenCalled();
    const forwardedEvent = originalClick.calls.mostRecent().args[0];
    expect(forwardedEvent.target).toBe(root.header);
    expect(forwardedEvent.clientX).toBe(15);
    expect(forwardedEvent.clientY).toBe(-25);
    expect(forwardedEvent.ctrlKey).toBe(true);
  });

  it("keeps row content and sticky surfaces above their state backgrounds", () => {
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
    `;

    const file = document.createElement("li");
    file.classList.add("file", "entry", "list-item", "selected");
    const fileName = document.createElement("span");
    fileName.classList.add("name");
    fileName.textContent = "styles.css";
    file.appendChild(fileName);

    const stickySource = document.createElement("li");
    stickySource.classList.add(
      "directory",
      "entry",
      "list-nested-item",
      "selected",
      "tree-view-sticky-header-source",
    );
    const stickySourceHeader = document.createElement("div");
    stickySourceHeader.classList.add("header", "list-item");
    stickySourceHeader.textContent = "Source";
    stickySource.appendChild(stickySourceHeader);

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
    tree.append(stickyLayer, stickySource, file);
    jasmine.attachToDOM(tree);

    try {
      expect(getComputedStyle(fileName).position).toBe("relative");
      expect(getComputedStyle(file, "::before").backgroundColor).toBe("rgb(220, 225, 235)");
      expect(getComputedStyle(stickyList).backgroundColor).toBe("rgb(242, 242, 242)");
      expect(getComputedStyle(stickyEntry).backgroundColor).toBe("rgb(242, 242, 242)");
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(220, 225, 235)");
      expect(getComputedStyle(stickyEntry).transform).toBe("none");
      expect(getComputedStyle(stickyLayer).height).toBe("0px");
      expect(getComputedStyle(stickyLayer).overflow).toBe("visible");
      expect(getComputedStyle(stickyList).overflow).toBe("hidden");
      expect(getComputedStyle(stickyList).contain).toBe("paint");
      expect(getComputedStyle(stickyList).transform).not.toBe("none");
      expect(getComputedStyle(stickySourceHeader).visibility).toBe("hidden");
      expect(getComputedStyle(stickySource, "::before").visibility).toBe("hidden");

      tree.focus();
      expect(getComputedStyle(file, "::before").backgroundColor).toBe("rgb(90, 138, 233)");
      expect(getComputedStyle(stickyRow).backgroundColor).toBe("rgb(90, 138, 233)");
    } finally {
      stylesheet.dispose();
    }
  });
});
