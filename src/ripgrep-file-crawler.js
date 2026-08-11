const { spawn } = require("child_process");
const path = require("path");

// How many paths to accumulate before handing a batch to the caller. Streaming
// in batches keeps a crawl of a large project from turning into one callback
// per file while still letting consumers render results before the crawl ends.
const PathsChunkSize = 100;

/**
 * Lists the files under a set of directories.
 *
 * This is the file-listing counterpart to `RipgrepDirectorySearcher`, which
 * searches file *contents*. Both drive the bundled ripgrep binary, so the crawl
 * itself happens in a separate process: ripgrep honors `.gitignore` natively,
 * walks in parallel, and never blocks the renderer. What is left on this side is
 * splitting apart the NUL-terminated paths it streams back.
 *
 * It exists so that the ripgrep invocation lives in exactly one place. Every
 * consumer that rolled its own got some of these details right and some wrong:
 * the `app.asar.unpacked` rewrite, decoding stdout as UTF-8 so a multibyte
 * character never straddles a chunk boundary, excluding `.git`/`.hg` explicitly
 * because `--hidden` would otherwise list their internals, and — the subtle one
 * — only passing a positive `--glob` when the caller actually narrowed the
 * search, since in ripgrep a positive glob overrides the ignore files and would
 * silently defeat `core.excludeVcsIgnoredPaths`.
 *
 * @private
 */
module.exports = class RipgrepFileCrawler {
  constructor() {
    this.rgPath = null;
  }

  /**
   * Lists the files under one or more directories.
   *
   * @param directoryPaths - an `Array` of absolute directory paths to crawl.
   * @param {Object} [options]
   * @param {Function} options.didFindPaths - called with an `Array` of absolute paths as they are found. Called several times over the life of one crawl.
   * @param {String} options.inclusion - glob scoping the crawl. `**` means "everything", and is treated as no restriction at all.
   * @param options.ignoredNames - an `Array` of `String` globs to exclude.
   * @param {Boolean} options.followSymlinks - whether to descend into symlinked directories (default: false).
   * @param {Boolean} options.excludeVcsIgnoredPaths - whether to honor VCS ignore files (default: true). ripgrep only consults `.gitignore` inside a repository, so a directory with no `.git` above it lists everything either way.
   * @param {Boolean} options.sort - whether to return paths in a stable order. Costs ripgrep its parallel walk, so only ask when the order is observable.
   * @returns {Promise} with a `cancel()` method that resolves the crawl early.
   * @public
   * @api-status Public
   */
  crawl(directoryPaths, options = {}) {
    const emittedPaths = new Set();
    const crawls = directoryPaths.map((directoryPath) =>
      this.crawlDirectory(directoryPath, options, emittedPaths),
    );

    const promise = Promise.all(crawls).then(() => undefined);
    promise.cancel = () => {
      for (const crawl of crawls) {
        crawl.cancel();
      }
    };
    return promise;
  }

  crawlDirectory(directoryPath, options, emittedPaths) {
    // Delay the require of @vscode/ripgrep to not mess with the snapshot creation.
    if (!this.rgPath) {
      this.rgPath = require("./ripgrep").rgPath;
    }

    const didFindPaths = options.didFindPaths || (() => {});
    // `--null` terminates each path with NUL instead of a newline. A newline is
    // a legal character in a POSIX filename, so splitting on one would break
    // such a path into two that do not exist.
    const args = ["--files", "--hidden", "--null"];

    if (options.sort) {
      args.push("--sort", "path");
    }

    // A positive glob overrides the ignore files, so only scope by the
    // inclusion when the caller actually narrowed it.
    if (options.inclusion && options.inclusion !== "**") {
      args.push("--glob", options.inclusion);
    }

    if (options.followSymlinks) {
      args.push("--follow");
    }

    if (options.excludeVcsIgnoredPaths === false) {
      // Disable only VCS ignore files; still honor `.ignore`/`.rgignore`,
      // matching project search's `--no-ignore-vcs` semantics.
      args.push("--no-ignore-vcs");
    }

    for (const ignoredName of options.ignoredNames || []) {
      if (ignoredName) {
        args.push("--glob", `!${ignoredName}`);
      }
    }

    // Never surface `.git`/`.hg` internals, regardless of the VCS-ignore
    // setting: `--hidden` lists them otherwise.
    args.push("--glob", "!.git");
    args.push("--glob", "!.hg");

    let cancelled = false;
    let child = null;

    const promise = new Promise((resolve) => {
      child = spawn(this.rgPath, args, { cwd: directoryPath });
      // Decode as UTF-8 so multibyte characters in paths survive chunk
      // boundaries (Node's StringDecoder reassembles them).
      child.stdout.setEncoding("utf8");

      let remainder = "";
      let batch = [];

      const flush = () => {
        if (batch.length > 0) {
          didFindPaths(batch);
          batch = [];
        }
      };

      const found = (relativePath) => {
        if (!relativePath) return;
        const absolutePath = path.join(directoryPath, relativePath);
        // Roots can nest or overlap; a file reached through two of them is
        // still one file.
        if (emittedPaths.has(absolutePath)) return;
        emittedPaths.add(absolutePath);
        batch.push(absolutePath);
        if (batch.length === PathsChunkSize) flush();
      };

      child.stdout.on("data", (chunk) => {
        if (cancelled) return;
        const paths = (remainder + chunk).split("\0");
        remainder = paths.pop();
        for (const foundPath of paths) found(foundPath);
      });

      child.stderr.on("data", () => {
        // ripgrep reports unreadable paths and invalid excludes here. Neither
        // is worth failing a crawl over.
      });

      child.on("error", () => {
        flush();
        resolve();
      });

      child.on("close", () => {
        if (!cancelled) found(remainder);
        flush();
        resolve();
      });
    });

    promise.cancel = () => {
      cancelled = true;
      if (child) child.kill();
    };
    return promise;
  }
};
