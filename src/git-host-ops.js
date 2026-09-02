const crypto = require("crypto");

const GitRepositoryStatusProvider = require("./git-repository-status-provider");
const GitRepositoryDiffProvider = require("./git-repository-diff-provider");
const GitRepositoryHistoryProvider = require("./git-repository-history-provider");
const { loadNativeBackend, validateNativeBackend } = require("./git-native-backend");
const { parseDiffPatch } = require("./repository-diff");
const { parseStatusSnapshot } = require("./repository-status-snapshot");

// Cap on cached HEAD blobs (keyed by repo+path+headOid). Immutable per key, so a
// simple insertion-order LRU keeps the worker's memory bounded across many files.
const BLOB_CACHE_MAX = 256;

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

function usesCliWorktreeDiff(descriptor, request) {
  if (descriptor?.hasSubmodules !== true) return false;
  const from = request?.from?.type;
  const to = request?.to?.type;
  return to === "worktree" && (from === "index" || from === "commit");
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
  error.name = "GitNativeDiffTooLargeError";
  error.code = "ERR_GIT_DIFF_TOO_LARGE";
  error.operation = "diff";
  error.maxBytes = maxBytes;
  error.structuredBytes = structured;
  error.patchBytes = patch;
  throw error;
}

// The git-host worker's operation registry. All performance-sensitive reads
// enter git-utils here, never in a renderer. The only history read left on the
// CLI is a path-limited `git log --follow`, whose rename-following semantics are
// intentionally assigned to system Git rather than used as a fallback.
module.exports = function createGitHostOps(runner, { nativeBackend } = {}) {
  const native = nativeBackend
    ? validateNativeBackend(nativeBackend).nativeBackend
    : loadNativeBackend().nativeBackend;
  const cliHistory = new GitRepositoryHistoryProvider({ runner });
  const cliStatus = new GitRepositoryStatusProvider({ runner });
  const cliDiff = new GitRepositoryDiffProvider({ runner });

  const blobCache = new Map();
  function cacheBlob(key, value) {
    if (blobCache.has(key)) blobCache.delete(key);
    blobCache.set(key, value);
    if (blobCache.size > BLOB_CACHE_MAX) blobCache.delete(blobCache.keys().next().value);
  }

  return {
    snapshot: async ({ descriptor, request, options = {} }, { signal }) => {
      if (descriptor.hasSubmodules !== true || request.status === false) {
        return native.snapshot(descriptor, { ...request, signal });
      }

      // libgit2 status is disproportionately expensive for repositories with
      // declared submodules. This is a descriptor-selected provider route, not
      // an error fallback: refs remain native while status runs through the
      // existing system-Git provider in parallel.
      const nativeRefs =
        request.refs === false
          ? Promise.resolve({})
          : native.snapshot(descriptor, { ...request, status: false, refs: true, signal });
      const cliStatusOutput = cliStatus.getStatus(
        descriptor.workingDirectory || descriptor.gitDirectory,
        { ...options, includeIgnored: request.includeIgnored === true, signal },
      );
      const [nativeResult, statusOutput] = await Promise.all([nativeRefs, cliStatusOutput]);
      const statusValue = parseStatusSnapshot(statusOutput, {
        generation: request.generations?.status ?? 1,
        includesIgnored: request.includeIgnored === true,
      });
      return {
        ...nativeResult,
        status: snapshotSection(statusValue, request.knownFingerprints?.status),
      };
    },

    diff: async ({ descriptor, request, maxBytes }, { signal }) => {
      if (usesCliWorktreeDiff(descriptor, request)) {
        const format = request.format || "structured";
        const rawPatch = await cliDiff.getDiffPatch(
          descriptor.workingDirectory || descriptor.gitDirectory,
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
      const result = await native.diff(descriptor, { ...request, signal });
      return assertDiffWithinLimit(result, maxBytes);
    },

    history: ({ descriptor, request }, { signal }) =>
      native.history(descriptor, { ...request, signal }),

    commit: ({ descriptor, revision }, { signal }) =>
      native.commit(descriptor, { revision, signal }),

    // This operation is CLI by design. It is only called for path-limited
    // history, and is never reached because a native operation failed.
    logFollow: ({ descriptor, request, options }, { signal }) =>
      cliHistory.getLog(
        descriptor.workingDirectory || descriptor.gitDirectory,
        { ...request, path: request.path },
        { ...options, signal },
      ),

    describe: ({ descriptor }, { signal }) => native.describe(descriptor, { signal }),

    branchesContaining: ({ descriptor, request }, { signal }) =>
      native.branchesContaining(descriptor, { ...request, signal }),

    fileMode: ({ descriptor, path }, { signal }) => native.fileMode(descriptor, path, { signal }),

    submodulePaths: ({ descriptor }, { signal }) => native.submodulePaths(descriptor, { signal }),

    readObjects: ({ descriptor, requests }, { signal }) =>
      native.readObjects(descriptor, requests, { signal }),

    blame: ({ descriptor, request }, { signal }) =>
      native.blame(descriptor, { ...request, signal }),

    readConfig: ({ descriptor, keys }, { signal }) =>
      native.readConfig(descriptor, { keys, signal }),

    mutate: ({ descriptor, request }, { signal }) =>
      native.mutate(descriptor, { ...request, signal }),

    // Gutter line diff: fetch (and cache) the immutable HEAD blob natively,
    // then run the repository-independent native line diff without reopening
    // the repository for subsequent buffer edits.
    lineDiff: async (
      { descriptor, relativePosixPath, headOid, text, ignoreEolWhitespace },
      { signal },
    ) => {
      const revision = headOid || "HEAD";
      let blob;
      if (headOid) {
        const key = `${descriptor.gitDirectory}\0${relativePosixPath}\0${headOid}`;
        if (blobCache.has(key)) {
          blob = blobCache.get(key);
        } else {
          [blob] = await native.readObjects(descriptor, [{ revision, path: relativePosixPath }], {
            signal,
          });
          cacheBlob(key, blob);
        }
      } else {
        [blob] = await native.readObjects(descriptor, [{ revision, path: relativePosixPath }], {
          signal,
        });
      }
      if (!blob) return [];
      return native.lineDiff(blob.content, text, { ignoreEolWhitespace, signal });
    },

    // System-Git write path: operations that depend on hooks, filters, signing,
    // credential helpers, transports, or full porcelain behavior remain here.
    exec: ({ workingDirectory, args, options, raw }, { signal }) =>
      raw
        ? runner.execute(args, workingDirectory, { ...options, signal })
        : runner.runResult(args, workingDirectory, { ...options, signal }),
  };
};

module.exports.assertDiffWithinLimit = assertDiffWithinLimit;
module.exports.usesCliWorktreeDiff = usesCliWorktreeDiff;
