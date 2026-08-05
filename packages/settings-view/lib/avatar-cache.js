const fs = require("@lumine-code/fs-plus");
const fsPromises = require("fs").promises;
const path = require("path");
const remote = require("@electron/remote");
const picomatch = require("picomatch");

module.exports = class AvatarCache {
  constructor(packageManager) {
    this.packageManager = packageManager;
    // 5 hour expiry, used to keep the newest cached avatar around
    this.expiry = 1000 * 60 * 60 * 5;
    this.createAvatarCache();
    this.expireAvatarCache();
  }

  // Public: Get an avatar image from the filesystem, fetching it first if necessary
  avatar(login, callback) {
    this.cachedAvatar(login, (err, cached) => {
      let stale;
      if (cached) {
        stale = Date.now() - parseInt(cached.split("-").pop()) > this.expiry;
      }
      if (cached && (!stale || !this.online())) {
        return callback(null, cached);
      } else {
        return this.fetchAndCacheAvatar(login, callback);
      }
    });
  }

  online() {
    return navigator.onLine;
  }

  createAvatarCache() {
    return fs.makeTree(this.getCachePath());
  }

  avatarPath(login) {
    return path.join(this.getCachePath(), `${login}-${Date.now()}`);
  }

  // Lists the cached avatars matching `pattern`. The cache is one flat
  // directory, so this reads it directly rather than pulling in a glob
  // library. Kept as a method so tests can stub filesystem failures.
  async glob(pattern) {
    const directory = path.dirname(pattern);
    const isMatch = picomatch(path.basename(pattern));
    const entries = await fsPromises.readdir(directory);
    return entries.filter(isMatch).map((entry) => path.join(directory, entry));
  }

  cachedAvatar(login, callback) {
    this.glob(this.avatarGlob(login)).then((files) => {
      files.sort().reverse();
      for (let imagePath of Array.from(files)) {
        const filename = path.basename(imagePath);
        const array = filename.split("-"),
          createdOn = array[array.length - 1];
        if (Date.now() - parseInt(createdOn) < this.expiry) {
          return callback(null, imagePath);
        }
      }
      return callback(null, null);
    }, callback);
  }

  avatarGlob(login) {
    return path.join(this.getCachePath(), `${login}-*([0-9])`);
  }

  fetchAndCacheAvatar(login, callback) {
    if (!this.online()) {
      return callback(null, null);
    } else {
      const imagePath = this.avatarPath(login);
      const url = `https://avatars.githubusercontent.com/${login}`;
      fetch(url, { headers: { "User-Agent": navigator.userAgent } })
        .then(async (response) => {
          const contentType = response.headers.get("content-type") || "";
          if (!response.ok || !contentType.startsWith("image/")) {
            return callback(null);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFile(imagePath, buffer, (error) => {
            if (error) {
              try {
                if (fs.existsSync(imagePath)) {
                  fs.unlinkSync(imagePath);
                }
              } catch {
                /* ignore unlink failure */
              }
              return callback(error);
            }
            callback(null, imagePath);
          });
        })
        .catch((error) => callback(error));
    }
  }

  // The cache expiry doesn't need to be clever, or even compare dates, it just
  // needs to always keep around the newest item, and that item only. The localStorage
  // cache updates in place, so it doesn't need to be purged.

  expireAvatarCache() {
    const deleteAvatar = (child) => {
      const avatarPath = path.join(this.getCachePath(), child);
      fs.unlink(avatarPath, function (error) {
        if (error && error.code !== "ENOENT") {
          // Ignore cache paths that don't exist
          return console.warn(`Error deleting avatar (${error.code}): ${avatarPath}`);
        }
      });
    };

    return fs.readdir(this.getCachePath(), function (error, _files) {
      let key;
      if (_files == null) {
        _files = [];
      }
      const files = {};
      for (let filename of Array.from(_files)) {
        const parts = filename.split("-");
        const stamp = parts.pop();
        key = parts.join("-");
        if (files[key] == null) {
          files[key] = [];
        }
        files[key].push(`${key}-${stamp}`);
      }

      const result = [];
      for (key in files) {
        const children = files[key];
        children.sort();
        children.pop(); // keep
        // Right now a bunch of clients might be instantiated at once, so
        // we can just ignore attempts to unlink files that have already been removed
        // - this should be fixed with a singleton client
        result.push(children.forEach(deleteAvatar));
      }
      return result;
    });
  }

  getCachePath() {
    return this.cachePath != null
      ? this.cachePath
      : (this.cachePath = path.join(remote.app.getPath("userData"), "Cache", "settings-view"));
  }
};
