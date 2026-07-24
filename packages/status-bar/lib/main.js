const { CompositeDisposable, Emitter } = require("atom");
const StatusBarView = require("./status-bar-view");

module.exports = {
  activate() {
    this.emitters = new Emitter();
    this.subscriptions = new CompositeDisposable();

    this.statusBar = new StatusBarView();
    this.attachStatusBar();

    this.subscriptions.add(
      atom.config.onDidChange("status-bar.fullWidth", () => {
        this.attachStatusBar();
      }),
    );

    this.updateStatusBarVisibility();

    this.statusBarVisibilitySubscription = atom.config.observe("status-bar.isVisible", () => {
      this.updateStatusBarVisibility();
    });

    atom.commands.add("atom-workspace", "status-bar:toggle", () => {
      if (this.statusBarPanel.isVisible()) {
        atom.config.set("status-bar.isVisible", false);
      } else {
        atom.config.set("status-bar.isVisible", true);
      }
    });
  },

  deactivate() {
    this.statusBarVisibilitySubscription?.dispose();
    this.statusBarVisibilitySubscription = null;

    this.statusBarPanel?.destroy();
    this.statusBarPanel = null;

    this.statusBar?.destroy();
    this.statusBar = null;

    this.subscriptions?.dispose();
    this.subscriptions = null;

    this.emitters?.dispose();
    this.emitters = null;

    if (atom.__workspaceView != null) {
      delete atom.__workspaceView.statusBar;
    }
  },

  updateStatusBarVisibility() {
    if (atom.config.get("status-bar.isVisible")) {
      this.statusBarPanel.show();
    } else {
      this.statusBarPanel.hide();
    }
  },

  provideStatusBar() {
    return {
      addLeftTile: this.statusBar.addLeftTile.bind(this.statusBar),
      addRightTile: this.statusBar.addRightTile.bind(this.statusBar),
      getLeftTiles: this.statusBar.getLeftTiles.bind(this.statusBar),
      getRightTiles: this.statusBar.getRightTiles.bind(this.statusBar),
    };
  },

  attachStatusBar() {
    if (this.statusBarPanel != null) {
      this.statusBarPanel.destroy();
    }

    const panelArgs = { item: this.statusBar, priority: 0 };
    if (atom.config.get("status-bar.fullWidth")) {
      this.statusBarPanel = atom.workspace.addFooterPanel(panelArgs);
    } else {
      this.statusBarPanel = atom.workspace.addBottomPanel(panelArgs);
    }
  },
};
