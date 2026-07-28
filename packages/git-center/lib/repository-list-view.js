const { applySwitchItem, buildSwitchItems } = require("./helpers");
const { divergenceChips, statusChips } = require("./status-summary");

// Repository picker. Selecting a repository makes it the window's active
// repository (unpinned).
module.exports = class RepositoryListView {
  toggle() {
    return atom.modals.toggle({
      id: "git-center.repositories",
      className: "git-center-repository-list",
      placeholder: "Select a repository",
      emptyMessage: "No repositories in this window",
      // Reading the repositories is async, so the list opens with busy chrome
      // and fills in. The run is abandoned if the view goes away first, which
      // is what the old post-await isVisible() check was doing by hand.
      source: async (req) => {
        req.progress({ busy: true, message: "Loading repositories…" });
        const items = [
          { auto: true, repoName: "Auto" },
          ...(await buildSwitchItems()).filter((item) => item.current),
        ];
        req.progress({ busy: false, message: null });
        return items;
      },
      renderer: {
        entry: (item) => ({ id: item.auto ? "auto" : item.workingDirectory, text: item.repoName }),
        row: (item) => {
          if (item.auto) {
            return {
              className: "git-center-item",
              icon: ["icon-sync"],
              label: item.repoName,
              detail: "The active repository is updated based on the active editor.",
            };
          }

          // The branch badge sits last so the working-tree and upstream detail
          // reads to its left, closest to the repository it describes.
          return {
            className: "git-center-item",
            icon: ["icon-repo"],
            label: item.repoName,
            detail: item.workingDirectory,
            trailing: [
              ...statusChips(item.status),
              ...divergenceChips(item.upstream),
              { text: item.branch, className: "badge badge-info" },
            ],
          };
        },
      },
      confirm: ({ item }) => {
        if (item.auto) {
          atom.repositories.setActiveRepository(null);
        } else {
          applySwitchItem(item, { pin: true });
        }
      },
    });
  }

  hide() {
    const session = atom.modals.getActiveSession();
    if (session && session.rootSpec.id === "git-center.repositories") session.cancel("api");
  }

  destroy() {}
};
