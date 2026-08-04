const path = require("path");
const os = require("os");
const { webUtils } = require("electron");
const fs = require("./fs-compat");
const { CompositeDisposable, Emitter } = require("atom");

const { repoForPath, getStyleObject, getDuplicateCopyPath } = require("./helpers");

const AddDialog = require("./add-dialog");
const MoveDialog = require("./move-dialog");
const CopyDialog = require("./copy-dialog");
const FileOperationProcess = require("./file-operation-process");

let IgnoredNames; // Defer requiring until actually needed

const AddProjectsView = require("./add-projects-view");
const Directory = require("./directory");
const RootDragAndDrop = require("./root-drag-and-drop");
const TreeEntry = require("./tree-entry");
const TreeRowView = require("./tree-row-view");
const TreeRootSection = require("./tree-root-section");

const TREE_VIEW_URI = "lumine://tree-view";
const TREE_VIEW_CLIPBOARD_FORMAT = "application/lumine-tree-view";
const TREE_VIEW_CLIPBOARD_VERSION = 1;

function toggleConfig(keyPath) {
  return atom.config.set(keyPath, !atom.config.get(keyPath));
}

function debounce(fn, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  const digits = value >= 10 || unit === "B" ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

let nextId = 1;

class TreeView {
  constructor(state) {
    this.onDragLeave = this.onDragLeave.bind(this);
    this.onDragEnter = this.onDragEnter.bind(this);

    this.onStylesheetsChanged = this.onStylesheetsChanged.bind(this);
    this.id = nextId++;

    this.element = document.createElement("div");
    this.element.classList.add("tool-panel", "tree-view");
    this.element.tabIndex = -1;

    this.viewport = document.createElement("div");
    this.viewport.classList.add("tree-view-viewport");

    this.scroller = document.createElement("div");
    this.scroller.classList.add("tree-view-scroller");

    this.list = document.createElement("ol");
    this.list.classList.add(
      "tree-view-root",
      "full-menu",
      "list-tree",
      "has-collapsable-children",
      "focusable-panel",
    );
    this.list.setAttribute("role", "tree");

    this.stickyHeaderLayer = document.createElement("div");
    this.stickyHeaderLayer.classList.add("tree-view-sticky-header-layer");
    this.stickyHeaderLayer.setAttribute("aria-hidden", "true");
    this.stickyHeaderLayer.hidden = true;

    this.stickyHeaderList = document.createElement("ol");
    this.stickyHeaderList.classList.add(
      "tree-view-sticky-header-list",
      "full-menu",
      "list-tree",
      "has-collapsable-children",
    );
    this.stickyHeaderLayer.appendChild(this.stickyHeaderList);
    this.scroller.appendChild(this.list);
    this.viewport.append(this.scroller, this.stickyHeaderLayer);
    this.element.appendChild(this.viewport);

    this.operationStatus = document.createElement("div");
    this.operationStatus.classList.add("tree-view-operation-status");
    this.operationStatus.hidden = true;
    this.element.appendChild(this.operationStatus);

    this.stickyHeadersEnabled = false;
    this.stickyHeaderEntries = [];
    this.stickyHeaderUpdateFrame = null;

    this.treeEntries = new Set();
    this.projectEntries = new Set();
    this.visibleRows = [];
    this.rowTops = [0];
    this.rowViews = new Map();
    this.selectedEntries = new Set();
    this.regularRowHeight = 24;
    this.rootRowHeight = 32;
    this.contentWidth = 0;
    this.scrollportWidth = 0;
    this.stickyHeaderClipPath = null;

    this.disposables = new CompositeDisposable();
    this.emitter = new Emitter();
    this.fileOperationProcess = new FileOperationProcess({
      onDidStart: (operation) => this.beginOperationStatus(operation),
      onDidProgress: (progress) => this.updateOperationStatus(progress),
      onDidFinish: () => this.finishOperationStatus(),
      onDidChange: (operations) => this.fileOperationQueueChanged(operations),
      onConflict: (conflict) => this.resolveFileOperationConflict(conflict),
    });
    this.disposables.add(
      atom.config.observe("tree-view.stickyHeaders", (stickyHeaders) => {
        this.setStickyHeadersEnabled(stickyHeaders);
      }),
    );

    if (typeof ResizeObserver === "function") {
      this.stickyHeaderResizeObserver = new ResizeObserver(() => {
        this.measureRowHeights();
        this.rebuildVisibleRows();
      });
      this.stickyHeaderResizeObserver.observe(this.element);
    }

    this.roots = [];

    this.selectedPath = null;
    this.selectOnMouseUp = null;
    this.lastFocusedEntry = null;
    this.ignoredPatterns = [];
    this.useSyncFS = false;
    this.currentlyOpening = new Map();

    this.openExternalService = null;

    this.editorsToMove = new Map();
    this.editorsToDestroy = [];

    this.dragEventCounts = new WeakMap();
    this.rootDragAndDrop = new RootDragAndDrop(this);

    this.specialRoots = [];

    this.handleEvents();

    process.nextTick(() => {
      this.onStylesheetsChanged();
      let onStylesheetsChanged = debounce(this.onStylesheetsChanged, 100);
      this.disposables.add(
        atom.styles.onDidAddStyleElement(onStylesheetsChanged),
        atom.styles.onDidRemoveStyleElement(onStylesheetsChanged),
        atom.styles.onDidUpdateStyleElement(onStylesheetsChanged),
      );
    });

    this.updateRoots(state.directoryExpansionStates);

    if (state.selectedPaths?.length > 0) {
      for (let selectedPath of state.selectedPaths) {
        this.selectMultipleEntries(this.treeEntryForPath(selectedPath));
      }
    } else {
      this.selectEntry(this.roots[0]);
    }

    if (state.scrollTop != null || state.scrollLeft != null) {
      // We have to restore the last scroll offsets, but it's too early. We use
      // an `IntersectionObserver` so that we can be notified when the element
      // is rendered and visible. At that point, we can make the changes
      // exactly once, then disconnect this observer.
      let observer = new IntersectionObserver(() => {
        if (this.isVisible()) {
          this.scroller.scrollTop = state.scrollTop;
          this.scroller.scrollLeft = state.scrollLeft;
          this.updateStickyHeaderOverlay();
          observer.disconnect();
        }
      });
      observer.observe(this.element);
    }

    if (state.width > 0) {
      this.element.style.width = `${state.width}px`;
    }

    this.disposables.add(
      this.onWillMoveEntry(({ initialPath }) => {
        let isDir = fs.isDirectorySync(initialPath);
        if (isDir) initialPath += path.sep;
        const editorPaths = new Set();
        for (let editor of atom.workspace.getTextEditors()) {
          let filePath = editor.getPath();
          if (isDir ? filePath?.startsWith(initialPath) : filePath === initialPath) {
            editorPaths.add(filePath);
          }
        }
        this.editorsToMove.set(initialPath, editorPaths);
      }),
      this.onEntryMoved(({ initialPath, newPath }) => {
        const moveKey = fs.isDirectorySync(newPath) ? initialPath + path.sep : initialPath;
        const editorPaths = this.editorsToMove.get(moveKey);
        if (editorPaths) {
          for (let editor of atom.workspace.getTextEditors()) {
            let filePath = editor.getPath();
            if (editorPaths.has(filePath)) {
              editor.getBuffer().setPath(filePath.replace(initialPath, newPath));
            }
          }
          this.editorsToMove.delete(moveKey);
        }
        this.refreshSpecialRoots();
      }),
      this.onMoveEntryFailed(({ initialPath }) => {
        this.editorsToMove.delete(initialPath);
        this.editorsToMove.delete(initialPath + path.sep);
      }),
      this.onWillDeleteEntry(({ pathToDelete }) => {
        let isDir = fs.isDirectorySync(pathToDelete);
        if (isDir) pathToDelete += path.sep;
        for (let editor of atom.workspace.getTextEditors()) {
          let filePath = editor.getPath();
          if (
            (isDir ? filePath?.startsWith(pathToDelete) : filePath === pathToDelete) &&
            !editor.isModified()
          ) {
            this.editorsToDestroy.push(filePath);
          }
        }
      }),
      this.onEntryDeleted(() => {
        for (let editor of atom.workspace.getTextEditors()) {
          let index = this.editorsToDestroy.indexOf(editor.getPath());
          if (index !== -1) {
            editor.destroy();
            this.editorsToDestroy.splice(index, 1);
          }
        }
        this.refreshSpecialRoots();
      }),
      this.onDeleteEntryFailed(({ pathToDelete }) => {
        let index = this.editorsToDestroy.indexOf(pathToDelete);
        if (index !== -1) {
          this.editorsToDestroy.splice(index, 1);
        }
      }),
    );
  }

  serialize() {
    let { scrollLeft, scrollTop } = this.scroller;
    let width = parseInt(this.element.style.width || 0, 10);

    class ExpansionStateBuilder {
      constructor(roots) {
        for (let root of roots) {
          this[root.directory.path] = root.directory.serializeExpansionState();
        }
      }
    }

    return {
      directoryExpansionStates: new ExpansionStateBuilder(this.roots),
      deserializer: "TreeView",
      selectedPaths: Array.from(this.getSelectedEntries(), (item) => item.getPath()),
      scrollLeft,
      scrollTop,
      width,
    };
  }

  destroy() {
    this.fileOperationProcess.destroy();
    this.clearOperationStatus();
    if (this.stickyHeaderUpdateFrame != null) {
      cancelAnimationFrame(this.stickyHeaderUpdateFrame);
      this.stickyHeaderUpdateFrame = null;
    }
    this.destroyRowViews();
    this.clearStickyHeaderViews();
    this.stickyHeaderResizeObserver?.disconnect();
    for (let root of this.roots) {
      root.directory.destroy();
      this.unregisterTreeEntry(root);
    }
    for (const section of this.specialRoots) {
      section.destroy();
    }
    this.specialRoots = [];
    this.disposables.dispose();
    this.rootDragAndDrop.dispose();
    return this.emitter.emit("did-destroy");
  }

  setBusySignal(busySignal) {
    this.operationBusyProvider?.dispose();
    this.operationBusyProvider = null;
    this.busySignal = busySignal;
    if (this.currentFileOperation) this.showBusyOperationStatus();
  }

  beginOperationStatus(operation) {
    this.currentFileOperation = {
      ...operation,
      phase: operation.operation === "copy" ? "copying" : "moving",
      startedAt: Date.now(),
    };
    this.showBusyOperationStatus();
    clearTimeout(this.operationStatusDelay);
    this.operationStatusDelay = setTimeout(() => {
      this.operationStatusDelay = null;
      if (!this.currentFileOperation) return;
      this.showOperationStatus();
    }, 250);
  }

  updateOperationStatus(progress) {
    if (!this.currentFileOperation || progress.id !== this.currentFileOperation.id) return;
    const previousTitle = this.getBusyOperationTitle();
    Object.assign(this.currentFileOperation, progress);
    const nextTitle = this.getBusyOperationTitle();
    if (this.operationBusyProvider && previousTitle !== nextTitle) {
      this.operationBusyProvider.changeTitle(nextTitle, previousTitle);
    }
    if (!this.operationStatus.hidden) this.renderCurrentOperationStatus();
  }

  finishOperationStatus() {
    this.clearOperationStatus();
    this.currentFileOperation = null;
  }

  fileOperationQueueChanged(operations) {
    if (operations.length > 1) {
      this.showOperationStatus();
    } else if (!this.operationStatus.hidden) {
      this.renderOperationStatus();
    }
  }

  showOperationStatus() {
    clearTimeout(this.operationStatusDelay);
    this.operationStatusDelay = null;
    this.operationStatus.hidden = false;
    this.renderOperationStatus();
    if (!this.operationStatusInterval) {
      this.operationStatusInterval = setInterval(() => this.renderCurrentOperationStatus(), 1000);
    }
  }

  clearOperationStatus() {
    clearTimeout(this.operationStatusDelay);
    clearInterval(this.operationStatusInterval);
    this.operationStatusDelay = null;
    this.operationStatusInterval = null;
    this.operationStatus.hidden = true;
    this.operationStatus.replaceChildren();
    this.operationBusyProvider?.dispose();
    this.operationBusyProvider = null;
  }

  showBusyOperationStatus() {
    if (!this.busySignal || !this.currentFileOperation) return;
    this.operationBusyProvider = this.busySignal.create();
    this.operationBusyProvider.add(this.getBusyOperationTitle());
  }

  getOperationAction(operation = this.currentFileOperation) {
    switch (operation?.phase) {
      case "copying":
        return "Copying";
      case "copying-to-move":
        return "Copying to move";
      case "cancelling":
        return "Cancelling";
      default:
        return operation?.operation === "copy" ? "Copying" : "Moving";
    }
  }

  getBusyOperationTitle() {
    const name = path.basename(this.currentFileOperation.sourcePath);
    return `tree-view: ${this.getOperationAction()} ${name}`;
  }

  renderOperationStatus() {
    const operations = this.fileOperationProcess.getOperations();
    this.operationStatus.replaceChildren();
    for (let index = 0; index < operations.length; index++) {
      let operation = operations[index];
      if (operation.id === this.currentFileOperation?.id) {
        operation = { ...operation, ...this.currentFileOperation };
      }

      const row = document.createElement("div");
      row.classList.add("tree-view-operation-row");
      row.classList.toggle("is-queued", operation.state === "queued");
      row.dataset.operationId = operation.id;
      row.title = `${operation.sourcePath}\n${operation.destinationPath}`;

      const indicator = document.createElement("span");
      if (operation.state === "running") {
        indicator.classList.add("loading", "loading-spinner-tiny", "inline-block");
      } else {
        indicator.classList.add("icon", "icon-clock");
      }

      const label = document.createElement("span");
      label.classList.add("tree-view-operation-label");
      label.textContent = this.getOperationLabel(operation, index);

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.classList.add("btn", "btn-xs", "icon", "icon-x", "tree-view-operation-cancel");
      cancelButton.disabled = operation.cancelRequested;
      cancelButton.title = operation.cancelRequested
        ? "Cancellation requested"
        : "Cancel operation";
      cancelButton.setAttribute("aria-label", cancelButton.title);
      cancelButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.fileOperationProcess.cancel(operation.id);
      });

      row.append(indicator, label, cancelButton);
      this.operationStatus.appendChild(row);
    }
  }

  renderCurrentOperationStatus() {
    const operation = this.currentFileOperation;
    if (!operation) return;
    const row = this.operationStatus.querySelector(`[data-operation-id="${operation.id}"]`);
    const label = row?.querySelector(".tree-view-operation-label");
    if (label) label.textContent = this.getOperationLabel(operation, 0);
  }

  getOperationLabel(operation, index) {
    const parts = [];
    if (operation.state === "queued") {
      parts.push(index === 1 ? "Next" : "Queued");
      parts.push(operation.operation === "copy" ? "Copy" : "Move");
      parts.push(path.basename(operation.sourcePath));
    } else {
      parts.push(`${this.getOperationAction(operation)} ${path.basename(operation.sourcePath)}`);
      if (operation.entries > 1) {
        parts.push(`${operation.entries} items`);
      } else {
        const size = formatBytes(operation.bytesTotal);
        if (size) parts.push(size);
      }
      const elapsed = Math.floor((Date.now() - operation.startedAt) / 1000);
      parts.push(elapsed === 0 ? "<1s" : `${elapsed}s`);
    }
    return parts.join(" · ");
  }

  resolveFileOperationConflict({ relativePath }) {
    const chosen = atom.confirm({
      message: `'${relativePath}' already exists`,
      detailedMessage: "Do you want to replace it?",
      buttons: ["Replace file", "Skip", "Cancel"],
    });
    return ["replace", "skip", "cancel"][chosen] ?? "cancel";
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  getTitle() {
    return "Project";
  }

  getIconName() {
    return "file-submodule";
  }

  getURI() {
    return TREE_VIEW_URI;
  }

  setStickyHeadersEnabled(stickyHeaders) {
    this.stickyHeadersEnabled = stickyHeaders;
    this.element.classList.toggle("sticky-headers", stickyHeaders);

    if (stickyHeaders) {
      this.scheduleStickyHeadersUpdate();
    } else {
      this.renderStickyHeaderEntries([]);
    }
  }

  scheduleStickyHeadersUpdate() {
    if (!this.stickyHeadersEnabled || this.stickyHeaderUpdateFrame != null) return;

    this.stickyHeaderUpdateFrame = requestAnimationFrame(() => {
      this.stickyHeaderUpdateFrame = null;
      this.updateStickyHeaderOverlay();
    });
  }

  updateStickyHeadersOnScroll() {
    if (!this.stickyHeadersEnabled) return;

    if (this.stickyHeaderUpdateFrame != null) {
      cancelAnimationFrame(this.stickyHeaderUpdateFrame);
      this.stickyHeaderUpdateFrame = null;
    }
    this.updateStickyHeaderOverlay();
  }

  updateStickyHeaderOverlay() {
    const scrollLeft = this.scroller.scrollLeft;
    const stickyLeft = -scrollLeft;
    if (this.stickyHeaderLeft !== stickyLeft) {
      this.stickyHeaderLeft = stickyLeft;
      this.stickyHeaderList.style.left = `${stickyLeft}px`;
    }
    // The cached width, not a fresh measurement: this runs on every scroll
    // event, and reading the list back would force a layout each time.
    this.stickyHeaderList.style.width = this.contentWidth > 0 ? `${this.contentWidth}px` : "100%";
    const clipLeft = Math.max(0, scrollLeft);
    const clipRight = Math.max(0, this.contentWidth - clipLeft - this.scrollportWidth);
    const clipPath =
      this.contentWidth > 0 && this.scrollportWidth > 0 && (clipLeft > 0 || clipRight > 0)
        ? `inset(0px ${clipRight}px 0px ${clipLeft}px)`
        : "";
    if (this.stickyHeaderClipPath !== clipPath) {
      this.stickyHeaderClipPath = clipPath;
      this.stickyHeaderList.style.clipPath = clipPath;
    }
    this.renderStickyHeaderEntries(this.collectStickyHeaderEntries());
  }

  collectStickyHeaderEntries() {
    if (!this.stickyHeadersEnabled || this.visibleRows.length === 0) return [];

    const scrollTop = this.scroller.scrollTop;
    const firstIndex = this.indexAtOffset(scrollTop);
    let root = this.visibleRows[firstIndex];
    while (root?.parent) root = root.parent;
    if (!root || (!root.projectRoot && !root.specialRoot)) return [];

    const rootBottom = this.rowTops[root.subtreeEndIndex] ?? root.top + root.height;
    if (scrollTop < root.top || scrollTop >= rootBottom) return [];

    const entries = [root];
    let directory = root;
    let slot = scrollTop + root.height;

    while (directory.isExpanded && slot < rootBottom) {
      const probe = this.visibleRows[this.indexAtOffset(slot)];
      if (!probe || probe.index >= directory.subtreeEndIndex) break;

      let child = probe;
      while (child?.parent && child.parent !== directory) child = child.parent;
      if (!child || child.parent !== directory || child.kind !== "directory" || !child.isExpanded) {
        break;
      }

      const childBottom = this.rowTops[child.subtreeEndIndex] ?? child.top + child.height;
      if (child.top >= slot || childBottom <= slot) break;

      entries.push(child);
      slot += child.height;
      directory = child;
    }

    return entries;
  }

  renderStickyHeaderEntries(entries) {
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < entries.length &&
      commonPrefixLength < this.stickyHeaderEntries.length &&
      entries[commonPrefixLength] === this.stickyHeaderEntries[commonPrefixLength]
    ) {
      commonPrefixLength++;
    }

    while (this.stickyHeaderList.children.length > commonPrefixLength) {
      this.stickyHeaderList.lastElementChild.treeRowView?.destroy();
    }

    for (let index = commonPrefixLength; index < entries.length; index++) {
      const entry = entries[index];
      const view = new TreeRowView(this, "directory", { sticky: true });
      const element = view.bind(entry);
      element.treeRowView = view;
      this.stickyHeaderList.appendChild(element);
    }

    this.stickyHeaderEntries = entries.slice();
    let stackTop = 0;
    let stackBottom = 0;
    for (let index = 0; index < this.stickyHeaderList.children.length; index++) {
      const child = this.stickyHeaderList.children[index];
      const entry = entries[index];
      child.treeRowView?.sync();
      // Not only on creation: every stylesheet that arrives during startup
      // re-measures the row grid, and a mounted sticky copy must follow it the
      // way renderVisibleRows refreshes real rows. A copy trusting the height
      // it was born with ends up a stale band over rows laid out on the new
      // grid, and the whole stack below it lands offset.
      child.style.height = `${entry.height}px`;
      child.style.setProperty("--tree-view-depth", entry.depth);

      const subtreeBottom = this.rowTops?.[entry.subtreeEndIndex];
      const visibleSubtreeBottom =
        subtreeBottom == null ? Infinity : subtreeBottom - this.scroller.scrollTop;
      // Push an ending header upward as its following sibling reaches the
      // sticky stack. Ancestors have a higher z-index, so nested headers slide
      // underneath them rather than painting over them.
      const pushOffset = Math.min(
        entry.height,
        Math.max(0, stackTop + entry.height - visibleSubtreeBottom),
      );
      child.style.clipPath = "";
      child.style.top = pushOffset > 0 ? `-${pushOffset}px` : "";
      child.style.zIndex = entries.length - index;
      stackTop += entry.height;
      stackBottom = Math.max(stackBottom, stackTop - pushOffset);
    }

    this.stickyHeaderLayer.hidden = entries.length === 0;
    if (entries.length === 0) {
      this.stickyHeaderList.style.height = "";
      return;
    }
    // The visible bottom of the stack, not the sum of its heights: the list is
    // an opaque surface, and while a header is being pushed out the sum leaves
    // a dead band below the stack that covers the very row sliding in to
    // replace it — one band per simultaneously departing header.
    this.stickyHeaderList.style.height = `${stackBottom}px`;
  }

  clearStickyHeaderViews() {
    for (const child of Array.from(this.stickyHeaderList.children)) {
      child.treeRowView?.destroy();
    }
    this.stickyHeaderList.replaceChildren();
    this.stickyHeaderEntries = [];
  }

  registerTreeEntry(entry, { project = true } = {}) {
    this.treeEntries.add(entry);
    if (project) this.projectEntries.add(entry);
    return entry;
  }

  unregisterTreeEntry(entry) {
    for (const child of entry.children.slice()) this.unregisterTreeEntry(child);
    entry.children = [];

    const rowView = this.rowViews.get(entry);
    if (rowView) this.destroyRowView(entry, rowView);
    this.selectedEntries.delete(entry);
    if (this.lastFocusedEntry === entry) this.lastFocusedEntry = null;
    entry.subscriptions?.dispose();
    entry.subscriptions = null;
    this.treeEntries.delete(entry);
    this.projectEntries.delete(entry);
  }

  createDirectoryTreeEntry(directory, parent = null, { projectRoot = false } = {}) {
    const shouldExpand = directory.expansionState.isExpanded;
    const entry = new TreeEntry(this, {
      item: directory,
      kind: "directory",
      parent,
      projectRoot,
    });
    entry.subscriptions = new CompositeDisposable(
      directory.onDidStatusChange(() => {
        entry.syncViews();
        this.scheduleStickyHeadersUpdate();
      }),
      directory.onDidAddEntries((addedEntries) => {
        this.addDirectoryTreeEntries(entry, addedEntries);
      }),
      directory.onDidRemoveEntries((removedEntries) => {
        this.removeDirectoryTreeEntries(entry, removedEntries);
      }),
    );
    this.registerTreeEntry(entry);

    if (shouldExpand) {
      Promise.resolve().then(() => {
        if (this.treeEntries.has(entry)) entry.expand();
      });
    }
    return entry;
  }

  createFileTreeEntry(file, parent) {
    const entry = new TreeEntry(this, {
      item: file,
      kind: "file",
      parent,
    });
    entry.subscriptions = new CompositeDisposable(
      file.onDidStatusChange(() => {
        entry.syncViews();
        this.scheduleStickyHeadersUpdate();
      }),
    );
    return this.registerTreeEntry(entry);
  }

  addDirectoryTreeEntries(parent, addedEntries) {
    for (const item of addedEntries) {
      const entry =
        item instanceof Directory
          ? this.createDirectoryTreeEntry(item, parent)
          : this.createFileTreeEntry(item, parent);
      const index = Math.min(
        item.indexInParentDirectory ?? parent.children.length,
        parent.children.length,
      );
      parent.children.splice(index, 0, entry);
    }
    this.rebuildVisibleRows();
  }

  removeDirectoryTreeEntries(parent, removedEntries) {
    for (let index = parent.children.length - 1; index >= 0; index--) {
      const entry = parent.children[index];
      if (!removedEntries.has(entry.item)) continue;
      parent.children.splice(index, 1);
      this.unregisterTreeEntry(entry);
    }
    this.rebuildVisibleRows();
  }

  async expandTreeEntry(entry, isRecursive = false) {
    if (!entry || entry.kind !== "directory") return;
    if (entry.specialRoot) return entry.section.expand();
    if (entry.special) return Promise.resolve();

    if (!entry.isExpanded) {
      entry.isExpanded = true;
      entry.syncViews();
      this.rebuildVisibleRows();
      await entry.directory.expand();
    }

    if (isRecursive) {
      for (const child of entry.children.slice()) {
        if (child.kind === "directory") await child.expand(true);
      }
    }
    this.rebuildVisibleRows();
  }

  collapseTreeEntry(entry, isRecursive = false) {
    if (!entry || entry.kind !== "directory") return;
    if (entry.specialRoot) return entry.section.collapse();
    if (entry.special || !entry.isExpanded) return;

    if (isRecursive) {
      for (const child of entry.children.slice()) {
        if (child.kind === "directory") child.collapse(true);
      }
    }

    for (const child of entry.children.slice()) this.unregisterTreeEntry(child);
    entry.children = [];
    entry.isExpanded = false;
    entry.directory.collapse();
    entry.syncViews();

    if (!this.selectedEntries.has(entry) && this.selectedEntries.size === 0) {
      this.selectEntry(entry);
    }
    this.rebuildVisibleRows();
  }

  reloadTreeEntry(entry) {
    if (!entry || entry.kind !== "directory") return;
    if (entry.specialRoot) return entry.section.refresh();
    if (entry.special) return;
    entry.directory.reload();
  }

  rebuildVisibleRows({ preserveScroll = true } = {}) {
    if (!this.scroller || !this.list) return;

    const oldAnchor =
      preserveScroll && this.visibleRows.length > 0
        ? this.visibleRows[this.indexAtOffset(this.scroller.scrollTop)]
        : null;
    const oldAnchorOffset = oldAnchor ? this.scroller.scrollTop - oldAnchor.top : 0;
    const rows = [];
    const rowTops = [0];

    const appendEntry = (entry, depth) => {
      entry.depth = depth;
      entry.index = rows.length;
      entry.top = rowTops[rowTops.length - 1];
      entry.height =
        entry.projectRoot || entry.specialRoot ? this.rootRowHeight : this.regularRowHeight;
      rows.push(entry);
      rowTops.push(entry.top + entry.height);

      if (entry.kind === "directory" && entry.isExpanded) {
        for (const child of entry.children) appendEntry(child, depth + 1);
      }
      entry.subtreeEndIndex = rows.length;
    };

    for (const section of this.specialRoots) {
      const isRenderable = section.isRenderable();
      section.element.hidden = !isRenderable;
      if (isRenderable) appendEntry(section.root, 0);
    }
    for (const root of this.roots) appendEntry(root, 0);

    this.visibleRows = rows;
    this.rowTops = rowTops;
    this.viewport.hidden = rows.length === 0;

    if (oldAnchor && rows.includes(oldAnchor)) {
      this.scroller.scrollTop = Math.max(0, oldAnchor.top + oldAnchorOffset);
    }

    this.renderVisibleRows();
  }

  measureRowHeights() {
    if (!this.list?.isConnected) return;

    const regularProbe = document.createElement("li");
    regularProbe.classList.add("tree-view-metrics-probe", "file", "entry", "list-item");
    regularProbe.textContent = "M";

    const rootProbe = document.createElement("li");
    rootProbe.classList.add(
      "tree-view-metrics-probe",
      "directory",
      "entry",
      "list-nested-item",
      "project-root",
      "expanded",
    );
    const rootHeader = document.createElement("div");
    rootHeader.classList.add("header", "list-item", "project-root-header");
    rootHeader.textContent = "M";
    rootProbe.appendChild(rootHeader);
    this.list.append(regularProbe, rootProbe);

    const regularHeight = regularProbe.getBoundingClientRect().height;
    const rootHeight = rootHeader.getBoundingClientRect().height;
    regularProbe.remove();
    rootProbe.remove();

    const nextRegularHeight = regularHeight || this.regularRowHeight;
    const nextRootHeight = rootHeight || this.rootRowHeight;
    if (nextRegularHeight !== this.regularRowHeight || nextRootHeight !== this.rootRowHeight) {
      this.regularRowHeight = nextRegularHeight;
      this.rootRowHeight = nextRootHeight;
    }
  }

  indexAtOffset(offset) {
    if (this.visibleRows.length === 0) return 0;
    const boundedOffset = Math.max(0, Math.min(offset, this.rowTops[this.rowTops.length - 1]));
    let low = 0;
    let high = this.visibleRows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.rowTops[middle + 1] <= boundedOffset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return Math.min(low, this.visibleRows.length - 1);
  }

  renderVisibleRows() {
    if (!this.scroller || this.visibleRows.length === 0) {
      this.destroyRowViews();
      this.contentWidth = 0;
      this.renderStickyHeaderEntries([]);
      return;
    }

    const needed = new Set(this.visibleRows);

    for (const [entry, view] of Array.from(this.rowViews)) {
      if (!needed.has(entry)) this.destroyRowView(entry, view);
    }

    const viewsByParent = new Map();
    for (const entry of this.visibleRows) {
      let view = this.rowViews.get(entry);
      if (!view) {
        view = new TreeRowView(this, entry.kind);
        view.bind(entry);
        this.rowViews.set(entry, view);
      } else {
        view.element.style.height = `${entry.height}px`;
        view.element.style.setProperty("--tree-view-depth", entry.depth);
        view.sync();
      }

      const parent = entry.section ? entry.section.element : this.list;
      let views = viewsByParent.get(parent);
      if (!views) viewsByParent.set(parent, (views = []));
      views.push(view);
    }

    for (const [parent, views] of viewsByParent) {
      let reference =
        parent === this.list
          ? Array.from(parent.children).find((child) => child.classList.contains("tree-view-row"))
          : parent.firstElementChild;
      for (const view of views) {
        if (view.element === reference) {
          reference = reference.nextElementSibling;
        } else {
          parent.insertBefore(view.element, reference);
        }
      }
    }

    // Every logically visible row is mounted, so the list sizes itself to the
    // widest one: `width: max-content` with `min-width: 100%`. Measuring each
    // row here instead and writing the maximum back could only ever grow the
    // tree — a row is `min-width: 100%` of a list already stretched to the
    // previous content width, so it reports that width back as its own.
    this.contentWidth = Math.ceil(this.list.getBoundingClientRect().width);
    this.scrollportWidth = this.scroller.clientWidth;
    this.updateStickyHeaderOverlay();
  }

  destroyRowView(entry, view) {
    if (this.rowViews.get(entry) === view) this.rowViews.delete(entry);
    view.destroy();
  }

  destroyRowViews() {
    for (const [entry, view] of Array.from(this.rowViews)) {
      this.destroyRowView(entry, view);
    }
  }

  treeEntryForElement(element) {
    return element?.closest?.(".entry, .tree-view-sticky-header")?.treeEntry ?? null;
  }

  elementForTreeEntry(entry) {
    return this.rowViews.get(entry)?.element ?? null;
  }

  treeEntryForPath(entryPath) {
    let realPathMatchEntry = null;
    let bestMatchEntry = null;
    let bestMatchLength = 0;
    for (const entry of this.treeEntries) {
      const currentPath = entry.getPath();
      if (currentPath === entryPath) return entry;
      if (realPathMatchEntry == null && entry.isPathEqual(entryPath)) {
        realPathMatchEntry = entry;
      }
      if (
        this.projectEntries.has(entry) &&
        entry.contains(entryPath) &&
        currentPath.length > bestMatchLength
      ) {
        bestMatchEntry = entry;
        bestMatchLength = currentPath.length;
      }
    }
    return realPathMatchEntry ?? bestMatchEntry;
  }

  getPreferredLocation() {
    return atom.config.get("tree-view.showOnRightSide") ? "right" : "left";
  }

  getAllowedLocations() {
    return ["left", "right"];
  }

  isPersistentDockItem() {
    return true;
  }

  getPreferredWidth() {
    return Math.max(this.contentWidth, this.scroller.scrollWidth);
  }

  onDirectoryCreated(callback) {
    return this.emitter.on("directory-created", callback);
  }

  onEntryCopied(callback) {
    return this.emitter.on("entry-copied", callback);
  }

  onWillDeleteEntry(callback) {
    return this.emitter.on("will-delete-entry", callback);
  }

  onEntryDeleted(callback) {
    return this.emitter.on("entry-deleted", callback);
  }

  onDeleteEntryFailed(callback) {
    return this.emitter.on("delete-entry-failed", callback);
  }

  onWillMoveEntry(callback) {
    return this.emitter.on("will-move-entry", callback);
  }

  onEntryMoved(callback) {
    return this.emitter.on("entry-moved", callback);
  }

  onMoveEntryFailed(callback) {
    return this.emitter.on("move-entry-failed", callback);
  }

  onFileCreated(callback) {
    return this.emitter.on("file-created", callback);
  }

  handleEvents() {
    this.scroller.addEventListener(
      "scroll",
      () => {
        this.updateStickyHeadersOnScroll();
      },
      { passive: true },
    );

    this.element.addEventListener("click", (e) => {
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
        return this.entryClicked(e);
      }
    });

    this.element.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.element.addEventListener("mouseup", (e) => this.onMouseUp(e));
    this.element.addEventListener("focusout", () => {
      requestAnimationFrame(() => {
        if (!this.element.contains(document.activeElement)) {
          this.addProjectsView?.clearSelection();
        }
      });
    });
    this.element.addEventListener("dragstart", (e) => this.onDragStart(e));
    this.element.addEventListener("dragenter", (e) => this.onDragEnter(e));
    this.element.addEventListener("dragleave", (e) => this.onDragLeave(e));
    this.element.addEventListener("dragover", (e) => this.onDragOver(e));
    this.element.addEventListener("drop", (e) => this.onDrop(e));

    atom.commands.add(this.element, {
      "core:move-up": (e) => this.moveUp(e),
      "core:move-down": (e) => this.moveDown(e),
      "core:page-up": (e) => this.pageUp(e),
      "core:page-down": (e) => this.pageDown(e),
      "core:move-to-top": (e) => this.scrollToTop(e),
      "core:move-to-bottom": (e) => this.scrollToBottom(e),

      "tree-view:expand-item": () => this.openSelectedEntry({ pending: true }, true),
      "tree-view:recursive-expand-directory": () => {
        this.expandDirectory(true);
      },
      "tree-view:collapse-directory": () => this.collapseDirectory(),
      "tree-view:recursive-collapse-directory": () => {
        this.collapseDirectory(true);
      },
      "tree-view:collapse-all": () => this.collapseDirectory(true, true),

      "tree-view:open-selected-entry": () => this.openSelectedEntry(),
      "tree-view:open-selected-entry-right": () => this.openSelectedEntryRight(),
      "tree-view:open-selected-entry-left": () => this.openSelectedEntryLeft(),
      "tree-view:open-selected-entry-up": () => this.openSelectedEntryUp(),
      "tree-view:open-selected-entry-down": () => this.openSelectedEntryDown(),

      "tree-view:move": () => this.moveSelectedEntry(),
      "tree-view:copy": () => this.copySelectedEntries(),
      "tree-view:cut": () => this.cutSelectedEntries(),
      "tree-view:paste": () => this.pasteEntries(),

      "tree-view:copy-full-path": () => this.copySelectedEntryPath(false),
      "tree-view:show-in-file-manager": () => this.showSelectedEntryInFileManager(),
      "tree-view:open-in-new-window": () => this.openSelectedEntryInNewWindow(),
      "tree-view:copy-project-path": () => this.copySelectedEntryPath(true),

      "tree-view:unfocus": () => this.unfocus(),

      "tree-view:toggle-vcs-ignored-files": () => toggleConfig(`tree-view.hideVcsIgnoredFiles`),
      "tree-view:toggle-ignored-names": () => toggleConfig(`tree-view.hideIgnoredNames`),
      "tree-view:remove-project-folder": (e) => this.removeProjectFolder(e),
    });

    for (let i = 0; i < 9; i++) {
      atom.commands.add(this.element, `tree-view:open-selected-entry-in-pane-${i + 1}`, () =>
        this.openSelectedEntryInPane(i),
      );
    }

    // Update the tree view…
    this.disposables.add(
      // …when the active pane changes.
      atom.workspace.getCenter().onDidChangeActivePaneItem(() => {
        // Don't steal selection from special root sections
        if (!(this.hasFocus() && this.getSelectedEntries().some((entry) => entry.special))) {
          this.selectActiveFile();
        }
        if (atom.config.get("tree-view.autoReveal")) {
          this.revealActiveFile({ show: false, focus: false });
        }
      }),
      // …when we detect new/deleted files in the project.
      atom.project.onDidChangePaths(debounce(() => this.updateRoots(), 50)),
      // …when a git repository is added (e.g. git init) — rebuild so items subscribe to the new repo.
      atom.repositories.onDidAddRepository(debounce(() => this.updateRoots(), 50)),
      // …when any repo is destroyed (e.g. .git deleted) — rebuild so items lose their git colors.
      atom.repositories.observeRepositories((repo) => {
        this.disposables.add(repo.onDidDestroy(debounce(() => this.updateRoots(), 50)));
      }),
      // …when the user changes any of the settings that affect what gets shown
      // (and in what order).
      atom.config.onDidChange("tree-view.hideVcsIgnoredFiles", () => this.updateRoots()),
      atom.config.onDidChange("tree-view.hideIgnoredNames", () => this.updateRoots()),
      atom.config.onDidChange("core.ignoredNames", () => this.updateRoots()),
      atom.config.onDidChange("tree-view.sortFoldersBeforeFiles", () => this.updateRoots()),
      atom.config.onDidChange("tree-view.squashDirectoryNames", () => this.updateRoots()),
    );
  }

  toggle() {
    return atom.workspace.toggle(this);
  }

  async show(focus = false) {
    const activeElement = focus ? null : document.activeElement;
    const activePane = focus ? null : atom.workspace.getActivePane();

    await atom.workspace.open(this, {
      searchAllPanes: true,
      activatePane: focus,
      activateItem: true,
    });
    let container = atom.workspace.paneContainerForURI(this.getURI());
    if (!container) {
      console.error(`Cannot find container for:`, this.getURI());
      return;
    }
    container.show();
    this.scheduleStickyHeadersUpdate();
    if (focus) {
      this.focus();
    } else if (
      activeElement &&
      activeElement !== document.body &&
      activeElement.isConnected &&
      document.activeElement !== activeElement
    ) {
      activeElement.focus();
    } else if (activePane && atom.workspace.getActivePane() !== activePane) {
      activePane.activate();
    }
  }

  hide() {
    return atom.workspace.hide(this);
  }

  focus() {
    return this.element.focus();
  }

  unfocus() {
    return atom.workspace.getCenter().activate();
  }

  hasFocus() {
    return document.activeElement === this.element;
  }

  toggleFocus() {
    if (this.hasFocus()) {
      return this.unfocus();
    } else {
      return this.show(true);
    }
  }

  // Special roots

  addSpecialRoot(config) {
    const section = new TreeRootSection(this, config);
    this.specialRoots.push(section);
    this.viewport.hidden =
      this.roots.length === 0 && !this.specialRoots.some((candidate) => candidate.isRenderable());
    this.rebuildVisibleRows();
    return section;
  }

  removeSpecialRoot(section) {
    const index = this.specialRoots.indexOf(section);
    if (index === -1) return;
    section.destroy();
    this.specialRoots.splice(index, 1);
    this.viewport.hidden =
      this.roots.length === 0 && !this.specialRoots.some((candidate) => candidate.isRenderable());
    this.rebuildVisibleRows();
  }

  // A closed section keeps its entries registered so it can reopen without
  // reading the disk again, so nothing drops them out of the selection the way
  // `collapseTreeEntry` does for a directory it unregisters. Hand the selection
  // to a row that stays on screen rather than leaving it on one nobody can see.
  releaseSelectionInSection(section) {
    const stays = section.isRenderable();
    const leaving = stays ? section.entries : [section.root, ...section.entries];

    let released = false;
    for (const entry of leaving) {
      if (!this.selectedEntries.delete(entry)) continue;
      released = true;
      entry.syncViews();
      if (this.lastFocusedEntry === entry) this.lastFocusedEntry = null;
    }
    if (!released) return;

    if (this.selectedEntries.size > 0) {
      this.scheduleStickyHeadersUpdate();
      return;
    }
    this.selectedPath = null;
    this.selectEntry(stays ? section.root : this.roots[0]);
  }

  refreshSpecialRoots() {
    for (const section of this.specialRoots) {
      section.refresh();
    }
    this.rebuildVisibleRows();
  }

  entryClicked(event) {
    let entry = this.treeEntryForElement(event.target);
    if (!entry) return;

    let { detail = 1 } = event;
    let isRecursive = event.altKey ?? false;

    if (entry.kind === "directory") {
      // Special root directory entry: reveal in main tree
      if (entry.special && !entry.specialRoot) {
        this.selectEntry(entry);
        this.revealInTree(entry.getPath());
        return;
      }
      // Alt+click: open externally via open-external service
      if (event.altKey && this.openExternalService) {
        this.selectEntry(entry);
        requestAnimationFrame(() => {
          this.openExternalService.openExternal(entry.getPath());
        });
        return;
      }
      let doubleClick = atom.config.get("tree-view.dirDoubleClick");
      if (doubleClick) {
        // Double-click mode
        if (detail === 1) {
          this.selectEntry(entry);
          if (event.offsetX <= 10) {
            entry.toggleExpansion(isRecursive);
          }
        } else if (detail === 2) {
          entry.toggleExpansion(isRecursive);
        }
      } else {
        // Single-click mode: every click selects and toggles
        this.selectEntry(entry);
        entry.toggleExpansion(isRecursive);
      }
    } else if (entry.kind === "file") {
      // Alt+click: open externally via open-external service
      if (event.altKey && this.openExternalService) {
        this.selectEntry(entry);
        requestAnimationFrame(() => {
          this.openExternalService.openExternal(entry.getPath());
        });
        return;
      }
      let doubleClick = atom.config.get("tree-view.fileDoubleClick");
      if (doubleClick) {
        // Double-click mode
        if (detail === 1) {
          this.selectEntry(entry);
        } else if (detail === 2) {
          return this.openAfterPromise(entry.getPath(), {
            searchAllPanes: atom.config.get("tree-view.alwaysOpenExisting"),
          });
        }
      } else {
        // Single-click mode: every click selects and opens
        this.selectEntry(entry);
        return this.fileViewEntryClicked(event);
      }
    }
  }

  fileViewEntryClicked(event) {
    let filePath = this.treeEntryForElement(event.target)?.getPath();
    if (!filePath) return;
    let { detail = 1 } = event;
    let alwaysOpenExisting = atom.config.get("tree-view.alwaysOpenExisting");
    let allowPendingPaneItems = atom.config.get("core.allowPendingPaneItems");
    if (detail >= 2) {
      return this.openAfterPromise(filePath, {
        searchAllPanes: alwaysOpenExisting,
      });
    }
    if (allowPendingPaneItems) {
      let openPromise = atom.workspace.open(filePath, {
        pending: true,
        activatePane: false,
        searchAllPanes: alwaysOpenExisting,
      });
      this.currentlyOpening.set(filePath, openPromise);
      return openPromise.then(() => this.currentlyOpening.delete(filePath));
    }
  }

  openAfterPromise(uri, options) {
    let promise = this.currentlyOpening.get(uri);
    if (promise) {
      return promise.then(() => atom.workspace.open(uri, options));
    } else {
      return atom.workspace.open(uri, options);
    }
  }

  // Update the state of the tree view by synchronizing it with the state of
  // the filesystem and the user's current settings.
  updateRoots(expansionStates = {}) {
    // Repository destruction can schedule this callback while the window is
    // shutting down, after AtomEnvironment has already cleared its project.
    if (atom.isDestroying || !atom.project) return;

    let selectedPaths = this.selectedPaths();
    let oldExpansionStates = {};
    for (let root of this.roots) {
      oldExpansionStates[root.directory.path] = root.directory.serializeExpansionState();
      root.directory.destroy();
      this.unregisterTreeEntry(root);
    }
    this.roots = [];
    let projectPaths = atom.project.getPaths();
    if (projectPaths.length > 0) {
      this.viewport.hidden = false;
      let addProjectsViewElement = this.element.querySelector("#add-projects-view");
      if (addProjectsViewElement) {
        this.element.removeChild(addProjectsViewElement);
        this.addProjectsView = null;
      }
      if (IgnoredNames == null) {
        IgnoredNames = require("./ignored-names");
      }

      for (let projectPath of projectPaths) {
        let stats = fs.lstatSyncNoException(projectPath);
        if (!stats) continue;

        // Read the date getters from the original Stats object before it is
        // flattened: as of Node 24 atime/mtime/ctime/birthtime are prototype
        // getters, so Object.assign (own enumerable only) drops them.
        const statFlat = Object.assign({}, stats);
        for (let key of ["atime", "birthtime", "ctime", "mtime"]) {
          statFlat[key] = stats[key] && stats[key].getTime();
        }
        stats = statFlat;

        let directory = new Directory({
          name: path.basename(projectPath),
          fullPath: projectPath,
          symlink: false,
          isRoot: true,
          expansionState: expansionStates[projectPath] ??
            oldExpansionStates[projectPath] ?? { isExpanded: true },
          ignoredNames: new IgnoredNames(),
          useSyncFS: this.useSyncFS,
          stats,
        });

        let root = this.createDirectoryTreeEntry(directory, null, { projectRoot: true });
        this.roots.push(root);
      }
      this.rebuildVisibleRows({ preserveScroll: false });
      let results = [];
      for (let selectedPath of selectedPaths) {
        results.push(this.selectMultipleEntries(this.treeEntryForPath(selectedPath)));
      }
      return results;
    } else {
      this.rebuildVisibleRows({ preserveScroll: false });
      this.viewport.hidden = !this.specialRoots.some((section) => section.isRenderable());
      this.selectedPath = null;
      this.lastFocusedEntry = null;
      if (!this.element.querySelector("#add-projects-view")) {
        this.addProjectsView = new AddProjectsView();
        if (this.projectList) this.addProjectsView.setProjectList(this.projectList);
        if (this.recentList) this.addProjectsView.setRecentList(this.recentList);
        return this.element.appendChild(this.addProjectsView.element);
      }
    }
  }

  getActivePath() {
    return atom.workspace.getCenter()?.getActivePaneItem()?.getPath?.();
  }

  selectActiveFile() {
    let activeFilePath = this.getActivePath();
    if (this.treeEntryForPath(activeFilePath)) {
      return this.selectEntryForPath(activeFilePath);
    } else {
      // If the active file is not part of the project, deselect all entries.
      return this.deselect();
    }
  }

  revealPath(filePath, options = {}) {
    if (!atom.project.getPaths().length) {
      return Promise.resolve();
    }
    let { show, focus } = options;
    focus ??= atom.config.get("tree-view.focusOnReveal");
    let promise = show || focus ? this.show(focus) : Promise.resolve();

    return promise.then(() => {
      if (!filePath) return;
      let [rootPath, relativePath] = atom.project.relativizePath(filePath);
      if (rootPath == null) return;

      let pathComponents = relativePath.split(path.sep);

      // Add the root folder to the path components…
      pathComponents.unshift(rootPath.substring(rootPath.lastIndexOf(path.sep) + 1));
      // …and remove it from the current path.
      let currentPath = rootPath.substring(0, rootPath.lastIndexOf(path.sep));
      for (let pathComponent of pathComponents) {
        currentPath += path.sep + pathComponent;
        let entry = this.treeEntryForPath(currentPath);
        if (!entry) return;
        if (entry.kind === "directory") {
          entry.expand();
        } else {
          this.selectEntry(entry);
          this.scrollToEntry(entry);
        }
      }
    });
  }

  revealActiveFile(options = {}) {
    return this.revealPath(this.getActivePath(), options);
  }

  copySelectedEntryPath(relativePath = false) {
    let pathToCopy = this.selectedPath;
    if (!pathToCopy) return;
    if (relativePath) {
      pathToCopy = atom.project.relativize(pathToCopy);
    }
    return atom.clipboard.write(pathToCopy);
  }

  entryForPath(entryPath) {
    if (this.treeEntries) {
      return this.elementForTreeEntry(this.treeEntryForPath(entryPath)) ?? undefined;
    }

    let entries = Array.from(this.list.querySelectorAll(".entry"));
    // A symlink entry also matches its target's path via realpath, so an exact
    // path match anywhere in the list must beat an earlier realpath alias.
    let realPathMatchEntry = null;
    let bestMatchEntry = null,
      bestMatchLength = 0;
    for (let entry of entries) {
      let currentPath = entry.getPath();
      if (currentPath === entryPath) return entry;
      if (realPathMatchEntry == null && entry.isPathEqual(entryPath)) {
        realPathMatchEntry = entry;
      }
      if (entry.directory?.contains(entryPath) && currentPath.length > bestMatchLength) {
        bestMatchEntry = entry;
        bestMatchLength = currentPath.length;
      }
    }
    return realPathMatchEntry ?? bestMatchEntry;
  }

  selectEntryForPath(entryPath) {
    let entry = this.treeEntryForPath(entryPath);
    return this.selectEntry(entry);
  }

  revealInTree(entryPath) {
    let [rootPath, relativePath] = atom.project.relativizePath(entryPath);
    if (rootPath == null) return;
    let components = relativePath.split(path.sep);
    components.unshift(rootPath.substring(rootPath.lastIndexOf(path.sep) + 1));
    let currentPath = rootPath.substring(0, rootPath.lastIndexOf(path.sep));
    for (let component of components) {
      currentPath += path.sep + component;
      let entry = this.treeEntryForPath(currentPath);
      if (!entry) return;
      if (entry.kind === "directory") {
        entry.expand();
      }
      if (entry.isPathEqual(entryPath)) {
        this.selectEntry(entry);
        this.scrollToEntry(entry);
      }
    }
  }

  moveDown(event) {
    event?.stopImmediatePropagation();
    if (this.roots.length === 0 && !this.selectedEntry()) {
      return this.moveEmptyViewSelection(1);
    }
    let selectedEntry = this.selectedEntry();
    if (selectedEntry != null) {
      // If the current entry is a directory…
      if (selectedEntry.kind === "directory" && selectedEntry.isExpanded) {
        // …the next entry should be its first child.
        if (this.selectEntry(selectedEntry.children[0])) {
          this.scrollToEntry(this.selectedEntry(), false);
          return;
        }
      }
      let nextEntry = this.nextEntry(selectedEntry);
      if (nextEntry) this.selectEntry(nextEntry);
    } else {
      this.selectEntry(this.roots[0]);
    }
    return this.scrollToEntry(this.selectedEntry(), false);
  }

  moveUp(event) {
    event?.stopImmediatePropagation();
    if (this.roots.length === 0 && !this.selectedEntry()) {
      return this.moveEmptyViewSelection(-1);
    }
    let selectedEntry = this.selectedEntry();
    if (selectedEntry != null) {
      let previousEntry = this.previousEntry(selectedEntry);
      if (previousEntry) {
        this.selectEntry(previousEntry);
      } else {
        this.selectEntry(selectedEntry.parent);
      }
    } else {
      this.selectEntry(this.visibleRows[this.visibleRows.length - 1]);
    }
    return this.scrollToEntry(this.selectedEntry(), false);
  }

  nextEntry(entry) {
    const index = this.visibleRows.indexOf(entry);
    return index === -1 ? null : (this.visibleRows[index + 1] ?? null);
  }

  previousEntry(entry) {
    const index = this.visibleRows.indexOf(entry);
    return index <= 0 ? null : this.visibleRows[index - 1];
  }

  emptyViewControls() {
    return this.addProjectsView?.getNavigableElements() ?? [];
  }

  selectedEmptyViewControl() {
    let selected = this.addProjectsView?.element.querySelector(".btn.selected");
    if (this.emptyViewControls().includes(selected)) return selected;
    return null;
  }

  selectEmptyViewControl(control) {
    if (!control) return;
    this.deselect();
    this.addProjectsView?.clearSelection();
    this.selectedPath = null;
    this.lastFocusedEntry = null;
    control.classList.add("selected");
    this.scrollToEmptyViewControl(control);
    return control;
  }

  moveEmptyViewSelection(delta) {
    let controls = this.emptyViewControls();
    if (controls.length === 0) return;

    let selected = this.selectedEmptyViewControl();
    let index = controls.indexOf(selected);
    if (index === -1) {
      index = delta < 0 ? controls.length : -1;
    }
    return this.selectEmptyViewControl(
      controls[(index + delta + controls.length) % controls.length],
    );
  }

  activateSelectedEmptyViewControl() {
    let control =
      this.selectedEmptyViewControl() ?? this.selectEmptyViewControl(this.emptyViewControls()[0]);
    return control?.click();
  }

  scrollToEmptyViewControl(control) {
    const scrollLeft = this.scroller.scrollLeft;
    if (control.scrollIntoViewIfNeeded) {
      control.scrollIntoViewIfNeeded(false);
    } else {
      control.scrollIntoView({ block: "nearest" });
    }
    this.scroller.scrollLeft = scrollLeft;
  }

  expandDirectory(isRecursive = false) {
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) return;

    let directory = selectedEntry.kind === "directory" ? selectedEntry : selectedEntry.parent;
    if (!directory) return;
    if (isRecursive === false && directory.isExpanded) {
      if (directory.directory.getEntries().length > 0) {
        // Select the first entry in the expanded folder if it exists.
        return this.moveDown();
      }
    } else {
      return directory.expand(isRecursive);
    }
  }

  collapseDirectory(isRecursive = false, allDirectories = false) {
    if (allDirectories) {
      for (let root of this.roots) root.collapse(true);
      return;
    }
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) return;

    let directory = selectedEntry.kind === "directory" ? selectedEntry : selectedEntry.parent;
    while (directory && !directory.isExpanded) directory = directory.parent;
    if (directory) {
      directory.collapse(isRecursive);
      return this.selectEntry(directory);
    }
  }

  openSelectedEntry(options = {}, expandDirectory = false) {
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) {
      if (!expandDirectory) return this.activateSelectedEmptyViewControl();
      return;
    }

    if (selectedEntry.kind === "directory") {
      if (expandDirectory) {
        return this.expandDirectory(false);
      } else {
        return selectedEntry.toggleExpansion();
      }
    } else if (selectedEntry.kind === "file") {
      if (atom.config.get("tree-view.alwaysOpenExisting")) {
        options = { searchAllPanes: true, ...options };
      }
      return this.openAfterPromise(selectedEntry.getPath(), options);
    }
  }

  openSelectedEntrySplit(orientation, side) {
    let selectedEntry = this.selectedEntry();
    if (!selectedEntry) return;

    let pane = atom.workspace.getCenter().getActivePane();
    if (!pane || selectedEntry.kind !== "file") return;

    if (atom.workspace.getCenter().getActivePaneItem()) {
      let split = pane.split(orientation, side);
      return atom.workspace.openURIInPane(selectedEntry.getPath(), split);
    } else {
      return this.openSelectedEntry({}, true);
    }
  }

  openSelectedEntryRight() {
    return this.openSelectedEntrySplit("horizontal", "after");
  }

  openSelectedEntryLeft() {
    return this.openSelectedEntrySplit("horizontal", "before");
  }

  openSelectedEntryUp() {
    return this.openSelectedEntrySplit("vertical", "before");
  }

  openSelectedEntryDown() {
    return this.openSelectedEntrySplit("vertical", "after");
  }

  openSelectedEntryInPane(index) {
    let selectedEntry = this.selectedEntry();
    if (selectedEntry == null) return;

    let pane = atom.workspace.getCenter().getPanes()[index];
    if (pane && selectedEntry.kind === "file") {
      return atom.workspace.open(selectedEntry.getPath(), { pane });
    }
  }

  moveSelectedEntry() {
    let oldPath;
    if (this.hasFocus()) {
      let entry = this.selectedEntry();
      // Can't move it if it's a root project directory.
      if (!entry || this.roots.includes(entry)) {
        return;
      }
      oldPath = entry.getPath();
    } else {
      oldPath = this.getActivePath();
    }
    if (!oldPath) return;
    let dialog = new MoveDialog(oldPath, {
      move: (initialPath, newPath) => this.fileOperationProcess.run("move", initialPath, newPath),
      willMove: ({ initialPath, newPath }) => {
        return this.emitter.emit("will-move-entry", { initialPath, newPath });
      },
      onMove: ({ initialPath, newPath }) => {
        return this.emitter.emit("entry-moved", { initialPath, newPath });
      },
      onMoveFailed: ({ initialPath, newPath }) => {
        return this.emitter.emit("move-entry-failed", { initialPath, newPath });
      },
    });
    dialog.attach();
    // This method used to return nothing. We might as well have it return the
    // instance of `MoveDialog` so that testing is slightly easier.
    return dialog;
  }

  showSelectedEntryInFileManager() {
    let filePath = this.selectedEntry()?.getPath();
    if (!filePath) return;

    if (!fs.existsSync(filePath)) {
      return atom.notifications.addWarning(
        `Unable to show ${filePath} in ${this.getFileManagerName()}`,
      );
    }
    return atom.showItemInFolder(filePath);
  }

  showCurrentFileInFileManager() {
    let filePath = atom.workspace.getCenter().getActiveTextEditor()?.getPath();
    if (!filePath) return;

    if (!fs.existsSync(filePath)) {
      return atom.notifications.addWarning(
        `Unable to show ${filePath} in ${this.getFileManagerName()}`,
      );
    }
    return atom.showItemInFolder(filePath);
  }

  getFileManagerName() {
    switch (process.platform) {
      case "darwin":
        return "Finder";
      case "win32":
        return "Explorer";
      default:
        return "File Manager";
    }
  }

  openSelectedEntryInNewWindow() {
    let pathToOpen = this.selectedEntry()?.getPath();
    if (pathToOpen) {
      return atom.open({ pathsToOpen: [pathToOpen], newWindow: true });
    }
  }

  copySelectedEntry() {
    let oldPath;
    if (this.hasFocus()) {
      let entry = this.selectedEntry();
      if (this.roots.includes(entry)) return;
      oldPath = entry?.getPath();
    } else {
      oldPath = this.getActivePath();
    }
    if (!oldPath) return;

    let dialog = new CopyDialog(oldPath, {
      copy: (initialPath, newPath) => this.fileOperationProcess.run("copy", initialPath, newPath),
      onCopy: ({ initialPath, newPath }) => {
        return this.emitter.emit("entry-copied", { initialPath, newPath });
      },
      onCopyFailed: ({ initialPath, newPath }) => {
        return this.emitter.emit("copy-entry-failed", { initialPath, newPath });
      },
    });
    return dialog.attach();
  }

  async removeSelectedEntries() {
    let activePath = this.getActivePath();
    let selectedPaths, selectedEntries;
    if (this.hasFocus()) {
      selectedPaths = this.selectedPaths();
      selectedEntries = this.getSelectedEntries();
    } else if (activePath) {
      selectedPaths = [activePath];
      selectedEntries = [this.treeEntryForPath(activePath)];
    }
    if ((selectedPaths?.length ?? 0) === 0) return;

    // Skip entries inside special root sections (e.g. favourites)
    selectedEntries = Array.from(selectedEntries).filter((entry) => entry && !entry.section);
    selectedPaths = selectedEntries.map((e) => e.getPath());
    if (selectedPaths.length === 0) return;

    for (let root of this.roots) {
      if (selectedPaths.includes(root.getPath())) {
        atom.confirm(
          {
            message: `The root directory '${root.directory.name}' can't be removed.`,
            buttons: ["OK"],
          },
          () => {},
        ); // noop
        return;
      }
    }

    atom.confirm(
      {
        message: `Are you sure you want to delete the selected ${selectedPaths.length > 1 ? "items" : "item"}?`,
        detailedMessage: `You are deleting:\n${selectedPaths.join("\n")}`,
        buttons: ["Move to Trash", "Cancel"],
      },
      async (response) => {
        if (response === 0) {
          // Move to Trash
          let failedDeletions = [];
          let deletionPromises = [];

          // Since this goes async, all entries that correspond to paths we're
          // about to delete will soon detach frmo the tree. So we should figure
          // out ahead of time which element we're going to select when we're
          // done.
          let newSelectedEntry;
          let firstSelectedEntry = selectedEntries[0];
          if (firstSelectedEntry) {
            newSelectedEntry = firstSelectedEntry.parent;
            while (newSelectedEntry && this.selectedEntries.has(newSelectedEntry)) {
              newSelectedEntry = newSelectedEntry.parent;
            }
          }

          for (let selectedPath of selectedPaths) {
            // Don't delete entries which no longer exist. This can happen, for
            // example, when
            //
            // * the entry is deleted outside the editor before "Move to Trash" is
            //   selected;
            // * a folder and one of its children are both selected for deletion,
            //   but the parent folder is deleted first.
            if (!fs.existsSync(selectedPath)) continue;

            let meta = { pathToDelete: selectedPath };

            this.emitter.emit("will-delete-entry", meta);

            let promise = atom
              .trashItem(selectedPath)
              .then(() => {
                this.emitter.emit("entry-deleted", meta);
              })
              .catch(() => {
                this.emitter.emit("delete-entry-failed", meta);
                failedDeletions.push(selectedPath);
              })
              .finally(() => {
                repoForPath(selectedPath)?.scheduleStatusSnapshotRefresh();
              });

            deletionPromises.push(promise);
          }

          await Promise.allSettled(deletionPromises);

          if (failedDeletions.length > 0) {
            atom.notifications.addError(this.formatTrashFailureMessage(failedDeletions), {
              description: this.formatTrashEnabledMessage(),
              detail: `${failedDeletions.join("\n")}`,
              dismissable: true,
            });
          }

          if (newSelectedEntry) {
            this.selectEntry(newSelectedEntry);
          }

          if (atom.config.get("tree-view.squashDirectoryNames")) {
            return this.updateRoots();
          }
        }
      },
    );
  }

  formatTrashFailureMessage(failedDeletions) {
    let fileText = failedDeletions.length > 1 ? "files" : "file";
    return `The following ${fileText} couldn’t be moved to the trash:`;
  }

  formatTrashEnabledMessage() {
    switch (process.platform) {
      case "linux":
        return "Do you have permission to delete, and Trash is enabled on the volume where the files are stored?";
      case "darwin":
        return "Is Trash enabled on the volume where the files are stored?";
      case "win32":
        return "Is there a Recycle Bin on the drive where the files are stored?";
    }
  }

  // Public: Copy the path of the selected entry or entries.
  //
  // Write paths to the native clipboard so they can be pasted across windows.
  copySelectedEntries() {
    return this.performCopyOperation("copy");
  }

  // Public: Cut the path of the selected entry or entries.
  //
  // Write paths to the native clipboard so they can be moved across windows.
  cutSelectedEntries() {
    return this.performCopyOperation("cut");
  }

  // Clipboard events cannot carry the copied paths for the tree view: the
  // renderer may not trigger `execCommand("paste")`, and Chromium targets
  // ClipboardEvents at the focused editable element or `document.body`, never
  // at a non-editable panel. Write the payload with the async Clipboard API
  // instead, which registers the format with the operating system.
  performCopyOperation(operation) {
    const paths = this.selectedPaths();
    if (paths.length === 0) return false;

    atom.clipboard.writeNativeData(paths.join(os.EOL), TREE_VIEW_CLIPBOARD_FORMAT, {
      version: TREE_VIEW_CLIPBOARD_VERSION,
      operation,
      paths,
    });
    return true;
  }

  // Public: Paste a copied or cut item.
  //
  // If a file is selected, the file's parent directory is used as the paste
  // destination.
  async pasteEntries() {
    const targetPath = this.getPasteTargetPath();
    if (!targetPath) return false;

    const clipboardEntry = await this.readTreeClipboardData();
    if (clipboardEntry) {
      return this.pastePaths(clipboardEntry.paths, clipboardEntry.operation, targetPath);
    }

    return atom.pasteProviders.handlePaste({
      target: { type: "directory", path: targetPath },
    });
  }

  async readTreeClipboardData() {
    const data = await atom.clipboard.readNativeData(TREE_VIEW_CLIPBOARD_FORMAT);
    if (
      data?.version === TREE_VIEW_CLIPBOARD_VERSION &&
      ["copy", "cut"].includes(data.operation) &&
      Array.isArray(data.paths) &&
      data.paths.length > 0 &&
      data.paths.every((entryPath) => typeof entryPath === "string" && entryPath.length > 0)
    ) {
      return data;
    }
    return null;
  }

  getPasteTargetPath() {
    const selectedEntry = this.selectedEntry();
    if (!selectedEntry) return null;
    const selectedPath = selectedEntry.getPath();
    return selectedEntry.kind === "file" ? path.dirname(selectedPath) : selectedPath;
  }

  async pastePaths(initialPaths, operation, newDirectoryPath) {
    const pendingOperations = [];
    const reservedPaths = new Set();
    for (let initialPath of initialPaths) {
      if (fs.existsSync(initialPath)) {
        if (operation === "copy") {
          pendingOperations.push(this.copyEntry(initialPath, newDirectoryPath, { reservedPaths }));
        } else if (operation === "cut") {
          pendingOperations.push(this.moveEntry(initialPath, newDirectoryPath));
        }
      }
    }
    const results = await Promise.all(pendingOperations);
    return results.some(Boolean) || operation === "cut";
  }

  add(isCreatingFile) {
    let selectedEntry = this.selectedEntry() ?? this.roots[0];
    let selectedPath = selectedEntry?.getPath() ?? "";

    let dialog = new AddDialog(selectedPath, isCreatingFile);

    dialog.onDidCreateDirectory((createdPath) => {
      this.treeEntryForPath(createdPath)?.reload();
      this.selectEntryForPath(createdPath);
      if (atom.config.get("tree-view.squashDirectoryNames")) this.updateRoots();

      this.emitter.emit("directory-created", { path: createdPath });
    });

    dialog.onDidCreateFile((createdPath) => {
      this.treeEntryForPath(createdPath)?.reload();
      atom.workspace.open(createdPath);
      if (atom.config.get("tree-view.squashDirectoryNames")) this.updateRoots();

      this.emitter.emit("file-created", { path: createdPath });
    });
    return dialog.attach();
  }

  removeProjectFolder(event) {
    if (this.multiSelectEnabled()) {
      for (const entry of this.getSelectedEntries()) {
        if (entry.projectRoot) {
          const path = entry.getPath?.();
          if (path) atom.project.removePath(path);
        }
      }
      return;
    }

    // Remove the targeted project folder (generally this only happens through
    // the context menu)
    let pathToRemove = event.target.closest(".project-root > .header")?.dataset.path;

    // If an entry is selected, remove that entry's project folder
    let selectedRoot = this.selectedEntry();
    while (selectedRoot?.parent) selectedRoot = selectedRoot.parent;
    pathToRemove ??= selectedRoot?.projectRoot ? selectedRoot.getPath() : null;

    // Finally, if only one project folder exists and nothing is selected,
    // remove that folder
    if (!pathToRemove && this.roots.length === 1) {
      pathToRemove = this.roots[0].getPath?.();
    }

    if (pathToRemove) {
      atom.project.removePath(pathToRemove);
    }
  }

  selectedEntry() {
    return this.lastFocusedEntry && this.selectedEntries.has(this.lastFocusedEntry)
      ? this.lastFocusedEntry
      : (this.getSelectedEntries()[0] ?? null);
  }

  selectEntry(entry) {
    entry = entry?.treeEntry ?? entry;
    if (!entry) return;
    this.addProjectsView?.clearSelection();
    this.selectedPath = entry.getPath();
    this.lastFocusedEntry = entry;
    let selectedEntries = this.getSelectedEntries();
    if (selectedEntries.length > 1 || selectedEntries[0] !== entry) {
      this.deselect(selectedEntries);
      this.selectedEntries.add(entry);
      entry.syncViews();
    }
    this.scheduleStickyHeadersUpdate();
    return entry;
  }

  getSelectedEntries() {
    const visible = this.visibleRows.filter((entry) => this.selectedEntries.has(entry));
    for (const entry of this.selectedEntries) {
      if (!visible.includes(entry)) visible.push(entry);
    }
    return visible;
  }

  deselect(elementsToDeselect) {
    elementsToDeselect ??= this.getSelectedEntries();
    for (let selected of elementsToDeselect) {
      selected = selected?.treeEntry ?? selected;
      if (!selected) continue;
      this.selectedEntries.delete(selected);
      selected.syncViews();
    }
    if (this.selectedEntries.size === 0) this.selectedPath = null;
    this.scheduleStickyHeadersUpdate();
  }

  scrollTop(top = null) {
    if (top !== null) {
      this.scroller.scrollTop = top;
      this.updateStickyHeaderOverlay();
      return this.scroller.scrollTop;
    } else {
      return this.scroller.scrollTop;
    }
  }

  scrollBottom(bottom = null) {
    if (bottom !== null) {
      this.scroller.scrollTop = bottom - this.scroller.clientHeight;
      this.updateStickyHeaderOverlay();
      return this.scroller.scrollTop;
    } else {
      return this.scroller.scrollTop + this.scroller.clientHeight;
    }
  }

  scrollToEntry(entry, center = true) {
    entry = entry?.treeEntry ?? entry;
    if (!entry || entry.index < 0 || this.visibleRows[entry.index] !== entry) return;

    const scrollLeft = this.scroller.scrollLeft;
    const viewportHeight = this.scroller.clientHeight;
    if (center) {
      this.scroller.scrollTop = Math.max(
        0,
        entry.top - Math.max(0, viewportHeight - entry.height) / 2,
      );
    } else {
      const stickyHeight = this.collectStickyHeaderEntries().reduce(
        (height, stickyEntry) => height + stickyEntry.height,
        0,
      );
      const visibleTop = this.scroller.scrollTop + stickyHeight;
      const visibleBottom = this.scroller.scrollTop + viewportHeight;
      if (entry.top < visibleTop) {
        this.scroller.scrollTop = Math.max(0, entry.top - stickyHeight);
      } else if (entry.top + entry.height > visibleBottom) {
        this.scroller.scrollTop = entry.top + entry.height - viewportHeight;
      }
    }
    this.updateStickyHeaderOverlay();
    this.scroller.scrollLeft = scrollLeft;
  }

  scrollToBottom() {
    if (this.roots.length === 0 && !this.selectedEntry()) {
      let controls = this.emptyViewControls();
      return this.selectEmptyViewControl(controls[controls.length - 1]);
    }
    let lastEntry = this.visibleRows[this.visibleRows.length - 1];
    if (lastEntry) {
      this.selectEntry(lastEntry);
      this.scrollToEntry(lastEntry);
    }
  }

  scrollToTop() {
    if (this.roots.length === 0 && !this.selectedEntry()) {
      return this.selectEmptyViewControl(this.emptyViewControls()[0]);
    }
    if (this.roots[0]) {
      this.selectEntry(this.roots[0]);
    }
    this.scroller.scrollTop = 0;
    this.updateStickyHeaderOverlay();
  }

  pageUp() {
    this.scroller.scrollTop -= this.scroller.clientHeight;
    this.updateStickyHeaderOverlay();
  }

  pageDown() {
    this.scroller.scrollTop += this.scroller.clientHeight;
    this.updateStickyHeaderOverlay();
  }

  // Copies an entry from `initialPath` to `newDirectoryPath`.
  //
  // If the entry already exists in `newDirectoryPath`, a number is appended to
  // the basename.
  async copyEntry(initialPath, newDirectoryPath, { reservedPaths } = {}) {
    let initialPathIsDirectory = fs.isDirectorySync(initialPath);
    // Do not allow copying test/a/ into test/a/b/
    // Note: A trailing path.sep is added to prevent false positives, such as test/a -> test/ab
    let realNewDirectoryPath = fs.realpathSync(newDirectoryPath) + path.sep;
    let realInitialPath = fs.realpathSync(initialPath) + path.sep;

    if (initialPathIsDirectory && realNewDirectoryPath.startsWith(realInitialPath)) {
      if (!fs.isSymbolicLinkSync(initialPath)) {
        atom.notifications.addWarning("Cannot copy a folder into itself");
        return;
      }
    }
    let newPath = getDuplicateCopyPath(initialPath, newDirectoryPath, {
      isDirectory: initialPathIsDirectory,
      pathExists: (candidatePath) =>
        fs.existsSync(candidatePath) || reservedPaths?.has(candidatePath),
      style: atom.config.get("tree-view.duplicateCopyNameStyle"),
    });
    reservedPaths?.add(newPath);

    try {
      this.emitter.emit("will-copy-entry", { initialPath, newPath });
      const result = await this.fileOperationProcess.run("copy", initialPath, newPath);
      if (result.cancelled) {
        this.emitter.emit("copy-entry-failed", { initialPath, newPath });
        return false;
      }
      this.emitter.emit("entry-copied", { initialPath, newPath });
      let repo = repoForPath(newPath);
      if (repo) {
        repo.scheduleStatusSnapshotRefresh();
      }
      return true;
    } catch (error) {
      this.emitter.emit("copy-entry-failed", { initialPath, newPath });
      atom.notifications.addWarning(`Failed to copy entry ${initialPath} to ${newDirectoryPath}`, {
        detail: error.message,
      });
      return false;
    } finally {
      reservedPaths?.delete(newPath);
    }
  }

  // Moves an entry from `initialPath` to `newDirectoryPath`.
  async moveEntry(initialPath, newDirectoryPath) {
    // Do not allow moving test/a/ into test/a/b/
    // Note: A trailing path.sep is added to prevent false positives, such as test/a -> test/ab
    try {
      let realNewDirectoryPath = fs.realpathSync(newDirectoryPath) + path.sep;
      let realInitialPath = fs.realpathSync(initialPath) + path.sep;
      if (fs.isDirectorySync(initialPath) && realNewDirectoryPath.startsWith(realInitialPath)) {
        if (!fs.isSymbolicLinkSync(initialPath)) {
          atom.notifications.addWarning("Cannot move a folder into itself");
          return;
        }
      }
    } catch (error) {
      atom.notifications.addWarning(`Failed to move entry ${initialPath} to ${newDirectoryPath}`, {
        detail: error.message,
      });
      return false;
    }
    let newPath = path.join(newDirectoryPath, path.basename(initialPath));
    try {
      this.emitter.emit("will-move-entry", { initialPath, newPath });
      const result = await this.fileOperationProcess.run("move", initialPath, newPath);
      if (result.cancelled || result.skipped) {
        if (result.partial) {
          this.updateEditorsAfterPartialMove(initialPath, newPath);
          repoForPath(newPath)?.scheduleStatusSnapshotRefresh();
        }
        this.emitter.emit("move-entry-failed", { initialPath, newPath });
        return !result.cancelled;
      }
      this.emitter.emit("entry-moved", { initialPath, newPath });
      let repo = repoForPath(newPath);
      if (repo) {
        repo.scheduleStatusSnapshotRefresh();
      }
    } catch (error) {
      this.emitter.emit("move-entry-failed", { initialPath, newPath });
      atom.notifications.addWarning(`Failed to move entry ${initialPath} to ${newDirectoryPath}`, {
        detail: error.message,
      });
      return false;
    }
    return true;
  }

  updateEditorsAfterPartialMove(initialPath, newPath) {
    const initialPrefix = initialPath.endsWith(path.sep) ? initialPath : initialPath + path.sep;
    for (const editor of atom.workspace.getTextEditors()) {
      const editorPath = editor.getPath();
      if (editorPath !== initialPath && !editorPath?.startsWith(initialPrefix)) continue;

      const movedPath = newPath + editorPath.slice(initialPath.length);
      if (!fs.existsSync(editorPath) && fs.existsSync(movedPath)) {
        editor.getBuffer().setPath(movedPath);
      }
    }
    this.refreshSpecialRoots();
  }

  onStylesheetsChanged() {
    // If visible, force a redraw so the scrollbars are styled correctly based on
    // the theme.
    if (!this.isVisible()) return;
    this.scroller.style.display = "none";
    this.scroller.offsetWidth;
    this.scroller.style.display = "";
    this.measureRowHeights();
    this.rebuildVisibleRows();
  }

  onMouseDown(event) {
    let entryToSelect = this.treeEntryForElement(event.target);
    if (!entryToSelect) return;
    event.stopPropagation();

    // Middle-click: select and focus, prevent auto-scroll
    if (event.button === 1) {
      event.preventDefault();
      this.selectEntry(entryToSelect);
      this.showFullMenu();
      this.focus();
      return;
    }

    let cmdKey = event.metaKey || (event.ctrlKey && process.platform !== "darwin");
    // return early if clicking on a selected entry
    if (this.selectedEntries.has(entryToSelect)) {
      // mouse right click or ctrl click as right click on darwin platforms
      if (event.button === 2 || (event.ctrlKey && process.platform === "darwin")) {
        return;
      } else {
        let shiftKey = event.shiftKey;
        this.selectOnMouseUp = { shiftKey, cmdKey };
        return;
      }
    }
    if (event.shiftKey && cmdKey) {
      // select continuous from this.lastFocusedEntry but leave others
      this.selectContinuousEntries(entryToSelect, false);
      this.showMultiSelectMenuIfNecessary();
    } else if (event.shiftKey) {
      // select continuous from this.lastFocusedEntry and deselect rest
      this.selectContinuousEntries(entryToSelect);
      this.showMultiSelectMenuIfNecessary();
      // only allow ctrl click for multi selection on non-darwin systems
    } else if (cmdKey) {
      this.selectMultipleEntries(entryToSelect);
      this.lastFocusedEntry = entryToSelect;
      this.showMultiSelectMenuIfNecessary();
    } else {
      this.selectEntry(entryToSelect);
      this.showFullMenu();
    }
  }

  onMouseUp(event) {
    if (!this.selectOnMouseUp) return;
    let { shiftKey, cmdKey } = this.selectOnMouseUp;
    this.selectOnMouseUp = null;

    let entryToSelect = this.treeEntryForElement(event.target);
    if (!entryToSelect) return;
    event.stopPropagation();

    if (shiftKey && cmdKey) {
      // select continuous from this.lastFocusedEntry but leave others
      this.selectContinuousEntries(entryToSelect, false);
      this.showMultiSelectMenuIfNecessary();
    } else if (shiftKey) {
      // select continuous from this.lastFocusedEntry and deselect rest
      this.selectContinuousEntries(entryToSelect);
      this.showMultiSelectMenuIfNecessary();
      // only allow ctrl click for multi selection on non darwin systems
    } else if (cmdKey) {
      this.deselect([entryToSelect]);
      this.lastFocusedEntry = entryToSelect;
      this.showMultiSelectMenuIfNecessary();
    } else {
      this.selectEntry(entryToSelect);
      this.showFullMenu();
    }
  }

  // Public: Return an array of paths from all selected items.
  //
  // Example:
  //
  //     this.selectedPaths()
  //     => ['selected/path/one', 'selected/path/two', 'selected/path/three']
  //
  // Returns Array of selected item paths.
  selectedPaths() {
    return Array.from(this.getSelectedEntries()).map((entry) => entry.getPath());
  }

  // Public: Selects items within a range defined by a currently selected entry
  // and a new given entry. This is Shift+click functionality.
  selectContinuousEntries(entry, deselectOthers = true) {
    entry = entry?.treeEntry ?? entry;
    let currentSelectedEntry = this.lastFocusedEntry ?? this.selectedEntry();
    if (!currentSelectedEntry) return [];
    let elements = [];
    const sameRootContainer =
      entry.parent != null ||
      (entry.specialRoot && currentSelectedEntry.specialRoot) ||
      (entry.projectRoot && currentSelectedEntry.projectRoot);
    if (entry.parent === currentSelectedEntry.parent && sameRootContainer) {
      let entryIndex = this.visibleRows.indexOf(entry);
      let selectedIndex = this.visibleRows.indexOf(currentSelectedEntry);
      let minIndex = Math.min(entryIndex, selectedIndex);
      let maxIndex = Math.max(entryIndex, selectedIndex);
      for (let i = minIndex; i <= maxIndex; i++) {
        elements.push(this.visibleRows[i]);
      }
      if (deselectOthers) this.deselect();
      for (let element of elements) {
        this.selectedEntries.add(element);
        element.syncViews();
      }
    }
    return elements;
  }

  // Public: Selects an entry without clearing previously selected items. This
  // is Cmd+click functionality.
  selectMultipleEntries(entry) {
    entry = entry?.treeEntry ?? entry;
    if (!entry) return;
    if (this.selectedEntries.has(entry)) {
      this.selectedEntries.delete(entry);
      if (this.lastFocusedEntry === entry) {
        this.lastFocusedEntry = this.getSelectedEntries()[0] ?? null;
      }
    } else {
      this.selectedEntries.add(entry);
      this.selectedPath = entry.getPath();
      this.lastFocusedEntry = entry;
    }
    entry.syncViews();
    return entry;
  }

  // Public: Toggle the `full-menu` class on the main list element to display
  // the full context menu.
  showFullMenu() {
    this.list.classList.remove("multi-select", "all-roots-selected");
    this.list.classList.add("full-menu");
    this.stickyHeaderList.classList.remove("multi-select", "all-roots-selected");
    this.stickyHeaderList.classList.add("full-menu");
  }

  // Toggle the `multi-select` class on the main list element to display the
  // context menu with only the items that make sense for multi-select
  // functionality.
  showMultiSelectMenu() {
    this.list.classList.remove("full-menu");
    this.list.classList.add("multi-select");
    this.stickyHeaderList.classList.remove("full-menu");
    this.stickyHeaderList.classList.add("multi-select");
    const allRoots = Array.from(this.getSelectedEntries()).every((entry) => entry.projectRoot);
    this.list.classList.toggle("all-roots-selected", allRoots);
    this.stickyHeaderList.classList.toggle("all-roots-selected", allRoots);
  }

  showMultiSelectMenuIfNecessary() {
    if (this.getSelectedEntries().length > 1) {
      this.showMultiSelectMenu();
    } else {
      this.showFullMenu();
    }
  }

  // Public: Check for the `multi-select` class on the main list.
  //
  // Returns Boolean
  multiSelectEnabled() {
    return this.list.classList.contains("multi-select");
  }

  onDragEnter(event) {
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (!entry) return;
    if (this.rootDragAndDrop.isDragging(event)) return;
    if (!this.isAtomTreeViewEvent(event)) return;
    event.stopPropagation();
    let count = this.dragEventCounts.get(entry);
    if (count == null) {
      count = 0;
      this.dragEventCounts.set(entry, count);
    }
    if (!(count !== 0 || this.selectedEntries.has(entry))) {
      entryElement.classList.add("drag-over", "selected");
    }
    this.dragEventCounts.set(entry, count + 1);
  }

  onDragLeave(event) {
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (!entry) return;
    if (this.rootDragAndDrop.isDragging(event)) return;
    if (!this.isAtomTreeViewEvent(event)) return;
    event.stopPropagation();
    this.dragEventCounts.set(entry, this.dragEventCounts.get(entry) - 1);
    if (this.dragEventCounts.get(entry) === 0 && entryElement.classList.contains("drag-over")) {
      entryElement.classList.remove("drag-over", "selected");
    }
  }

  // Handle entry name object dragstart event.
  onDragStart(event) {
    this.dragEventCounts = new WeakMap();
    this.selectOnMouseUp = null;
    let entry = this.treeEntryForElement(event.target);
    if (!entry) return;
    event.stopPropagation();
    if (this.rootDragAndDrop.canDragStart(event)) {
      return this.rootDragAndDrop.onDragStart(event);
    }
    let dragImage = document.createElement("ol");
    dragImage.classList.add("entries", "list-tree");
    dragImage.style.position = "absolute";
    dragImage.style.top = `0px`;
    dragImage.style.left = `0px`;
    // Ensure the cloned file name element is rendered on a separate GPU
    // layer to prevent overlapping elements located at (0px, 0px) from
    // being used as the drag image.
    dragImage.style.willChange = "transform";
    let initialPaths = [];
    for (let target of this.getSelectedEntries()) {
      let entryPath = target.getPath();
      let parentSelected = target.parent;
      while (parentSelected && !this.selectedEntries.has(parentSelected)) {
        parentSelected = parentSelected.parent;
      }
      if (!parentSelected) {
        initialPaths.push(entryPath);
        let temporaryView = null;
        let sourceElement = this.elementForTreeEntry(target);
        if (!sourceElement) {
          temporaryView = new TreeRowView(this, target.kind);
          sourceElement = temporaryView.bind(target);
        }
        let newElement = sourceElement.cloneNode(true);
        for (let [key, value] of Object.entries(getStyleObject(sourceElement))) {
          if (value === "") continue;
          newElement.style[key] = value;
        }
        newElement.style.paddingLeft = "1em";
        newElement.style.paddingRight = "1em";
        dragImage.append(newElement);
        temporaryView?.destroy();
      }
    }
    document.body.appendChild(dragImage);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setDragImage(dragImage, 0, 0);
    event.dataTransfer.setData("initialPaths", JSON.stringify(initialPaths));
    event.dataTransfer.setData("atom-tree-view-event", "true");
    window.requestAnimationFrame(() => dragImage.remove());
  }

  // Handle entry dragover event; reset default dragover actions.
  onDragOver(event) {
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (!entry) return;
    if (this.rootDragAndDrop.isDragging(event)) return;
    if (!this.isAtomTreeViewEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.dragEventCounts.get(entry) > 0 && entryElement.classList.contains("selected")) {
      entryElement.classList.add("drag-over", "selected");
    }
  }

  // Handle entry drop event.
  async onDrop(event) {
    this.dragEventCounts = new WeakMap();
    const entryElement = event.target.closest(".entry.directory");
    let entry = this.treeEntryForElement(entryElement);
    if (entry) {
      if (this.rootDragAndDrop.isDragging(event)) return;
      if (!this.isAtomTreeViewEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();

      // Drop onto special root section: delegate to onDrop callback
      if (entry.section) {
        let section = entry.section;
        if (section?.config.onDrop) {
          let initialPaths = event.dataTransfer.getData("initialPaths");
          if (initialPaths) {
            section.config.onDrop(JSON.parse(initialPaths));
          }
        }
        entryElement.classList.remove("drag-over", "selected");
        return;
      }

      let newDirectoryPath = entry.getPath?.();
      if (!newDirectoryPath) return false;

      let initialPaths = event.dataTransfer.getData("initialPaths");
      if (initialPaths) {
        // Drop event from the editor
        initialPaths = JSON.parse(initialPaths);
        if (initialPaths.includes(newDirectoryPath)) return;

        entryElement.classList.remove("drag-over", "selected");
        // Iterate backwards so that files in a dir are moved before the dir
        // itself.
        const pendingOperations = [];
        const reservedPaths = new Set();
        for (let j = initialPaths.length - 1; j >= 0; j -= 1) {
          // Note: This is necessary on Windows to circumvent node-pathwatcher
          // holding a lock on expanded folders and preventing them from being
          // moved or deleted.
          //
          // TODO: Investigate whether this is still needed now that we're on
          // the `watchPath` API.
          let initialPath = initialPaths[j];
          this.treeEntryForPath(initialPath)?.collapse?.();
          if ((process.platform === "darwin" && event.metaKey) || event.ctrlKey) {
            // Mimic OS-specific conventions in which holding down a modifier
            // key means that an entry is copied rather than moved.
            pendingOperations.push(
              this.copyEntry(initialPath, newDirectoryPath, { reservedPaths }),
            );
          } else {
            pendingOperations.push(this.moveEntry(initialPath, newDirectoryPath));
          }
        }
        await Promise.all(pendingOperations);
      } else {
        // Drop event from OS
        entryElement.classList.remove("selected");
        const pendingOperations = [];
        const reservedPaths = new Set();
        for (let file of event.dataTransfer.files) {
          const droppedPath = getPathForDroppedFile(file);
          if (!droppedPath) continue;
          if ((process.platform === "darwin" && event.metaKey) || event.ctrlKey) {
            pendingOperations.push(
              this.copyEntry(droppedPath, newDirectoryPath, { reservedPaths }),
            );
          } else {
            pendingOperations.push(this.moveEntry(droppedPath, newDirectoryPath));
          }
        }
        await Promise.all(pendingOperations);
      }
    } else if (event.dataTransfer.files.length) {
      // A drop event from the OS that isn't targeting a specific folder in the
      // tree view. This is probably the user dragging a folder into the tree
      // view in order to add a new folder to the project.
      for (let entry of event.dataTransfer.files) {
        const droppedPath = getPathForDroppedFile(entry);
        if (droppedPath) atom.project.addPath(droppedPath);
      }
    }
  }

  isAtomTreeViewEvent(event) {
    for (let item of event.dataTransfer.items) {
      if (item.type === "atom-tree-view-event" || item.kind === "file") return true;
    }
    return false;
  }

  isVisible() {
    return this.element.offsetWidth !== 0 || this.element.offsetHeight !== 0;
  }
}

function getPathForDroppedFile(file) {
  if (typeof webUtils?.getPathForFile === "function") {
    try {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) return filePath;
    } catch {
      // Spec fakes and older call sites may still provide a path property instead.
    }
  }

  return file.path;
}

module.exports = TreeView;
