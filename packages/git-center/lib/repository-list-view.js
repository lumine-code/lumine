const { applySwitchItem, buildSwitchItems } = require("./helpers");
const { divergenceChips, statusChips } = require("./status-summary");

// Repository picker. Selecting a repository makes it the window's active
// repository (unpinned).
module.exports = class RepositoryListView {
  constructor() {
    this.selectListView = atom.workspace.buildSelectList({
      className: "git-center-repository-list",
      items: [],
      emptyMessage: "No repositories in this window",
      filterKeyForItem: (item) => item.repoName,
      elementForItem: (item, { highlight }) => {
        if (item.auto) {
          return {
            className: "git-center-item",
            icon: ["icon-sync"],
            primary: highlight(item.repoName),
            secondary: "The active repository is updated based on the active editor.",
          };
        }

        // The branch badge sits last so the working-tree and upstream detail
        // reads to its left, closest to the repository it describes.
        return {
          className: "git-center-item",
          icon: ["icon-repo"],
          primary: highlight(item.repoName),
          secondary: item.workingDirectory,
          trailing: [
            ...statusChips(item.status),
            ...divergenceChips(item.upstream),
            { text: item.branch, className: "badge badge-info" },
          ],
        };
      },
      didConfirmSelection: (item) => {
        this.hide();
        if (item.auto) {
          atom.repositories.setActiveRepository(null);
        } else {
          applySwitchItem(item, { pin: true });
        }
      },
      didCancelSelection: () => this.hide(),
    });
  }

  async toggle() {
    if (this.selectListView.isVisible()) {
      this.hide();
      return;
    }

    this.selectListView.reset();
    await this.selectListView.update({ items: [], loadingMessage: "Loading repositories…" });
    this.selectListView.show();

    const items = [
      { auto: true, repoName: "Auto" },
      ...(await buildSwitchItems()).filter((item) => item.current),
    ];
    if (!this.selectListView.isVisible()) {
      return;
    }
    await this.selectListView.update({ items, loadingMessage: null });
  }

  hide() {
    this.selectListView.hide();
  }

  destroy() {
    this.selectListView.destroy();
  }
};
