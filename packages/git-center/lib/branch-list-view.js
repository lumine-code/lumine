const branchNameSpec = require("./branch-name-dialog");
const { applySwitchItem, buildSwitchItems, checkoutBranch } = require("./helpers");
const { divergenceChips, statusChips } = require("./status-summary");

const ACTIONS = [
  { action: "create", branch: "Create new branch...", icon: "icon-plus" },
  { action: "create-from", branch: "Create new branch from...", icon: "icon-plus" },
  { action: "detach", branch: "Checkout detached...", icon: "icon-git-commit" },
];

// Branch picker for the active repository. Selecting a non-current branch
// checks it out through the repository's operations facade; the action rows
// enter a sublist instead, so the whole flow is one session the user can back
// out of a step at a time.
module.exports = class BranchListView {
  toggle() {
    if (!atom.repositories.getActiveRepository()) return null;

    return atom.modals.toggle({
      id: "git-center.branches",
      className: "git-center-branch-list",
      title: "Branches",
      placeholder: "Select a branch",
      emptyMessage: "No branches yet",
      // The run is abandoned if the view goes away or the repository changes
      // under it, which is what the old post-await guards checked by hand.
      source: async (req) => {
        req.progress({ busy: true, message: "Loading branches…" });
        const items = [...ACTIONS, ...(await buildSwitchItems()).filter((item) => item.active)];
        req.progress({ busy: false, message: null });
        return items;
      },
      renderer: {
        entry: (item) => ({ id: item.action ?? item.branch, text: item.branch }),
        row: (item) => {
          const className = ["git-center-item"];
          if (item.action) {
            className.push("git-center-branch-action");
            if (item.action === "detach") className.push("git-center-branch-action-last");
          }
          return {
            className,
            icon: [item.icon || "icon-git-branch"],
            label: item.branch,
            // Action rows stay one line; branch rows name their upstream below.
            detail: item.action ? undefined : item.upstream?.name || "(no upstream)",
            trailing: [
              // Only the checked-out branch has a working tree to report on.
              ...(item.current ? statusChips(item.status) : []),
              ...divergenceChips(item.upstream),
              item.current && { text: "current", className: "badge" },
            ],
          };
        },
      },
      confirm: ({ item }) => {
        if (!item.action) {
          applySwitchItem(item);
          return;
        }
        const repository = atom.repositories.getActiveRepository();
        if (!repository) return;
        if (item.action === "create") {
          return {
            push: branchNameSpec({
              prompt: "Please provide a new branch name",
              onConfirm: (name) => checkoutBranch(repository, name, { createNew: true }),
            }),
          };
        }
        return { push: this.referenceSpec(item.action, repository) };
      },
    });
  }

  referenceSpec(action, repository) {
    return {
      id: "git-center.references",
      className: "git-center-reference-list",
      title: action === "detach" ? "Checkout detached" : "Start point",
      placeholder: "Select a reference",
      emptyMessage: "No references yet",
      source: async (req) => {
        req.progress({ busy: true, message: "Loading references…" });
        const refs = await repository.ensureRefsSnapshot?.().catch(() => null);
        req.progress({ busy: false, message: null });
        return this.buildReferenceItems(refs);
      },
      renderer: {
        entry: (item) => ({ id: item.reference, text: `${item.label} ${item.detail}` }),
        row: (item) => ({
          className: "git-center-item",
          icon: [item.icon],
          label: item.label,
          detail: item.detail || undefined,
        }),
      },
      confirm: ({ item }) => {
        if (action === "detach") {
          checkoutBranch(repository, item.reference, { detach: true });
          return;
        }
        return {
          push: branchNameSpec({
            prompt: "Please provide a new branch name",
            onConfirm: (name) =>
              checkoutBranch(repository, name, { createNew: true, startPoint: item.reference }),
          }),
        };
      },
    };
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

  hide() {
    const session = atom.modals.getActiveSession();
    if (session && session.rootSpec.id === "git-center.branches") session.cancel("api");
  }

  destroy() {}
};
