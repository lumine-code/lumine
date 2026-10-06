const path = require("path");

// Each file is stored once, in its immediate directory. Keeping descendants in
// every ancestor would multiply memory by path depth for very large projects.
module.exports = class FileIndexDirectoryTree {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.directories = new Map();
    this.root = this.ensureDirectory(rootPath);
  }

  ensureDirectory(directoryPath) {
    let directory = this.directories.get(directoryPath);
    if (directory) return directory;
    const parentPath = path.dirname(directoryPath);
    const parent =
      directoryPath === this.rootPath || parentPath === directoryPath
        ? null
        : this.ensureDirectory(parentPath);
    directory = { path: directoryPath, parent, files: new Set(), children: new Set() };
    this.directories.set(directoryPath, directory);
    parent?.children.add(directory);
    return directory;
  }

  add(filePath) {
    this.ensureDirectory(path.dirname(filePath)).files.add(filePath);
  }

  delete(filePath) {
    let directory = this.directories.get(path.dirname(filePath));
    if (!directory?.files.delete(filePath)) return;
    while (directory.parent && directory.files.size === 0 && directory.children.size === 0) {
      this.directories.delete(directory.path);
      directory.parent.children.delete(directory);
      directory = directory.parent;
    }
  }

  *pathsUnder(indexPath) {
    if (this.directories.get(path.dirname(indexPath))?.files.has(indexPath)) yield indexPath;
    const directory = this.directories.get(indexPath);
    if (!directory) return;
    yield* this.descendants(directory);
  }

  *descendants(directory) {
    yield* directory.files;
    for (const child of directory.children) yield* this.descendants(child);
  }
};
