const { createGitExec } = require("./git-executor");
const { resolveGitPath } = require("./git-binary");
const path = require("path");

// Lazily resolve the system git binary (honoring `git.path`, passed to the
// worker as LUMINE_GIT_PATH) and build the shared executor once per process.
let sharedGitExec = null;
function defaultGitExec(args, workingDirectory, options) {
  if (!sharedGitExec) {
    sharedGitExec = createGitExec(resolveGitPath(process.env.LUMINE_GIT_PATH || ""));
  }
  return sharedGitExec(args, workingDirectory, options);
}

// Bound the number of concurrent `git` child processes across the worker.
// Opening a project with many repositories otherwise fires a burst of
// status/refs refreshes — the refs provider alone spawns five `git` processes
// per repository — flooding the OS with dozens of simultaneous spawns at
// startup. A shared FIFO semaphore flattens that burst into a bounded pipeline
// without changing any provider's observable behavior.
const DEFAULT_MAX_CONCURRENT_GIT = 6;
const MAX_GIT_ERROR_DETAIL_BYTES = 64 * 1024;
const TRUNCATED_DIAGNOSTIC_SUFFIX = "\n… [truncated by git-host]";

function abortError() {
  const error = new Error("The Git operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function boundedErrorDetail(value) {
  const text = String(value).trim();
  if (Buffer.byteLength(text) <= MAX_GIT_ERROR_DETAIL_BYTES) return text;
  const suffixBytes = Buffer.byteLength(TRUNCATED_DIAGNOSTIC_SUFFIX);
  return (
    Buffer.from(text)
      .subarray(0, MAX_GIT_ERROR_DETAIL_BYTES - suffixBytes)
      .toString("utf8") + TRUNCATED_DIAGNOSTIC_SUFFIX
  );
}

// Two lanes, so a user-initiated command (a stage, a commit) never waits out a
// long backlog of background refreshes. Interactive waiters are admitted
// first, FIFO within each lane, and `reservedInteractive` slots are kept off
// limits to background work: even a fully saturated background queue leaves an
// interactive command a free slot.
class Semaphore {
  constructor(max, { reservedInteractive = 0 } = {}) {
    this.max = max;
    this.backgroundMax = Math.max(1, max - reservedInteractive);
    this.activeInteractive = 0;
    this.activeBackground = 0;
    this.interactiveQueue = [];
    this.backgroundQueue = [];
  }

  get active() {
    return this.activeInteractive + this.activeBackground;
  }

  async acquire(priority = "background", signal) {
    if (signal?.aborted) throw abortError();
    const interactive = priority === "interactive";
    const belowLimit = interactive
      ? this.active < this.max
      : this.active < this.max && this.activeBackground < this.backgroundMax;
    if (belowLimit) {
      if (interactive) this.activeInteractive++;
      else this.activeBackground++;
      return;
    }
    const queue = interactive ? this.interactiveQueue : this.backgroundQueue;
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index === -1) return;
        queue.splice(index, 1);
        signal.removeEventListener("abort", waiter.onAbort);
        reject(abortError());
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      queue.push(waiter);
    });
  }

  release(priority = "background") {
    if (priority === "interactive") this.activeInteractive--;
    else this.activeBackground--;
    this.admit();
  }

  // Counts are incremented synchronously before each admitted waiter resolves,
  // so a concurrently arriving acquire() can never slip past the limits.
  admit() {
    while (this.interactiveQueue.length > 0 && this.active < this.max) {
      const waiter = this.interactiveQueue.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.activeInteractive++;
      waiter.resolve();
    }
    while (
      this.backgroundQueue.length > 0 &&
      this.active < this.max &&
      this.activeBackground < this.backgroundMax
    ) {
      const waiter = this.backgroundQueue.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.activeBackground++;
      waiter.resolve();
    }
  }

  async run(fn, priority = "background", signal) {
    await this.acquire(priority, signal);
    try {
      if (signal?.aborted) throw abortError();
      return await fn();
    } finally {
      this.release(priority);
    }
  }
}

// Process-wide limiter shared by every GitRunner instance, with one slot
// reserved for interactive commands.
const sharedGitLimiter = new Semaphore(DEFAULT_MAX_CONCURRENT_GIT, { reservedInteractive: 1 });

const COLOR_CONFIG = [
  "-c",
  "color.branch=false",
  "-c",
  "color.diff=false",
  "-c",
  "color.status=false",
  "-c",
  "color.ui=false",
];

// Repository operations are bound with command-line arguments instead of
// Git's repository-discovery environment. Remove variables that could redirect
// part of that binding while retaining object-directory overrides used by the
// diff provider (GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES).
const REPOSITORY_SELECTION_ENVIRONMENT_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
];
const REPOSITORY_ENVIRONMENT_VARIABLES = [
  ...REPOSITORY_SELECTION_ENVIRONMENT_VARIABLES,
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

function repositoryArguments(descriptor) {
  if (!descriptor) return [];
  const args = ["--git-dir", path.resolve(descriptor.gitDirectory)];
  if (descriptor.workingDirectory != null) {
    args.push("--work-tree", path.resolve(descriptor.workingDirectory));
  }
  return args;
}

class GitOperationError extends Error {
  constructor(command, result) {
    const stderr = String(result.stderr);
    const stdout = String(result.stdout);
    const detail = boundedErrorDetail(
      stderr.trim() || stdout.trim() || `exit code ${result.exitCode}`,
    );
    super(`Git ${command} failed: ${detail}`);
    this.name = "GitOperationError";
    this.code = "ERR_GIT_COMMAND_FAILED";
    this.command = command;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

class GitRunner {
  constructor({ execute, limiter = sharedGitLimiter, trustAllRepositories = false } = {}) {
    this.execute = execute || defaultGitExec;
    this.limiter = limiter;
    // When set, every command runs with `-c safe.directory=*` so Git trusts
    // repositories owned by another user account instead of refusing them with
    // its "dubious ownership" check. Controlled by `git.trustAllRepositories`.
    this.trustAllRepositories = trustAllRepositories;
  }

  async run(args, workingDirectory, options = {}) {
    const result = await this.runResult(args, workingDirectory, options);
    return result.stdout;
  }

  async executeResult(args, workingDirectory, options = {}, { includeColorConfig = true } = {}) {
    const priority = options.priority === "interactive" ? "interactive" : "background";
    const environment = {
      GIT_TERMINAL_PROMPT: options.allowPrompt ? "1" : "0",
      GIT_EDITOR: "true",
      LC_ALL: "C",
      // Background commands never take git's optional locks: a debounced
      // status refresh holding .git/index.lock would otherwise make a
      // concurrent user `git add` fail with "index.lock exists". The trade-off
      // (background statuses stop refreshing the index stat cache) is bounded,
      // because the interactive post-operation refresh still does.
      ...(priority === "background" && !options.allowPrompt ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
      ...options.env,
    };
    if (options.repositoryDescriptor) {
      const selectionVariables = new Set(
        REPOSITORY_SELECTION_ENVIRONMENT_VARIABLES.map((name) =>
          process.platform === "win32" ? name.toUpperCase() : name,
        ),
      );
      for (const name of Object.keys(environment)) {
        const canonicalName = process.platform === "win32" ? name.toUpperCase() : name;
        if (selectionVariables.has(canonicalName)) delete environment[name];
      }
    }
    const configArguments = [];
    if (this.trustAllRepositories) {
      configArguments.push("-c", "safe.directory=*");
    }
    for (const [key, value] of Object.entries(options.config || {})) {
      configArguments.push("-c", `${key}=${value}`);
    }
    const boundRepositoryArguments = repositoryArguments(options.repositoryDescriptor);
    const runExec = () =>
      this.execute(
        [
          ...(includeColorConfig ? COLOR_CONFIG : []),
          ...configArguments,
          ...boundRepositoryArguments,
          ...args,
        ],
        workingDirectory,
        {
          env: environment,
          unsetEnv: options.repositoryDescriptor ? REPOSITORY_ENVIRONMENT_VARIABLES : undefined,
          stdin: options.stdin,
          encoding: options.encoding,
          maxBuffer: options.maxBuffer,
          signal: options.signal,
          killSignal: options.killSignal,
        },
      );
    // Interactive/credential operations may block for a long time; keep them out
    // of the shared read budget so a hung prompt cannot starve status refreshes.
    if (options.signal?.aborted) throw abortError();
    return options.allowPrompt
      ? await runExec()
      : await this.limiter.run(runExec, priority, options.signal);
  }

  async runResult(args, workingDirectory, options = {}) {
    const result = await this.executeResult(args, workingDirectory, options);
    const allowedExitCodes = options.allowedExitCodes || [0];
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new GitOperationError(args[0], result);
    }
    return result;
  }

  runRawResult(args, workingDirectory, options = {}) {
    return this.executeResult(args, workingDirectory, options, { includeColorConfig: false });
  }
}

module.exports = GitRunner;
module.exports.GitOperationError = GitOperationError;
module.exports.Semaphore = Semaphore;
