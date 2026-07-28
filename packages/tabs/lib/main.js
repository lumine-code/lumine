const { CompositeDisposable } = require("atom");
const layout = require("./layout");
const TabBarView = require("./tab-bar-view.js");
const _ = require("@lumine-code/underscore-plus");

module.exports = {
  activate() {
    this.subscriptions = new CompositeDisposable();
    layout.activate();
    this.tabBarViews = [];

    // If the command bubbles up without being handled by a particular pane,
    // close all tabs in all panes
    this.subscriptions.add(
      atom.commands.add("atom-workspace", {
        "tabs:close-all-tabs": () => {
          // We loop backwards because the panes are
          // removed from the array as we go
          for (let i = this.tabBarViews.length - 1; i >= 0; i--) {
            this.tabBarViews[i].closeAllTabs();
          }
        },
      }),
    );

    const paneContainers = {
      center: atom.workspace.getCenter(),
      left: atom.workspace.getLeftDock(),
      right: atom.workspace.getRightDock(),
      bottom: atom.workspace.getBottomDock(),
    };

    Object.keys(paneContainers).forEach((location) => {
      const container = paneContainers[location];
      if (!container) {
        return;
      }

      this.subscriptions.add(
        container.observePanes((pane) => {
          const tabBarView = new TabBarView(pane, location);

          const paneElement = pane.getElement();
          paneElement.insertBefore(tabBarView.element, paneElement.firstChild);

          this.tabBarViews.push(tabBarView);
          pane.onDidDestroy(() => _.remove(this.tabBarViews, tabBarView));
        }),
      );
    });
  },

  deactivate() {
    layout.deactivate();
    this.subscriptions.dispose();

    for (let tabBarView of this.tabBarViews) {
      tabBarView.destroy();
    }
  },
};
