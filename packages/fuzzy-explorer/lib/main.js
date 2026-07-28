const { CompositeDisposable, Disposable } = require("atom");
const { clipboard, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const CSON = require("@lumine-code/season");
const searchForPattern = require("./search-pattern");

const CACHE_UPDATED_CHANNEL = "fuzzy-explorer:cache-updated";
const VIEW_ID = "fuzzy-explorer.paths";

module.exports = {
  openExternalService: null,
  claudeChatService: null,
  ignores: [],
  Ignores: [],
  items: [],
  building: false,
  separator: 0,
  disposables: null,
  cacheUpdateSubscription: null,
  cacheFingerprint: null,

  activate() {
    this.cacheUpdateSubscription = new Disposable();

    this.disposables = new CompositeDisposable(
      atom.config.observe("fuzzy-explorer.separator", (value) => {
        this.separator = value;
      }),
      atom.commands.add("atom-workspace", {
        "fuzzy-explorer:toggle": () => this.toggle(),
        "fuzzy-explorer:refresh": () => this.build(),
        "fuzzy-explorer:edit": () => this.editConfig(),
      }),
    );

    this.observeCacheUpdates();
    this.loadCache();
  },

  deactivate() {
    this.cacheUpdateSubscription.dispose();
    this.disposables.dispose();
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
    if (this.loadCache()) this.refreshOpenList();
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
    this.refreshOpenList();
  },

  // The index can finish while the list is up; re-reading it is idempotent, so
  // there is no "did the panel become visible yet?" guard to get wrong.
  refreshOpenList() {
    const session = atom.modals.getActiveSession();
    if (session && session.rootSpec.id === VIEW_ID) session.refresh();
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

  getHelpMarkdown() {
    const summary = this.items ? `\n\n**${this.items.length}** files indexed` : "";
    return (
      "Available commands:\n" +
      "- **Enter**: Open file\n" +
      "- **Alt+Enter**: Open externally\n" +
      "- **Ctrl+Enter**: Show in folder\n" +
      "- **Alt+Left|Right|Up|Down**: Split pane\n" +
      "- **Alt+C A|R|N**: Copy path\n" +
      "- **Alt+V A|R|N**: Insert path\n" +
      "- **Alt+Q**: Query from item\n" +
      "- **Alt+S**: Query from selection\n" +
      "- **Alt+0|/|\\\\**: Set separator\n" +
      "- **Alt+F**: Attach to claude-chat\n" +
      "- **F5**: Refresh index" +
      summary
    );
  },

  toggle() {
    return atom.modals.toggle({
      id: VIEW_ID,
      className: "fuzzy-explorer",
      placeholder: "Find a file",
      emptyMessage: "No matches found",
      source: () => this.items,
      matcher: atom.modals.matchers.fuzzy({ maxResults: 50 }),
      help: () => this.getHelpMarkdown(),
      renderer: {
        row: (item) => ({ label: item }),
        decorate: (li, item) => {
          atom.icons.applyTo(
            li.firstChild,
            { path: item, context: "fuzzy-explorer" },
            { name: path.basename(item) },
          );
        },
      },
      actions: this.buildActions(),
      confirm: (ctx) => this.openItem(ctx),
    });
  },

  buildActions() {
    const splits = [
      ["split-left", "left", "alt-left"],
      ["split-right", "right", "alt-right"],
      ["split-up", "up", "alt-up"],
      ["split-down", "down", "alt-down"],
    ];
    const paths = [
      ["insert-absolute-path", "insert", "a", "alt-v alt-a"],
      ["insert-relative-path", "insert", "r", "alt-v"],
      ["insert-file-name", "insert", "n", "alt-v alt-n"],
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
          if (this.openExternalService) this.openExternalService.openExternal(item);
          else shell.openPath(item);
        },
      },
      {
        name: "show-in-folder",
        label: "Show in folder",
        keystroke: "ctrl-enter",
        run: ({ item }) => {
          if (this.openExternalService) this.openExternalService.showInFolder(item);
          else shell.showItemInFolder(item);
        },
      },
      ...splits.map(([name, side, keystroke]) => ({
        name,
        label: `Split ${side}`,
        keystroke,
        run: ({ item }) => this.openSplit(item, side),
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
          atom.config.set("fuzzy-explorer.separator", value);
          atom.notifications.addSuccess(`Separator has been changed to ${label}`);
          return { keepOpen: true };
        },
      })),
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
        name: "claude-chat",
        label: "Attach to claude-chat",
        keystroke: "alt-f",
        run: ({ item }) => {
          if (!this.claudeChatService) {
            atom.notifications.addWarning("claude-chat service not available");
            return { keepOpen: true };
          }
          const [, relativePath] = atom.project.relativizePath(item);
          this.claudeChatService.setAttachContext({
            type: "paths",
            paths: [item],
            label: relativePath || item,
            icon: "file",
          });
        },
      },
      {
        name: "refresh-index",
        label: "Refresh index",
        keystroke: "f5",
        when: "always",
        run: ({ session }) => {
          this.items = [];
          session.setStatus({ busy: true, message: "Indexing files…" });
          this.build();
          return { keepOpen: true, refresh: true };
        },
      },
    ];
  },

  // Confirming a directory drills into it rather than failing to open it.
  drillInto(item) {
    return { keepOpen: true, query: item + path.sep, select: "reset" };
  },

  openItem({ item }) {
    try {
      if (!fs.lstatSync(item).isFile()) return this.drillInto(item);
    } catch (error) {
      atom.notifications.addError(error.message || String(error), { detail: item });
      return { keepOpen: true };
    }
    atom.workspace.open(item, { pending: atom.config.get("core.allowPendingPaneItems") });
  },

  openSplit(item, side) {
    try {
      if (!fs.lstatSync(item).isFile()) {
        atom.notifications.addError("Cannot open path, because it's a dir", { detail: item });
        return;
      }
    } catch (error) {
      atom.notifications.addError(error.message || String(error), { detail: item });
      return;
    }
    atom.workspace.open(item, { split: side });
  },

  applyPath({ item, target }, op, rel) {
    let editor = target.editor;
    let text;

    if (rel === "a") {
      text = item;
    } else if (rel === "r") {
      if (!editor) {
        atom.notifications.addError("Cannot insert path, because there is no active text editor");
        return;
      }
      const editorPath = editor.getPath();
      text = editorPath ? path.relative(path.dirname(editorPath), item) : item;
    } else {
      text = path.basename(item);
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
