const GitCliBackend = require("./git-cli-backend");
const GitBlobCache = require("./git-blob-cache");
const { normalizeGitOperationError } = require("./git-error");
const { assertDiffWithinLimit } = GitCliBackend;

// The git-host worker's operation registry. System Git is the sole repository
// backend; this layer preserves the backend-neutral payload and result contract
// consumed by GitRepository and editor packages.
module.exports = function createGitHostOps(
  runner,
  { cliBackend = new GitCliBackend({ runner }), blobCache = new GitBlobCache() } = {},
) {
  const invoke = async (operation, callback) => {
    try {
      return await callback(cliBackend);
    } catch (error) {
      throw normalizeGitOperationError(error, { operation, backend: "cli" });
    }
  };

  return {
    snapshot: ({ descriptor, request, options = {} }, { signal }) =>
      invoke("snapshot", (backend) =>
        backend.snapshot(descriptor, request, { ...options, signal }),
      ),

    diff: ({ descriptor, request, maxBytes }, { signal }) =>
      invoke("diff", async (backend) => {
        const result = await backend.diff(descriptor, request, { maxBytes, signal });
        return assertDiffWithinLimit(result, maxBytes);
      }),

    history: (payload, context) =>
      invoke("history", (backend) => backend.history(payload.descriptor, payload.request, context)),

    commit: (payload, context) =>
      invoke("commit", (backend) =>
        backend.commit(payload.descriptor, { revision: payload.revision }, context),
      ),

    logFollow: (payload, context) =>
      invoke("logFollow", (backend) =>
        backend.logFollow(payload.descriptor, payload.request, {
          ...payload.options,
          ...context,
        }),
      ),

    describe: (payload, context) =>
      invoke("describe", (backend) => backend.describe(payload.descriptor, context)),

    branchesContaining: (payload, context) =>
      invoke("branchesContaining", (backend) =>
        backend.branchesContaining(payload.descriptor, payload.request, context),
      ),

    fileMode: (payload, context) =>
      invoke("fileMode", (backend) => backend.fileMode(payload.descriptor, payload.path, context)),

    submodulePaths: (payload, context) =>
      invoke("submodulePaths", (backend) => backend.submodulePaths(payload.descriptor, context)),

    readObjects: (payload, context) =>
      invoke("readObjects", (backend) =>
        backend.readObjects(payload.descriptor, payload.requests, context),
      ),

    blame: (payload, context) =>
      invoke("blame", (backend) => backend.blame(payload.descriptor, payload.request, context)),

    readConfig: (payload, context) =>
      invoke("readConfig", (backend) =>
        backend.readConfig(payload.descriptor, payload.keys, context),
      ),

    // Fetch and cache the immutable HEAD blob, then run the repository-independent
    // line diff without reopening the repository for subsequent buffer edits.
    lineDiff: async (payload, { signal }) => {
      const { descriptor, relativePosixPath, headOid, text, ignoreEolWhitespace } = payload;
      const revision = headOid || "HEAD";
      let blob;
      if (headOid) {
        const key = `${descriptor.gitDirectory}\0${relativePosixPath}\0${headOid}`;
        blob = await blobCache.getOrLoad(
          key,
          ({ signal: sharedSignal }) =>
            invoke("lineDiff", async (backend) => {
              const [loadedBlob] = await backend.readObjects(
                descriptor,
                [{ revision, path: relativePosixPath }],
                { signal: sharedSignal },
              );
              return loadedBlob;
            }),
          { signal },
        );
      } else {
        [blob] = await invoke("lineDiff", (backend) =>
          backend.readObjects(descriptor, [{ revision, path: relativePosixPath }], { signal }),
        );
      }
      if (!blob) return [];
      return invoke("lineDiff", (backend) =>
        backend.lineDiff(blob.content, text, {
          ignoreEolWhitespace,
          signal,
        }),
      );
    },

    // Keep raw command errors intact: callers use their command, exitCode,
    // stderr, and ERR_GIT_COMMAND_FAILED fields directly.
    exec: (payload, context) => cliBackend.exec(payload, context),
  };
};

module.exports.assertDiffWithinLimit = assertDiffWithinLimit;
