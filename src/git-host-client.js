const GitHost = require("./git-host");

// Renderer-side client for every read operation owned by git-host. Repository
// descriptors are discovered before they reach this boundary and are sent
// verbatim; the client never searches upward for a repository a second time.

function splitSignal(options = {}) {
  const { signal, ...rest } = options;
  return { signal, rest };
}

module.exports = class GitHostClient {
  constructor(host = null) {
    this.host = host;
  }

  request(operation, payload, options) {
    // GitHost.reset() deliberately replaces the singleton when git.path or
    // trust settings change. Resolve it per request so repositories that were
    // already open cannot revive the retired worker.
    return (this.host || GitHost.instance()).request(operation, payload, options);
  }

  getSnapshot(descriptor, request = {}, options = {}) {
    const { signal, rest } = splitSignal(options);
    return this.request("snapshot", { descriptor, request, options: rest }, { signal });
  }

  getFileMode(descriptor, relativePosixPath, options = {}) {
    const { signal } = splitSignal(options);
    return this.request("fileMode", { descriptor, path: relativePosixPath }, { signal });
  }

  getSubmodulePaths(descriptor, options = {}) {
    const { signal } = splitSignal(options);
    return this.request("submodulePaths", { descriptor }, { signal });
  }

  getDescription(descriptor, options = {}) {
    const { signal } = splitSignal(options);
    return this.request("describe", { descriptor }, { signal });
  }

  getBranchesContaining(descriptor, commit, params = {}, options = {}) {
    const { signal } = splitSignal(options);
    return this.request(
      "branchesContaining",
      { descriptor, request: { commit, ...params } },
      { signal },
    );
  }

  getDiff(descriptor, request, options = {}) {
    const { signal, rest } = splitSignal(options);
    return this.request("diff", { descriptor, request, maxBytes: rest.maxBytes }, { signal });
  }

  getLineDiffs(descriptor, { relativePosixPath, headOid, text, ignoreEolWhitespace, signal }) {
    return this.request(
      "lineDiff",
      { descriptor, relativePosixPath, headOid, text, ignoreEolWhitespace },
      { signal },
    );
  }

  getConfigValues(descriptor, keys, options = {}) {
    const { signal } = splitSignal(options);
    return this.request("readConfig", { descriptor, keys }, { signal });
  }

  getHistory(descriptor, params, options = {}) {
    const { signal } = splitSignal(options);
    return this.request("history", { descriptor, request: params }, { signal });
  }

  getCommit(descriptor, revision, options = {}) {
    const { signal } = splitSignal(options);
    return this.request("commit", { descriptor, revision }, { signal });
  }

  readObjects(descriptor, requests, options = {}) {
    const { signal, rest } = splitSignal(options);
    return this.request(
      "readObjects",
      { descriptor, requests, encoding: rest.encoding || "buffer" },
      { signal },
    );
  }

  async getFileAtRevision(
    descriptor,
    relativePosixPath,
    revision,
    { encoding = "utf8", ...options } = {},
  ) {
    const [object] = await this.readObjects(descriptor, [{ revision, path: relativePosixPath }], {
      ...options,
      encoding,
    });
    return object?.content ?? null;
  }

  async getIndexFile(descriptor, relativePosixPath, { encoding = "utf8", ...options } = {}) {
    const [object] = await this.readObjects(
      descriptor,
      [{ source: "index", path: relativePosixPath }],
      { ...options, encoding },
    );
    return object?.content ?? null;
  }

  async getBlob(descriptor, oid, { encoding = "utf8", ...options } = {}) {
    const [object] = await this.readObjects(descriptor, [{ oid }], { ...options, encoding });
    return object?.content ?? null;
  }

  getBlame(descriptor, relativePosixPath, params = {}, options = {}) {
    const { signal } = splitSignal(options);
    return this.request(
      "blame",
      { descriptor, request: { path: relativePosixPath, ...params } },
      { signal },
    );
  }

  exec(args, workingDirectory, options = {}, raw = false) {
    const { signal, rest } = splitSignal(options);
    return this.request("exec", { workingDirectory, args, options: rest, raw }, { signal });
  }

  writeCommandOutput(args, workingDirectory, destinationPath, options = {}) {
    const { signal, rest } = splitSignal(options);
    return this.request(
      "writeCommandOutput",
      { workingDirectory, args, destinationPath, options: rest },
      { signal },
    );
  }
};
