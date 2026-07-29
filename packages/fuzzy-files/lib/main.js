const { CompositeDisposable, Disposable } = require("atom");
const { shell, clipboard } = require("electron");
const picomatch = require("picomatch");
const path = require("path");
const fs = require("fs");
const PathLoader = require("./path-loader");

const metricsReporter = {
  sendCrawlEvent() {},
};

module.exports = {
  openExternalService: null,
  windowsClipService: null,
  claudeChatService: null,
  treeViewService: null,
  scoreModifiers: [],
  ignores: [],
  Ignores: [],
  items: [],
  viewSynced: false,
  needRebuild: true,
  building: false,
  selectList: null,
  disposables: null,
  separator: 0,
  initialLine: 0,
  projectCount: 0,
  loadPathsTask: null,
  projectPathsSubscription: null,
  cacheCallbacks: [],

  activate() {
    this.building = false;
    this.cacheCallbacks = [];
    this.projectCount = atom.project.getPaths().length;

    this.selectList = atom.workspace.buildSelectList({
      className: "fuzzy-files",
      crumb: "Files",
      emptyMessage: "No matches found",
      removeDiacritics: true,
      algorithm: "command-t",
      loadingSpinner: true,
      elementForItem: (item, options) => this.elementForItem(item, options),
      didConfirmSelection: () => this.performAction("open"),
      didCancelSelection: () => this.selectList.hide(),
      willShow: () => this.update(),
      filterKeyForItem: (item) => this.displayPath(item),
      filterQuery: (query) => this.parseQuery(query),
      filterScoreModifier: (score, item) => {
        const depth = (item.fPath.match(/[\\/]/g) || []).length + 1;
        score = score / (item.distance * Math.sqrt(depth));
        for (const fn of this.scoreModifiers) {
          score = fn(score, item);
        }
        return score;
      },
    });

    this.disposables = new CompositeDisposable(
      atom.config.observe("fuzzy-files.separator", (value) => {
        this.separator = value;
      }),
      atom.commands.add("atom-workspace", {
        "fuzzy-files:toggle": () => this.selectList.toggle(),
        "fuzzy-files:refresh": () => this.cache(),
      }),
      // Registered in the package's own namespace: the item-actions list
      // (F12) derives its rows — label, description, keybinding — from these
      // registrations and the keymap, so nothing is documented twice. Every
      // description says something the humanized command name does not.
      atom.commands.add(this.selectList.element, {
        "fuzzy-files:open": {
          description: "Open the file, at the line given after a colon in the query",
          didDispatch: () => this.performAction("open"),
        },
        "fuzzy-files:open-external": {
          description: "Open the file in the default external program",
          didDispatch: () => this.performAction("open-external"),
        },
        "fuzzy-files:show-in-folder": {
          description: "Show the file in the system file manager",
          didDispatch: () => this.performAction("show-in-folder"),
        },
        "fuzzy-files:trash": {
          description: "Move the file to the system trash, where it can be restored",
          didDispatch: () => this.performAction("trash"),
        },
        "fuzzy-files:split-left": {
          description: "Open the file in a pane to the left",
          didDispatch: () => this.performAction("split", { side: "left" }),
        },
        "fuzzy-files:split-right": {
          description: "Open the file in a pane to the right",
          didDispatch: () => this.performAction("split", { side: "right" }),
        },
        "fuzzy-files:split-up": {
          description: "Open the file in a pane above",
          didDispatch: () => this.performAction("split", { side: "up" }),
        },
        "fuzzy-files:split-down": {
          description: "Open the file in a pane below",
          didDispatch: () => this.performAction("split", { side: "down" }),
        },
        "fuzzy-files:insert-project-path": {
          description: "Insert the path relative to the project root",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "p" }),
        },
        "fuzzy-files:insert-absolute-path": {
          description: "Insert the full path from the filesystem root into the active editor",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "a" }),
        },
        "fuzzy-files:insert-relative-path": {
          description: "Insert the path relative to the active editor",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "r" }),
        },
        "fuzzy-files:insert-file-name": {
          description: "Insert the base name, without its directories, into the active editor",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "n" }),
        },
        "fuzzy-files:copy-project-path": {
          description: "Copy the path relative to the project root",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "p" }),
        },
        "fuzzy-files:copy-absolute-path": {
          description: "Copy the full path from the filesystem root to the clipboard",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "a" }),
        },
        "fuzzy-files:copy-relative-path": {
          description: "Copy the path relative to the active editor",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "r" }),
        },
        "fuzzy-files:copy-file-name": {
          description: "Copy the base name, without its directories, to the clipboard",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "n" }),
        },
        "fuzzy-files:refresh-index": {
          description: "Crawl the project again to pick up changes made outside the editor",
          didDispatch: () => this.refresh(),
        },
        "fuzzy-files:use-default-separator": {
          description: "Use the platform path separator",
          didDispatch: () => {
            atom.config.set("fuzzy-files.separator", 0);
            atom.notifications.addSuccess("Separator has been changed to default");
          },
        },
        "fuzzy-files:use-forward-slashes": {
          description: "Use forward slashes in inserted and copied paths",
          didDispatch: () => {
            atom.config.set("fuzzy-files.separator", 1);
            atom.notifications.addSuccess("Separator has been changed to forward slash");
          },
        },
        "fuzzy-files:use-backslashes": {
          description: "Use backslashes in inserted and copied paths",
          didDispatch: () => {
            atom.config.set("fuzzy-files.separator", 2);
            atom.notifications.addSuccess("Separator has been changed to backslash");
          },
        },
        "fuzzy-files:cut-file": {
          description: "Cut the file to the system clipboard",
          didDispatch: () => this.performAction("clip", { effect: "cut" }),
        },
        "fuzzy-files:copy-file": {
          description: "Copy the file to the system clipboard",
          didDispatch: () => this.performAction("clip", { effect: "copy" }),
        },
        "fuzzy-files:query-selected-path": {
          description: "Continue the query from the selected path",
          didDispatch: () => this.updateQueryFromItem(),
        },
        "fuzzy-files:query-selection": {
          description: "Use the editor selection as the query",
          didDispatch: () => this.selectList.setQueryFromSelection(),
        },
        "fuzzy-files:reveal-in-tree-view": {
          description: "Expand the tree view to the file and select it there",
          didDispatch: () => this.performAction("reveal-in-tree-view"),
        },
        "fuzzy-files:claude-chat": {
          description: "Attach the file to the Claude chat",
          didDispatch: () => this.performAction("claude-chat"),
        },
      }),
      atom.project.onDidChangeFiles((events) => {
        if (!this.needRebuild) this.updateEvent(events);
      }),
      atom.project.onDidChangePaths((projectPaths) => {
        this.projectCount = projectPaths.length;
        this.restartCache();
      }),
      atom.config.onDidChange("core.ignoredNames", () => {
        this.restartCache();
      }),
      atom.config.onDidChange("core.followSymlinks", () => {
        this.restartCache();
      }),
      atom.config.onDidChange("core.excludeVcsIgnoredPaths", () => {
        this.restartCache();
      }),
      atom.config.onDidChange("fuzzy-files.ignoredNames", () => {
        this.restartCache();
      }),
      atom.workspace.onDidChangeActivePaneItem(() => {
        if (!this.needRebuild) this.relativize();
      }),
    );

    process.nextTick(() => this.startLoadPathsTask());
  },

  deactivate() {
    this.stopLoadPathsTask();
    this.disposables.dispose();
    this.selectList.destroy();
  },

  parseIgnores() {
    this.ignores = [];
    this.Ignores = [];
    for (let ignore of atom.config.get("core.ignoredNames")) {
      this.ignores.push(ignore);
      this.ignores.push("**/" + ignore + "/**");
    }
    for (let ignore of atom.config.get("fuzzy-files.ignoredNames")) {
      this.ignores.push(ignore);
      this.ignores.push("**/" + ignore + "/**");
    }
    for (let ignore of this.ignores) {
      // `basename` only for a pattern with no slash, matching minimatch's
      // `matchBase`. Unconditionally it would defeat the `**/<name>/**` forms
      // pushed above, since only the basename would ever be compared.
      this.Ignores.push(picomatch(ignore, { basename: !ignore.includes("/"), dot: true }));
    }
  },

  cache(callback) {
    if (callback) this.cacheCallbacks.push(callback);
    if (this.building) return this.loadPathsTask;

    this.building = true;
    this.parseIgnores();
    this.items = [];
    this.stopLoadPathsTask();

    if (atom.project.getPaths().length === 0) {
      this.building = false;
      this.viewSynced = false;
      this.needRebuild = false;
      this.relativize();
      this.notifyCacheCallbacks();
      return null;
    }

    try {
      this.loadPathsTask = PathLoader.startTask((filePaths) => {
        this.items = this.itemsForFilePaths(filePaths);
        this.building = false;
        this.viewSynced = false;
        this.needRebuild = false;
        this.relativize();
        this.notifyCacheCallbacks();
      }, metricsReporter);
      return this.loadPathsTask;
    } catch (error) {
      this.building = false;
      if (error.code === "ENOENT" || error.code === "EPERM") {
        atom.notifications.addError("Project path not found!", { detail: error.message });
      } else {
        throw error;
      }
      this.notifyCacheCallbacks(error);
      return null;
    }
  },

  notifyCacheCallbacks(error) {
    const callbacks = this.cacheCallbacks.splice(0);
    for (const callback of callbacks) {
      callback(error);
    }
  },

  startLoadPathsTask() {
    if (this.building) return;
    if (atom.project.getPaths().length === 0) return;
    this.cache();
  },

  restartCache() {
    this.needRebuild = true;
    this.stopLoadPathsTask();
    this.building = false;
    if (atom.project.getPaths().length === 0) {
      this.cache();
    } else {
      this.startLoadPathsTask();
    }
  },

  stopLoadPathsTask() {
    if (this.projectPathsSubscription != null) {
      this.projectPathsSubscription.dispose();
    }
    this.projectPathsSubscription = null;

    if (this.loadPathsTask != null) {
      this.loadPathsTask.terminate();
    }
    this.loadPathsTask = null;
  },

  itemsForFilePaths(filePaths) {
    return filePaths.reduce((items, aPath) => {
      const [pPath, fPath] = atom.project.relativizePath(aPath);
      if (!pPath || !fPath) return items;

      const normalizedPath = path.normalize(fPath);
      items.push({
        pPath,
        fPath: normalizedPath,
        aPath: path.join(pPath, normalizedPath),
        nPath: path.basename(normalizedPath),
      });
      return items;
    }, []);
  },

  updateEvent(events) {
    this.viewSynced = false;
    let pPath, fPath;
    for (let e of events) {
      if (e.action === "created") {
        [pPath, fPath] = atom.project.relativizePath(e.path);
        if (!pPath || !fPath || this.isIgnored(fPath) || !this.isFilePath(e.path)) continue;
        fPath = path.normalize(fPath);
        let item = { pPath: pPath, fPath: fPath };
        item.aPath = path.join(item.pPath, item.fPath);
        item.nPath = path.basename(item.fPath);
        this.items.push(item);
      } else if (e.action === "deleted") {
        [pPath, fPath] = atom.project.relativizePath(e.path);
        if (!pPath) continue;
        atom.icons.invalidate({ paths: [e.path] });
        this.items = this.items.filter(
          (item) =>
            !(
              pPath === item.pPath &&
              (fPath === item.fPath || item.fPath.startsWith(fPath + path.sep))
            ),
        );
      } else if (e.action === "renamed") {
        let [pOldPath, fOldPath] = atom.project.relativizePath(e.oldPath);
        let [pNewPath, fNewPath] = atom.project.relativizePath(e.path);
        atom.icons.invalidate({ paths: [e.oldPath] });
        for (let item of this.items) {
          if (
            pOldPath === item.pPath &&
            (fOldPath === item.fPath || item.fPath.startsWith(fOldPath + path.sep))
          ) {
            item.pPath = pNewPath;
            item.fPath = item.fPath.replace(fOldPath, fNewPath);
            item.aPath = path.join(item.pPath, item.fPath);
            item.nPath = path.basename(item.fPath);
          }
        }
      }
    }
  },

  relativize(editor) {
    if (!editor) editor = atom.workspace.getActiveTextEditor();
    let editorPath = editor ? editor.getPath() : undefined;
    if (!editor || !editorPath) {
      for (let item of this.items) {
        item.rPath = item.fPath;
        item.distance = 1;
      }
    } else {
      for (let item of this.items) {
        item.rPath = path.relative(path.dirname(editorPath), item.aPath);
        let match = item.rPath.match(/[\\/\\]/g);
        item.distance = match ? match.length + 1 : 1;
      }
    }
  },

  isIgnored(fPath) {
    for (let isMatch of this.Ignores) {
      if (isMatch(fPath)) return true;
    }
    return false;
  },

  isFilePath(filePath) {
    try {
      return fs.lstatSync(filePath).isFile();
    } catch {
      return false;
    }
  },

  elementForItem(item, { highlight }) {
    return {
      primary: highlight(this.displayPath(item)),
      didRender: (li) =>
        atom.icons.applyTo(
          li.firstChild,
          { path: item.aPath, context: "fuzzy-files", hints: { directory: false } },
          { name: path.basename(item.aPath) },
        ),
    };
  },

  displayPath(item) {
    if (this.projectCount > 1) {
      return path.join(path.basename(item.pPath), item.fPath);
    }
    return item.fPath;
  },

  parseQuery(query) {
    if (query.length === 0) {
      this.initialLine = 0;
      return query;
    }
    let colon = query.indexOf(":");
    if (colon !== -1) {
      let initialLineRaw = query.substring(colon + 1);
      this.initialLine = initialLineRaw.match(/^\d+$/) ? parseInt(initialLineRaw) - 1 : 0;
      return query.slice(0, colon);
    }
    this.initialLine = 0;
    return query;
  },

  // The command table moved to the actions list (F12); the index size is the
  // one thing only this line can say.
  infoLine() {
    return `${this.items.length} files in ${this.projectCount} project${
      this.projectCount !== 1 ? "s" : ""
    }`;
  },

  update() {
    if (this.needRebuild) {
      this.selectList.update({
        items: [],
        loadingMessage: "Indexing project\u2026",
      });
      this.cache(() => {
        this.viewSynced = true;
        this.selectList.update({
          items: this.items,
          loadingMessage: null,
          infoMessage: this.infoLine(),
        });
      });
    } else if (!this.viewSynced) {
      this.viewSynced = true;
      this.relativize();
      this.selectList.update({
        items: this.items,
        infoMessage: this.infoLine(),
      });
    } else {
      this.relativize();
    }
  },

  refresh() {
    this.needRebuild = true;
    this.update();
  },

  updateQueryFromItem() {
    let text = this.displayPath(this.selectList.getSelectedItem()) + path.sep;
    this.selectList.refs.queryEditor.setText(text);
    this.selectList.refs.queryEditor.moveToEndOfLine();
  },

  performAction(mode, params) {
    let item = this.selectList.getSelectedItem();
    if (!item) return;

    let editor, aPath, text;

    if (mode === "open") {
      aPath = item.aPath;
      try {
        if (!fs.lstatSync(aPath).isFile()) {
          return this.updateQueryFromItem();
        }
      } catch (error) {
        atom.notifications.addError(error.message || String(error), {
          detail: aPath,
        });
      }
    }

    this.selectList.hide();

    if (mode === "open") {
      atom.workspace.open(item.aPath, {
        initialLine: this.initialLine,
        pending: atom.config.get("core.allowPendingPaneItems"),
      });
    } else if (mode === "open-external") {
      if (this.openExternalService) {
        this.openExternalService.openExternal(item.aPath);
      } else {
        shell.openPath(item.aPath);
      }
    } else if (mode === "show-in-folder") {
      if (this.openExternalService) {
        this.openExternalService.showInFolder(item.aPath);
      } else {
        shell.showItemInFolder(item.aPath);
      }
    } else if (mode === "trash") {
      aPath = item.aPath;
      if (atom.trashItem) {
        atom
          .trashItem(aPath)
          .then(() =>
            atom.notifications.addSuccess("Item has been trashed", {
              detail: aPath,
            }),
          )
          .catch(() =>
            atom.notifications.addError("Item cannot be trashed", {
              detail: aPath,
            }),
          );
      } else if (shell.moveItemToTrash) {
        if (shell.moveItemToTrash(aPath)) {
          atom.notifications.addSuccess("Item has been trashed", {
            detail: aPath,
          });
        } else {
          atom.notifications.addError("Item cannot be trashed", {
            detail: aPath,
          });
        }
      }
    } else if (mode === "split") {
      aPath = item.aPath;
      try {
        if (fs.lstatSync(aPath).isFile()) {
          atom.workspace.open(aPath, {
            initialLine: this.initialLine,
            split: params.side,
          });
        } else {
          atom.notifications.addError(`Cannot open path, because it's a dir`, {
            detail: aPath,
          });
        }
      } catch (error) {
        atom.notifications.addError(error.message || String(error), {
          detail: aPath,
        });
      }
    } else if (mode === "path") {
      if (params.rel === "p") {
        text = item.fPath;
      } else if (params.rel === "a") {
        text = item.aPath;
      } else if (params.rel === "r") {
        editor = atom.workspace.getActiveTextEditor();
        if (!editor) {
          atom.notifications.addError("Cannot insert path, because there is no active text editor");
          return;
        }
        let editorPath = editor.getPath();
        text = editorPath ? path.relative(path.dirname(editorPath), item.aPath) : item.fPath;
      } else if (params.rel === "n") {
        text = path.basename(item.fPath);
      }
      if (this.separator === 1) {
        text = text.replace(/\\/g, "/");
      } else if (this.separator === 2) {
        text = text.replace(/\//g, "\\");
      }
      if (params.op === "insert") {
        if (!editor) editor = atom.workspace.getActiveTextEditor();
        if (!editor) {
          atom.notifications.addError("Cannot insert path, because there is no active text editor");
          return;
        }
        editor.insertText(text, { select: true });
      } else if (params.op === "copy") {
        clipboard.writeText(text);
      }
    } else if (mode === "clip") {
      if (!this.windowsClipService) {
        atom.notifications.addWarning("Windows clipboard service not available", {
          detail: "The windows-clip package is required for Cut/Copy file operations",
        });
        return;
      }
      aPath = item.aPath;
      if (params.effect === "cut") {
        this.windowsClipService.writeFilePaths([aPath], this.windowsClipService.DROP_EFFECT_MOVE);
        atom.notifications.addSuccess("File cut to clipboard", {
          detail: aPath,
        });
      } else if (params.effect === "copy") {
        this.windowsClipService.writeFilePaths([aPath], this.windowsClipService.DROP_EFFECT_COPY);
        atom.notifications.addSuccess("File copied to clipboard", {
          detail: aPath,
        });
      }
    } else if (mode === "reveal-in-tree-view") {
      if (!this.treeViewService) {
        atom.notifications.addWarning("tree-view service not available", {
          detail: "The tree-view package is required for reveal in tree view",
        });
        return;
      }
      this.treeViewService.revealPath(item.aPath, { show: true });
    } else if (mode === "claude-chat") {
      if (!this.claudeChatService) {
        atom.notifications.addWarning("claude-chat service not available");
        return;
      }
      const context = {
        type: "paths",
        paths: [item.aPath],
        label: item.fPath,
        icon: "file",
      };
      this.claudeChatService.setAttachContext(context);
    }
  },

  provideFuzzyFilesScoreModifier() {
    return {
      add: (fn) => {
        this.scoreModifiers.push(fn);
        return new Disposable(() => {
          const i = this.scoreModifiers.indexOf(fn);
          if (i !== -1) this.scoreModifiers.splice(i, 1);
        });
      },
    };
  },

  consumeOpenExternal(service) {
    this.openExternalService = service;
    return {
      dispose: () => {
        this.openExternalService = null;
      },
    };
  },

  consumeWindowsClip(service) {
    this.windowsClipService = service;
    return {
      dispose: () => {
        this.windowsClipService = null;
      },
    };
  },

  consumeClaudeChat(service) {
    this.claudeChatService = service;
    return {
      dispose: () => {
        this.claudeChatService = null;
      },
    };
  },

  consumeTreeViewSelection(service) {
    this.treeViewService = service;
    return {
      dispose: () => {
        this.treeViewService = null;
      },
    };
  },
};
