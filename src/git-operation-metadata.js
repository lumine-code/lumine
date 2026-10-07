const path = require("path");

// Whether a target path lands inside the working tree. Written files outside it
// (temp directories, mostly) cannot change `git status` output. A lexical
// check is enough here: a false "inside" merely refreshes status without need.
function writesIntoWorkingDirectory(workingDirectory, targetPath) {
  let root = path.resolve(workingDirectory);
  let resolved = path.resolve(workingDirectory, String(targetPath ?? ""));
  if (process.platform === "win32") {
    root = root.toLowerCase();
    resolved = resolved.toLowerCase();
  }
  return resolved === root || resolved.startsWith(root + path.sep);
}

// `branch.*` and `remote.*` config keys feed the refs snapshot (remote -v,
// for-each-ref %(upstream)) and the status snapshot's branch headers; every
// other key is invisible to both snapshots.
function configRefreshHint([key]) {
  return /^(branch|remote)\./i.test(String(key ?? "")) ? "both" : "none";
}

// Which snapshots each operation can invalidate, consulted by the repository
// registry to right-size its post-operation refresh. "status" operations touch
// the index or working tree but can never move a ref; "refs"/"both" move refs
// or remotes; "none" writes only the object database or unrelated config.
// Functions receive the operation's arguments for the hints that depend on
// them. Anything absent refreshes both snapshots — the safe default.
const OPERATION_REFRESH_HINTS = {
  executeGit: "both",
  createTag: "refs",
  stageFiles: "status",
  unstageFiles: "status",
  stageFileModeChange: "status",
  stageFileSymlinkChange: "status",
  applyPatch: "status",
  commit: "both",
  merge: "both",
  cherryPick: "both",
  rebase: "both",
  // `merge --abort` restores the pre-merge worktree/index; HEAD never moved,
  // and MERGE_HEAD is not part of the refs snapshot.
  abortMerge: "status",
  // Stashes are not part of either public snapshot. Applying or creating one
  // only changes the index and working tree from their point of view.
  stashPush: "status",
  stashApply: "status",
  stashPop: "status",
  stashDrop: "none",
  checkoutSide: "status",
  checkout: "both",
  checkoutFiles: "status",
  // fetch/push move remote or tracking refs, which also feed the status
  // snapshot's ahead/behind branch headers.
  fetch: "both",
  pull: "both",
  push: "both",
  reset: "both",
  deleteRef: "both",
  updateSubmodules: "status",
  // Every worktree operation acts on a *different* checkout, so this
  // repository's own index and working tree are untouched. What changes is the
  // worktree list, which `git worktree list` supplies to the refs snapshot —
  // and, for `add -b`, a new branch, which the same snapshot carries.
  worktreeAdd: "refs",
  worktreeRemove: "refs",
  worktreeMove: "refs",
  worktreeLock: "refs",
  worktreeUnlock: "refs",
  worktreePrune: "refs",
  setConfig: configRefreshHint,
  unsetConfig: configRefreshHint,
  // A brand-new remote has no refs yet, so only `remote -v` output changes.
  addRemote: "refs",
  // Removing a remote deletes refs/remotes/<name>/*; if HEAD tracked one of
  // them, the status snapshot's upstream header changes too.
  removeRemote: "both",
  setRemoteUrl: "refs",
  createBlob: "none",
  expandBlobToFile: (args, operations) =>
    writesIntoWorkingDirectory(operations.workingDirectory, args[0]) ? "status" : "none",
  mergeFile: (args, operations) =>
    writesIntoWorkingDirectory(operations.workingDirectory, args[3]) ? "status" : "none",
  writeMergeConflictToIndex: "status",
};

const OPERATION_OPTION_INDEX = Object.freeze({
  executeGit: 1,
  createTag: 1,
  stageFiles: 1,
  unstageFiles: 1,
  stageFileModeChange: 2,
  stageFileSymlinkChange: 1,
  applyPatch: 1,
  commit: 1,
  merge: 1,
  abortMerge: 0,
  cherryPick: 1,
  rebase: 1,
  stashPush: 0,
  stashApply: 1,
  stashPop: 1,
  stashDrop: 1,
  checkoutSide: 2,
  checkout: 1,
  checkoutFiles: 2,
  fetch: 2,
  pull: 2,
  push: 2,
  reset: 2,
  deleteRef: 1,
  updateSubmodules: 1,
  worktreeAdd: 1,
  worktreeRemove: 1,
  worktreeMove: 2,
  worktreeLock: 1,
  worktreeUnlock: 1,
  worktreePrune: 0,
  setConfig: 2,
  unsetConfig: 1,
  addRemote: 2,
  removeRemote: 1,
  setRemoteUrl: 2,
  createBlob: 0,
  expandBlobToFile: 2,
  mergeFile: 4,
  writeMergeConflictToIndex: 4,
});

const SIGNING_OPERATIONS = new Set(["commit", "merge", "cherryPick", "rebase", "createTag"]);
const AUTH_OPERATIONS = new Set(["fetch", "push", "updateSubmodules", "executeGit"]);

function operationRefreshHint(name, args, workingDirectory) {
  const hint = OPERATION_REFRESH_HINTS[name];
  return typeof hint === "function" ? hint(args, { workingDirectory }) : hint || "both";
}

function rawGitCommand(args = []) {
  const valueFlags = new Set([
    "-c",
    "-C",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--config-env",
  ]);
  for (let index = 0; index < args.length; index++) {
    const value = String(args[index]);
    if (valueFlags.has(value)) {
      index++;
      continue;
    }
    if (value.startsWith("-")) continue;
    return value;
  }
  return null;
}

module.exports = {
  rawGitCommand,
  OPERATION_OPTION_INDEX,
  SIGNING_OPERATIONS,
  AUTH_OPERATIONS,
  operationRefreshHint,
};
