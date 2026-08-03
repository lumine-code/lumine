const { CompositeDisposable } = require("atom");

const { applySwitchItem, buildSwitchItems, updateListPreservingScroll } = require("./helpers");
const { divergenceChips, statusChips } = require("./status-summary");

const ACTIONS = [
  { id: "action:auto", auto: true, repoName: "Auto" },
  { id: "action:rescan", rescan: true, repoName: "Rescan repositories" },
];

// Repository picker. Selecting a repository makes it the window's active
// repository (unpinned).
module.exports = class RepositoryListView {
  constructor() {
    this.subscriptions = new CompositeDisposable();
    this.repositorySubscriptions = null;
    this.refreshRequested = false;
    this.refreshPromise = null;
    this.activeRescanIds = new Set();
    this.rescanScrollTop = null;
    this.selectListView = atom.workspace.buildSelectList({
      className: "git-center-repository-list",
      items: [],
      separatorIds: [],
      emptyMessage: "No repositories in this window",
      filterKeyForItem: (item) => item.repoName,
      elementForItem: (item, { highlight }) => {
        if (item.rescan) {
          return {
            className: "git-center-item",
            icon: ["icon-sync"],
            primary: highlight(item.repoName),
            secondary: "Scan project roots again for Git repositories.",
          };
        }
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
        if (item.rescan) {
          atom.commands.dispatch(atom.workspace.getElement(), "repositories:rescan");
          return;
        }
        this.hide();
        if (item.auto) {
          atom.repositories.setActiveRepository(null);
        } else {
          applySwitchItem(item, { pin: true });
        }
      },
      didCancelSelection: () => this.hide(),
    });

    this.subscriptions.add(
      this.selectListView.getPanel().onDidChangeVisible((visible) => {
        if (visible) {
          this.observeRepositories();
          this.requestRefresh().catch(() => {});
        } else {
          this.stopObservingRepositories();
          this.activeRescanIds.clear();
          this.rescanScrollTop = null;
        }
      }),
    );
  }

  observeRepositories() {
    this.stopObservingRepositories();
    const subscriptions = new CompositeDisposable();
    this.repositorySubscriptions = subscriptions;

    subscriptions.add(
      atom.repositories.onDidChange(() => {
        if (!this.selectListView.isVisible()) return;
        this.observeRepositories();
        this.requestRefresh().catch(() => {});
      }),
      atom.repositories.onDidChangeActiveRepository(() => {
        this.requestRefresh().catch(() => {});
      }),
      atom.repositories.onDidStartRescan(({ id }) => {
        if (this.activeRescanIds.size === 0) {
          this.rescanScrollTop = this.selectListView.refs.items?.scrollTop ?? null;
        }
        this.activeRescanIds.add(id);
        this.selectListView
          .update({
            items: [],
            loadingMessage: "Loading repositories…",
          })
          .catch(() => {});
      }),
      atom.repositories.onDidFinishRescan(({ id }) => {
        this.activeRescanIds.delete(id);
        if (this.activeRescanIds.size === 0) {
          const scrollTop = this.rescanScrollTop;
          this.rescanScrollTop = null;
          this.requestRefresh()
            .then(() => {
              if (scrollTop != null && this.selectListView.refs.items) {
                this.selectListView.refs.items.scrollTop = scrollTop;
              }
            })
            .catch(() => {});
        }
      }),
    );

    for (const repository of atom.repositories.getRepositories()) {
      subscriptions.add(
        repository.onDidChangeStatusSnapshot(() => {
          this.requestRefresh().catch(() => {});
        }),
        repository.onDidChangeRefsSnapshot(() => {
          this.requestRefresh().catch(() => {});
        }),
      );
    }
  }

  stopObservingRepositories() {
    this.repositorySubscriptions?.dispose();
    this.repositorySubscriptions = null;
    this.refreshRequested = false;
  }

  requestRefresh() {
    if (!this.selectListView.isVisible()) return Promise.resolve();
    this.refreshRequested = true;
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshItems().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async refreshItems() {
    while (this.refreshRequested && this.selectListView.isVisible()) {
      this.refreshRequested = false;
      if (this.activeRescanIds.size > 0) {
        await this.selectListView.update({
          items: [],
          loadingMessage: "Loading repositories…",
        });
        continue;
      }
      // One row per repository, so the working directory identifies it.
      const repositories = (await buildSwitchItems())
        .filter((item) => item.current)
        .map((item) => ({ ...item, id: `repo:${item.workingDirectory}` }));
      const items = [...ACTIONS, ...repositories];
      if (!this.selectListView.isVisible()) return;
      await updateListPreservingScroll(this.selectListView, {
        items,
        // A rule below the actions, as in the branch list.
        separatorIds: repositories.length > 0 ? [repositories[0].id] : [],
        loadingMessage: null,
      });
    }
  }

  async toggle() {
    if (this.selectListView.isVisible()) {
      this.hide();
      return;
    }

    this.selectListView.reset();
    await this.selectListView.update({ items: [], loadingMessage: "Loading repositories…" });
    this.selectListView.show();
    await this.requestRefresh();
  }

  hide() {
    this.selectListView.hide();
  }

  destroy() {
    this.stopObservingRepositories();
    this.subscriptions.dispose();
    this.selectListView.destroy();
  }
};
