// Working-tree and upstream detail, described once as chips and rendered either
// as select-list `trailing` descriptors in the pickers or straight into the
// status bar tiles. Nothing here touches `atom`.
//
// File status colors come from core's `git-status.css`, so a chip only carries
// the shared `status-*` class and never a color of its own.

const KIND_LABELS = {
  added: "added",
  modified: "modified",
  removed: "deleted",
  conflicted: "conflicted",
};

// Mirrors core's `summaryFromStatusEntry` and git-panel's `classNameForStatus`:
// a conflict outranks everything, a new file reads as added, and a deletion on
// either side reads as removed. Renames and copies stay modified.
function classifyEntry(entry) {
  if (entry.conflicted) return "conflicted";
  if (entry.untracked || entry.indexStatus === "A") return "added";
  if (entry.indexStatus === "D" || entry.worktreeStatus === "D") return "removed";
  return "modified";
}

// Counts per change kind, or `null` before the first snapshot has loaded so
// callers can render nothing rather than a row of zeros. Ignored entries are
// skipped here rather than excluded from the snapshot: the snapshot is shared
// with tree-view and tabs, which need it to carry them.
function summarizeStatus(snapshot) {
  if (!snapshot?.initialized) return null;
  const summary = { added: 0, modified: 0, removed: 0, conflicted: 0 };
  for (const entry of snapshot.files) {
    if (entry.ignored) continue;
    summary[classifyEntry(entry)]++;
  }
  return summary;
}

function isDirty(summary) {
  return Boolean(summary) && Object.values(summary).some((count) => count > 0);
}

// `+3 ~12 -1 !2`, dropping every kind that has nothing to report.
function statusChips(summary) {
  if (!summary) return [];
  return [
    summary.added > 0 && { text: `+${summary.added}`, className: "git-center-count status-added" },
    summary.modified > 0 && {
      text: `~${summary.modified}`,
      className: "git-center-count status-modified",
    },
    summary.removed > 0 && {
      text: `-${summary.removed}`,
      className: "git-center-count status-removed",
    },
    summary.conflicted > 0 && {
      text: `!${summary.conflicted}`,
      className: "git-center-count status-conflicted",
    },
  ].filter(Boolean);
}

// `↑2 ↓1` against the branch's own upstream. A deleted upstream reports `gone`
// instead: the counts are still zero, but that says nothing useful once the ref
// they were measured against no longer exists.
function divergenceChips(upstream) {
  if (!upstream) return [];
  if (upstream.gone) return [{ text: "gone", className: "git-center-gone" }];
  return [
    upstream.ahead > 0 && { text: `↑${upstream.ahead}`, className: "git-center-ahead" },
    upstream.behind > 0 && { text: `↓${upstream.behind}`, className: "git-center-behind" },
  ].filter(Boolean);
}

function statusTooltipLine(summary) {
  if (!isDirty(summary)) return null;
  return Object.entries(KIND_LABELS)
    .filter(([kind]) => summary[kind] > 0)
    .map(([kind, label]) => `${summary[kind]} ${label}`)
    .join(", ");
}

function divergenceTooltipLine(upstream) {
  if (!upstream) return null;
  if (upstream.gone) return `Upstream ${upstream.name} is gone`;
  const parts = [];
  if (upstream.ahead > 0) parts.push(`${upstream.ahead} ahead`);
  if (upstream.behind > 0) parts.push(`${upstream.behind} behind`);
  if (parts.length === 0) return `Up to date with ${upstream.name}`;
  return `${parts.join(", ")} of ${upstream.name}`;
}

// Replaces a tile's chips in place. The pickers hand the same descriptors to
// select-list instead, which builds its own `.trailing-block` around them.
function renderChips(container, chips) {
  container.textContent = "";
  for (const chip of chips) {
    const span = document.createElement("span");
    span.className = chip.className;
    span.textContent = chip.text;
    container.appendChild(span);
  }
  container.style.display = chips.length > 0 ? "" : "none";
}

module.exports = {
  divergenceChips,
  divergenceTooltipLine,
  isDirty,
  renderChips,
  statusChips,
  statusTooltipLine,
  summarizeStatus,
};
