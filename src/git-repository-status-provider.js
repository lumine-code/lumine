const GitRunner = require("./git-runner");
const fs = require("fs/promises");
const path = require("path");

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The Git status read was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

async function fileSignature(filePath) {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
  } catch {
    return null;
  }
}

async function fileSignatures(workingDirectory, candidates, signal) {
  const signatures = new Array(candidates.length);
  let next = 0;
  // Keep filesystem work bounded as well as Git subprocesses. All of this
  // runs in git-host, never on the renderer's input/layout thread.
  await Promise.all(
    Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (next < candidates.length) {
        throwIfAborted(signal);
        const index = next++;
        signatures[index] = await fileSignature(
          path.join(workingDirectory, candidates[index].path),
        );
      }
    }),
  );
  return signatures;
}

function quoteGitPath(filePath) {
  // --stdin-paths accepts Git's C quoting, not JSON's Unicode escapes. Quote
  // UTF-8 bytes so whitespace, quotes, backslashes and control characters in
  // a filename cannot split or redirect a batch entry.
  let quoted = '"';
  for (const byte of Buffer.from(filePath)) {
    if (byte === 34 || byte === 92) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 32 && byte <= 126) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${quoted}"`;
}

function contentCandidates(records) {
  const candidates = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record.startsWith("1 ") && !record.startsWith("2 ")) continue;
    const renamed = record.startsWith("2 ");
    const match =
      /^([12]) ([^ ]{2}) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([\s\S]*)$/.exec(record);
    if (
      match &&
      match[2][1] === "M" &&
      match[3] === "N..." &&
      /^(100644|100755)$/.test(match[5]) &&
      match[5] === match[6] &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(match[8]) &&
      !/^0+$/.test(match[8])
    ) {
      const filePath = renamed ? /^[RC]\d+ ([\s\S]*)$/.exec(match[9])?.[1] : match[9];
      if (filePath) candidates.push({ index, path: filePath, oid: match[8], staged: match[2][0] });
    }
    // A rename/copy has a second NUL-delimited record containing its source
    // path. That path is data even if it starts with "1 " or "2 ".
    if (renamed) index++;
  }
  return candidates;
}

async function normalizeWorktreeStatus(
  output,
  workingDirectory,
  runner,
  options,
  indexPath,
  before,
) {
  if (before == null) return output;
  const records = String(output).split("\0");
  const candidates = contentCandidates(records);
  if (candidates.length === 0) return output;
  const signatures = await fileSignatures(workingDirectory, candidates, options.signal);
  let hashes;
  try {
    // A nonzero cached-size mismatch makes Git status report M without
    // hashing, even when the clean-filtered blob still equals the index.
    // Verify those candidates without staging, refreshing or locking the
    // index. One stdin batch avoids a child process for every dirty file.
    const result = await runner.run(["hash-object", "--stdin-paths"], workingDirectory, {
      ...options,
      stdin: `${candidates.map((candidate) => quoteGitPath(candidate.path)).join("\n")}\n`,
    });
    hashes = String(result).trimEnd().split(/\r?\n/);
  } catch (error) {
    throwIfAborted(options.signal);
    if (error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
    // A disappearing file or failed clean filter must leave the original
    // dirty status visible rather than hide an unverified change.
    return output;
  }
  throwIfAborted(options.signal);
  if (hashes.length !== candidates.length) return output;
  const after = await fileSignatures(workingDirectory, candidates, options.signal);
  if (before !== (await fileSignature(indexPath))) return output;
  throwIfAborted(options.signal);
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (
      signatures[index] == null ||
      signatures[index] !== after[index] ||
      hashes[index] !== candidate.oid
    )
      continue;
    records[candidate.index] =
      candidate.staged === "."
        ? ""
        : `${records[candidate.index].slice(0, 3)}.${records[candidate.index].slice(4)}`;
  }
  return records.filter((record) => record !== "").join("\0") + "\0";
}

module.exports = class GitRepositoryStatusProvider {
  constructor({ runner, execute } = {}) {
    this.runner = runner || new GitRunner({ execute });
  }

  async getStatus(workingDirectory, options = {}) {
    throwIfAborted(options.signal);
    const indexPath = path.join(
      options.repositoryDescriptor?.gitDirectory || path.join(workingDirectory, ".git"),
      "index",
    );
    const before = await fileSignature(indexPath);
    const args = [
      "status",
      "--porcelain=v2",
      "--branch",
      "--ahead-behind",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--renames",
    ];
    if (options.includeIgnored) args.push("--ignored=matching");
    const output = await this.runner.run(args, workingDirectory, options);
    throwIfAborted(options.signal);
    return normalizeWorktreeStatus(
      output,
      workingDirectory,
      this.runner,
      options,
      indexPath,
      before,
    );
  }

  // The index mode of a path (`git ls-files --stage`); returns the first stage's
  // mode, or null when the path is not tracked. Callers fall back to the
  // working-tree mode for untracked paths.
  async getFileMode(workingDirectory, relativePosixPath, options = {}) {
    const output = await this.runner.run(
      ["--literal-pathspecs", "ls-files", "--stage", "--", relativePosixPath],
      workingDirectory,
      options,
    );
    if (!output) return null;
    const space = output.indexOf(" ");
    return space === -1 ? null : output.slice(0, space);
  }

  // Read declared paths through Git's config parser so quoted, escaped,
  // whitespace, and Unicode values round-trip without parsing display output.
  async getSubmodulePaths(workingDirectory, options = {}) {
    const result = await this.runner.runResult(
      ["config", "--null", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
      workingDirectory,
      { ...options, allowedExitCodes: [0, 1] },
    );
    if (result.exitCode === 1) return [];
    return String(result.stdout)
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const separator = record.indexOf("\n");
        return separator === -1 ? null : record.slice(separator + 1);
      })
      .filter(Boolean);
  }
};
