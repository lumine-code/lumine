const { CompositeDisposable, Disposable, TextBuffer } = require("atom");

const SelectNext = require("./select-next");
const { History, HistoryCycler } = require("./history");
const FindOptions = require("./find-options");
const BufferSearch = require("./buffer-search");
const { EditorSearchTarget, AdapterSearchTarget } = require("./search-target");
const FindView = require("./find-view");
const ProjectFindView = require("./project-find-view");
const ResultsModel = require("./results-model");
const ResultsPaneView = require("./results-pane");

module.exports = {
  activate(param) {
    // Convert old config setting for backward compatibility.
    if (param == null) {
      param = {};
    }
    const { findOptions, findHistory, replaceHistory, pathsHistory } = param;
    if (atom.config.get("search-panel.openProjectFindResultsInRightPane")) {
      atom.config.set("search-panel.projectSearchResultsPaneSplitDirection", "right");
    }
    atom.config.unset("search-panel.openProjectFindResultsInRightPane");

    atom.workspace.addOpener(function (filePath) {
      if (filePath.indexOf(ResultsPaneView.URI) !== -1) {
        return new ResultsPaneView();
      }
    });

    this.subscriptions = new CompositeDisposable();
    this.currentItemSub = new Disposable();
    this.findHistory = new History(findHistory);
    this.replaceHistory = new History(replaceHistory);
    this.pathsHistory = new History(pathsHistory);

    this.findOptions = new FindOptions(findOptions);
    this.findModel = new BufferSearch(this.findOptions);
    // The buffer find UI searches through a SearchTarget. The editor-backed
    // target wraps the BufferSearch model; other targets (search adapters) are
    // selected per active pane item in observeActivePaneItem.
    this.editorTarget = new EditorSearchTarget(this.findModel);
    this.activeTarget = this.editorTarget;
    this.searchAdapterServices = [];
    this.resultsModel = new ResultsModel(this.findOptions);

    this.subscriptions.add(
      atom.workspace.getCenter().observeActivePaneItem((paneItem) => {
        this.activatePaneItem(paneItem);
      }),
    );

    this.subscriptions.add(
      atom.commands.add(".search-panel, .search-panel-project", "window:focus-next-pane", () =>
        atom.views.getView(atom.workspace).focus(),
      ),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:project-show", () => {
        this.createProjectFindView();
        return showPanel(this.projectFindPanel, this.findPanel, () =>
          this.projectFindView.focusFindElement(),
        );
      }),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:project-toggle", () => {
        this.createProjectFindView();
        return togglePanel(this.projectFindPanel, this.findPanel, () =>
          this.projectFindView.focusFindElement(),
        );
      }),
    );

    this.subscriptions.add(
      atom.commands.add(
        "atom-workspace",
        "search-panel:project-show-in-current-directory",
        ({ target }) => {
          this.createProjectFindView();
          this.findPanel?.hide();
          this.projectFindPanel.show();
          this.projectFindView.focusFindElement();
          return this.projectFindView.findInCurrentlySelectedDirectory(target);
        },
      ),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:use-selection-as-find-pattern", () => {
        if (this.projectFindPanel?.isVisible() || this.findPanel?.isVisible()) {
          return;
        }
        return this.createViews();
      }),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:use-selection-as-replace-pattern", () => {
        if (this.projectFindPanel?.isVisible() || this.findPanel?.isVisible()) {
          return;
        }
        return this.createViews();
      }),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:toggle", () => {
        this.createFindView();
        return togglePanel(this.findPanel, this.projectFindPanel, () =>
          this.findView.focusFindEditor(),
        );
      }),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:show", () => {
        this.createFindView();
        return showPanel(this.findPanel, this.projectFindPanel, () =>
          this.findView.focusFindEditor(),
        );
      }),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:show-replace", () => {
        this.createFindView();
        return showPanel(this.findPanel, this.projectFindPanel, () =>
          this.findView.focusReplaceEditor(),
        );
      }),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:clear-history", () => {
        this.findHistory.clear();
        return this.replaceHistory.clear();
      }),
    );

    this.subscriptions.add(
      atom.commands.add("atom-workspace", "search-panel:clear", () => {
        this.findView?.clear();
        this.projectFindView?.clear();
      }),
    );

    // Handling cancel in the workspace + code editors
    const handleEditorCancel = ({ target }) => {
      const isMiniEditor = target.tagName === "ATOM-TEXT-EDITOR" && target.hasAttribute("mini");
      if (!isMiniEditor) {
        this.findPanel?.hide();
        return this.projectFindPanel?.hide();
      }
    };

    this.subscriptions.add(
      atom.commands.add("atom-workspace", {
        "core:cancel": handleEditorCancel,
        "core:close": handleEditorCancel,
      }),
    );

    const selectNextObjectForEditorElement = (editorElement) => {
      if (this.selectNextObjects == null) {
        this.selectNextObjects = new WeakMap();
      }
      const editor = editorElement.getModel();
      let selectNext = this.selectNextObjects.get(editor);
      if (selectNext == null) {
        selectNext = new SelectNext(editor);
        this.selectNextObjects.set(editor, selectNext);
      }
      return selectNext;
    };

    var showPanel = function (panelToShow, panelToHide, postShowAction) {
      panelToHide?.hide();
      panelToShow.show();
      return postShowAction?.();
    };

    var togglePanel = function (panelToToggle, panelToHide, postToggleAction) {
      panelToHide?.hide();

      if (panelToToggle.isVisible()) {
        return panelToToggle.hide();
      } else {
        panelToToggle.show();
        return postToggleAction?.();
      }
    };

    return this.subscriptions.add(
      atom.commands.add(".editor:not(.mini)", {
        "search-panel:select-next"() {
          return selectNextObjectForEditorElement(this).findAndSelectNext();
        },
        "search-panel:select-all"() {
          return selectNextObjectForEditorElement(this).findAndSelectAll();
        },
        "search-panel:select-undo"() {
          return selectNextObjectForEditorElement(this).undoLastSelection();
        },
        "search-panel:select-skip"() {
          return selectNextObjectForEditorElement(this).skipCurrentSelection();
        },
      }),
    );
  },

  consumeSearchAdapter(service) {
    this.searchAdapterServices.push(service);
    this.activatePaneItem(atom.workspace.getCenter().getActivePaneItem());
    return new Disposable(() => {
      this.searchAdapterServices = this.searchAdapterServices.filter(
        (candidate) => candidate !== service,
      );
      this.activatePaneItem(atom.workspace.getCenter().getActivePaneItem());
    });
  },

  toggleAutocompletions(value) {
    if (this.findView == null) {
      return;
    }
    this.autocompleteSubscriptions?.dispose();
    this.autocompleteSubscriptions = null;
    if (value) {
      this.autocompleteSubscriptions = new CompositeDisposable();
      const disposable = this.autocompleteWatchEditor?.(this.findView.findEditor, ["default"]);
      if (disposable != null) {
        this.autocompleteSubscriptions.add(disposable);
      }
    }
  },

  consumeAutocompleteWatchEditor(watchEditor) {
    this.autocompleteWatchEditor = watchEditor;
    const configObserver = atom.config.observe("search-panel.autocompleteSearches", (value) =>
      this.toggleAutocompletions(value),
    );
    return new Disposable(() => {
      configObserver.dispose();
      this.autocompleteSubscriptions?.dispose();
      this.autocompleteSubscriptions = null;
      this.autocompleteWatchEditor = null;
    });
  },

  provideSearchControl() {
    return {
      resultsMarkerLayerForTextEditor: this.findModel.resultsMarkerLayerForTextEditor.bind(
        this.findModel,
      ),

      // FindOptions access
      getFindOptions: () => this.findOptions,
      onDidChangeFindOptions: (callback) => this.findOptions.onDidChange(callback),

      // Panel visibility
      showFind: () => {
        this.createFindView();
        this.projectFindPanel?.hide();
        this.findPanel.show();
        this.findView.focusFindEditor();
      },
      showReplace: () => {
        this.createFindView();
        this.projectFindPanel?.hide();
        this.findPanel.show();
        this.findView.focusReplaceEditor();
      },
      showProjectFind: () => {
        this.createProjectFindView();
        this.findPanel?.hide();
        this.projectFindPanel.show();
        this.projectFindView.focusFindElement();
      },
      hideFind: () => this.findPanel?.hide(),
      hideProjectFind: () => this.projectFindPanel?.hide(),
      isFindVisible: () => this.findPanel?.isVisible() ?? false,
      isProjectFindVisible: () => this.projectFindPanel?.isVisible() ?? false,

      // Events
      onDidUpdate: (callback) => this.findModel.onDidUpdate(callback),
      onDidChangeCurrentResult: (callback) => this.findModel.onDidChangeCurrentResult(callback),
      onDidChangeFindVisibility: (callback) => {
        this.createFindView();
        return this.findPanel.onDidChangeVisible(callback);
      },
      onDidChangeProjectFindVisibility: (callback) => {
        this.createProjectFindView();
        return this.projectFindPanel.onDidChangeVisible(callback);
      },

      // Search triggers
      search: (findPattern, options) => {
        this.createFindView();
        this.findView.search(findPattern, options);
      },
      projectSearch: (findPattern, pathsPattern) => {
        this.createProjectFindView();
        this.findOptions.set({ findPattern, pathsPattern });
        this.projectFindView.confirm();
      },
    };
  },

  createViews() {
    this.createFindView();
    this.createProjectFindView();
  },

  createViewOptions() {
    if (this.viewOptions != null) {
      return this.viewOptions;
    }

    const findBuffer = new TextBuffer();
    const replaceBuffer = new TextBuffer();
    const pathsBuffer = new TextBuffer();

    this.viewOptions = {
      findBuffer,
      replaceBuffer,
      pathsBuffer,
      findHistoryCycler: new HistoryCycler(findBuffer, this.findHistory),
      replaceHistoryCycler: new HistoryCycler(replaceBuffer, this.replaceHistory),
      pathsHistoryCycler: new HistoryCycler(pathsBuffer, this.pathsHistory),
    };

    return this.viewOptions;
  },

  createFindView() {
    if (this.findView != null) {
      return;
    }

    this.findView = new FindView(this.activeTarget, this.createViewOptions());

    this.findPanel = atom.workspace.addBottomPanel({
      item: this.findView,
      visible: false,
      className: "tool-panel panel-bottom",
    });

    this.findView.setPanel(this.findPanel);
    if (this.activeTarget?.refresh) {
      this.activeTarget.refresh();
    }
    this.toggleAutocompletions(atom.config.get("search-panel.autocompleteSearches"));
  },

  createProjectFindView() {
    if (this.projectFindView != null) {
      return;
    }

    this.projectFindView = new ProjectFindView(this.resultsModel, this.createViewOptions());

    this.projectFindPanel = atom.workspace.addBottomPanel({
      item: this.projectFindView,
      visible: false,
      className: "tool-panel panel-bottom",
    });

    this.projectFindView.setPanel(this.projectFindPanel);

    // HACK: Soooo, we need to get the model to the pane view whenever it is
    // created. Creation could come from the opener below, or, more problematic,
    // from a deserialize call when splitting panes. For now, all pane views will
    // use this same model. This needs to be improved! I dont know the best way
    // to deal with this:
    // 1. How should serialization work in the case of a shared model.
    // 2. Or maybe we create the model each time a new pane is created? Then
    //    ProjectFindView needs to know about each model so it can invoke a search.
    //    And on each new model, it will run the search again.
    //
    // See https://github.com/atom/find-and-replace/issues/63
    // This makes projectFindView accesible in ResultsPaneView so that resultsModel
    // can be properly set for ResultsPaneView instances and ProjectFindView instance
    // as different pane views don't necessarily use same models anymore
    // but most recent pane view and projectFindView do
    ResultsPaneView.projectFindView = this.projectFindView;
  },

  // Point the buffer find view at the given SearchTarget (editor- or
  // adapter-backed) and, for adapters, re-highlight the current query.
  activateTarget(target) {
    // Clear the outgoing adapter target's highlights when leaving it, so search
    // results don't linger in a view that's no longer active.
    if (this.activeTarget && this.activeTarget !== target && this.activeTarget.deactivate) {
      this.activeTarget.deactivate();
    }
    this.activeTarget = target;
    if (this.findView) {
      this.findView.setTarget(target);
      if (target.refresh) target.refresh();
    }
  },

  getSearchAdapterForPaneItem(paneItem) {
    if (!paneItem) return null;
    for (const service of this.searchAdapterServices || []) {
      const adapter =
        service.getActiveAdapter?.() ||
        (service.handlesItem?.(paneItem) ? service.getAdapterForItem?.(paneItem) : null);
      if (adapter) return adapter;
    }
    return null;
  },

  activatePaneItem(paneItem) {
    this.subscriptions.delete(this.currentItemSub);
    this.currentItemSub.dispose();

    const adapter = this.getSearchAdapterForPaneItem(paneItem);
    if (adapter) {
      this.findModel.setEditor(null);
      return this.activateTarget(new AdapterSearchTarget(adapter, this.findOptions));
    }

    if (atom.workspace.isTextEditor(paneItem)) {
      this.findModel.setEditor(paneItem);
      return this.activateTarget(this.editorTarget);
    } else if (paneItem?.observeEmbeddedTextEditor != null) {
      this.currentItemSub = paneItem.observeEmbeddedTextEditor((editor) => {
        if (atom.workspace.getCenter().getActivePaneItem() === paneItem) {
          this.findModel.setEditor(editor);
          this.activateTarget(this.editorTarget);
        }
      });
      return this.subscriptions.add(this.currentItemSub);
    } else if (paneItem?.getEmbeddedTextEditor != null) {
      this.findModel.setEditor(paneItem.getEmbeddedTextEditor());
      return this.activateTarget(this.editorTarget);
    } else {
      this.findModel.setEditor(null);
      return this.activateTarget(this.editorTarget);
    }
  },

  deactivate() {
    this.findPanel?.destroy();
    this.findPanel = null;
    this.findView?.destroy();
    this.findView = null;
    this.findModel?.destroy();
    this.findModel = null;

    this.projectFindPanel?.destroy();
    this.projectFindPanel = null;
    this.projectFindView?.destroy();
    this.projectFindView = null;
    this.viewOptions = null;

    ResultsPaneView.model = null;

    this.autocompleteSubscriptions?.dispose();
    this.autocompleteManagerService = null;
    this.subscriptions?.dispose();
    return (this.subscriptions = null);
  },

  serialize() {
    return {
      findOptions: this.findOptions.serialize(),
      findHistory: this.findHistory.serialize(),
      replaceHistory: this.replaceHistory.serialize(),
      pathsHistory: this.pathsHistory.serialize(),
    };
  },
};
