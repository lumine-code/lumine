const fs = require("fs");
const os = require("os");
const path = require("path");
const GitRunner = require("./git-runner");
const { assertGitRevision } = require("./git-revision");

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function endpointDescription(endpoint) {
  return endpoint?.type || String(endpoint);
}

function validateEndpoint(endpoint) {
  const type = endpoint?.type;
  if (!["commit", "index", "worktree", "file", "empty"].includes(type)) {
    throw new TypeError(`Unsupported diff endpoint: ${endpointDescription(endpoint)}`);
  }
  if (type === "commit" && typeof endpoint.revision !== "string") {
    throw new TypeError("Commit diff endpoints require a revision string");
  }
  if (type === "commit") assertGitRevision(endpoint.revision);
  if (type === "file" && typeof endpoint.path !== "string") {
    throw new TypeError("File diff endpoints require a path string");
  }
  return endpoint;
}

function unsupportedPair(from, to) {
  return new TypeError(
    `Unsupported diff endpoint pair: ${endpointDescription(from)} -> ${endpointDescription(to)}. ` +
      "Repository endpoints may be commit, index, worktree, or empty; file endpoints may pair with file or empty.",
  );
}

async function removeTemporaryObjects(directory) {
  try {
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Unable to remove temporary Git object directory ${directory}`, error);
  }
}

async function temporaryEmptyTree(runner, workingDirectory, options) {
  const objectDirectoryOutput = await runner.run(
    ["rev-parse", "--git-path", "objects"],
    workingDirectory,
    options,
  );
  const repositoryObjects = path.resolve(workingDirectory, objectDirectoryOutput.trim());
  const temporaryObjects = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lumine-empty-tree-"));
  const inheritedAlternates = options.env?.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const environment = {
    ...options.env,
    GIT_OBJECT_DIRECTORY: temporaryObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [repositoryObjects, inheritedAlternates]
      .filter(Boolean)
      .join(path.delimiter),
  };
  try {
    const oid = (
      await runner.run(["hash-object", "-t", "tree", "-w", "--stdin"], workingDirectory, {
        ...options,
        env: environment,
        stdin: "",
      })
    ).trim();
    return {
      oid,
      options: { ...options, env: environment },
      dispose: () => removeTemporaryObjects(temporaryObjects),
    };
  } catch (error) {
    await removeTemporaryObjects(temporaryObjects);
    throw error;
  }
}

// Maps endpoint pairs onto git diff invocations and returns the raw patch.
module.exports = class GitRepositoryDiffProvider {
  constructor({ runner, execute } = {}) {
    this.runner = runner || new GitRunner({ execute });
  }

  async getDiffPatch(workingDirectory, request, options = {}) {
    const from = validateEndpoint(request.from);
    const to = validateEndpoint(request.to);

    const args = [
      "-c",
      "core.quotePath=false",
      "diff",
      "--patch",
      "--no-ext-diff",
      "--no-color",
      request.detectRenames === false ? "--no-renames" : "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `--unified=${request.context ?? 3}`,
    ];
    if (request.ignoreWhitespace) args.push("--ignore-all-space");
    if (request.diffFilter) args.push(`--diff-filter=${request.diffFilter}`);

    let allowedExitCodes = [0];
    let emptyTree = null;
    if (from.type === to.type && from.type !== "commit" && from.type !== "file") {
      return "";
    } else if (from.type === "index" && to.type === "worktree") {
      // No endpoint arguments.
    } else if (from.type === "worktree" && to.type === "index") {
      args.push("--reverse");
    } else if (from.type === "commit" && to.type === "index") {
      args.push("--cached", from.revision);
    } else if (from.type === "index" && to.type === "commit") {
      args.push("--cached", "--reverse", to.revision);
    } else if (from.type === "commit" && to.type === "worktree") {
      args.push(from.revision);
    } else if (from.type === "worktree" && to.type === "commit") {
      args.push("--reverse", to.revision);
    } else if (from.type === "commit" && to.type === "commit") {
      args.push(from.revision, to.revision);
    } else if (
      (from.type === "empty" || to.type === "empty") &&
      from.type !== "file" &&
      to.type !== "file"
    ) {
      // There is no CLI spelling for the index against an implicit empty
      // tree. Materialize Git's algorithm-specific empty tree as an inert
      // object, then use ordinary diff endpoint rules. This works for SHA-1
      // and SHA-256 without a hard-coded OID.
      emptyTree = await temporaryEmptyTree(this.runner, workingDirectory, options);
      if (from.type === "empty" && to.type === "index") {
        args.push("--cached", emptyTree.oid);
      } else if (from.type === "index" && to.type === "empty") {
        args.push("--cached", "--reverse", emptyTree.oid);
      } else if (from.type === "empty" && to.type === "worktree") {
        args.push(emptyTree.oid);
      } else if (from.type === "worktree" && to.type === "empty") {
        args.push("--reverse", emptyTree.oid);
      } else if (from.type === "empty" && to.type === "commit") {
        args.push(emptyTree.oid, to.revision);
      } else if (from.type === "commit" && to.type === "empty") {
        args.push(from.revision, emptyTree.oid);
      } else {
        throw unsupportedPair(from, to);
      }
    } else if (
      (from.type === "file" || from.type === "empty") &&
      (to.type === "file" || to.type === "empty") &&
      (from.type === "file" || to.type === "file")
    ) {
      // git diff --no-index exits 1 when the files differ.
      allowedExitCodes = [0, 1];
      args.push(
        "--no-index",
        "--",
        from.type === "empty" ? NULL_DEVICE : from.path,
        to.type === "empty" ? NULL_DEVICE : to.path,
      );
      return this.runner.run(args, workingDirectory, { ...options, allowedExitCodes });
    } else {
      throw unsupportedPair(from, to);
    }

    if (request.paths?.length) args.push("--", ...request.paths);
    try {
      return await this.runner.run(args, workingDirectory, {
        ...(emptyTree?.options || options),
        allowedExitCodes,
      });
    } finally {
      await emptyTree?.dispose();
    }
  }
};
