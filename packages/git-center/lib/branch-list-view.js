const { CompositeDisposable } = require("atom");

const BranchNameDialog = require("./branch-name-dialog");
const { applySwitchItem, checkoutBranch, updateListPreservingScroll } = require("./helpers");
const { divergenceChips, statusChips, summarizeStatus } = require("./status-summary");

const ACTIONS = [
  {
    id: "action:create",
    action: "create",
    branch: "Create new branch...",
    icon: "icon-plus",
    crumb: "New branch",
  },
  {
    id: "action:create-from",
    action: "create-from",
    branch: "Create new branch from...",
    icon: "icon-plus",
    crumb: "Create from",
  },
  {
    id: "action:detach",
    action: "detach",
    branch: "Checkout detached...",
    icon: "icon-git-commit",
    crumb: "Detach",
  },
];

const RELATIVE_TIME_UNITS = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

function formatRelativeTime(date, now = Date.now()) {
  const timestamp = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;

  const elapsed = now - timestamp;
  const magnitude = Math.abs(elapsed);
  if (magnitude < 60 * 1000) return "now";

  for (const [unit, milliseconds] of RELATIVE_TIME_UNITS) {
    if (magnitude < milliseconds) continue;
    const value = Math.max(1, Math.round(magnitude / milliseconds));
    const amount = `${value} ${unit}${value === 1 ? "" : "s"}`;
    return elapsed >= 0 ? `${amount} ago` : `in ${amount}`;
  }
  return "now";
}

function primaryForItem(item, highlight) {
  const primary = document.createDocumentFragment();
  primary.appendChild(highlight(item.branch));
  const relativeTime = formatRelativeTime(item.lastCommit?.committerDate);
  if (relativeTime) {
    const time = document.createElement("span");
    time.classList.add("git-center-ref-time");
    time.textContent = ` ${relativeTime}`;
    primary.appendChild(time);
  }
  return primary;
}

function detailForItem(item) {
  const commit = item.lastCommit;
  if (!commit) return undefined;
  return [commit.authorName, commit.oid?.slice(0, 7), commit.subject]
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" • ");
}

// Checkout picker for the active repository. Local branches switch directly,
// remote branches resolve to a tracking local branch, and tags detach HEAD.
module.exports = class BranchListView {
  constructor() {
    this.subscriptions = new CompositeDisposable();
    this.branchRepositorySubscriptions = null;
    this.referenceRepositorySubscriptions = null;
    this.branchRefreshRequested = false;
    this.branchRefreshPromise = null;
    this.referenceRefreshRequested = false;
    this.referenceRefreshPromise = null;
    this.branchNameDialog = new BranchNameDialog();
    this.selectListView = atom.workspace.buildSelectList({
      className: "git-center-branch-list",
      crumb: "Branches",
      items: [],
      separatorIds: [],
      emptyMessage: "No branches or tags yet",
      filterKeyForItem: (item) =>
        item.action
          ? item.branch
          : [
              item.branch,
              item.lastCommit?.authorName,
              item.lastCommit?.oid,
              item.lastCommit?.subject,
            ]
              .filter(Boolean)
              .join(" "),
      elementForItem: (item, { highlight }) => {
        const className = ["git-center-item"];
        if (item.action) {
          className.push("git-center-branch-action");
          if (item.action === "detach") className.push("git-center-branch-action-last");
        }
        return {
          className,
          icon: [item.icon || "icon-git-branch"],
          primary: item.action ? highlight(item.branch) : primaryForItem(item, highlight),
          // Action rows stay one line; refs carry their target commit below.
          secondary: item.action ? undefined : detailForItem(item),
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
        else this.confirmCheckoutItem(item);
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

    this.subscriptions.add(
      this.selectListView.getPanel().onDidChangeVisible((visible) => {
        if (visible) {
          this.observeActiveRepository();
          this.requestBranchRefresh().catch(() => {});
        } else {
          this.stopObservingActiveRepository();
        }
      }),
      this.referenceListView.getPanel().onDidChangeVisible((visible) => {
        if (visible) {
          this.observeReferenceRepository();
          this.requestReferenceRefresh().catch(() => {});
        } else {
          this.stopObservingReferenceRepository();
        }
      }),
    );
  }

  observeActiveRepository() {
    this.stopObservingActiveRepository();
    const subscriptions = new CompositeDisposable();
    this.branchRepositorySubscriptions = subscriptions;
    const repository = atom.repositories.getActiveRepository();

    subscriptions.add(
      atom.repositories.onDidChangeActiveRepository(() => {
        if (!this.selectListView.isVisible()) return;
        this.observeActiveRepository();
        this.requestBranchRefresh().catch(() => {});
      }),
    );
    if (repository) {
      subscriptions.add(
        repository.onDidChangeStatusSnapshot(() => {
          this.requestBranchRefresh().catch(() => {});
        }),
        repository.onDidChangeRefsSnapshot(() => {
          this.requestBranchRefresh().catch(() => {});
        }),
      );
    }
  }

  stopObservingActiveRepository() {
    this.branchRepositorySubscriptions?.dispose();
    this.branchRepositorySubscriptions = null;
    this.branchRefreshRequested = false;
  }

  observeReferenceRepository() {
    this.stopObservingReferenceRepository();
    const repository = this.pendingReference?.repository;
    if (!repository) return;
    const subscriptions = new CompositeDisposable();
    this.referenceRepositorySubscriptions = subscriptions;
    subscriptions.add(
      repository.onDidChangeRefsSnapshot(() => {
        this.requestReferenceRefresh().catch(() => {});
      }),
    );
  }

  stopObservingReferenceRepository() {
    this.referenceRepositorySubscriptions?.dispose();
    this.referenceRepositorySubscriptions = null;
    this.referenceRefreshRequested = false;
  }

  requestBranchRefresh() {
    if (!this.selectListView.isVisible()) return Promise.resolve();
    this.branchRefreshRequested = true;
    if (!this.branchRefreshPromise) {
      this.branchRefreshPromise = this.refreshBranchItems().finally(() => {
        this.branchRefreshPromise = null;
      });
    }
    return this.branchRefreshPromise;
  }

  async refreshBranchItems() {
    while (this.branchRefreshRequested && this.selectListView.isVisible()) {
      this.branchRefreshRequested = false;
      const repository = atom.repositories.getActiveRepository();
      if (!repository) {
        this.hide();
        return;
      }
      const [refs, statusSnapshot] = await Promise.all([
        repository.ensureRefsSnapshot?.().catch(() => null),
        repository.ensureStatusSnapshot?.().catch(() => null),
      ]);
      const groups = this.buildCheckoutGroups(repository, refs, summarizeStatus(statusSnapshot));
      const items = [...ACTIONS, ...groups.flat()];
      // A rule below the actions and above each further kind of ref, which is
      // all that marks the groups apart.
      const separatorIds = groups.filter((group) => group.length > 0).map((group) => group[0].id);
      if (
        !this.selectListView.isVisible() ||
        atom.repositories.getActiveRepository() !== repository
      ) {
        continue;
      }
      await updateListPreservingScroll(this.selectListView, {
        items,
        separatorIds,
        loadingMessage: null,
      });
    }
  }

  buildCheckoutGroups(repository, refs, status) {
    const localBranches = (refs?.branches || [])
      .map((branch) => ({
        id: `branch:${branch.name}`,
        repository,
        kind: "local",
        branch: branch.name,
        reference: branch.name,
        oid: branch.oid,
        icon: "icon-git-branch",
        current: branch.isHead,
        status,
        upstream: branch.upstream || null,
        lastCommit: branch.lastCommit || null,
      }))
      .sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return a.branch.localeCompare(b.branch);
      });

    if (!localBranches.some((item) => item.current)) {
      const head = refs?.head;
      const matchingRef = [
        ...(refs?.branches || []),
        ...(refs?.remoteBranches || []),
        ...(refs?.tags || []),
      ].find((entry) => entry.lastCommit?.oid === head?.oid);
      localBranches.unshift({
        id: "head",
        repository,
        kind: "head",
        branch: head?.name || (head?.oid ? head.oid.slice(0, 7) : "(no branch)"),
        reference: "HEAD",
        oid: head?.oid || null,
        icon: "icon-git-commit",
        current: true,
        status,
        upstream: null,
        lastCommit: matchingRef?.lastCommit || null,
      });
    }

    const remoteBranches = (refs?.remoteBranches || [])
      .filter((branch) => !branch.symrefTarget)
      .map((branch) => {
        const trackingBranch = (refs?.branches || []).find(
          (localBranch) => localBranch.upstream?.ref === branch.ref,
        );
        return {
          id: `remote:${branch.name}`,
          repository,
          kind: "remote",
          branch: branch.name,
          reference: branch.name,
          oid: branch.oid,
          icon: "icon-cloud-download",
          current: false,
          status: null,
          upstream: null,
          trackingBranch: trackingBranch?.name || null,
          trackingBranchCurrent: Boolean(trackingBranch?.isHead),
          localBranchName: branch.name.slice(branch.remoteName.length + 1),
          lastCommit: branch.lastCommit || null,
        };
      })
      .sort((a, b) => a.branch.localeCompare(b.branch));

    const tags = (refs?.tags || [])
      .map((tag) => ({
        id: `tag:${tag.name}`,
        repository,
        kind: "tag",
        branch: tag.name,
        reference: tag.ref,
        oid: tag.targetOid,
        icon: "icon-tag",
        current: false,
        status: null,
        upstream: null,
        lastCommit: tag.lastCommit || null,
      }))
      .sort((a, b) => a.branch.localeCompare(b.branch));

    return [localBranches, remoteBranches, tags];
  }

  confirmCheckoutItem(item) {
    this.hide();
    if (item.kind === "local" || item.kind === "head") {
      applySwitchItem(item);
      return;
    }
    if (item.kind === "remote") {
      if (item.trackingBranch) {
        if (!item.trackingBranchCurrent) checkoutBranch(item.repository, item.trackingBranch);
      } else {
        checkoutBranch(item.repository, item.localBranchName, {
          createNew: true,
          track: true,
          startPoint: item.reference,
        });
      }
      return;
    }
    if (item.kind === "tag") {
      checkoutBranch(item.repository, item.reference, { detach: true });
    }
  }

  requestReferenceRefresh() {
    if (!this.referenceListView.isVisible()) return Promise.resolve();
    this.referenceRefreshRequested = true;
    if (!this.referenceRefreshPromise) {
      this.referenceRefreshPromise = this.refreshReferenceItems().finally(() => {
        this.referenceRefreshPromise = null;
      });
    }
    return this.referenceRefreshPromise;
  }

  async refreshReferenceItems() {
    while (this.referenceRefreshRequested && this.referenceListView.isVisible()) {
      this.referenceRefreshRequested = false;
      const repository = this.pendingReference?.repository;
      if (!repository) return;
      const refs = await repository.ensureRefsSnapshot?.().catch(() => null);
      if (!this.referenceListView.isVisible() || repository !== this.pendingReference?.repository) {
        continue;
      }
      await updateListPreservingScroll(this.referenceListView, {
        items: this.buildReferenceItems(refs),
        loadingMessage: null,
      });
    }
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

    await this.requestReferenceRefresh();
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

    await this.requestBranchRefresh();
  }

  hide() {
    this.selectListView.hide();
  }

  destroy() {
    this.stopObservingActiveRepository();
    this.stopObservingReferenceRepository();
    this.subscriptions.dispose();
    this.selectListView.destroy();
    this.referenceListView.destroy();
    this.branchNameDialog.destroy();
  }
};
