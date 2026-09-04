const { loadNativeBackend, validateNativeBackend } = require("./git-native-backend");

// Adapter from the git-utils addon to git-host's backend-neutral operation
// contract. Resolution is lazy, so merely constructing git-host never loads a
// native binary and CLI-owned operations remain independent from it.
module.exports = class GitUtilsBackend {
  constructor({ nativeBackend, getNativeBackend } = {}) {
    this.backend = nativeBackend ? validateNativeBackend(nativeBackend).nativeBackend : null;
    this.getNativeBackend = getNativeBackend || (() => loadNativeBackend().nativeBackend);
  }

  resolve() {
    if (!this.backend) this.backend = this.getNativeBackend();
    return this.backend;
  }

  snapshot(descriptor, request, { signal } = {}) {
    return this.resolve().snapshot(descriptor, { ...request, signal });
  }

  diff(descriptor, request, { signal, maxBytes } = {}) {
    return this.resolve().diff(descriptor, {
      ...request,
      maxBytes: maxBytes ?? request.maxBytes,
      signal: signal ?? request.signal,
    });
  }

  history(descriptor, request, { signal } = {}) {
    return this.resolve().history(descriptor, { ...request, signal });
  }

  async commit(descriptor, request, { signal } = {}) {
    try {
      return await this.resolve().commit(descriptor, { ...request, signal });
    } catch (error) {
      if (error?.libgit2Code === -3) return null;
      throw error;
    }
  }

  blame(descriptor, request, { signal } = {}) {
    return this.resolve().blame(descriptor, { ...request, signal });
  }

  describe(descriptor, { signal } = {}) {
    return this.resolve().describe(descriptor, { signal });
  }

  branchesContaining(descriptor, request, { signal } = {}) {
    return this.resolve().branchesContaining(descriptor, { ...request, signal });
  }

  readObjects(descriptor, requests, options) {
    return this.resolve().readObjects(descriptor, requests, options);
  }

  readConfig(descriptor, keys, { signal } = {}) {
    return this.resolve().readConfig(descriptor, { keys, signal });
  }

  fileMode(descriptor, path, options) {
    return this.resolve().fileMode(descriptor, path, options);
  }

  submodulePaths(descriptor, options) {
    return this.resolve().submodulePaths(descriptor, options);
  }
};
