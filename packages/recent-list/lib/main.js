const { Disposable, CompositeDisposable } = require("atom");
const path = require("path");
const fs = require("fs");

class RecentList {
  constructor() {
    this.items = [];
    this.restart = true;
    this.selectList = atom.workspace.buildSelectList({
      className: "recent-list",
      crumb: "Recent",
      emptyMessage: "No matches found",
      removeDiacritics: true,
      elementForItem: (item, options) => this.elementForItem(item, options),
      didConfirmSelection: () => this.performAction("open"),
      didCancelSelection: () => this.didCancelSelection(),
      willShow: () => this.onWillShow(),
      filter: (items, query) => this.filter(items, query),
    });
    this.disposables = new CompositeDisposable();
    this.disposables.add(
      atom.history.onDidChangeProjects(() => {
        this.restart = true;
      }),
      atom.commands.add("atom-workspace", {
        "recent-list:toggle": () => this.toggle(),
      }),
      // Registered in the package's own namespace: the item-actions list
      // (F12) derives its rows — label, description, keybinding — from these
      // registrations and the keymap, so nothing is documented twice. Every
      // description says something the humanized command name does not.
      atom.commands.add(this.selectList.element, {
        "recent-list:open": {
          description: "Open the project in a new window",
          didDispatch: () => this.performAction("open"),
        },
        "recent-list:swap": {
          description: "Open the project in a new window and close the current one",
          didDispatch: () => this.performAction("swap"),
        },
        "recent-list:switch": {
          description: "Replace the folders of the current window with the project paths",
          didDispatch: () => this.performAction("switch"),
        },
        "recent-list:append": {
          description: "Add the project paths to the folders of the current window",
          didDispatch: () => this.performAction("append"),
        },
        "recent-list:paste": {
          description: "Insert the project paths into the active editor",
          didDispatch: () => this.performAction("paste"),
        },
        "recent-list:dev": {
          description: "Open the project in a new window in dev mode",
          didDispatch: () => this.performAction("dev"),
        },
        "recent-list:safe": {
          description: "Open the project in a new window in safe mode",
          didDispatch: () => this.performAction("safe"),
        },
        "recent-list:update": {
          description: "Read the recent projects from the history again",
          didDispatch: () => this.refresh(),
        },
        "recent-list:external": {
          description: "Open each project folder in the default external program",
          didDispatch: () => this.performAction("external"),
        },
        "recent-list:show": {
          description: "Show each project folder in the system file manager",
          didDispatch: () => this.performAction("show"),
        },
        "recent-list:delete": {
          description: "Remove the project from the history, keeping the list open",
          didDispatch: () => this.deleteSelected(),
        },
      }),
    );
  }

  setOpenExternalService(service) {
    this.openExternalService = service;
  }

  destroy() {
    this.disposables.dispose();
    this.selectList.destroy();
  }

  toggle() {
    this.selectList.toggle();
  }

  updateItems() {
    this.selectList.update({
      items: this.items,
      loadingMessage: null,
    });
  }

  updateLoadingMessage() {
    this.selectList.update({
      items: [],
      loadingMessage: "Indexing project\u2026",
    });
  }

  onWillShow() {
    if (this.restart) {
      this.restart = false;
      this.items = [];
      this.updateLoadingMessage();
      this.cache().then(() => {
        this.updateItems();
      });
    }
  }

  refresh() {
    this.restart = true;
    this.onWillShow();
  }

  cache() {
    return new Promise((resolve) => {
      for (let project of atom.history.getProjects()) {
        this.items.push({
          paths: project.paths.map((ppath) => {
            return (
              ppath
                .replace(/[\\/]+$/, "")
                .split(/[\\/]/g)
                .join(path.sep) + path.sep
            );
          }),
          texts: project.paths.map((ppath) => {
            return atom.tools.removeDiacritics(
              ppath
                .replace(/[\\/]+$/, "")
                .split(/[\\/]/g)
                .join(path.sep) + path.sep,
            );
          }),
          originalPaths: project.paths,
        });
      }
      resolve();
    });
  }

  filter(items, query) {
    query = atom.tools.removeDiacritics(query);
    if (query.length === 0) {
      return items;
    }
    const scoredItems = [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      item.score = 0;
      item.matchIndices = null;
      for (let i = 0; i < item.texts.length; i++) {
        const result = atom.tools.fuzzyMatcher.match(item.texts[i], query, {
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
        scoredItems.push(item);
      }
    }
    return scoredItems.sort((a, b) => b.score - a.score);
  }

  elementForItem(item, { highlight }) {
    // Indices come from this package's own filter(), not the built-in matcher,
    // so they are passed explicitly rather than left to highlight's default.
    const indices = item.matchIndices || [];
    const li = document.createElement("li");

    for (let i = 0; i < item.paths.length; i++) {
      const line = document.createElement("div");
      line.classList.add("primary-line", "icon", "icon-file-directory");
      if (i > 0) {
        line.classList.add("icon-line");
      }
      if (i === item.ibest && indices.length > 0) {
        line.appendChild(highlight(item.paths[i], indices));
      } else {
        line.textContent = item.paths[i];
      }
      li.appendChild(line);
    }

    return li;
  }

  performAction(mode) {
    if (!mode) {
      mode = "open";
    }
    let item = this.selectList.getSelectedItem();
    if (!item) {
      return;
    } else {
      this.selectList.hide();
    }
    const data = this.prepareData(item);
    if (!data.pathsToOpen.length) {
      return;
    }
    if (mode === "open") {
      atom.open(data);
    } else if (mode === "dev") {
      atom.open({ ...data, devMode: true });
    } else if (mode === "safe") {
      atom.open({ ...data, safeMode: true });
    } else if (mode === "swap") {
      let closed = atom.project.getPaths().length ? true : false;
      atom.open(data);
      if (closed) {
        atom.close();
      }
    } else if (mode === "switch") {
      atom.project.setPaths(data.pathsToOpen);
    } else if (mode === "append") {
      for (let projectPath of data.pathsToOpen) {
        atom.project.addPath(projectPath, { mustExist: true });
      }
    } else if (mode === "external") {
      if (!this.openExternalService) {
        atom.notifications.addWarning("The `open-external` package is not available");
        return;
      }
      for (let projectPath of data.pathsToOpen) {
        this.openExternalService.openExternal(projectPath);
      }
    } else if (mode === "show") {
      if (!this.openExternalService) {
        atom.notifications.addWarning("The `open-external` package is not available");
        return;
      }
      for (let projectPath of data.pathsToOpen) {
        this.openExternalService.showInFolder(projectPath);
      }
    } else if (mode === "paste") {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) {
        atom.notifications.addError("Cannot insert path, because there is no active text editor");
        return;
      }
      editor.insertText(data.pathsToOpen.join("\n"), { selection: true });
    }
  }

  async deleteSelected() {
    const item = this.selectList.getSelectedItem();
    if (!item) return;
    const currentIdx = this.selectList.selectionIndex ?? 0;
    const scrollEl = this.selectList.refs.items;
    const scrollTop = scrollEl?.scrollTop ?? 0;
    const newFilteredLength = this.selectList.items.length - 1;
    const clampedIdx = newFilteredLength > 0 ? Math.min(currentIdx, newFilteredLength - 1) : 0;
    const idx = this.items.indexOf(item);
    if (idx !== -1) {
      this.items.splice(idx, 1);
    }
    await this.selectList.update({
      items: this.items,
      loadingMessage: null,
      initialSelectionIndex: clampedIdx,
    });
    if (scrollEl) scrollEl.scrollTop = scrollTop;
    atom.history.removeProject(item.originalPaths);
  }

  didCancelSelection() {
    this.selectList.hide();
  }

  prepareData(item) {
    const pathsToOpen = [];
    const errs = [];
    for (let projectPath of item.paths) {
      if (fs.existsSync(projectPath) && fs.lstatSync(projectPath).isDirectory()) {
        pathsToOpen.push(projectPath.replace(/[\\/]+$/, ""));
      } else {
        errs.push(projectPath);
      }
    }
    if (errs.length) {
      atom.notifications.addError("Directory does not exist", {
        detail: errs.join("\n"),
      });
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
