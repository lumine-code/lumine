const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const GitRepositoryStatusProvider = require("./git-repository-status-provider");
const GitRepositoryRefsProvider = require("./git-repository-refs-provider");
const GitRepositoryDiffProvider = require("./git-repository-diff-provider");
const GitRepositoryHistoryProvider = require("./git-repository-history-provider");
const { applyFileEndpointPaths, parseDiffPatch } = require("./repository-diff");
const {
  parseBlamePorcelain,
  parseCommitRecords,
  parseNameStatusTokens,
} = require("./repository-history");
const { parseRefsSnapshot } = require("./repository-refs-snapshot");
const { parseStatusSnapshot } = require("./repository-status-snapshot");
const { computeLineDiffHunks } = require("./line-diff");
const { assertGitRevision } = require("./git-revision");
const {
  assertRepositoryDescriptorAvailableAsync,
  ERR_GIT_REPOSITORY_UNAVAILABLE,
} = require("./git-repository-descriptor");

const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_SUBMODULE_CACHE_ENTRIES = 1000;
const EMPTY_SUBMODULE_PATHS = Object.freeze([]);
const VALIDATED_REPOSITORY_DESCRIPTOR = Symbol("validated-repository-descriptor");
const DEFER_REPOSITORY_READ_POSTFLIGHT = Symbol("defer-repository-read-postflight");

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
    submodulePaths: Object.freeze([...snapshot.submodulePaths].sort()),
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

function bareStatusSnapshot(refs, { generation, includesIgnored }) {
  const currentBranch = refs.branches.find((branch) => branch.isHead);
  return Object.freeze({
    schemaVersion: 1,
    generation,
    initialized: true,
    includesIgnored,
    head: refs.head
      ? Object.freeze({
          oid: refs.head.oid,
          name: refs.head.name,
          detached: refs.head.detached,
          unborn: refs.head.unborn,
        })
      : null,
    upstream: currentBranch?.upstream
      ? Object.freeze({
          name: currentBranch.upstream.name,
          ahead: currentBranch.upstream.ahead,
          behind: currentBranch.upstream.behind,
        })
      : null,
    submodulePaths: EMPTY_SUBMODULE_PATHS,
    files: Object.freeze([]),
    counts: Object.freeze({
      total: 0,
      staged: 0,
      unstaged: 0,
      conflicted: 0,
      untracked: 0,
      ignored: 0,
    }),
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
  // Spell stage 0 explicitly. Without it, a path beginning with `1:`, `2:`,
  // or `3:` is parsed as a conflict-stage selector rather than path text.
  if (request.source === "index") return `:0:${request.path}`;
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
    const headerEnd = output.indexOf(0x0a, cursor);
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
    if (output.length < cursor + size + 1 || output[cursor + size] !== 0x0a) {
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

async function resolveLineUnsafeObjectExpression(runner, expression, workingDirectory, options) {
  const result = await runner.runResult(
    ["rev-parse", "--verify", "--end-of-options", expression],
    workingDirectory,
    { ...options, allowedExitCodes: [0, 128] },
  );
  return result.exitCode === 0 ? String(result.stdout).trim() : null;
}

// System Git service. It owns all command construction and parsing inside
// git-host, so GitRepository and packages consume domain structures rather
// than CLI output.
module.exports = class SystemGitService {
  constructor({
    runner,
    assertRepositoryDescriptorAvailable = assertRepositoryDescriptorAvailableAsync,
  }) {
    this.runner = runner;
    this.assertRepositoryDescriptorAvailable = assertRepositoryDescriptorAvailable;
    this.statusProvider = new GitRepositoryStatusProvider({ runner });
    this.refsProvider = new GitRepositoryRefsProvider({ runner });
    this.diffProvider = new GitRepositoryDiffProvider({ runner });
    this.historyProvider = new GitRepositoryHistoryProvider({ runner });
    this.submodulePathsByWorkingDirectory = new Map();
  }

  async validatedRepositoryOptions(descriptor, operation, options) {
    const validatedDescriptor = await this.assertRepositoryDescriptorAvailable(descriptor, {
      operation,
      signal: options.signal,
    });
    return {
      ...options,
      repositoryDescriptor: validatedDescriptor || descriptor,
      [VALIDATED_REPOSITORY_DESCRIPTOR]: true,
    };
  }

  async repositoryFailure(error, descriptor, operation) {
    if (error?.code === ERR_GIT_REPOSITORY_UNAVAILABLE) return error;
    try {
      await this.assertRepositoryDescriptorAvailable(descriptor, {
        operation,
      });
    } catch (validationError) {
      if (validationError?.code === ERR_GIT_REPOSITORY_UNAVAILABLE) return validationError;
    }
    return error;
  }

  async readRepository(descriptor, operation, options, callback) {
    const validatedOptions = await this.validatedRepositoryOptions(descriptor, operation, options);
    let result;
    try {
      result = await callback(validatedOptions);
    } catch (error) {
      throw await this.repositoryFailure(error, descriptor, operation);
    }
    if (!options[DEFER_REPOSITORY_READ_POSTFLIGHT]) {
      await this.assertRepositoryDescriptorAvailable(descriptor, {
        operation,
        signal: options.signal,
      });
    }
    return result;
  }

  async mutateRepository(descriptor, operation, options, callback) {
    const validatedOptions = await this.validatedRepositoryOptions(descriptor, operation, options);
    try {
      return await callback(validatedOptions);
    } catch (error) {
      throw await this.repositoryFailure(error, descriptor, operation);
    }
  }

  async cachedSubmodulePaths(descriptor, options = {}) {
    if (!descriptor.workingDirectory) return EMPTY_SUBMODULE_PATHS;
    const workingDirectory = workingDirectoryFor(descriptor);
    const manifestPath = path.join(workingDirectory, ".gitmodules");
    let stat;
    try {
      stat = await fs.promises.stat(manifestPath, { bigint: true });
    } catch {
      this.submodulePathsByWorkingDirectory.delete(workingDirectory);
      return EMPTY_SUBMODULE_PATHS;
    }

    const signature = `${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
    const cached = this.submodulePathsByWorkingDirectory.get(workingDirectory);
    if (cached?.signature === signature) return cached.paths;

    const paths = Object.freeze(
      [...(await this.statusProvider.getSubmodulePaths(workingDirectory, options))].sort(),
    );
    if (this.submodulePathsByWorkingDirectory.size >= MAX_SUBMODULE_CACHE_ENTRIES) {
      this.submodulePathsByWorkingDirectory.clear();
    }
    this.submodulePathsByWorkingDirectory.set(workingDirectory, { signature, paths });
    return paths;
  }

  async snapshot(descriptor, request, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "snapshot", requestOptions, (validatedOptions) =>
        this.snapshot(descriptor, request, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    const workingDirectory = workingDirectoryFor(descriptor);
    const bare = descriptor.workingDirectory == null;
    const statusRequested = request.status !== false;
    const refsRequested = request.refs !== false;
    const refsNeeded = refsRequested || (bare && statusRequested);
    const includeIgnored = request.includeIgnored === true;
    const [statusOutput, refsOutput, submodulePaths] = await Promise.all([
      statusRequested && !bare
        ? this.statusProvider.getStatus(workingDirectory, {
            ...options,
            includeIgnored,
            signal,
          })
        : null,
      refsNeeded ? this.refsProvider.getRefs(workingDirectory, { ...options, signal }) : null,
      statusRequested && !bare
        ? this.cachedSubmodulePaths(descriptor, { ...options, signal })
        : EMPTY_SUBMODULE_PATHS,
    ]);
    const refsValue = refsNeeded
      ? canonicalRefsSnapshot(
          parseRefsSnapshot(refsOutput, {
            generation: request.generations?.refs ?? 1,
          }),
        )
      : null;
    const result = {};
    if (statusRequested) {
      const value = canonicalStatusSnapshot(
        bare
          ? bareStatusSnapshot(refsValue, {
              generation: request.generations?.status ?? 1,
              includesIgnored: includeIgnored,
            })
          : parseStatusSnapshot(statusOutput, {
              generation: request.generations?.status ?? 1,
              includesIgnored: includeIgnored,
              submodulePaths,
            }),
      );
      result.status = snapshotSection(value, request.knownFingerprints?.status);
    }
    if (refsRequested) {
      result.refs = snapshotSection(refsValue, request.knownFingerprints?.refs);
    }
    return result;
  }

  async diff(descriptor, request, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "diff", requestOptions, (validatedOptions) =>
        this.diff(descriptor, request, validatedOptions),
      );
    }
    const { signal, maxBytes } = requestOptions;
    const format = request.format || "structured";
    const rawPatch = await this.diffProvider.getDiffPatch(
      workingDirectoryFor(descriptor),
      request,
      {
        signal,
        maxBuffer: maxBytes,
        repositoryDescriptor: requestOptions.repositoryDescriptor,
      },
    );
    const result = {
      schemaVersion: 1,
      files:
        format === "patch" ? [] : applyFileEndpointPaths(parseDiffPatch(rawPatch).files, request),
      ...(format === "structured" ? {} : { rawPatch }),
    };
    return assertDiffWithinLimit(result, maxBytes);
  }

  async history(descriptor, request, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "history", requestOptions, (validatedOptions) =>
        this.history(descriptor, request, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    if (!request.allRefs) assertGitRevision(request.revision);
    const output = await this.historyProvider.getLog(workingDirectoryFor(descriptor), request, {
      ...options,
      signal,
    });
    return parseCommitRecords(output);
  }

  async commit(descriptor, { revision }, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "commit", requestOptions, (validatedOptions) =>
        this.commit(descriptor, { revision }, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    assertGitRevision(revision);
    const workingDirectory = workingDirectoryFor(descriptor);
    const logOutput = await this.historyProvider.getLog(
      workingDirectory,
      { revision, limit: 1 },
      { ...options, signal },
    );
    const [commit] = parseCommitRecords(logOutput);
    if (!commit) return null;
    const nameStatusOutput = await this.historyProvider.getNameStatus(
      workingDirectory,
      commit.sha,
      {
        ...options,
        signal,
        parent: commit.parents[0] || null,
      },
    );
    return { ...commit, files: parseNameStatusTokens(nameStatusOutput) };
  }

  async blame(descriptor, request, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "blame", requestOptions, (validatedOptions) =>
        this.blame(descriptor, request, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    assertGitRevision(request.revision, { allowNull: true });
    const output = await this.historyProvider.getBlame(
      workingDirectoryFor(descriptor),
      request.path,
      request,
      { ...options, signal },
    );
    return parseBlamePorcelain(output);
  }

  describe(descriptor, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "describe", requestOptions, (validatedOptions) =>
        this.describe(descriptor, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    return this.refsProvider.getDescription(workingDirectoryFor(descriptor), {
      ...options,
      signal,
    });
  }

  branchesContaining(descriptor, request, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(
        descriptor,
        "branchesContaining",
        requestOptions,
        (validatedOptions) => this.branchesContaining(descriptor, request, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    const { commit, ...params } = request;
    assertGitRevision(commit, { label: "commit" });
    return this.refsProvider.getBranchesContaining(
      workingDirectoryFor(descriptor),
      commit,
      params,
      { ...options, signal },
    );
  }

  fileMode(descriptor, relativePosixPath, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "fileMode", requestOptions, (validatedOptions) =>
        this.fileMode(descriptor, relativePosixPath, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    return this.statusProvider.getFileMode(workingDirectoryFor(descriptor), relativePosixPath, {
      ...options,
      signal,
    });
  }

  submodulePaths(descriptor, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "submodulePaths", requestOptions, (validatedOptions) =>
        this.submodulePaths(descriptor, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    return this.cachedSubmodulePaths(descriptor, { ...options, signal });
  }

  async readObjects(descriptor, requests, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "readObjects", requestOptions, (validatedOptions) =>
        this.readObjects(descriptor, requests, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
    if (requests.length === 0) return [];
    const workingDirectory = workingDirectoryFor(descriptor);
    // Plain --batch is supported by the older system Git versions still
    // shipped by macOS and long-term-support Linux distributions. Its protocol
    // is LF-delimited, so resolve the rare CR/LF-bearing object expression via
    // argv first, then batch the resulting hexadecimal oid.
    const expressions = await Promise.all(
      requests.map((request) => {
        const expression = objectExpression(request);
        return /[\r\n]/.test(expression)
          ? resolveLineUnsafeObjectExpression(this.runner, expression, workingDirectory, {
              ...options,
              signal,
            })
          : expression;
      }),
    );
    const batchExpressions = expressions.filter((expression) => expression != null);
    if (batchExpressions.length === 0) return requests.map(() => null);
    const result = await this.runner.runResult(["cat-file", "--batch"], workingDirectory, {
      ...options,
      signal,
      stdin: `${batchExpressions.join("\n")}\n`,
      encoding: "buffer",
      maxBuffer: options.maxBuffer ?? MAX_OBJECT_BYTES,
    });
    const batchObjects = parseBatchObjects(result.stdout, batchExpressions.length);
    let batchIndex = 0;
    return expressions.map((expression) =>
      expression == null ? null : batchObjects[batchIndex++],
    );
  }

  async readConfig(descriptor, keys, requestOptions = {}) {
    if (!requestOptions[VALIDATED_REPOSITORY_DESCRIPTOR]) {
      return this.readRepository(descriptor, "readConfig", requestOptions, (validatedOptions) =>
        this.readConfig(descriptor, keys, validatedOptions),
      );
    }
    const { signal, ...options } = requestOptions;
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
      ? this.runner.runRawResult(args, workingDirectory, { ...options, signal })
      : this.runner.runResult(args, workingDirectory, { ...options, signal });
  }

  execRepository({ descriptor, args, options = {} }, context = {}) {
    const { signal } = context;
    const { repositoryRead = false, ...commandOptions } = options;
    const execute = repositoryRead
      ? this.readRepository.bind(this)
      : this.mutateRepository.bind(this);
    return execute(
      descriptor,
      repositoryRead ? "execRepository" : "repository-command",
      {
        ...commandOptions,
        signal,
        [DEFER_REPOSITORY_READ_POSTFLIGHT]: context[DEFER_REPOSITORY_READ_POSTFLIGHT] === true,
      },
      (validatedOptions) =>
        this.runner.runResult(args, workingDirectoryFor(descriptor), validatedOptions),
    );
  }

  async writeRepositoryCommandOutput(
    { descriptor, args, options = {}, destinationPath },
    { signal } = {},
  ) {
    const operation = "writeRepositoryCommandOutput";
    const requestOptions = { ...options, signal };
    const validatedOptions = await this.validatedRepositoryOptions(
      descriptor,
      operation,
      requestOptions,
    );
    let result;
    try {
      result = await this.runner.runResult(args, workingDirectoryFor(descriptor), {
        ...validatedOptions,
        encoding: "buffer",
      });
    } catch (error) {
      throw await this.repositoryFailure(error, descriptor, operation);
    }
    try {
      return await this.replaceCommandOutput(result, destinationPath, signal, () =>
        this.assertRepositoryDescriptorAvailable(descriptor, { operation, signal }),
      );
    } catch (error) {
      throw await this.repositoryFailure(error, descriptor, operation);
    }
  }

  async replaceCommandOutput(result, destinationPath, signal, beforeReplace = null) {
    signal?.throwIfAborted();

    // Never expose a partially-written blob or merge result. The temporary
    // file lives beside the destination so the final rename stays on one
    // filesystem and is atomic. Cancellation or any write error leaves the
    // previous destination intact.
    const temporaryPath = path.join(
      path.dirname(destinationPath),
      `.lumine-git-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    let replaced = false;
    try {
      let mode;
      try {
        mode = (await fs.promises.stat(destinationPath)).mode;
      } catch {
        // A new destination uses the process's normal creation mode.
      }
      await fs.promises.writeFile(temporaryPath, result.stdout, {
        signal,
        flag: "wx",
        ...(mode == null ? {} : { mode }),
      });
      signal?.throwIfAborted();
      await beforeReplace?.();
      signal?.throwIfAborted();
      await fs.promises.rename(temporaryPath, destinationPath);
      replaced = true;
      return { exitCode: result.exitCode, stderr: result.stderr };
    } finally {
      if (!replaced) await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
};

module.exports.canonicalConfigKey = canonicalConfigKey;
module.exports.parseBatchObjects = parseBatchObjects;
module.exports.DEFER_REPOSITORY_READ_POSTFLIGHT = DEFER_REPOSITORY_READ_POSTFLIGHT;
