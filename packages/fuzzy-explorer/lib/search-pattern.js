const fs = require("fs");
const path = require("path");

const globMagicPattern = /[*?[\]{}]/;

// Splits one of the patterns from `explorer.cson` into the directory to crawl
// and the glob to scope that crawl by, which is the shape `atom.project.crawl()`
// takes. The leading literal segments become the root so ripgrep never has to
// walk above the part of the tree the user actually asked about.
//
// Returns `null` when the pattern does not name an existing directory.
module.exports = function searchForPattern(rawPattern) {
  // Globs speak `/`. On Windows the config may use `\`, so normalize the
  // separators there — but never on POSIX, where a backslash is an ordinary
  // character in a filename.
  const normalizedPattern = path.sep === "\\" ? rawPattern.replace(/\\/g, "/") : rawPattern;
  const parts = normalizedPattern.split("/");
  const rootParts = [];
  const includeParts = [];
  let foundGlob = false;

  for (const part of parts) {
    if (!foundGlob && !globMagicPattern.test(part)) {
      rootParts.push(part);
    } else {
      foundGlob = true;
      includeParts.push(part);
    }
  }

  if (!foundGlob) {
    // The normalized form, so this branch agrees with the glob one below about
    // where a Windows pattern's separators are.
    const resolvedPath = path.resolve(normalizedPattern);
    if (isDirectory(resolvedPath)) {
      return { root: resolvedPath, include: "**" };
    }
    return {
      root: directoryOrNull(path.dirname(resolvedPath)),
      include: path.basename(resolvedPath),
    };
  }

  const root = directoryOrNull(path.resolve(rootParts.join("/") || "."));
  if (!root) return null;

  const include = includeParts.join("/") || "**";
  return { root, include };
};

function directoryOrNull(candidate) {
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function isDirectory(candidate) {
  return directoryOrNull(candidate) != null;
}
