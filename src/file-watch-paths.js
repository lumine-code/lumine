const path = require("path");

function absolutePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError("A non-empty filesystem path is required");
  }
  return path.resolve(value);
}

// relative() preserves drive and UNC roots and checks whole path components.
// Do not case-fold: distinct spellings can identify distinct files even on
// Windows when a directory has case sensitivity enabled.
function relativePath(parent, child, pathApi = path) {
  const relative = pathApi.relative(parent, child);
  if (
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    return null;
  }
  // win32.relative() ignores case unconditionally. Check the common prefix
  // ourselves, after normalization, without losing its root or separators.
  const normalizedParent = pathApi.normalize(parent);
  const normalizedChild = pathApi.normalize(child);
  const prefix = normalizedParent.endsWith(pathApi.sep)
    ? normalizedParent
    : normalizedParent + pathApi.sep;
  if (normalizedChild !== normalizedParent && !normalizedChild.startsWith(prefix)) {
    return null;
  }
  return relative;
}

function containsPath(parent, child, recursive = true, pathApi = path) {
  const relative = relativePath(parent, child, pathApi);
  return relative !== null && (recursive || !relative.includes(pathApi.sep));
}

function ancestors(directoryPath, pathApi = path) {
  const result = [];
  let current = pathApi.normalize(directoryPath);
  while (true) {
    result.push(current);
    const parent = pathApi.dirname(current);
    if (parent === current) return result.reverse();
    current = parent;
  }
}

module.exports = { absolutePath, relativePath, containsPath, ancestors };
