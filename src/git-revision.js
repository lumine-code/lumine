function assertGitRevision(value, { allowNull = false, label = "revision" } = {}) {
  if (value == null && allowNull) return value;
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
    throw new TypeError(`${label} must be a non-empty Git revision, not a command-line option`);
  }
  return value;
}

module.exports = { assertGitRevision };
