const fs = require("fs");
const path = require("path");
const GitHostClient = require("./git-host-client");
const GitOperationError = require("./git-operation-error");
const {
  OPERATION_OPTION_INDEX,
  SIGNING_OPERATIONS,
  AUTH_OPERATIONS,
  operationRefreshHint,
} = require("./git-operation-metadata");

// The renderer owns prompts and transport. Git argv and filesystem work are
// implemented once in the worker's GitRepositoryOperations.
class RemoteGitOperations {
  constructor(provider, descriptor) {
    this.provider = provider;
    this.descriptor = descriptor;
  }

  getOperationRefreshHint(name, args) {
    if (name === "executeGit" && args[1]?.readOnly) return "none";
    return operationRefreshHint(name, args, this.descriptor.workingDirectory);
  }
}

for (const [name, optionIndex] of Object.entries(OPERATION_OPTION_INDEX)) {
  RemoteGitOperations.prototype[name] = async function (...args) {
    const options = args[optionIndex] || {};
    return this.provider.withPreparedOptions(name, this.descriptor, options, (prepared) => {
      args[optionIndex] = prepared;
      return this.provider.performOperation(this.descriptor, name, args);
    });
  };
}

module.exports = class GitRepositoryOperationProvider {
  constructor({ exec, authBroker, gitHostClient = new GitHostClient() } = {}) {
    this.client = gitHostClient;
    this.authBroker = authBroker || null;
    this.exec = exec || gitHostClient.exec.bind(gitHostClient);
    // Argument-vector specs inject a transport into the same worker backend;
    // production never loads the backend into the renderer.
    if (exec) {
      const GitRepositoryOperations = require("./git-repository-operations");
      const GitWorkspaceOperations = require("./git-workspace-operations");
      const backend = {
        runRepository: async (args, descriptor, options) =>
          (await exec(args, descriptor.workingDirectory, options, false)).stdout,
        runRepositoryRaw: (args, descriptor, options) =>
          exec(args, descriptor.workingDirectory, options, true),
        runRepositoryToFile: async (args, descriptor, destination, options) => {
          const result = await exec(
            args,
            descriptor.workingDirectory,
            { ...options, encoding: "buffer" },
            false,
          );
          await fs.promises.writeFile(destination, result.stdout);
          return result;
        },
      };
      this.performOperation = (descriptor, name, args) =>
        new GitRepositoryOperations(backend, descriptor)[name](...args);
      this.workspaceOperations = new GitWorkspaceOperations({
        runResult: (args, workingDirectory, options) =>
          exec(args, workingDirectory, options, false),
      });
    } else {
      this.performOperation = gitHostClient.performOperation.bind(gitHostClient);
    }
  }

  async withPreparedOptions(name, descriptor, options, callback) {
    let prepared = { priority: "interactive", ...options };
    if (!this.authBroker) return callback(prepared);
    const auth = !options.readOnly && (AUTH_OPERATIONS.has(name) || name === "pull");
    const signing =
      !options.readOnly &&
      (SIGNING_OPERATIONS.has(name) || name === "pull" || name === "executeGit");
    const promptSigning = signing && globalThis.lumine?.config?.get("git.promptForGpgPassphrase");
    if (!auth && !promptSigning) return callback(prepared);
    const workingDirectory = descriptor.workingDirectory || descriptor.gitDirectory;
    const session = await this.authBroker.createSession({
      workingDirectory,
      signal: options.signal,
      signing: Boolean(promptSigning),
    });
    prepared = {
      ...prepared,
      env: { ...prepared.env, ...session.env },
      ...(promptSigning
        ? { allowPrompt: true, config: { ...prepared.config, ...session.config } }
        : {}),
    };
    try {
      return await callback(prepared);
    } finally {
      session.dispose();
    }
  }

  async executeGit(args, workingDirectory, options = {}) {
    return this.withPreparedOptions(
      "executeGit",
      { workingDirectory },
      { allowedExitCodes: [0], ...options },
      async (prepared) => {
        const result = await this.exec(args, workingDirectory, prepared, true);
        if (
          typeof result.exitCode === "number" &&
          !prepared.allowedExitCodes.includes(result.exitCode)
        )
          throw new GitOperationError(args[0], result);
        return result;
      },
    );
  }

  createRepositoryOperations({ repository }) {
    const descriptor = repository?.getHostDescriptor?.();
    if (!descriptor)
      throw new TypeError("Repository operations require an exact repository descriptor");
    return new RemoteGitOperations(this, descriptor);
  }

  initializeRepository(directoryPath, options = {}) {
    const prepared = { priority: "interactive", ...options };
    return this.workspaceOperations
      ? this.workspaceOperations.initialize(directoryPath, prepared)
      : this.client.initializeRepository(directoryPath, prepared);
  }

  async cloneRepository(remoteUrl, destinationPath, options = {}) {
    return this.withPreparedOptions(
      "fetch",
      { workingDirectory: path.dirname(destinationPath) },
      options,
      (prepared) =>
        this.workspaceOperations
          ? this.workspaceOperations.clone(remoteUrl, destinationPath, prepared)
          : this.client.cloneRepository(remoteUrl, destinationPath, prepared),
    );
  }
};
