const fs = require("fs/promises");
const path = require("path");

// Repository creation has no descriptor yet. Its destination is serialized by
// the registry and its command construction lives beside the worker backend.
module.exports = class GitWorkspaceOperations {
  constructor(runner) {
    this.runner = runner;
  }

  async initialize(directoryPath, options = {}) {
    await fs.mkdir(directoryPath, { recursive: true });
    const args = ["init"];
    if (options.initialBranch) args.push(`--initial-branch=${options.initialBranch}`);
    if (options.bare) args.push("--bare");
    args.push(".");
    return (await this.runner.runResult(args, directoryPath, options)).stdout;
  }

  async clone(remoteUrl, destinationPath, options = {}) {
    const parent = path.dirname(destinationPath);
    await fs.mkdir(parent, { recursive: true });
    const args = ["clone"];
    if (options.noLocal) args.push("--no-local");
    if (options.bare) args.push("--bare");
    if (options.recursive) args.push("--recursive");
    if (options.depth != null) args.push(`--depth=${options.depth}`);
    if (options.branch) args.push("--branch", options.branch);
    if (options.sourceRemoteName) args.push("--origin", options.sourceRemoteName);
    args.push("--", remoteUrl, destinationPath);
    return (await this.runner.runResult(args, parent, options)).stdout;
  }
};
