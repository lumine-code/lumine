const { protocol } = require("electron");
const fs = require("fs");
const path = require("path");

// Handles requests with 'lumine' protocol.
//
// It's created by {AtomApplication} upon instantiation and is used to create a
// custom resource loader for 'lumine://' URLs.
//
// A URL names a package and a file inside it: `lumine://<package>/<file>`. The
// first segment is looked up as a directory in each of these, in the same
// priority order the package loader resolves a name in, so an overridden
// package serves the assets of the copy that is actually running:
//   * ~/.lumine/assets
//   * ~/.lumine/packages-dev (unless in safe mode)
//   * ~/.lumine/packages (unless in safe mode)
//   * RESOURCE_PATH/packages
//   * RESOURCE_PATH/node_modules
//
// A package directory does not have to be named after the package, so when no
// directory matches, the first segment is resolved as a package name instead.
//
module.exports = class AtomProtocolHandler {
  constructor(resourcePath, safeMode, resolvePackagePath) {
    this.loadPaths = [];
    this.resolvePackagePath = resolvePackagePath;

    if (!safeMode) {
      this.loadPaths.push(path.join(process.env.LUMINE_HOME, "packages-dev"));
      this.loadPaths.push(path.join(process.env.LUMINE_HOME, "packages"));
    }

    this.loadPaths.push(path.join(resourcePath, "packages"));
    this.loadPaths.push(path.join(resourcePath, "node_modules"));

    this.registerAtomProtocol();
  }

  // Creates the 'lumine' custom protocol handler.
  registerAtomProtocol() {
    protocol.registerFileProtocol("lumine", (request, callback) => {
      const relativePath = path.normalize(request.url.slice("lumine://".length));

      let filePath;
      if (relativePath.indexOf("assets/") === 0) {
        const assetsPath = path.join(process.env.LUMINE_HOME, relativePath);
        if (isFile(assetsPath)) filePath = assetsPath;
      }

      if (!filePath) {
        for (let loadPath of this.loadPaths) {
          filePath = path.join(loadPath, relativePath);
          if (isFile(filePath)) break;
        }
      }

      if (!isFile(filePath)) {
        const resolvedPath = this.resolveThroughPackageName(relativePath);
        if (resolvedPath) filePath = resolvedPath;
      }

      callback(filePath);
    });
  }

  // Treat the first path segment as a package name rather than a directory
  // name, for a package whose install directory is called something else.
  resolveThroughPackageName(relativePath) {
    if (typeof this.resolvePackagePath !== "function") return null;

    const segments = relativePath.split(path.sep);
    if (segments.length < 2) return null;

    let packagePath;
    try {
      packagePath = this.resolvePackagePath(segments[0]);
    } catch {
      return null;
    }
    if (!packagePath) return null;

    const filePath = path.join(packagePath, ...segments.slice(1));
    return isFile(filePath) ? filePath : null;
  }
};

function isFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat != null && stat.isFile();
  } catch {
    return false;
  }
}
