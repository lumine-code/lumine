const ProjectDirectory = require("./project-directory");
const fs = require("@lumine-code/fs-plus");
const path = require("path");

function hostForURI(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

// A resolved directory is remembered so that the next question about the same
// URI costs nothing. Every file opened asks for its directory, and asks again
// for each interested party — the buffer registering with the repository
// platform, the tab resolving its VCS status — and each fresh answer costs two
// `stat`s to place the directory plus, once something asks for its real path, an
// `lstat` per path component. Opening a folder's worth of files asked 1190 times
// about 240 directories.
//
// Only a URI that resolved onto an existing directory is remembered. One that
// did not is left to be asked again, since the answer changes the moment the
// directory is created — and the fallback for that case is the URI itself,
// which is exactly what would go stale.
const MAX_REMEMBERED_DIRECTORIES = 5000;

// Public: Turns a project URI into a {Directory}, for local paths.
//
// This is the provider {Project} falls back to when no package claims a URI. A
// package supplies its own by providing the `project.directory-provider`
// service; the methods below are the shape that contract expects.
module.exports = class DefaultDirectoryProvider {
  // Public: Create a Directory that corresponds to the specified URI.
  //
  // * `uri` {String} The path to the directory to add. This is guaranteed not to
  // be contained by a {Directory} in `lumine.project`.
  //
  // Returns:
  // * {Directory} if the given URI is compatible with this provider.
  // * `null` if the given URI is not compatible with this provider.
  directoryForURISync(uri) {
    const remembered = this.directoriesByURI?.get(uri);
    if (remembered) return remembered;

    const normalizedPath = this.normalizePath(uri);
    const host = hostForURI(uri);
    let directoryPath;
    let onExistingDirectory = false;
    if (host) {
      directoryPath = uri;
    } else if (fs.isDirectorySync(normalizedPath)) {
      directoryPath = normalizedPath;
      onExistingDirectory = true;
    } else if (fs.isDirectorySync(path.dirname(normalizedPath))) {
      directoryPath = path.dirname(normalizedPath);
      onExistingDirectory = true;
    } else {
      directoryPath = normalizedPath;
    }
    const directory = new ProjectDirectory(directoryPath);
    if (host) {
      directory.path = directoryPath;
      if (fs.isCaseInsensitive()) {
        directory.lowerCasePath = directoryPath.toLowerCase();
      }
      return directory;
    }

    if (onExistingDirectory) {
      this.directoriesByURI ??= new Map();
      if (this.directoriesByURI.size >= MAX_REMEMBERED_DIRECTORIES) this.directoriesByURI.clear();
      this.directoriesByURI.set(uri, directory);
    }
    return directory;
  }

  // Forgets every remembered directory. Only needed when the filesystem is
  // rearranged underneath a running window.
  clearDirectoryCache() {
    this.directoriesByURI?.clear();
  }

  // Public: Create a Directory that corresponds to the specified URI.
  //
  // * `uri` {String} The path to the directory to add. This is guaranteed not to
  // be contained by a {Directory} in `lumine.project`.
  //
  // Returns a {Promise} that resolves to:
  // * {Directory} if the given URI is compatible with this provider.
  // * `null` if the given URI is not compatible with this provider.
  directoryForURI(uri) {
    return Promise.resolve(this.directoryForURISync(uri));
  }

  // Public: Normalizes path.
  //
  // * `uri` {String} The path that should be normalized.
  //
  // Returns a {String} with normalized path.
  normalizePath(uri) {
    let matchData, pathWithNormalizedDiskDriveLetter;
    // Normalize disk drive letter on Windows to avoid opening two buffers for the same file
    pathWithNormalizedDiskDriveLetter = uri;
    if (process.platform === "win32" && (matchData = uri.match(/^([a-z]):/))) {
      pathWithNormalizedDiskDriveLetter = `${matchData[1].toUpperCase()}${uri.slice(1)}`;
    }
    return path.normalize(pathWithNormalizedDiskDriveLetter);
  }
};
