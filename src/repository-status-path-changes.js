function submoduleStatusEqual(left, right) {
  return (
    left === right ||
    (left?.isSubmodule === right?.isSubmodule &&
      left?.commitChanged === right?.commitChanged &&
      left?.modified === right?.modified &&
      left?.hasUntrackedChanges === right?.hasUntrackedChanges)
  );
}

function fileStatusEqual(left, right) {
  return (
    left === right ||
    (left.path === right.path &&
      left.originalPath === right.originalPath &&
      left.kind === right.kind &&
      left.indexStatus === right.indexStatus &&
      left.worktreeStatus === right.worktreeStatus &&
      left.headBlobOid === right.headBlobOid &&
      left.indexBlobOid === right.indexBlobOid &&
      left.staged === right.staged &&
      left.unstaged === right.unstaged &&
      left.conflicted === right.conflicted &&
      left.untracked === right.untracked &&
      left.ignored === right.ignored &&
      left.similarity === right.similarity &&
      submoduleStatusEqual(left.submodule, right.submodule))
  );
}

function directoryStatusEqual(left, right) {
  return (
    left.conflicted === right.conflicted &&
    left.modified === right.modified &&
    left.added === right.added &&
    left.staged === right.staged &&
    left.unstaged === right.unstaged
  );
}

const COLLECTIONS = [
  ["files", "statusEntriesByPath", fileStatusEqual],
  ["directories", "directoryStatusAggregates", directoryStatusEqual],
  ["ignoredFiles", "ignoredFileKeys"],
  ["ignoredDirectories", "ignoredDirKeys"],
];

module.exports = async function statusPathChanges(
  previous,
  next,
  { generation, reset, headChanged, pathKey, checkpoint },
) {
  const change = { generation, reset, headChanged };
  for (const [name, property, equal] of COLLECTIONS) {
    const keys = new Set();
    change[name] = keys;
    if (reset) continue;

    const before = previous[property];
    const after = next[property];
    const isFileCollection = name === "files";
    const add = (key, value) => {
      if (isFileCollection && value?.ignored) return;
      keys.add(key);
      if (isFileCollection && value?.originalPath) keys.add(pathKey(value.originalPath));
    };
    for (const [key, value] of after.entries()) {
      if (!before.has(key)) add(key, value);
      else if (equal && !equal(before.get(key), value)) {
        add(key, before.get(key));
        add(key, value);
      }
      const pendingYield = checkpoint();
      if (pendingYield && !(await pendingYield)) return null;
    }
    for (const [key, value] of before.entries()) {
      if (!after.has(key)) add(key, value);
      const pendingYield = checkpoint();
      if (pendingYield && !(await pendingYield)) return null;
    }
  }
  for (const [name] of COLLECTIONS) change[name] = Object.freeze([...change[name]]);
  return Object.freeze(change);
};
