const SystemGitService = require("./system-git-service");
const GitBlobCache = require("./git-blob-cache");
const { normalizeGitOperationError } = require("./git-error");

// The git-host worker's operation registry. This layer keeps system Git and its
// output parsing outside the renderer while preserving GitRepository's payload
// and result contract.
module.exports = function createGitHostOps(
  runner,
  { systemGitService = new SystemGitService({ runner }), blobCache = new GitBlobCache() } = {},
) {
  const invoke = async (operation, callback) => {
    try {
      return await callback(systemGitService);
    } catch (error) {
      throw normalizeGitOperationError(error, { operation });
    }
  };

  return {
    snapshot: ({ descriptor, request, options = {} }, { signal }) =>
      invoke("snapshot", (service) =>
        service.snapshot(descriptor, request, { ...options, signal }),
      ),

    diff: ({ descriptor, request, maxBytes }, { signal }) =>
      invoke("diff", (service) => service.diff(descriptor, request, { maxBytes, signal })),

    history: (payload, context) =>
      invoke("history", (service) => service.history(payload.descriptor, payload.request, context)),

    commit: (payload, context) =>
      invoke("commit", (service) =>
        service.commit(payload.descriptor, { revision: payload.revision }, context),
      ),

    describe: (payload, context) =>
      invoke("describe", (service) => service.describe(payload.descriptor, context)),

    branchesContaining: (payload, context) =>
      invoke("branchesContaining", (service) =>
        service.branchesContaining(payload.descriptor, payload.request, context),
      ),

    fileMode: (payload, context) =>
      invoke("fileMode", (service) => service.fileMode(payload.descriptor, payload.path, context)),

    submodulePaths: (payload, context) =>
      invoke("submodulePaths", (service) => service.submodulePaths(payload.descriptor, context)),

    readObjects: (payload, context) =>
      invoke("readObjects", async (service) => {
        const objects = await service.readObjects(payload.descriptor, payload.requests, context);
        if (!payload.encoding || payload.encoding === "buffer") return objects;
        return objects.map((object) =>
          object ? { ...object, content: object.content.toString(payload.encoding) } : null,
        );
      }),

    blame: (payload, context) =>
      invoke("blame", (service) => service.blame(payload.descriptor, payload.request, context)),

    readConfig: (payload, context) =>
      invoke("readConfig", (service) =>
        service.readConfig(payload.descriptor, payload.keys, context),
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
            invoke("lineDiff", async (service) => {
              const [loadedBlob] = await service.readObjects(
                descriptor,
                [{ revision, path: relativePosixPath }],
                { signal: sharedSignal },
              );
              return loadedBlob;
            }),
          { signal },
        );
      } else {
        [blob] = await invoke("lineDiff", (service) =>
          service.readObjects(descriptor, [{ revision, path: relativePosixPath }], { signal }),
        );
      }
      if (!blob) return [];
      return invoke("lineDiff", (service) =>
        service.lineDiff(blob.content, text, {
          ignoreEolWhitespace,
          signal,
        }),
      );
    },

    // Keep raw command errors intact: callers use their command, exitCode,
    // stderr, and ERR_GIT_COMMAND_FAILED fields directly.
    exec: (payload, context) => systemGitService.exec(payload, context),

    writeCommandOutput: (payload, context) => systemGitService.writeCommandOutput(payload, context),
  };
};
