const GitHost = require("./git-host");

// Renderer-side clients for the native operations owned by git-host. Repository
// descriptors are already discovered in the renderer and are sent verbatim;
// the worker never searches upward for a repository a second time.

function splitSignal(options = {}) {
  const { signal, ...rest } = options;
  return { signal, rest };
}

function contentWithEncoding(content, encoding) {
  if (content == null) return null;
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return encoding === "buffer" ? buffer : buffer.toString(encoding || "utf8");
}

class GitHostSnapshotProvider {
  getSnapshot(descriptor, request = {}, options = {}) {
    const { signal, rest } = splitSignal(options);
    return GitHost.instance().request(
      "snapshot",
      { descriptor, request, options: rest },
      { signal },
    );
  }
}

class GitHostStatusProvider {
  getFileMode(descriptor, relativePosixPath, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request(
      "fileMode",
      { descriptor, path: relativePosixPath },
      { signal },
    );
  }

  getSubmodulePaths(descriptor, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request("submodulePaths", { descriptor }, { signal });
  }
}

class GitHostRefsProvider {
  getDescription(descriptor, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request("describe", { descriptor }, { signal });
  }

  getBranchesContaining(descriptor, commit, params = {}, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request(
      "branchesContaining",
      { descriptor, request: { commit, ...params } },
      { signal },
    );
  }
}

class GitHostDiffProvider {
  getDiff(descriptor, request, options = {}) {
    const { signal, rest } = splitSignal(options);
    return GitHost.instance().request(
      "diff",
      { descriptor, request, maxBytes: rest.maxBytes },
      { signal },
    );
  }

  getLineDiffs(descriptor, { relativePosixPath, headOid, text, ignoreEolWhitespace, signal }) {
    return GitHost.instance().request(
      "lineDiff",
      { descriptor, relativePosixPath, headOid, text, ignoreEolWhitespace },
      { signal },
    );
  }
}

class GitHostConfigProvider {
  getConfigValues(descriptor, keys, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request("readConfig", { descriptor, keys }, { signal });
  }

  async getConfigValue(descriptor, key, options = {}) {
    const values = await this.getConfigValues(descriptor, [key], options);
    return Object.hasOwn(values, key) ? values[key] : null;
  }
}

class GitHostHistoryProvider {
  getHistory(descriptor, params, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request("history", { descriptor, request: params }, { signal });
  }

  getLogFollow(descriptor, params, options = {}) {
    const { signal, rest } = splitSignal(options);
    return GitHost.instance().request(
      "logFollow",
      { descriptor, request: params, options: rest },
      { signal },
    );
  }

  getCommit(descriptor, revision, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request("commit", { descriptor, revision }, { signal });
  }

  readObjects(descriptor, requests, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request("readObjects", { descriptor, requests }, { signal });
  }

  async getFileAtRevision(
    descriptor,
    relativePosixPath,
    revision,
    { encoding = "utf8", ...options } = {},
  ) {
    const [object] = await this.readObjects(
      descriptor,
      [{ revision, path: relativePosixPath }],
      options,
    );
    return contentWithEncoding(object?.content, encoding);
  }

  async getIndexFile(descriptor, relativePosixPath, { encoding = "utf8", ...options } = {}) {
    const [object] = await this.readObjects(
      descriptor,
      [{ source: "index", path: relativePosixPath }],
      options,
    );
    return contentWithEncoding(object?.content, encoding);
  }

  async getBlob(descriptor, oid, { encoding = "utf8", ...options } = {}) {
    const [object] = await this.readObjects(descriptor, [{ oid }], options);
    return contentWithEncoding(object?.content, encoding);
  }

  getBlame(descriptor, relativePosixPath, params = {}, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request(
      "blame",
      { descriptor, request: { path: relativePosixPath, ...params } },
      { signal },
    );
  }
}

class GitHostMutationProvider {
  mutate(descriptor, request, options = {}) {
    const { signal } = splitSignal(options);
    return GitHost.instance().request("mutate", { descriptor, request }, { signal });
  }
}

module.exports = {
  GitHostSnapshotProvider,
  GitHostStatusProvider,
  GitHostRefsProvider,
  GitHostConfigProvider,
  GitHostDiffProvider,
  GitHostHistoryProvider,
  GitHostMutationProvider,
};
