const crypto = require("crypto");
const path = require("path");
const GitRepositoryStatusProvider = require("./git-repository-status-provider");
const GitRepositoryRefsProvider = require("./git-repository-refs-provider");
const GitRepositoryDiffProvider = require("./git-repository-diff-provider");
const GitRepositoryHistoryProvider = require("./git-repository-history-provider");
const { parseDiffPatch } = require("./repository-diff");
const {
  parseBlamePorcelain,
  parseCommitRecords,
  parseNameStatusTokens,
} = require("./repository-history");
const { parseRefsSnapshot } = require("./repository-refs-snapshot");
const { parseStatusSnapshot } = require("./repository-status-snapshot");
const { computeLineDiffHunks } = require("./line-diff");
const { assertGitRevision } = require("./git-revision");

const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

function workingDirectoryFor(descriptor) {
  return descriptor.workingDirectory || descriptor.gitDirectory;
}

function snapshotFingerprint(value) {
  const { generation: _generation, ...stableValue } = value;
  return crypto.createHash("sha256").update(JSON.stringify(stableValue)).digest("hex");
}

function snapshotSection(value, knownFingerprint) {
  const fingerprint = snapshotFingerprint(value);
  return fingerprint === knownFingerprint
    ? { fingerprint, unchanged: true }
    : { fingerprint, unchanged: false, value };
}

function compareStatusEntries(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function canonicalStatusSnapshot(snapshot) {
  return Object.freeze({
    ...snapshot,
    files: Object.freeze([...snapshot.files].sort(compareStatusEntries)),
  });
}

function canonicalRefsSnapshot(snapshot) {
  return Object.freeze({
    ...snapshot,
    worktrees: Object.freeze(
      snapshot.worktrees.map((worktree) =>
        Object.freeze({ ...worktree, path: path.normalize(worktree.path) }),
      ),
    ),
  });
}

function diffResultBytes(result) {
  let structured = 0;
  let patch = 0;
  if (Array.isArray(result?.files) && result.files.length > 0) {
    structured = Buffer.byteLength(JSON.stringify(result.files));
  }
  if (typeof result?.rawPatch === "string") patch = Buffer.byteLength(result.rawPatch);
  else if (Buffer.isBuffer(result?.rawPatch)) patch = result.rawPatch.length;
  return { structured, patch };
}

function assertDiffWithinLimit(result, maxBytes) {
  if (maxBytes == null) return result;
  const { structured, patch } = diffResultBytes(result);
  if (structured <= maxBytes && patch <= maxBytes) return result;

  const error = new Error(
    `Git diff output exceeded the ${maxBytes} byte limit; raise maxBytes or narrow paths`,
  );
  error.name = "GitDiffTooLargeError";
  error.code = "ERR_GIT_DIFF_TOO_LARGE";
  error.operation = "diff";
  error.maxBytes = maxBytes;
  error.structuredBytes = structured;
  error.patchBytes = patch;
  throw error;
}

function objectExpression(request) {
  if (request.source === "index") return `:${request.path}`;
  if (request.oid) return request.oid;
  return `${request.revision || "HEAD"}:${request.path}`;
}

function canonicalConfigKey(key) {
  const parts = String(key).split(".");
  if (parts.length < 2) return String(key).toLowerCase();
  parts[0] = parts[0].toLowerCase();
  parts[parts.length - 1] = parts.at(-1).toLowerCase();
  return parts.join(".");
}

function parseBatchObjects(output, expectedCount) {
  const objects = [];
  let cursor = 0;
  while (objects.length < expectedCount) {
    const headerEnd = output.indexOf(0, cursor);
    if (headerEnd === -1) throw new Error("Git cat-file returned an invalid batch header");
    const header = output.subarray(cursor, headerEnd).toString("utf8");
    cursor = headerEnd + 1;
    if (header.endsWith(" missing")) {
      objects.push(null);
      continue;
    }

    const match = /^([^ ]+) ([^ ]+) (\d+)$/.exec(header);
    if (!match) throw new Error(`Git cat-file returned an invalid batch header: ${header}`);
    const size = Number(match[3]);
    if (output.length < cursor + size + 1 || output[cursor + size] !== 0) {
      throw new Error("Git cat-file returned a truncated object");
    }
    objects.push({
      oid: match[1],
      type: match[2],
      size,
      content: output.subarray(cursor, cursor + size),
    });
    cursor += size + 1;
  }
  return objects;
}

// System-Git adapter. It returns the same domain structures as git-utils and
// owns all CLI parsing inside git-host, so GitRepository and packages never
// need to know which backend produced a result. The first refactor slice only
// exposes capabilities that are statically assigned to CLI today; the adapter
// can be completed operation-by-operation without changing its consumers.
module.exports = class GitCliBackend {
  constructor({ runner }) {
    this.runner = runner;
    this.statusProvider = new GitRepositoryStatusProvider({ runner });
    this.refsProvider = new GitRepositoryRefsProvider({ runner });
    this.diffProvider = new GitRepositoryDiffProvider({ runner });
    this.historyProvider = new GitRepositoryHistoryProvider({ runner });
  }

  async snapshot(descriptor, request, { signal, ...options } = {}) {
    const workingDirectory = workingDirectoryFor(descriptor);
    const statusRequested = request.status !== false;
    const refsRequested = request.refs !== false;
    const includeIgnored = request.includeIgnored === true;
    const [statusOutput, refsOutput] = await Promise.all([
      statusRequested
        ? this.statusProvider.getStatus(workingDirectory, {
            ...options,
            includeIgnored,
            signal,
          })
        : null,
      refsRequested ? this.refsProvider.getRefs(workingDirectory, { ...options, signal }) : null,
    ]);
    const result = {};
    if (statusRequested) {
      const value = canonicalStatusSnapshot(
        parseStatusSnapshot(statusOutput, {
          generation: request.generations?.status ?? 1,
          includesIgnored: includeIgnored,
        }),
      );
      result.status = snapshotSection(value, request.knownFingerprints?.status);
    }
    if (refsRequested) {
      const value = canonicalRefsSnapshot(
        parseRefsSnapshot(refsOutput, {
          generation: request.generations?.refs ?? 1,
        }),
      );
      result.refs = snapshotSection(value, request.knownFingerprints?.refs);
    }
    return result;
  }

  async diff(descriptor, request, { signal, maxBytes } = {}) {
    const format = request.format || "structured";
    const rawPatch = await this.diffProvider.getDiffPatch(
      workingDirectoryFor(descriptor),
      request,
      { signal, maxBuffer: maxBytes },
    );
    const result = {
      schemaVersion: 1,
      files: format === "patch" ? [] : parseDiffPatch(rawPatch).files,
      ...(format === "structured" ? {} : { rawPatch }),
    };
    return assertDiffWithinLimit(result, maxBytes);
  }

  logFollow(descriptor, request, { signal, ...options } = {}) {
    if (!request.allRefs) assertGitRevision(request.revision);
    return this.historyProvider.getLog(
      workingDirectoryFor(descriptor),
      { ...request, path: request.path },
      { ...options, signal },
    );
  }

  async history(descriptor, request, { signal, ...options } = {}) {
    if (!request.allRefs) assertGitRevision(request.revision);
    const output = await this.historyProvider.getLog(
      workingDirectoryFor(descriptor),
      { ...request, path: null },
      { ...options, signal },
    );
    return parseCommitRecords(output);
  }

  async commit(descriptor, { revision }, { signal, ...options } = {}) {
    assertGitRevision(revision);
    const workingDirectory = workingDirectoryFor(descriptor);
    const logOutput = await this.historyProvider.getLog(
      workingDirectory,
      { revision, limit: 1 },
      { ...options, signal },
    );
    const [commit] = parseCommitRecords(logOutput);
    if (!commit) return null;
    const nameStatusOutput = await this.historyProvider.getNameStatus(workingDirectory, revision, {
      ...options,
      signal,
    });
    return { ...commit, files: parseNameStatusTokens(nameStatusOutput) };
  }

  async blame(descriptor, request, { signal, ...options } = {}) {
    assertGitRevision(request.revision, { allowNull: true });
    const output = await this.historyProvider.getBlame(
      workingDirectoryFor(descriptor),
      request.path,
      request,
      { ...options, signal },
    );
    return parseBlamePorcelain(output);
  }

  describe(descriptor, { signal, ...options } = {}) {
    return this.refsProvider.getDescription(workingDirectoryFor(descriptor), {
      ...options,
      signal,
    });
  }

  branchesContaining(descriptor, request, { signal, ...options } = {}) {
    const { commit, ...params } = request;
    assertGitRevision(commit, { label: "commit" });
    return this.refsProvider.getBranchesContaining(
      workingDirectoryFor(descriptor),
      commit,
      params,
      { ...options, signal },
    );
  }

  fileMode(descriptor, relativePosixPath, { signal, ...options } = {}) {
    return this.statusProvider.getFileMode(workingDirectoryFor(descriptor), relativePosixPath, {
      ...options,
      signal,
    });
  }

  submodulePaths(descriptor, { signal, ...options } = {}) {
    return this.statusProvider.getSubmodulePaths(workingDirectoryFor(descriptor), {
      ...options,
      signal,
    });
  }

  async readObjects(descriptor, requests, { signal, ...options } = {}) {
    if (requests.length === 0) return [];
    const workingDirectory = workingDirectoryFor(descriptor);
    const result = await this.runner.runResult(["cat-file", "--batch", "-Z"], workingDirectory, {
      ...options,
      signal,
      stdin: `${requests.map(objectExpression).join("\0")}\0`,
      encoding: "buffer",
      maxBuffer: options.maxBuffer ?? MAX_OBJECT_BYTES,
    });
    return parseBatchObjects(result.stdout, requests.length);
  }

  async readConfig(descriptor, keys, { signal, ...options } = {}) {
    const requested = new Map();
    for (const key of keys) {
      const original = String(key);
      const canonical = canonicalConfigKey(original);
      const aliases = requested.get(canonical) || [];
      aliases.push(original);
      requested.set(canonical, aliases);
    }
    const values = Object.fromEntries(keys.map((key) => [String(key), null]));
    if (requested.size === 0) return values;

    const output = await this.runner.run(
      ["config", "--null", "--list"],
      workingDirectoryFor(descriptor),
      {
        ...options,
        signal,
      },
    );
    for (const record of output.split("\0")) {
      const separator = record.indexOf("\n");
      if (separator === -1) continue;
      const requestedKeys = requested.get(canonicalConfigKey(record.slice(0, separator)));
      if (requestedKeys) {
        for (const requestedKey of requestedKeys) {
          values[requestedKey] = record.slice(separator + 1);
        }
      }
    }
    return values;
  }

  lineDiff(oldBuffer, newBuffer, options = {}) {
    const oldText = Buffer.isBuffer(oldBuffer) ? oldBuffer.toString("utf8") : String(oldBuffer);
    const newText = Buffer.isBuffer(newBuffer) ? newBuffer.toString("utf8") : String(newBuffer);
    return Promise.resolve(computeLineDiffHunks(oldText, newText, options));
  }

  exec({ workingDirectory, args, options = {}, raw }, { signal } = {}) {
    return raw
      ? this.runner.execute(args, workingDirectory, { ...options, signal })
      : this.runner.runResult(args, workingDirectory, { ...options, signal });
  }
};

module.exports.assertDiffWithinLimit = assertDiffWithinLimit;
module.exports.canonicalConfigKey = canonicalConfigKey;
module.exports.parseBatchObjects = parseBatchObjects;
