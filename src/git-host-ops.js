const GitCliBackend = require("./git-cli-backend");
const GitBlobCache = require("./git-blob-cache");
const GitUtilsBackend = require("./git-utils-backend");
const { normalizeGitBackendError } = require("./git-error");
const {
  GitBackend,
  backendForOperation,
  serializeError,
  usesCliWorktreeDiff,
} = require("./git-host-protocol");
const { assertDiffWithinLimit } = GitCliBackend;

// The git-host worker's operation registry. Backend selection is static and
// declared by git-host-protocol; failures from the selected backend propagate
// and never trigger an error fallback.
module.exports = function createGitHostOps(
  runner,
  { nativeBackend, getNativeBackend, backendOverrides = {}, blobCache = new GitBlobCache() } = {},
) {
  const native = new GitUtilsBackend({ nativeBackend, getNativeBackend });
  const cli = new GitCliBackend({ runner });
  const selectedBackend = (operation, payload) =>
    backendForOperation(operation, payload, { backendOverrides });
  const adapterForBackend = (backend) => {
    if (backend === GitBackend.CLI) return cli;
    if (backend === GitBackend.GIT_UTILS) return native;
    return null;
  };
  const selectedAdapter = (operation, payload) => {
    const backend = selectedBackend(operation, payload);
    const adapter = adapterForBackend(backend);
    if (adapter) return adapter;
    throw new Error(`Git operation ${operation} requires a composite route`);
  };
  const invokeBackend = async (operation, backend, callback) => {
    try {
      return await callback(adapterForBackend(backend));
    } catch (error) {
      throw normalizeGitBackendError(error, { operation, backend });
    }
  };
  const invokeSelected = (operation, payload, callback) =>
    invokeBackend(operation, selectedBackend(operation, payload), callback);

  return {
    snapshot: async ({ descriptor, request, options = {} }, { signal }) => {
      const backend = selectedBackend("snapshot", { descriptor, request });
      if (backend === GitBackend.GIT_UTILS) {
        return invokeBackend("snapshot", backend, (adapter) =>
          adapter.snapshot(descriptor, request, { signal }),
        );
      }

      if (backend === GitBackend.CLI) {
        return invokeBackend("snapshot", backend, (adapter) =>
          adapter.snapshot(descriptor, request, { ...options, signal }),
        );
      }

      // Benchmarks select system Git for status while refs remain accelerated;
      // both adapters run in parallel. This is a request-time policy decision,
      // never an error fallback.
      const nativeRefs = invokeBackend("snapshot", GitBackend.GIT_UTILS, (adapter) =>
        adapter.snapshot(descriptor, { ...request, status: false, refs: true }, { signal }),
      );
      const cliStatus = invokeBackend("snapshot", GitBackend.CLI, (adapter) =>
        adapter.snapshot(
          descriptor,
          { ...request, status: true, refs: false },
          { ...options, signal },
        ),
      );
      const [nativeResult, cliResult] = await Promise.allSettled([nativeRefs, cliStatus]);
      const result = {
        ...(nativeResult.status === "fulfilled" ? nativeResult.value : {}),
        ...(cliResult.status === "fulfilled" ? cliResult.value : {}),
      };
      const errors = [];
      if (nativeResult.status === "rejected") {
        errors.push({
          section: "refs",
          backend: GitBackend.GIT_UTILS,
          error: serializeError(nativeResult.reason),
        });
      }
      if (cliResult.status === "rejected") {
        errors.push({
          section: "status",
          backend: GitBackend.CLI,
          error: serializeError(cliResult.reason),
        });
      }
      if (errors.length > 0) result.errors = errors;
      return result;
    },

    diff: async ({ descriptor, request, maxBytes }, { signal }) => {
      const payload = { descriptor, request };
      return invokeSelected("diff", payload, async (adapter) => {
        const result = await adapter.diff(descriptor, request, { maxBytes, signal });
        return assertDiffWithinLimit(result, maxBytes);
      });
    },

    history: (payload, context) =>
      invokeSelected("history", payload, (adapter) =>
        adapter.history(payload.descriptor, payload.request, context),
      ),

    commit: (payload, context) =>
      invokeSelected("commit", payload, (adapter) =>
        adapter.commit(payload.descriptor, { revision: payload.revision }, context),
      ),

    // This operation is CLI by design. It is only called for path-limited
    // history, and is never reached because a native operation failed.
    logFollow: (payload, context) =>
      invokeSelected("logFollow", payload, (adapter) =>
        adapter.logFollow(payload.descriptor, payload.request, {
          ...payload.options,
          ...context,
        }),
      ),

    describe: (payload, context) =>
      invokeSelected("describe", payload, (adapter) =>
        adapter.describe(payload.descriptor, context),
      ),

    branchesContaining: (payload, context) =>
      invokeSelected("branchesContaining", payload, (adapter) =>
        adapter.branchesContaining(payload.descriptor, payload.request, context),
      ),

    fileMode: (payload, context) =>
      invokeSelected("fileMode", payload, (adapter) =>
        adapter.fileMode(payload.descriptor, payload.path, context),
      ),

    submodulePaths: (payload, context) =>
      invokeSelected("submodulePaths", payload, (adapter) =>
        adapter.submodulePaths(payload.descriptor, context),
      ),

    readObjects: (payload, context) =>
      invokeSelected("readObjects", payload, (adapter) =>
        adapter.readObjects(payload.descriptor, payload.requests, context),
      ),

    blame: (payload, context) =>
      invokeSelected("blame", payload, (adapter) =>
        adapter.blame(payload.descriptor, payload.request, context),
      ),

    readConfig: (payload, context) =>
      invokeSelected("readConfig", payload, (adapter) =>
        adapter.readConfig(payload.descriptor, payload.keys, context),
      ),

    // Gutter line diff: fetch (and cache) the immutable HEAD blob through the
    // selected adapter, then run its repository-independent line diff without
    // reopening the repository for subsequent buffer edits.
    lineDiff: async (payload, { signal }) => {
      const { descriptor, relativePosixPath, headOid, text, ignoreEolWhitespace } = payload;
      const objectBackend = selectedBackend("readObjects", payload);
      const diffBackend = selectedBackend("lineDiff", payload);
      const revision = headOid || "HEAD";
      let blob;
      if (headOid) {
        const key = `${descriptor.gitDirectory}\0${relativePosixPath}\0${headOid}`;
        blob = await blobCache.getOrLoad(
          key,
          ({ signal: sharedSignal }) =>
            invokeBackend("lineDiff", objectBackend, async (adapter) => {
              const [loadedBlob] = await adapter.readObjects(
                descriptor,
                [{ revision, path: relativePosixPath }],
                { signal: sharedSignal },
              );
              return loadedBlob;
            }),
          { signal },
        );
      } else {
        [blob] = await invokeBackend("lineDiff", objectBackend, (adapter) =>
          adapter.readObjects(descriptor, [{ revision, path: relativePosixPath }], { signal }),
        );
      }
      if (!blob) return [];
      return invokeBackend("lineDiff", diffBackend, (adapter) =>
        adapter.lineDiff(blob.content, text, {
          ignoreEolWhitespace,
          signal,
        }),
      );
    },

    // System-Git write path: operations that depend on hooks, filters, signing,
    // credential helpers, transports, or full porcelain behavior remain here.
    exec: (payload, context) => selectedAdapter("exec", payload).exec(payload, context),
  };
};

module.exports.assertDiffWithinLimit = assertDiffWithinLimit;
module.exports.usesCliWorktreeDiff = usesCliWorktreeDiff;
