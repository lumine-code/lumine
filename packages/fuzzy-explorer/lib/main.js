const { CompositeDisposable, Disposable } = require("atom");
const { clipboard, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const CSON = require("@lumine-code/season");
const searchForPattern = require("./search-pattern");

const CACHE_UPDATED_CHANNEL = "fuzzy-explorer:cache-updated";

module.exports = {
  openExternalService: null,
  claudeChatService: null,
  ignores: [],
  Ignores: [],
  items: [],
  pending: false,
  building: false,
  separator: 0,
  selectList: null,
  disposables: null,
  cacheUpdateSubscription: null,
  cacheFingerprint: null,

  activate() {
    this.cacheUpdateSubscription = new Disposable();

    this.selectList = atom.workspace.buildSelectList({
      className: "fuzzy-explorer",
      crumb: "Explorer",
      emptyMessage: "No matches found",
      removeDiacritics: true,
      algorithm: "command-t",
      loadingSpinner: true,
      elementForItem: (item, options) => this.elementForItem(item, options),
      didConfirmSelection: () => this.performAction("open"),
      didCancelSelection: () => this.selectList.hide(),
      willShow: () => this.updateView(true),
    });

    this.disposables = new CompositeDisposable(
      atom.config.observe("fuzzy-explorer.separator", (value) => {
        this.separator = value;
      }),
      atom.commands.add("atom-workspace", {
        "fuzzy-explorer:toggle": () => this.selectList.toggle(),
        "fuzzy-explorer:refresh": () => this.build(),
        "fuzzy-explorer:edit": () => this.editConfig(),
      }),
      // Registered in the package's own namespace: the item-actions list
      // (F12) derives its rows — label, description, keybinding — from these
      // registrations and the keymap, so nothing is documented twice. Every
      // description says something the humanized command name does not.
      atom.commands.add(this.selectList.element, {
        "fuzzy-explorer:open": {
          description: "Open the file, or continue the query into a directory",
          didDispatch: () => this.performAction("open"),
        },
        "fuzzy-explorer:open-external": {
          description: "Open the file in the default external program",
          didDispatch: () => this.performAction("open-external"),
        },
        "fuzzy-explorer:show-in-folder": {
          description: "Show the file in the system file manager",
          didDispatch: () => this.performAction("show-in-folder"),
        },
        "fuzzy-explorer:split-left": {
          description: "Open the file in a pane to the left",
          didDispatch: () => this.performAction("split", { side: "left" }),
        },
        "fuzzy-explorer:split-right": {
          description: "Open the file in a pane to the right",
          didDispatch: () => this.performAction("split", { side: "right" }),
        },
        "fuzzy-explorer:split-up": {
          description: "Open the file in a pane above",
          didDispatch: () => this.performAction("split", { side: "up" }),
        },
        "fuzzy-explorer:split-down": {
          description: "Open the file in a pane below",
          didDispatch: () => this.performAction("split", { side: "down" }),
        },
        "fuzzy-explorer:insert-absolute-path": {
          description: "Insert the full path from the filesystem root into the active editor",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "a" }),
        },
        "fuzzy-explorer:insert-relative-path": {
          description: "Insert the path relative to the active editor",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "r" }),
        },
        "fuzzy-explorer:insert-file-name": {
          description: "Insert the base name, without its directories, into the active editor",
          didDispatch: () => this.performAction("path", { op: "insert", rel: "n" }),
        },
        "fuzzy-explorer:copy-absolute-path": {
          description: "Copy the full path from the filesystem root to the clipboard",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "a" }),
        },
        "fuzzy-explorer:copy-relative-path": {
          description: "Copy the path relative to the active editor",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "r" }),
        },
        "fuzzy-explorer:copy-file-name": {
          description: "Copy the base name, without its directories, to the clipboard",
          didDispatch: () => this.performAction("path", { op: "copy", rel: "n" }),
        },
        "fuzzy-explorer:refresh-index": {
          description: "Scan the configured glob patterns again and rebuild the index",
          didDispatch: () => this.update(),
        },
        "fuzzy-explorer:use-default-separator": {
          description: "Use the platform path separator",
          didDispatch: () => {
            atom.config.set("fuzzy-explorer.separator", 0);
            atom.notifications.addSuccess("Separator has been changed to default");
          },
        },
        "fuzzy-explorer:use-forward-slashes": {
          description: "Use forward slashes in inserted and copied paths",
          didDispatch: () => {
            atom.config.set("fuzzy-explorer.separator", 1);
            atom.notifications.addSuccess("Separator has been changed to forward slash");
          },
        },
        "fuzzy-explorer:use-backslashes": {
          description: "Use backslashes in inserted and copied paths",
          didDispatch: () => {
            atom.config.set("fuzzy-explorer.separator", 2);
            atom.notifications.addSuccess("Separator has been changed to backslash");
          },
        },
        "fuzzy-explorer:query-selected-path": {
          description: "Continue the query from the selected path",
          didDispatch: () => this.updateQueryFromItem(),
        },
        "fuzzy-explorer:query-selection": {
          description: "Use the editor selection as the query",
          didDispatch: () => this.selectList.setQueryFromSelection(),
        },
        "fuzzy-explorer:claude-chat": {
          description: "Attach the file to the Claude chat",
          didDispatch: () => this.performAction("claude-chat"),
        },
      }),
    );

    this.observeCacheUpdates();
    if (this.loadCache()) {
      this.pending = true;
    }
  },

  deactivate() {
    this.cacheUpdateSubscription.dispose();
    this.disposables.dispose();
    this.selectList.destroy();
  },

  getConfigPath() {
    return (
      CSON.resolve(path.join(atom.getConfigDirPath(), "explorer")) ||
      path.join(atom.getConfigDirPath(), "explorer.json")
    );
  },

  getCachePath() {
    return path.join(this.getCacheDirectoryPath(), "explorer.json");
  },

  getCacheDirectoryPath() {
    return path.join(atom.getConfigDirPath(), "compile-cache");
  },

  ensureCacheDirectory() {
    const cacheDir = this.getCacheDirectoryPath();
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
  },

  getCacheFingerprint() {
    try {
      const stat = fs.statSync(this.getCachePath());
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  },

  observeCacheUpdates() {
    this.cacheUpdateSubscription.dispose();
    this.cacheUpdateSubscription = atom.applicationDelegate.onDidReceiveWindowEvent(
      CACHE_UPDATED_CHANNEL,
      (cacheFingerprint) => {
        this.handleCacheUpdate(cacheFingerprint);
      },
    );
  },

  handleCacheUpdate(cacheFingerprint) {
    if (this.building) return;
    if (cacheFingerprint === this.cacheFingerprint) return;
    if (this.loadCache()) {
      this.pending = true;
      this.updateView();
    }
  },

  notifyCacheUpdate() {
    atom.applicationDelegate.emitToOtherWindows(CACHE_UPDATED_CHANNEL, this.cacheFingerprint);
  },

  editConfig() {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        '[\n  // Add glob patterns here\n  // "C:/Projects/**/*.js"\n]\n',
      );
    }
    atom.workspace.open(configPath);
  },

  loadConfig() {
    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) return [];
    try {
      const patterns = CSON.readFileSync(configPath);
      if (!Array.isArray(patterns)) return [];
      return patterns.filter((p) => typeof p === "string" && p.length > 0);
    } catch {
      return [];
    }
  },

  loadCache() {
    const cachePath = this.getCachePath();
    if (!fs.existsSync(cachePath)) return false;
    const cacheFingerprint = this.getCacheFingerprint();
    if (cacheFingerprint === this.cacheFingerprint) return false;
    try {
      const content = fs.readFileSync(cachePath, "utf8");
      const items = JSON.parse(content);
      if (!Array.isArray(items)) return false;
      this.items = items;
      this.cacheFingerprint = cacheFingerprint;
      return true;
    } catch {
      return false;
    }
  },

  saveCache() {
    const cachePath = this.getCachePath();
    const cacheDir = this.ensureCacheDirectory();
    const tempPath = path.join(
      cacheDir,
      `explorer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json.tmp`,
    );

    fs.writeFileSync(tempPath, JSON.stringify(this.items));
    fs.renameSync(tempPath, cachePath);
    this.cacheFingerprint = this.getCacheFingerprint();
    this.notifyCacheUpdate();
  },

  parseIgnores() {
    this.ignores = [];
    for (let ignore of atom.config.get("core.ignoredNames") || []) {
      this.ignores.push(ignore);
      this.ignores.push("**/" + ignore);
      this.ignores.push("**/" + ignore + "/**");
    }
    for (let ignore of atom.config.get("fuzzy-explorer.ignoredNames") || []) {
      this.ignores.push(ignore);
      this.ignores.push("**/" + ignore);
      this.ignores.push("**/" + ignore + "/**");
    }
  },

  build() {
    if (this.building) return;
    this.building = true;
    this.parseIgnores();
    const patterns = this.loadConfig();
    const itemSet = new Set();
    if (patterns.length === 0) {
      this.items = [];
      this.saveCache();
      this.finishBuild();
      return;
    }
    Promise.all(patterns.map((pattern) => this.searchPromise(pattern, itemSet))).then(() => {
      this.items = [...itemSet];
      this.saveCache();
      this.finishBuild();
    });
  },

  finishBuild() {
    this.building = false;
    this.pending = true;
    this.updateView();
  },

  updateView(visible) {
    if (this.pending && (visible || this.selectList.isVisible())) {
      this.pending = false;
      this.selectList.update({
        items: this.items,
        loadingMessage: null,
        infoMessage: this.infoLine(),
      });
    }
  },

  searchPromise(pattern, itemSet) {
    const search = searchForPattern(pattern);
    if (!search) return Promise.resolve();

    // The editor's crawler runs ripgrep in its own process, so there is no Task
    // to fork here: `didFindPaths` is called with batches as they arrive.
    return atom.project.crawl({
      directoryPaths: [search.root],
      inclusion: search.include,
      ignoredNames: this.ignores,
      didFindPaths: (paths) => {
        for (const filePath of paths) {
          itemSet.add(path.normalize(filePath));
        }
      },
    });
  },

  // The command table moved to the actions list (F12); the index size is the
  // one thing only this line can say.
  infoLine() {
    const count = this.items ? this.items.length : 0;
    return `${count} files indexed`;
  },

  elementForItem(item, { highlight }) {
    return {
      primary: highlight(item),
      didRender: (li) =>
        atom.icons.applyTo(
          li.firstChild,
          { path: item, context: "fuzzy-explorer" },
          { name: path.basename(item) },
        ),
    };
  },

  update() {
    this.selectList.update({
      items: [],
      loadingMessage: "Indexing files\u2026",
    });
    this.build();
  },

  updateQueryFromItem() {
    let text = this.selectList.getSelectedItem() + path.sep;
    this.selectList.refs.queryEditor.setText(text);
    this.selectList.refs.queryEditor.moveToEndOfLine();
  },

  performAction(mode, params) {
    const item = this.selectList.getSelectedItem();
    if (!item) return;

    let editor, itemPath, text;

    if (mode === "open") {
      itemPath = item;
      try {
        if (!fs.lstatSync(itemPath).isFile()) {
          return this.updateQueryFromItem();
        }
      } catch (error) {
        atom.notifications.addError(error.message || String(error), {
          detail: itemPath,
        });
      }
    }

    this.selectList.hide();

    if (mode === "open") {
      atom.workspace.open(item, { pending: atom.config.get("core.allowPendingPaneItems") });
    } else if (mode === "open-external") {
      if (this.openExternalService) {
        this.openExternalService.openExternal(item);
      } else {
        shell.openPath(item);
      }
    } else if (mode === "show-in-folder") {
      if (this.openExternalService) {
        this.openExternalService.showInFolder(item);
      } else {
        shell.showItemInFolder(item);
      }
    } else if (mode === "split") {
      itemPath = item;
      try {
        if (fs.lstatSync(itemPath).isFile()) {
          atom.workspace.open(itemPath, { split: params.side });
        } else {
          atom.notifications.addError("Cannot open path, because it's a dir", {
            detail: itemPath,
          });
        }
      } catch (error) {
        atom.notifications.addError(error.message || String(error), {
          detail: itemPath,
        });
      }
    } else if (mode === "path") {
      if (params.rel === "a") {
        text = item;
      } else if (params.rel === "r") {
        editor = atom.workspace.getActiveTextEditor();
        if (!editor) {
          atom.notifications.addError("Cannot insert path, because there is no active text editor");
          return;
        }
        const editorPath = editor.getPath();
        text = editorPath ? path.relative(path.dirname(editorPath), item) : item;
      } else if (params.rel === "n") {
        text = path.basename(item);
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
    } else if (mode === "claude-chat") {
      if (!this.claudeChatService) {
        atom.notifications.addWarning("claude-chat service not available");
        return;
      }
      const [, relativePath] = atom.project.relativizePath(item);
      const context = {
        type: "paths",
        paths: [item],
        label: relativePath || item,
        icon: "file",
      };
      this.claudeChatService.setAttachContext(context);
    }
  },

  consumeOpenExternal(service) {
    this.openExternalService = service;
    return new Disposable(() => {
      this.openExternalService = null;
    });
  },

  consumeClaudeChat(service) {
    this.claudeChatService = service;
    return new Disposable(() => {
      this.claudeChatService = null;
    });
  },
};
