const fs = require("fs");
const path = require("path");
const { Icon } = require("./icon-descriptor");

// The built-in file-type provider — the lowest-priority link in the chain and
// the only one that is always present. It answers for every path, so no
// consumer ever has to carry its own default.
//
// It is pure: the registry owns the cache, so the same path asked twice costs
// one resolution, and an answer never goes stale behind an invalidation.

const MARKDOWN_EXTENSIONS = new Set([
  ".markdown",
  ".md",
  ".mdown",
  ".mkd",
  ".mkdown",
  ".rmd",
  ".ron",
]);

const COMPRESSED_EXTENSIONS = new Set([
  ".bz2",
  ".egg",
  ".epub",
  ".gem",
  ".gz",
  ".jar",
  ".lz",
  ".lzma",
  ".lzo",
  ".rar",
  ".tar",
  ".tgz",
  ".war",
  ".whl",
  ".xpi",
  ".xz",
  ".z",
  ".zip",
]);

const IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const BINARY_EXTENSIONS = new Set([
  ".ds_store",
  ".a",
  ".exe",
  ".o",
  ".pyc",
  ".pyo",
  ".so",
  ".woff",
]);

function isReadmePath(extension, filePath) {
  const base = path.basename(filePath, extension).toLowerCase();
  if (base !== "readme") return false;
  return extension === "" || MARKDOWN_EXTENSIONS.has(extension.toLowerCase());
}

function directoryClass({ symlink, submodule, repositoryRoot }) {
  // Order matters and matches what tree-view computed locally before the
  // registry owned it: a symlinked directory reads as a symlink first, then a
  // repository root, then a submodule.
  if (symlink) return "icon-file-symlink-directory";
  if (repositoryRoot) return "icon-repo";
  if (submodule) return "icon-file-submodule";
  return "icon-file-directory";
}

function fileClass(filePath) {
  const extension = path.extname(filePath);
  if (isReadmePath(extension, filePath)) return "icon-book";

  const lowercased = extension.toLowerCase();
  if (COMPRESSED_EXTENSIONS.has(lowercased)) return "icon-file-zip";
  if (IMAGE_EXTENSIONS.has(lowercased)) return "icon-file-media";
  if (lowercased === ".pdf") return "icon-file-pdf";
  if (BINARY_EXTENSIONS.has(lowercased)) return "icon-file-binary";
  return "icon-file-text";
}

// Defensive fallback for direct provider use. IconRegistry normally enriches
// local paths with cached filesystem hints before the provider chain runs.
function statHints(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    return { directory: stats.isDirectory(), symlink: stats.isSymbolicLink() };
  } catch {
    // Not on disk. Archive entries, remote items, and results for a file that
    // has since been deleted all land here and still get a useful icon from
    // the name alone.
    return { directory: false, symlink: false };
  }
}

module.exports = function createPathProvider() {
  return {
    id: "core-path",
    handles: ["path"],
    usesContext: false,

    iconFor(target) {
      const filePath = target.path;
      if (typeof filePath !== "string" || filePath.length === 0) return null;

      let { directory, symlink } = target.hints;
      if (directory === undefined && !target.hints.virtual && path.isAbsolute(filePath)) {
        const stats = statHints(filePath);
        directory = stats.directory;
        if (symlink === undefined) symlink = stats.symlink;
      }

      if (directory) {
        return Icon.classes([
          directoryClass({
            symlink,
            submodule: target.hints.submodule,
            repositoryRoot: target.hints.repositoryRoot,
          }),
        ]);
      }
      if (symlink) return Icon.classes(["icon-file-symlink-file"]);
      return Icon.classes([fileClass(filePath)]);
    },
  };
};
