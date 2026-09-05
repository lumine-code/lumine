const GitRunner = require("./git-runner");

// Keep the hot all-ref scan free of branch routing atoms. Git's ref-filter
// recomputes remote details once per atom and local branch, so asking for the
// upstream and push variants here makes large repositories quadratic in
// practice. Empty fields retain one simple parser layout; the targeted scans
// below fill them in without repeating the object/commit work.
const BASE_FOR_EACH_REF_FORMAT = [
  "%(refname)",
  "",
  "%(objectname)",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "%(HEAD)",
  "%(symref)",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
].join("%00");

const UPSTREAM_FOR_EACH_REF_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(upstream)",
  "%(upstream:track,nobracket)",
].join("%00");
const PUSH_FOR_EACH_REF_FORMAT = ["%(refname)", "%(objectname)", "%(push)"].join("%00");
const COMMIT_LOG_FORMAT = ["%H", "%P", "%an", "%ct", "%s"].join("%x00");
const TAG_OBJECT_FORMAT = ["%(objectname)", "%(objecttype)", "%(rest)"].join("\t");
const MAX_UPSTREAM_PATTERN_ARGUMENT_CHARS = 12 * 1024;

function configEntries(output) {
  return String(output)
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\n");
      return separator === -1
        ? { key: record, value: "" }
        : { key: record.slice(0, separator), value: record.slice(separator + 1) };
    });
}

function configNames(output) {
  return configEntries(output).map(({ key }) => key);
}

function configuredUpstreamRefs(output) {
  const fieldsByBranch = new Map();
  for (const key of configNames(output)) {
    const match = /^branch\.(.*)\.(remote|merge)$/i.exec(key);
    if (!match) continue;
    let fields = fieldsByBranch.get(match[1]);
    if (!fields) fieldsByBranch.set(match[1], (fields = new Set()));
    fields.add(match[2].toLowerCase());
  }
  return Array.from(fieldsByBranch, ([branch, fields]) =>
    fields.has("remote") && fields.has("merge") ? `refs/heads/${branch}` : null,
  ).filter(Boolean);
}

function mayHavePushTargets(configuration, remotes, upstreamRefs) {
  const entries = configEntries(configuration);
  if (entries.some(({ key }) => /^remote\..+\.push$/i.test(key))) return true;
  const pushDefault = entries
    .filter(({ key }) => key.toLowerCase() === "push.default")
    .at(-1)?.value;
  if (pushDefault?.trim().toLowerCase() === "nothing") return false;
  if (String(remotes).trim() || upstreamRefs.length > 0) return true;
  return entries.some(({ key }) => {
    const normalized = key.toLowerCase();
    return (
      normalized === "push.default" ||
      normalized === "remote.pushdefault" ||
      normalized.startsWith("remote.") ||
      (/^branch\..*\.(remote|pushremote)$/i.test(key) &&
        normalized !== "branch..remote" &&
        normalized !== "branch..pushremote")
    );
  });
}

function upstreamRefArguments(patterns) {
  const argumentChars = patterns.reduce((total, pattern) => total + pattern.length + 3, 0);
  // CreateProcess limits a Windows command line to 32,767 UTF-16 code units.
  // Fall back to one namespace scan well before that boundary; Git emits empty
  // upstream fields for unconfigured branches, so the result stays identical.
  return argumentChars <= MAX_UPSTREAM_PATTERN_ARGUMENT_CHARS ? patterns : ["refs/heads"];
}

function objectIdsForMetadata(output, refPrefix = "") {
  const objectIds = new Set();
  for (const record of String(output).split("\n")) {
    if (!record) continue;
    const [ref, , objectId] = record.split("\0", 3);
    if (refPrefix && !ref.startsWith(refPrefix)) continue;
    if (objectId) objectIds.add(objectId);
  }
  return Array.from(objectIds);
}

function tagObjectInput(objectIds) {
  return objectIds.flatMap((oid) => [`${oid} raw:${oid}`, `${oid}^{} peeled:${oid}`]).join("\n");
}

// Collects the raw command outputs that repository-refs-snapshot.js parses.
// Field separators are NUL and records are newline-terminated: refnames can
// never contain newlines or NUL, so both delimiters are unambiguous.
module.exports = class GitRepositoryRefsProvider {
  constructor({ runner, execute } = {}) {
    this.runner = runner || new GitRunner({ execute });
  }

  async getRefs(workingDirectory, options = {}) {
    const forEachRefPromise = this.runner.run(
      [
        "for-each-ref",
        `--format=${BASE_FOR_EACH_REF_FORMAT}`,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      workingDirectory,
      options,
    );
    const remotesPromise = this.runner.run(["remote", "-v"], workingDirectory, options);
    const worktreesPromise = this.runner.run(
      ["worktree", "list", "--porcelain", "-z"],
      workingDirectory,
      options,
    );
    const symbolicHeadPromise = this.runner.run(
      // Exit 1 means a detached HEAD; exit 128 an unborn branch elsewhere.
      ["symbolic-ref", "--quiet", "HEAD"],
      workingDirectory,
      {
        ...options,
        allowedExitCodes: [0, 1],
      },
    );
    const headOidPromise = this.runner.run(
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      workingDirectory,
      {
        ...options,
        allowedExitCodes: [0, 1],
      },
    );
    const configurationPromise = this.runner.run(
      ["config", "--null", "--list"],
      workingDirectory,
      options,
    );
    const commitMetadataPromise = forEachRefPromise.then((forEachRef) => {
      const objectIds = objectIdsForMetadata(forEachRef);
      return objectIds.length === 0
        ? ""
        : this.runner.run(
            [
              "log",
              "--no-walk=unsorted",
              "--stdin",
              "--ignore-missing",
              "--no-show-signature",
              "--no-decorate",
              "--no-use-mailmap",
              "--encoding=UTF-8",
              `--format=${COMMIT_LOG_FORMAT}`,
            ],
            workingDirectory,
            { ...options, stdin: `${objectIds.join("\n")}\n` },
          );
    });
    const tagObjectsPromise = forEachRefPromise.then((forEachRef) => {
      const objectIds = objectIdsForMetadata(forEachRef, "refs/tags/");
      return objectIds.length === 0
        ? ""
        : this.runner.run(["cat-file", `--batch-check=${TAG_OBJECT_FORMAT}`], workingDirectory, {
            ...options,
            stdin: `${tagObjectInput(objectIds)}\n`,
          });
    });

    // These small preflight commands normally finish while the base ref scan
    // is still reading commit metadata. Only branches with a real upstream
    // configuration are sent back through ref-filter. Push resolution remains
    // all-branch when it can produce a target, preserving BranchSet semantics.
    const routingRefsPromise = Promise.all([configurationPromise, remotesPromise]).then(
      async ([configuration, remotes]) => {
        const upstreamPatterns = configuredUpstreamRefs(configuration);
        const upstreamRefsPromise =
          upstreamPatterns.length === 0
            ? Promise.resolve("")
            : this.runner.run(
                [
                  "for-each-ref",
                  `--format=${UPSTREAM_FOR_EACH_REF_FORMAT}`,
                  ...upstreamRefArguments(upstreamPatterns),
                ],
                workingDirectory,
                options,
              );
        const pushRefsPromise = mayHavePushTargets(configuration, remotes, upstreamPatterns)
          ? this.runner.run(
              ["for-each-ref", `--format=${PUSH_FOR_EACH_REF_FORMAT}`, "refs/heads"],
              workingDirectory,
              options,
            )
          : Promise.resolve("");
        const [upstreamRefs, pushRefs] = await Promise.all([upstreamRefsPromise, pushRefsPromise]);
        return { remotes, upstreamRefs, pushRefs };
      },
    );

    const [forEachRef, tagObjects, commitMetadata, worktrees, symbolicHead, headOid, routingRefs] =
      await Promise.all([
        forEachRefPromise,
        tagObjectsPromise,
        commitMetadataPromise,
        worktreesPromise,
        symbolicHeadPromise,
        headOidPromise,
        routingRefsPromise,
      ]);
    const { remotes, upstreamRefs, pushRefs } = routingRefs;

    return {
      forEachRef,
      tagObjects,
      commitMetadata,
      upstreamRefs,
      pushRefs,
      remotes,
      worktrees,
      symbolicHead,
      headOid,
    };
  }

  // Describe HEAD as a ref name (`git describe --contains --all --always`);
  // returns "" when there is no HEAD yet (unborn branch).
  async getDescription(workingDirectory, options = {}) {
    const result = await this.runner.runResult(
      ["describe", "--contains", "--all", "--always", "HEAD"],
      workingDirectory,
      { ...options, allowedExitCodes: [0, 128] },
    );
    return result.exitCode === 0 ? String(result.stdout).trim() : "";
  }

  // The fully-qualified refnames of branches that contain a commit
  // (`git branch --contains <commit>`).
  async getBranchesContaining(
    workingDirectory,
    commit,
    { showLocal = false, showRemote = false, pattern = null } = {},
    options = {},
  ) {
    const args = ["branch", "--format=%(refname)", "--contains", commit];
    if (showLocal && showRemote) args.splice(1, 0, "--all");
    else if (showRemote) args.splice(1, 0, "--remotes");
    if (pattern) args.push("--", pattern);
    const output = await this.runner.run(args, workingDirectory, options);
    return output.trim() === "" ? [] : output.trim().split("\n");
  }
};
