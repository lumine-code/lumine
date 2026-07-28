const { CompositeDisposable, Disposable } = require("atom");
const { shell, clipboard } = require("electron");
const picomatch = require("picomatch");
const path = require("path");
const fs = require("fs");
const PathLoader = require("./path-loader");

const VIEW_ID = "fuzzy-files.paths";

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
  needRebuild: true,
  building: false,
  disposables: null,
  separator: 0,
  projectCount: 0,
  loadPathsTask: null,
  projectPathsSubscription: null,
  cacheCallbacks: [],

  activate() {
    this.building = false;
    this.cacheCallbacks = [];
    this.projectCount = atom.project.getPaths().length;

    this.disposables = new CompositeDisposable(
      atom.config.observe("fuzzy-files.separator", (value) => {
        this.separator = value;
      }),
      atom.commands.add("atom-workspace", {
        "fuzzy-files:toggle": () => this.toggle(),
        "fuzzy-files:refresh": () => this.cache(),
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
      this.needRebuild = false;
      this.relativize();
      this.notifyCacheCallbacks();
      return null;
    }

    try {
      this.loadPathsTask = PathLoader.startTask((filePaths) => {
        this.items = this.itemsForFilePaths(filePaths);
        this.building = false;
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

  displayPath(item) {
    if (this.projectCount > 1) {
      return path.join(path.basename(item.pPath), item.fPath);
    }
    return item.fPath;
  },

  // `path:line` is split here rather than in a side-effecting filter hook, so
  // the line number travels with the query instead of living on the module.
  parseQuery(raw) {
    const colon = raw.indexOf(":");
    if (raw.length === 0 || colon === -1) return { text: raw, initialLine: 0 };
    const rawLine = raw.substring(colon + 1);
    return {
      text: raw.slice(0, colon),
      initialLine: rawLine.match(/^\d+$/) ? parseInt(rawLine, 10) - 1 : 0,
    };
  },

  getHelpMarkdown() {
    return (
      "Available commands:\n" +
      "- **Enter**: Open file\n" +
      "- **Alt+Enter**: Open externally\n" +
      "- **Ctrl+Enter**: Show in folder\n" +
      "- **Alt+Left|Right|Up|Down**: Split pane\n" +
      "- **Alt+C P|A|R|N**: Copy path\n" +
      "- **Alt+V P|A|R|N**: Insert path\n" +
      "- **Alt+Delete**: Trash file\n" +
      "- **Alt+Q|S**: Query from item|selection\n" +
      "- **Alt+T**: Reveal in tree-view\n" +
      "- **Alt+0|/|\\\\**: Set path separator\n" +
      "- **Alt+F**: Attach to claude-chat\n" +
      "- **Alt+W Alt+C|X**: Copy/cut file\n" +
      "- **F5**: Refresh index\n\n" +
      `**${this.items.length}** files in **${this.projectCount}** project${
        this.projectCount !== 1 ? "s" : ""
      }`
    );
  },

  toggle() {
    return atom.modals.toggle({
      id: VIEW_ID,
      className: "fuzzy-files",
      placeholder: "Find a file",
      emptyMessage: "No matches found",
      parseQuery: (raw) => this.parseQuery(raw),
      help: () => this.getHelpMarkdown(),
      source: (req) => this.loadItems(req),
      matcher: atom.modals.matchers.fuzzy({
        maxResults: 50,
        scoreModifier: (item, score) => {
          const depth = (item.fPath.match(/[\\/]/g) || []).length + 1;
          score = score / (item.distance * Math.sqrt(depth));
          for (const fn of this.scoreModifiers) score = fn(score, item);
          return score;
        },
      }),
      renderer: {
        entry: (item) => ({ id: item.aPath, text: this.displayPath(item) }),
        row: (item) => ({ label: this.displayPath(item) }),
        decorate: (li, item) => {
          atom.icons.applyTo(
            li.firstChild,
            { path: item.aPath, context: "fuzzy-files", hints: { directory: false } },
            { name: path.basename(item.aPath) },
          );
        },
      },
      actions: this.buildActions(),
      confirm: (ctx) => this.openItem(ctx),
    });
  },

  // A rebuild is reported through the source's own progress channel, so the
  // list shows it is indexing without the package faking a loading state by
  // pushing an empty item array.
  async loadItems(req) {
    if (this.needRebuild) {
      req.progress({ busy: true, message: "Indexing project…" });
      await new Promise((resolve) => this.cache(resolve));
      if (req.signal.aborted) return [];
      req.progress({ busy: false, message: null });
    } else {
      this.relativize();
    }
    return this.items;
  },

  buildActions() {
    const splits = [
      ["split-left", "left", "alt-left"],
      ["split-right", "right", "alt-right"],
      ["split-up", "up", "alt-up"],
      ["split-down", "down", "alt-down"],
    ];
    const paths = [
      ["insert-project-path", "insert", "p", "alt-v alt-p"],
      ["insert-absolute-path", "insert", "a", "alt-v alt-a"],
      ["insert-relative-path", "insert", "r", "alt-v"],
      ["insert-file-name", "insert", "n", "alt-v alt-n"],
      ["copy-project-path", "copy", "p", "alt-c alt-p"],
      ["copy-absolute-path", "copy", "a", "alt-c alt-a"],
      ["copy-relative-path", "copy", "r", "alt-c"],
      ["copy-file-name", "copy", "n", "alt-c alt-n"],
    ];
    const separators = [
      ["use-default-separator", 0, "alt-0", "default"],
      ["use-forward-slashes", 1, "alt-/", "forward slash"],
      ["use-backslashes", 2, "alt-\\", "backslash"],
    ];

    return [
      { name: "open", label: "Open file", keystroke: "enter", run: (ctx) => this.openItem(ctx) },
      {
        name: "open-external",
        label: "Open externally",
        keystroke: "alt-enter",
        run: ({ item }) => {
          if (this.openExternalService) this.openExternalService.openExternal(item.aPath);
          else shell.openPath(item.aPath);
        },
      },
      {
        name: "show-in-folder",
        label: "Show in folder",
        keystroke: "ctrl-enter",
        run: ({ item }) => {
          if (this.openExternalService) this.openExternalService.showInFolder(item.aPath);
          else shell.showItemInFolder(item.aPath);
        },
      },
      {
        name: "trash",
        label: "Trash file",
        keystroke: "alt-delete",
        run: ({ item }) => this.trash(item),
      },
      ...splits.map(([name, side, keystroke]) => ({
        name,
        label: `Split ${side}`,
        keystroke,
        run: (ctx) => this.openSplit(ctx, side),
      })),
      ...paths.map(([name, op, rel, keystroke]) => ({
        name,
        label: name.replace(/-/g, " "),
        keystroke,
        run: (ctx) => this.applyPath(ctx, op, rel),
      })),
      ...separators.map(([name, value, keystroke, label]) => ({
        name,
        label: `Use ${label} separator`,
        keystroke,
        when: "always",
        run: () => {
          atom.config.set("fuzzy-files.separator", value);
          atom.notifications.addSuccess(`Separator has been changed to ${label}`);
          return { keepOpen: true };
        },
      })),
      {
        name: "cut-file",
        label: "Cut file",
        keystroke: "alt-w alt-x",
        run: ({ item }) => this.clip(item, "cut"),
      },
      {
        name: "copy-file",
        label: "Copy file",
        keystroke: "alt-w alt-c",
        run: ({ item }) => this.clip(item, "copy"),
      },
      {
        name: "query-selected-path",
        label: "Query from item",
        keystroke: "alt-q",
        run: ({ item }) => this.drillInto(item),
      },
      {
        name: "query-from-selection",
        label: "Query from selection",
        keystroke: "alt-s",
        when: "always",
        run: ({ session }) => {
          session.setQueryFromSelection();
          return { keepOpen: true };
        },
      },
      {
        name: "reveal-in-tree-view",
        label: "Reveal in tree-view",
        keystroke: "alt-t",
        run: ({ item }) => {
          if (!this.treeViewService) {
            atom.notifications.addWarning("tree-view service not available", {
              detail: "The tree-view package is required for reveal in tree view",
            });
            return { keepOpen: true };
          }
          this.treeViewService.revealPath(item.aPath, { show: true });
        },
      },
      {
        name: "claude-chat",
        label: "Attach to claude-chat",
        keystroke: "alt-f",
        run: ({ item }) => {
          if (!this.claudeChatService) {
            atom.notifications.addWarning("claude-chat service not available");
            return { keepOpen: true };
          }
          this.claudeChatService.setAttachContext({
            type: "paths",
            paths: [item.aPath],
            label: item.fPath,
            icon: "file",
          });
        },
      },
      {
        name: "refresh-index",
        label: "Refresh index",
        keystroke: "f5",
        when: "always",
        run: () => {
          this.needRebuild = true;
          return { keepOpen: true, refresh: true };
        },
      },
    ];
  },

  // Confirming a directory drills into it rather than failing to open it.
  drillInto(item) {
    return { keepOpen: true, query: this.displayPath(item) + path.sep, select: "reset" };
  },

  openItem({ item, query }) {
    try {
      if (!fs.lstatSync(item.aPath).isFile()) return this.drillInto(item);
    } catch (error) {
      atom.notifications.addError(error.message || String(error), { detail: item.aPath });
      return { keepOpen: true };
    }
    atom.workspace.open(item.aPath, {
      initialLine: query.initialLine,
      pending: atom.config.get("core.allowPendingPaneItems"),
    });
  },

  openSplit({ item, query }, side) {
    try {
      if (!fs.lstatSync(item.aPath).isFile()) {
        atom.notifications.addError("Cannot open path, because it's a dir", { detail: item.aPath });
        return;
      }
    } catch (error) {
      atom.notifications.addError(error.message || String(error), { detail: item.aPath });
      return;
    }
    atom.workspace.open(item.aPath, { initialLine: query.initialLine, split: side });
  },

  trash(item) {
    const aPath = item.aPath;
    if (atom.trashItem) {
      atom
        .trashItem(aPath)
        .then(() => atom.notifications.addSuccess("Item has been trashed", { detail: aPath }))
        .catch(() => atom.notifications.addError("Item cannot be trashed", { detail: aPath }));
    } else if (shell.moveItemToTrash) {
      if (shell.moveItemToTrash(aPath)) {
        atom.notifications.addSuccess("Item has been trashed", { detail: aPath });
      } else {
        atom.notifications.addError("Item cannot be trashed", { detail: aPath });
      }
    }
  },

  clip(item, effect) {
    if (!this.windowsClipService) {
      atom.notifications.addWarning("Windows clipboard service not available", {
        detail: "The windows-clip package is required for Cut/Copy file operations",
      });
      return { keepOpen: true };
    }
    const dropEffect =
      effect === "cut"
        ? this.windowsClipService.DROP_EFFECT_MOVE
        : this.windowsClipService.DROP_EFFECT_COPY;
    this.windowsClipService.writeFilePaths([item.aPath], dropEffect);
    atom.notifications.addSuccess(
      effect === "cut" ? "File cut to clipboard" : "File copied to clipboard",
      { detail: item.aPath },
    );
  },

  applyPath({ item, target }, op, rel) {
    const editor = target.editor;
    let text;

    if (rel === "p") {
      text = item.fPath;
    } else if (rel === "a") {
      text = item.aPath;
    } else if (rel === "r") {
      if (!editor) {
        atom.notifications.addError("Cannot insert path, because there is no active text editor");
        return;
      }
      const editorPath = editor.getPath();
      text = editorPath ? path.relative(path.dirname(editorPath), item.aPath) : item.fPath;
    } else {
      text = path.basename(item.fPath);
    }

    if (this.separator === 1) {
      text = text.replace(/\\/g, "/");
    } else if (this.separator === 2) {
      text = text.replace(/\//g, "\\");
    }

    if (op === "copy") {
      clipboard.writeText(text);
      return;
    }
    if (!editor) {
      atom.notifications.addError("Cannot insert path, because there is no active text editor");
      return;
    }
    editor.insertText(text, { select: true });
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
