const { CompositeDisposable, Disposable } = require("atom");
const path = require("path");
const fs = require("fs");

const VIEW_ID = "recent-list.projects";

const HELP = [
  "Available commands:",
  "- **Enter**: Open in new window",
  "- **Alt+Enter**: Swap current window",
  "- **Ctrl+Enter**: Switch in same window",
  "- **Shift+Enter**: Append to current window",
  "- **Alt+V**: Insert path",
  "- **Alt+D**: Open in new window in dev mode",
  "- **Alt+S**: Open in new window in safe mode",
  "- **Alt+F12**: Open external (via open-external)",
  "- **Ctrl+F12**: Show in explorer (via open-external)",
  "- **F5**: Refresh list",
  "- **Alt+Delete**: Remove from history",
].join("\n");

class RecentList {
  constructor() {
    this.items = [];
    this.restart = true;
    this.disposables = new CompositeDisposable(
      atom.history.onDidChangeProjects(() => {
        this.restart = true;
      }),
      atom.commands.add("atom-workspace", {
        "recent-list:toggle": () => this.toggle(),
      }),
    );
  }

  setOpenExternalService(service) {
    this.openExternalService = service;
  }

  destroy() {
    this.disposables.dispose();
  }

  toggle() {
    return atom.modals.toggle({
      id: VIEW_ID,
      className: "recent-list",
      placeholder: "Open a recent project",
      emptyMessage: "No matches found",
      help: HELP,
      source: (req) => this.loadItems(req),
      // Ranking is bespoke: it scores every path of a multi-root project,
      // keeps the best, then weights by recency and shallowness.
      matcher: atom.modals.matchers.custom((items, query) => this.filter(items, query)),
      renderer: {
        entry: (item) => ({ id: item, text: item.texts.join(" ") }),
        element: (item) => this.rowElement(item),
      },
      actions: this.buildActions(),
      confirm: ({ item }) => this.openProject(item, "open"),
    });
  }

  async loadItems(req) {
    if (this.restart) {
      this.restart = false;
      req.progress({ busy: true, message: "Indexing project…" });
      this.items = this.buildItems();
      req.progress({ busy: false, message: null });
    }
    return this.items;
  }

  buildItems() {
    const normalize = (projectPath) =>
      projectPath
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/g)
        .join(path.sep) + path.sep;

    return atom.history.getProjects().map((project) => ({
      paths: project.paths.map(normalize),
      texts: project.paths.map((p) => atom.ui.removeDiacritics(normalize(p))),
      originalPaths: project.paths,
    }));
  }

  filter(items, query) {
    const text = atom.ui.removeDiacritics(query.text ?? "");
    if (text.length === 0) return items.map((item) => ({ item, score: 1 }));

    const scored = [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      item.score = 0;
      item.matchIndices = null;
      for (let i = 0; i < item.texts.length; i++) {
        const result = atom.ui.fuzzyMatcher.match(item.texts[i], text, {
          recordMatchIndexes: true,
          algorithm: "command-t", // Path-aware matching
        });
        if (result && result.score > item.score) {
          item.score = result.score;
          item.ibest = i;
          item.matchIndices = result.matchIndexes;
        }
      }
      if (item.score > 0) {
        // Recency bonus: earlier items in history are more recent
        const recencyBonus = 1 + (items.length - idx) / (items.length * 10);
        // Depth bonus: shallower paths are often more important
        const bestPath = item.paths[item.ibest] || item.paths[0];
        const depth = (bestPath.match(/[\\/]/g) || []).length;
        const depthBonus = 1 / Math.sqrt(depth || 1);
        item.score *= recencyBonus * depthBonus;
        scored.push({ item, score: item.score });
      }
    }
    return scored.sort((a, b) => b.score - a.score);
  }

  // A project can have several roots, so a row is several primary lines and the
  // highlight belongs to whichever one actually matched.
  rowElement(item) {
    const indices = item.matchIndices || [];
    const li = document.createElement("li");

    for (let i = 0; i < item.paths.length; i++) {
      const line = document.createElement("div");
      line.classList.add("primary-line", "icon", "icon-file-directory");
      if (i > 0) line.classList.add("icon-line");
      if (i === item.ibest && indices.length > 0) {
        line.appendChild(atom.modals.ui.highlight(item.paths[i], indices));
      } else {
        line.textContent = item.paths[i];
      }
      li.appendChild(line);
    }
    return li;
  }

  buildActions() {
    const opens = [
      ["open", "Open in new window", "enter"],
      ["swap", "Swap current window", "alt-enter"],
      ["switch", "Switch in same window", "ctrl-enter"],
      ["append", "Append to current window", "shift-enter"],
      ["dev", "Open in new window in dev mode", "alt-d"],
      ["safe", "Open in new window in safe mode", "alt-s"],
      ["external", "Open external", "alt-f12"],
      ["show", "Show in explorer", "ctrl-f12"],
      ["paste", "Insert path", "alt-v"],
    ];

    return [
      ...opens.map(([name, label, keystroke]) => ({
        name,
        label,
        keystroke,
        run: (ctx) => this.openProject(ctx.item, name, ctx),
      })),
      {
        name: "update",
        label: "Refresh list",
        keystroke: "f5",
        when: "always",
        run: () => {
          this.restart = true;
          return { keepOpen: true, refresh: true };
        },
      },
      {
        name: "delete",
        label: "Remove from history",
        keystroke: "alt-delete",
        run: ({ item }) => {
          const index = this.items.indexOf(item);
          if (index !== -1) this.items.splice(index, 1);
          atom.history.removeProject(item.originalPaths);
          // The kernel clamps the focused row and holds the scroll offset, so
          // several entries can be removed in a row without the list jumping.
          return { keepOpen: true, refresh: true };
        },
      },
    ];
  }

  openProject(item, mode, ctx) {
    const data = this.prepareData(item);
    if (!data.pathsToOpen.length) return { keepOpen: true };

    if (mode === "open") {
      atom.open(data);
    } else if (mode === "dev") {
      atom.open({ ...data, devMode: true });
    } else if (mode === "safe") {
      atom.open({ ...data, safeMode: true });
    } else if (mode === "swap") {
      const closed = atom.project.getPaths().length ? true : false;
      atom.open(data);
      if (closed) atom.close();
    } else if (mode === "switch") {
      atom.project.setPaths(data.pathsToOpen);
    } else if (mode === "append") {
      for (const projectPath of data.pathsToOpen) {
        atom.project.addPath(projectPath, { mustExist: true });
      }
    } else if (mode === "external" || mode === "show") {
      if (!this.openExternalService) {
        atom.notifications.addWarning("The `open-external` package is not available");
        return { keepOpen: true };
      }
      for (const projectPath of data.pathsToOpen) {
        if (mode === "external") this.openExternalService.openExternal(projectPath);
        else this.openExternalService.showInFolder(projectPath);
      }
    } else if (mode === "paste") {
      const editor = ctx && ctx.target ? ctx.target.editor : null;
      if (!editor) {
        atom.notifications.addError("Cannot insert path, because there is no active text editor");
        return { keepOpen: true };
      }
      editor.insertText(data.pathsToOpen.join("\n"), { selection: true });
    }
  }

  prepareData(item) {
    const pathsToOpen = [];
    const errs = [];
    for (const projectPath of item.paths) {
      if (fs.existsSync(projectPath) && fs.lstatSync(projectPath).isDirectory()) {
        pathsToOpen.push(projectPath.replace(/[\\/]+$/, ""));
      } else {
        errs.push(projectPath);
      }
    }
    if (errs.length) {
      atom.notifications.addError("Directory does not exist", { detail: errs.join("\n") });
    }
    return { pathsToOpen };
  }
}

module.exports = {
  activate() {
    this.recentList = new RecentList();
  },

  deactivate() {
    this.recentList.destroy();
  },

  provideRecentList() {
    return {
      toggle: () => this.recentList.toggle(),
    };
  },

  consumeOpenExternal(service) {
    this.recentList.setOpenExternalService(service);
    return new Disposable(() => {
      this.recentList.setOpenExternalService(null);
    });
  },
};
