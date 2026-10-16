const path = require("path");

// Git owns eligibility and classification. Persistence state only adds an
// unstaged edit to an eligible path; it can never create a repository, turn an
// ignored file into a modification, or supply a missing index for a conflict.
module.exports = function bufferGitStatus(
  repository,
  filePath,
  { fileState = "unmodified", pendingSave = false } = {},
) {
  if (!filePath || !repository || repository.isDestroyed?.()) return null;
  if (repository.getWorkingDirectory && !repository.getWorkingDirectory()) return null;
  const snapshot = repository.getStatusSnapshot();
  if (!snapshot.initialized || snapshot.includesIgnored === false) return null;

  const relative = repository.relativize?.(filePath);
  if (relative != null) {
    const normalized = relative.split(path.sep).join("/");
    if (path.isAbsolute(relative) || normalized === ".." || normalized.startsWith("../"))
      return null;
    const first = normalized.split("/")[0];
    if (
      (repository.caseInsensitiveFs || process.platform === "win32"
        ? first.toLowerCase()
        : first) === ".git"
    )
      return null;
  }

  const saved = repository.getPathStatusSummary(filePath);
  const entry = repository.getStatusEntry?.(filePath);
  const ignored = repository.isPathIgnoredCached(filePath);
  const conflicted = Boolean(saved?.conflicted || entry?.conflicted);
  const untracked = Boolean(entry?.untracked || (saved?.added && !saved.staged));
  const canDiff = !ignored && !conflicted && !untracked;
  const bufferModified =
    canDiff && (pendingSave || fileState === "modified" || fileState === "conflicted");
  let status = null;
  if (ignored) status = "ignored";
  else if (conflicted) status = "conflicted";
  else if (saved?.modified || bufferModified) status = "modified";
  else if (saved?.added) status = "added";

  return Object.freeze({
    status,
    staged: Boolean(saved?.staged),
    unstaged: Boolean(saved?.unstaged || bufferModified),
    ignored,
    conflicted,
    untracked,
    canDiff,
    bufferModified,
  });
};
