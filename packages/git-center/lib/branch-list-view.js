const BranchNameDialog = require("./branch-name-dialog");
const { applySwitchItem, buildSwitchItems, checkoutBranch } = require("./helpers");
const { divergenceChips, statusChips } = require("./status-summary");

const ACTIONS = [
  { action: "create", branch: "Create new branch...", icon: "icon-plus", crumb: "New branch" },
  {
    action: "create-from",
    branch: "Create new branch from...",
    icon: "icon-plus",
    crumb: "Create from",
  },
  { action: "detach", branch: "Checkout detached...", icon: "icon-git-commit", crumb: "Detach" },
];

// Branch picker for the active repository. Selecting a non-current branch
// checks it out through the repository's operations facade.
module.exports = class BranchListView {
  constructor() {
    this.branchNameDialog = new BranchNameDialog();
    this.selectListView = atom.workspace.buildSelectList({
      className: "git-center-branch-list",
      crumb: "Branches",
      items: [],
      emptyMessage: "No branches yet",
      filterKeyForItem: (item) => item.branch,
      elementForItem: (item, { highlight }) => {
        const className = ["git-center-item"];
        if (item.action) {
          className.push("git-center-branch-action");
          if (item.action === "detach") className.push("git-center-branch-action-last");
        }

        return {
          className,
          icon: [item.icon || "icon-git-branch"],
          primary: highlight(item.branch),
          // Action rows stay one line; branch rows name their upstream below.
          secondary: item.action ? undefined : item.upstream?.name || "(no upstream)",
          trailing: [
            // Only the checked-out branch has a working tree to report on.
            ...(item.current ? statusChips(item.status) : []),
            ...divergenceChips(item.upstream),
            item.current && { text: "current", className: "badge" },
          ],
        };
      },
      didConfirmSelection: (item) => {
        if (item.action) this.performAction(item.action);
        else {
          this.hide();
          applySwitchItem(item);
        }
      },
      didCancelSelection: () => this.hide(),
    });

    this.referenceListView = atom.workspace.buildSelectList({
      className: "git-center-reference-list",
      items: [],
      emptyMessage: "No references yet",
      filterKeyForItem: (item) => `${item.label} ${item.detail}`,
      elementForItem: (item, { highlight }) => ({
        className: "git-center-item",
        icon: [item.icon],
        primary: highlight(item.label),
        secondary: item.detail || undefined,
      }),
      didConfirmSelection: (item) => this.confirmReference(item),
      didCancelSelection: () => this.referenceListView.hide(),
    });
  }

  performAction(action) {
    const repository = atom.repositories.getActiveRepository();
    if (!repository) return;

    // The next step shows itself as a flow step, which hides this list as a
    // transition — the trail keeps it as the previous breadcrumb entry.
    if (action === "create") {
      this.branchNameDialog.show({
        prompt: "Please provide a new branch name",
        crumb: ACTIONS.find((entry) => entry.action === action).crumb,
        onConfirm: (name) => checkoutBranch(repository, name, { createNew: true }),
      });
    } else {
      this.showReferenceList(action, repository);
    }
  }

  async showReferenceList(action, repository) {
    this.pendingReference = { action, repository };
    this.referenceListView.reset();
    await this.referenceListView.update({ items: [], loadingMessage: "Loading references…" });
    this.referenceListView.show({ crumb: ACTIONS.find((entry) => entry.action === action).crumb });

    const refs = await repository.ensureRefsSnapshot?.().catch(() => null);
    if (!this.referenceListView.isVisible() || repository !== this.pendingReference?.repository)
      return;
    await this.referenceListView.update({
      items: this.buildReferenceItems(refs),
      loadingMessage: null,
    });
  }

  buildReferenceItems(refs) {
    const items = [];
    if (refs?.head?.oid) {
      items.push({
        reference: "HEAD",
        label: "HEAD",
        detail: refs.head.name || refs.head.oid.slice(0, 7),
        icon: "icon-git-commit",
      });
    }
    for (const branch of refs?.branches || []) {
      items.push({
        reference: branch.name,
        label: branch.name,
        detail: "Local branch",
        icon: "icon-git-branch",
      });
    }
    for (const branch of refs?.remoteBranches || []) {
      if (branch.symrefTarget) continue;
      items.push({
        reference: branch.name,
        label: branch.name,
        detail: "Remote branch",
        icon: "icon-cloud-download",
      });
    }
    for (const tag of refs?.tags || []) {
      items.push({
        reference: tag.name,
        label: tag.name,
        detail: "Tag",
        icon: "icon-tag",
      });
    }
    return items;
  }

  confirmReference(item) {
    const { action, repository } = this.pendingReference ?? {};
    if (!repository) {
      this.referenceListView.hide();
      return;
    }

    if (action === "detach") {
      // Confirming completes the flow, so this hide ends the trail.
      this.referenceListView.hide();
      checkoutBranch(repository, item.reference, { detach: true });
    } else if (action === "create-from") {
      // The dialog shows itself as the next step; going back from it returns
      // to this reference list with its items and filter intact.
      this.branchNameDialog.show({
        prompt: "Please provide a new branch name",
        crumb: item.reference,
        onConfirm: (name) =>
          checkoutBranch(repository, name, { createNew: true, startPoint: item.reference }),
      });
    }
  }

  async toggle() {
    if (this.selectListView.isVisible()) {
      this.hide();
      return;
    }
    const repository = atom.repositories.getActiveRepository();
    if (!repository) {
      return;
    }

    this.selectListView.reset();
    await this.selectListView.update({ items: [], loadingMessage: "Loading branches…" });
    this.selectListView.show();

    const items = [...ACTIONS, ...(await buildSwitchItems()).filter((item) => item.active)];
    if (
      !this.selectListView.isVisible() ||
      atom.repositories.getActiveRepository() !== repository
    ) {
      return;
    }
    await this.selectListView.update({ items, loadingMessage: null });
  }

  hide() {
    this.selectListView.hide();
  }

  destroy() {
    this.selectListView.destroy();
    this.referenceListView.destroy();
    this.branchNameDialog.destroy();
  }
};
