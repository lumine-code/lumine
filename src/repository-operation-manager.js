const path = require("path");
const { Disposable } = require("@lumine-code/event-kit");
const RepositoryOperations = require("./repository-operations");
const RepositoryOperationQueue = require("./repository-operation-queue");
const WorkspaceOperationQueue = require("./workspace-operation-queue");
const RepositoryResourceQueue = require("./repository-resource-queue");
const GitWorkflowPolicy = require("./git-workflow-policy");
const { OPERATION_OPTION_INDEX } = require("./git-operation-metadata");
const resolveRemoteTarget = require("./git-remote-target");
const { isRepositoryUnavailableError } = require("./git-error");
const GitOperationError = require("./git-operation-error");
const completeCleanup = require("./complete-cleanup");
const OPERATION_REFRESH_HINTS = new Set(["none", "status", "refs", "both"]);
const normalizePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// Owns providers, write turns, workflows, resource domains and operation outcomes.
// Registry remains the public repository identity/routing facade.
module.exports = class RepositoryOperationManager {
  #operationProviderRegistrations = [];
  constructor(registry, { confirm } = {}) {
    this.registry = registry;
    this.nextOperationId = 1;
    this.resourceQueue = new RepositoryResourceQueue();
    this.workflowPolicy = new GitWorkflowPolicy({ config: registry.config, confirm });
    this.workspaceOperationQueue = new WorkspaceOperationQueue({
      keyForPath: normalizePath,
      nextId: () => this.nextOperationId++,
      snapshot: (operation) => this.operationSnapshot(operation),
      emit: (event, operation) => {
        if (!this.destroyed) this.emitter.emit(event, operation);
      },
      execute: (name, args, operation) => this.executeWorkspaceOperation(name, args, operation),
    });
  }

  destroy() {
    this.#operationProviderRegistrations = [];
  }

  createQueue(entry) {
    const repository = entry.repository;
    return new RepositoryOperationQueue({
      repository,
      nextId: () => this.nextOperationId++,
      snapshot: (operation) => this.operationSnapshot(operation),
      emit: (event, operation) => {
        if (!this.destroyed) this.emitter.emit(event, operation);
      },
      acquire: () => {
        this.assertOperationEntry(entry);
        const token = Symbol("operation");
        entry.operationOwners.add(token);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          entry.operationOwners.delete(token);
          this.prune(entry);
        };
      },
      execute: (name, args) => this.executeRepositoryOperation(entry, name, args),
    });
  }

  get destroyed() {
    return this.registry.destroyed;
  }
  get entryByRepository() {
    return this.registry.entryByRepository;
  }
  get entriesById() {
    return this.registry.entriesById;
  }
  get project() {
    return this.registry.project;
  }
  get config() {
    return this.registry.config;
  }
  get notificationManager() {
    return this.registry.notificationManager;
  }
  get emitter() {
    return this.registry.emitter;
  }
  getForPath(...args) {
    return this.registry.getForPath(...args);
  }
  register(...args) {
    return this.registry.register(...args);
  }
  add(...args) {
    return this.registry.add(...args);
  }
  getRepositories(...args) {
    return this.registry.getRepositories(...args);
  }
  emitChange(...args) {
    return this.registry.emitChange(...args);
  }
  removeUnavailableEntry(...args) {
    return this.registry.removeUnavailableEntry(...args);
  }
  prune(...args) {
    return this.registry.prune(...args);
  }

  addOperationProvider(provider, { fallback = false } = {}) {
    if (this.destroyed) throw new Error("Cannot add a provider to a destroyed RepositoryRegistry");
    if (
      !provider ||
      (typeof provider.createRepositoryOperations !== "function" &&
        typeof provider.initializeRepository !== "function" &&
        typeof provider.cloneRepository !== "function" &&
        typeof provider.executeGit !== "function")
    ) {
      throw new TypeError(
        "Repository operation providers must implement repository, workspace, or Git transport operations",
      );
    }

    const registration = { provider };
    if (fallback) {
      this.#operationProviderRegistrations.push(registration);
    } else {
      this.#operationProviderRegistrations.unshift(registration);
    }

    const removeRegistration = (initialFailures = []) => {
      const message = initialFailures.length
        ? "Unable to roll back repository operation provider registration"
        : "Unable to remove the repository operation provider cleanly";
      const index = this.#operationProviderRegistrations.indexOf(registration);
      if (index < 0) {
        completeCleanup([], message, initialFailures);
        return;
      }
      this.#operationProviderRegistrations.splice(index, 1);
      const records = [];
      // Registrations of the same provider share implementations. Removing one
      // registration must preserve the records owned by the remaining ones.
      if (!this.hasOperationProvider(provider)) {
        for (const entry of this.entriesById.values()) {
          if (entry.operationImplementations.has(provider)) {
            records.push(entry.operationImplementations.get(provider));
            entry.operationImplementations.delete(provider);
          }
        }
      }
      completeCleanup(
        [
          ...records.map((record) => () => this.disposeOperationImplementation(record)),
          (collectError) => this.emitOperationProviderChange(collectError),
        ],
        message,
        initialFailures,
      );
    };
    const subscription = new Disposable(() => removeRegistration());
    try {
      this.emitOperationProviderChange();
    } catch (error) {
      removeRegistration([error]);
    }
    return subscription;
  }

  getOperations(repository) {
    return this.entryByRepository.get(repository)?.operations || null;
  }

  canPerformOperation(repository, operationName) {
    return this.findOperationImplementation(repository, operationName) != null;
  }

  getOperationCapabilities(repository) {
    const capabilities = new Set();
    for (const { provider } of this.#operationProviderRegistrations) {
      const record = this.getOperationImplementation(repository, provider);
      if (!record) continue;

      for (const operationName of RepositoryOperations.standardCapabilities) {
        if (this.operationImplementationSupports(record, operationName)) {
          capabilities.add(operationName);
        }
      }
      const customCapabilities = record.implementation.getCapabilities?.() || [];
      for (const operationName of customCapabilities) {
        if (this.operationImplementationSupports(record, operationName)) {
          capabilities.add(operationName);
        }
      }
    }
    return Object.freeze(Array.from(capabilities));
  }

  getPendingOperations(repository) {
    const entries = repository
      ? [this.entryByRepository.get(repository)].filter(Boolean)
      : Array.from(this.entriesById.values());
    const operations = entries.flatMap((entry) => entry.operationQueue.getPendingOperations());
    if (!repository) {
      operations.push(...this.workspaceOperationQueue.getPendingOperations());
    }
    return Object.freeze(operations);
  }

  getWorkspaceOperationCapabilities() {
    const capabilities = [];
    if (this.findWorkspaceOperationProvider("initialize")) capabilities.push("initialize");
    if (this.findWorkspaceOperationProvider("clone")) capabilities.push("clone");
    return Object.freeze(capabilities);
  }

  canPerformWorkspaceOperation(operationName) {
    return this.findWorkspaceOperationProvider(operationName) != null;
  }

  canExecuteGitCommands() {
    return this.findGitCommandProvider() != null;
  }

  async executeGit(args, workingDirectory, options) {
    if (this.destroyed) {
      throw new Error("Cannot execute Git with a destroyed RepositoryRegistry");
    }
    if (!Array.isArray(args)) {
      throw new TypeError("Git arguments must be an array");
    }

    if (!this.findGitCommandProvider()) {
      const error = new Error("No provider implements raw Git command execution");
      error.code = "ERR_GIT_EXECUTION_UNAVAILABLE";
      throw error;
    }
    options?.signal?.throwIfAborted();
    const repository = await this.registry.resolveForPath(workingDirectory || process.cwd(), {
      refresh: false,
    });
    options?.signal?.throwIfAborted();
    if (repository && this.canPerformOperation(repository, "executeGit")) {
      return this.performOperation(repository, "executeGit", [args, options]);
    }
    return this.workspaceOperationQueue.enqueue("executeGit", workingDirectory || process.cwd(), [
      args,
      workingDirectory,
      options,
    ]);
  }

  initialize(directoryPath, options) {
    return this.performWorkspaceOperation("initialize", directoryPath, [directoryPath, options]);
  }

  clone(remoteUrl, destinationPath, options) {
    return this.performWorkspaceOperation("clone", destinationPath, [
      remoteUrl,
      destinationPath,
      options,
    ]);
  }

  async registerCreatedRepository(directoryPath, operationName) {
    this.assertWorkspaceOperationAvailable();
    const registration = await this.add(directoryPath);
    this.assertWorkspaceOperationAvailable();
    if (registration) return registration.repository;

    const error = new Error(
      `Git ${operationName} completed, but no repository was found at: ${directoryPath}`,
    );
    error.code = "ERR_REPOSITORY_DISCOVERY_FAILED";
    error.operation = operationName;
    error.directoryPath = directoryPath;
    throw error;
  }

  performWorkspaceOperation(operationName, workingDirectory, args) {
    try {
      this.assertWorkspaceOperationAvailable();
      return this.workspaceOperationQueue.enqueue(operationName, workingDirectory, args);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  assertWorkspaceOperationAvailable() {
    if (this.destroyed) {
      throw new Error("Cannot run an operation on a destroyed RepositoryRegistry");
    }
  }

  async executeWorkspaceOperation(operationName, args, operation) {
    this.assertWorkspaceOperationAvailable();
    if (operationName === "executeGit") {
      const provider = this.findGitCommandProvider();
      if (!provider)
        throw Object.assign(new Error("No provider implements raw Git command execution"), {
          code: "ERR_GIT_EXECUTION_UNAVAILABLE",
        });
      const result = await provider.executeGit(...args);
      if (
        typeof result?.exitCode === "number" &&
        !(args[2]?.allowedExitCodes || [0]).includes(result.exitCode)
      )
        throw new GitOperationError(args[0][0], result);
      return result;
    }
    const provider = this.findWorkspaceOperationProvider(operationName);
    this.assertWorkspaceOperationAvailable();
    if (!provider) {
      throw Object.assign(
        new Error(`No provider implements repository operation: ${operationName}`),
        { code: "ERR_REPOSITORY_OPERATION_UNAVAILABLE", operation: operationName },
      );
    }
    const methodName = operationName === "initialize" ? "initializeRepository" : "cloneRepository";
    await provider[methodName](...args);
    this.assertWorkspaceOperationAvailable();
    const repository = await this.registerCreatedRepository(
      operation.workingDirectory,
      operationName,
    );
    this.assertWorkspaceOperationAvailable();
    return repository;
  }

  hasOperationProvider(provider) {
    return this.#operationProviderRegistrations.some(
      (registration) => registration.provider === provider,
    );
  }

  findWorkspaceOperationProvider(operationName) {
    const methodName =
      operationName === "initialize"
        ? "initializeRepository"
        : operationName === "clone"
          ? "cloneRepository"
          : null;
    if (!methodName) return null;
    return (
      this.#operationProviderRegistrations.find(
        ({ provider }) => typeof provider[methodName] === "function",
      )?.provider || null
    );
  }

  findGitCommandProvider() {
    return (
      this.#operationProviderRegistrations.find(
        ({ provider }) => typeof provider.executeGit === "function",
      )?.provider || null
    );
  }

  performOperation(repository, operationName, args = []) {
    if (typeof operationName !== "string" || operationName.length === 0) {
      return Promise.reject(new TypeError("Repository operation name must be a non-empty string"));
    }
    try {
      if (this.destroyed) this.assertOperationEntry(null, operationName);
      const entry = this.entryByRepository.get(repository) || this.register(repository);
      this.assertOperationEntry(entry, operationName);
      return entry.operationQueue.enqueue(operationName, args);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  performWorkflow(repository, name, callback, options = {}) {
    if (typeof name !== "string" || !name || typeof callback !== "function") {
      return Promise.reject(new TypeError("A workflow requires a name and callback"));
    }
    return this.performOperation(repository, `workflow:${name}`, [callback, options]);
  }

  performRemoteOperation(repository, name, options = {}) {
    if (!["fetch", "pull", "push"].includes(name))
      return Promise.reject(new TypeError("Unknown remote workflow"));
    return this.performWorkflow(
      repository,
      name,
      async (operations) => {
        const refs = await repository.refreshRefsSnapshot({
          signal: options.signal,
          priority: "interactive",
        });
        const target = resolveRemoteTarget(refs, name);
        return operations[name](target.remote, target.reference, {
          ...options,
          ...(name === "push" ? { setUpstream: target.setUpstream } : {}),
        });
      },
      { signal: options.signal },
    );
  }

  assertOperationEntry(entry, operationName) {
    if (
      this.destroyed ||
      !entry ||
      entry.removing ||
      this.entriesById.get(entry.id) !== entry ||
      entry.repository.isDestroyed?.()
    ) {
      throw Object.assign(new Error("Repository has been destroyed"), {
        code: "ERR_GIT_REPOSITORY_DESTROYED",
        operation: operationName,
      });
    }
  }

  executeRepositoryOperation(entry, operationName, args) {
    this.assertOperationEntry(entry, operationName);
    const repository = entry.repository;
    const key = normalizePath(
      repository.getCommonDirectory?.() || repository.getPath?.() || entry.workingDirectory,
    );
    return this.resourceQueue.run(key, () => {
      if (operationName.startsWith("workflow:"))
        return this.executeRepositoryWorkflow(entry, operationName, args);
      return this.invokeRepositoryOperation(entry, operationName, args, {}, true);
    });
  }

  async executeRepositoryWorkflow(entry, operationName, [callback, options = {}]) {
    this.assertOperationEntry(entry, operationName);
    options.signal?.throwIfAborted();
    if (options.expectedHead)
      await this.workflowPolicy.assertAllowed(entry.repository, operationName, [], options);
    for (const name of options.guards || []) {
      await this.workflowPolicy.assertAllowed(entry.repository, name, [], options);
    }
    const completedSteps = [];
    let accepting = true;
    let stepTail = Promise.resolve();
    let stepFailed = false;
    let stepFailure;
    let callbackFailed = false;
    let callbackFailure;
    let unknownFailure;
    const closedError = () =>
      Object.assign(new Error("The Git workflow has already closed."), {
        code: "ERR_GIT_WORKFLOW_CLOSED",
        outcome: "not-started",
        retriable: false,
      });
    const direct = {
      isAvailable: (name) => accepting && this.canPerformOperation(entry.repository, name),
      execute: (name, ...args) => {
        if (!accepting) {
          const rejected = Promise.reject(closedError());
          // A saved facade can be called from a detached continuation. It still
          // rejects for that caller without producing an unhandled rejection.
          void rejected.catch(() => {});
          return rejected;
        }
        const result = stepTail.then(() => {
          if (stepFailed) throw stepFailure;
          if (callbackFailed) throw callbackFailure;
          options.signal?.throwIfAborted();
          const index = OPERATION_OPTION_INDEX[name];
          if (index !== undefined)
            args[index] = { ...args[index], ...(options.signal ? { signal: options.signal } : {}) };
          return this.invokeRepositoryOperation(entry, name, args, { signal: options.signal });
        });
        // Attach handlers at submission time, including for fire-and-forget
        // calls. The settled tail serializes accepted steps and keeps the turn
        // alive until each backend and its provider cleanup has completed.
        stepTail = result.then(
          () => {
            completedSteps.push(name);
          },
          (error) => {
            if (!stepFailed) {
              stepFailed = true;
              stepFailure = error;
            }
            if (error?.outcome === "unknown") unknownFailure ||= error;
          },
        );
        return result;
      },
    };
    for (const name of RepositoryOperations.standardCapabilities) {
      direct[name] = (...args) => direct.execute(name, ...args);
    }
    try {
      let result;
      try {
        result = await callback(Object.freeze(direct));
      } catch (error) {
        callbackFailed = true;
        callbackFailure = error;
      } finally {
        accepting = false;
      }
      await stepTail;
      if (!callbackFailed && !stepFailed) return result;
      const error = unknownFailure || (callbackFailed ? callbackFailure : stepFailure);
      if (completedSteps.length === 0 || error?.outcome === "unknown") throw error;
      throw Object.assign(
        new Error(`Git ${operationName.slice(9)} stopped after ${completedSteps.join(", ")}.`, {
          cause: error,
        }),
        {
          code: "ERR_GIT_WORKFLOW_PARTIAL",
          outcome: "partial",
          retriable: false,
          completedSteps: Object.freeze(completedSteps.slice()),
        },
      );
    } finally {
      try {
        await this.refreshRepositoryAfterOperation(entry.repository, options.refresh || "both");
      } catch (error) {
        this.reportRefreshFailure(entry.repository, error);
      }
    }
  }

  async invokeRepositoryOperation(
    entry,
    operationName,
    args,
    workflowOptions = {},
    refresh = false,
  ) {
    const repository = entry.repository;
    const failures = [];
    let result, record;
    let acquired = false;
    try {
      this.assertOperationEntry(entry, operationName);
      const optionIndex = OPERATION_OPTION_INDEX[operationName];
      if (
        operationName === "pull" &&
        !Object.hasOwn(args[optionIndex] || {}, "rebase") &&
        !args[optionIndex]?.ffOnly
      ) {
        args = args.slice();
        args[optionIndex] = {
          ...args[optionIndex],
          rebase: this.config?.get("git.pullRebase") === true,
        };
      }
      args[optionIndex]?.signal?.throwIfAborted();
      if (this.workflowPolicy.requiresCheck(operationName, args, workflowOptions)) {
        await this.workflowPolicy.assertAllowed(repository, operationName, args, workflowOptions);
      }
      record = this.findOperationImplementation(repository, operationName);
      this.assertOperationEntry(entry, operationName);
      if (!record) {
        throw Object.assign(
          new Error(`No provider implements repository operation: ${operationName}`),
          { code: "ERR_REPOSITORY_OPERATION_UNAVAILABLE", operation: operationName },
        );
      }
      record.activeOperations++;
      acquired = true;
      result = await record.implementation[operationName](...args);
      if (
        operationName === "executeGit" &&
        typeof result?.exitCode === "number" &&
        !(args[1]?.allowedExitCodes || [0]).includes(result.exitCode)
      )
        throw new GitOperationError(args[0][0], result);
    } catch (error) {
      failures.push(error);
      if (isRepositoryUnavailableError(error)) {
        try {
          if (typeof repository.signalRepositoryUnavailable === "function") {
            repository.signalRepositoryUnavailable(error);
          } else {
            this.removeUnavailableEntry(entry);
          }
        } catch (unavailableError) {
          failures.push(unavailableError);
        }
      }
    }
    if (acquired && refresh) {
      try {
        await this.refreshRepositoryAfterOperation(
          repository,
          this.operationRefreshHint(record.implementation, operationName, args),
        );
      } catch (error) {
        this.reportRefreshFailure(repository, error);
      }
    }
    if (acquired) {
      record.activeOperations--;
      if (record.pendingDisposal && record.activeOperations === 0) {
        try {
          this.disposeOperationImplementation(record);
        } catch (error) {
          if (failures.length) failures.push(error);
          else this.reportRefreshFailure(repository, error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Repository operation and its cleanup failed", {
        cause: failures[0],
      });
    }
    return result;
  }

  operationSnapshot(operation) {
    return Object.freeze({
      id: operation.id,
      repository: operation.repository,
      name: operation.name,
      status: operation.status,
      workingDirectory: operation.workingDirectory || null,
      queuedAt: operation.queuedAt,
      startedAt: operation.startedAt,
    });
  }

  findOperationImplementation(repository, operationName) {
    for (const { provider } of this.#operationProviderRegistrations.slice()) {
      const record = this.getOperationImplementation(repository, provider);
      if (
        record &&
        this.operationImplementationSupports(record, operationName) &&
        !record.disposed &&
        this.hasOperationProvider(provider) &&
        this.entryByRepository.get(repository)?.operationImplementations.get(provider) === record
      )
        return record;
    }
    return null;
  }

  operationImplementationSupports(record, operationName) {
    if (typeof record.implementation[operationName] !== "function") return false;
    if (RepositoryOperations.standardCapabilities.includes(operationName)) return true;
    return (record.implementation.getCapabilities?.() || []).includes(operationName);
  }

  getOperationImplementation(repository, provider) {
    const entry = this.entryByRepository.get(repository);
    if (
      !entry ||
      entry.removing ||
      this.entriesById.get(entry.id) !== entry ||
      repository.isDestroyed?.() ||
      !this.hasOperationProvider(provider)
    )
      return null;
    if (entry.operationImplementations.has(provider)) {
      return entry.operationImplementations.get(provider);
    }
    if (typeof provider.createRepositoryOperations !== "function") {
      entry.operationImplementations.set(provider, null);
      return null;
    }

    const implementation = provider.createRepositoryOperations({
      repository,
      workingDirectory: entry.workingDirectory,
      gitDirectory: repository.getPath?.() || null,
    });
    const record = implementation
      ? { implementation, activeOperations: 0, pendingDisposal: false, disposed: false }
      : null;
    // A synchronous factory can remove its provider or repository. Its returned
    // implementation must not escape the registration that owned its creation.
    if (
      this.destroyed ||
      entry.removing ||
      this.entriesById.get(entry.id) !== entry ||
      repository.isDestroyed?.() ||
      !this.hasOperationProvider(provider)
    ) {
      this.disposeOperationImplementation(record);
      return null;
    }
    entry.operationImplementations.set(provider, record);
    return record;
  }

  disposeOperationImplementation(record) {
    if (!record || record.disposed) return;
    if (record.activeOperations > 0) {
      record.pendingDisposal = true;
    } else {
      record.disposed = true;
      record.pendingDisposal = false;
      record.implementation.destroy?.();
    }
  }

  disposeOperationImplementations(entry) {
    const records = [...entry.operationImplementations.values()];
    entry.operationImplementations.clear();
    const failures = [];
    for (const record of records) {
      try {
        this.disposeOperationImplementation(record);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Unable to dispose repository operation implementations", {
        cause: failures[0],
      });
    }
  }

  operationRefreshHint(implementation, operationName, args) {
    if (typeof implementation?.getOperationRefreshHint !== "function") return "both";
    try {
      const hint = implementation.getOperationRefreshHint(operationName, args);
      return OPERATION_REFRESH_HINTS.has(hint) ? hint : "both";
    } catch {
      return "both";
    }
  }

  async refreshRepositoryAfterOperation(repository, hint = "both", { peers = true } = {}) {
    if (hint === "none" || repository.isDestroyed?.()) return;
    if (peers && (hint === "refs" || hint === "both")) {
      const commonDirectory = repository.getCommonDirectory?.() || repository.getPath?.();
      if (commonDirectory) {
        const domain = normalizePath(commonDirectory);
        const related = this.getRepositories().filter(
          (other) =>
            other !== repository &&
            normalizePath(other.getCommonDirectory?.() || other.getPath?.()) === domain,
        );
        await Promise.all(
          related.map((other) =>
            this.refreshRepositoryAfterOperation(other, hint, { peers: false }),
          ),
        );
      }
    }
    let statusRefresh = null;
    if (
      (hint === "status" || hint === "both") &&
      repository.refreshStatusSnapshot &&
      repository.getStatusSnapshot?.().initialized
    ) {
      // This refresh gates the operation's promise, so it rides the
      // interactive lane along with the operation itself.
      try {
        statusRefresh = Promise.resolve(
          repository.refreshStatusSnapshot({ priority: "interactive" }),
        ).catch((error) => this.reportRefreshFailure(repository, error));
      } catch (error) {
        this.reportRefreshFailure(repository, error);
      }
    }

    // Preserve combined snapshot ordering while waiting for both requested
    // domains. A completed operation exposes fresh initialized snapshots.
    if (statusRefresh) await statusRefresh;

    // Unobserved snapshots stay lazy; initialized refs participate in readiness.
    if (
      (hint === "refs" || hint === "both") &&
      repository.refreshRefsSnapshot &&
      repository.getRefsSnapshot?.().initialized
    ) {
      let refsRefresh;
      try {
        refsRefresh = repository.refreshRefsSnapshot();
      } catch (error) {
        this.reportRefreshFailure(repository, error);
      }
      await Promise.resolve(refsRefresh).catch((error) =>
        this.reportRefreshFailure(repository, error),
      );
    }
  }

  reportRefreshFailure(repository, error) {
    try {
      if (repository.isDestroyed?.()) return;
      // GitRepository owns the once-per-repository reporting policy. Route
      // post-operation failures through the same gate so a combined status+refs
      // refresh cannot produce duplicate warnings.
      if (typeof repository.reportBackgroundSnapshotError === "function") {
        repository.reportBackgroundSnapshotError(error);
        return;
      }
      // The Git command has already succeeded. Never report it as failed (and
      // invite a dangerous retry) merely because the read cache did not refresh.
      this.notificationManager?.addWarning("Repository refresh failed after Git operation", {
        detail: error.message,
        dismissable: true,
      });
    } catch (reportError) {
      console.error("Unable to report a repository refresh failure", error, reportError);
    }
  }

  emitOperationProviderChange(collectError) {
    if (this.destroyed || this.entriesById.size === 0) return;
    const repositories = this.getRepositories();
    this.emitChange(
      {
        added: [],
        removed: [],
        updated: repositories,
        rootsAdded: [],
        rootsRemoved: [],
        routingChangedPrefixes: [],
      },
      collectError,
    );
  }
};
