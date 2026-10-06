// Serializes operations for one repository or workspace destination.
// Registry callbacks own provider selection, Git execution, cache refresh and
// any repository retention needed by the operation.
module.exports = class RepositoryOperationQueue {
  #repository;
  #nextId;
  #acquire;
  #execute;
  #emit;
  #snapshot;
  #tail = Promise.resolve();
  #pending = new Map();
  #outstanding = 0;

  constructor({ repository, nextId, acquire = () => {}, execute, emit, snapshot }) {
    this.#repository = repository;
    this.#nextId = nextId;
    this.#acquire = acquire;
    this.#execute = execute;
    this.#emit = emit;
    this.#snapshot = snapshot;
  }

  getPendingOperations() {
    return Object.freeze(
      [...this.#pending.values()].map((operation) => this.#takeSnapshot(operation)),
    );
  }

  isIdle() {
    return this.#outstanding === 0;
  }

  enqueue(name, args = [], { workingDirectory } = {}) {
    if (typeof name !== "string" || name.length === 0) {
      return Promise.reject(new TypeError("Repository operation name must be a non-empty string"));
    }

    let operation, release;
    try {
      operation = {
        id: this.#nextId(),
        repository: this.#repository,
        workingDirectory,
        name,
        status: "queued",
        queuedAt: Date.now(),
        startedAt: null,
      };
      release = this.#acquire();
    } catch (error) {
      return Promise.reject(error);
    }

    let resolveResult, rejectResult, completeTurn;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const completion = new Promise((resolve) => (completeTurn = resolve));
    const previous = this.#tail;
    // Reserve the slot before synchronous observers can enqueue another write.
    // Its caller can fail promptly, but successors must still wait for every
    // predecessor even when this slot never reaches execution.
    this.#tail = previous.then(() => completion);
    this.#outstanding++;
    this.#pending.set(operation.id, operation);
    const settle = { release, resolveResult, rejectResult, completeTurn };

    try {
      this.#emit("did-queue-operation", this.#takeSnapshot(operation));
    } catch (error) {
      void this.#complete(operation, undefined, true, error, settle);
      return result;
    }

    void previous.then(() => this.#run(operation, args, settle));
    return result;
  }

  #takeSnapshot(operation) {
    // A callback may return the record itself; observers must never be able to
    // mutate the queue's own status or identity through that snapshot.
    return Object.freeze({ ...this.#snapshot(operation) });
  }

  async #run(operation, args, settle) {
    let value, primaryError;
    let failed = false;
    try {
      operation.status = "running";
      operation.startedAt = Date.now();
      this.#emit("did-start-operation", this.#takeSnapshot(operation));
      value = await this.#execute(operation.name, args, operation);
    } catch (error) {
      failed = true;
      primaryError = error;
    }
    await this.#complete(operation, value, failed, primaryError, settle);
  }

  async #complete(operation, value, failed, primaryError, settle) {
    const failures = failed ? [primaryError] : [];
    this.#pending.delete(operation.id);
    operation.status = failed ? "failed" : "succeeded";
    try {
      this.#emit(
        "did-finish-operation",
        Object.freeze({
          ...this.#takeSnapshot(operation),
          status: operation.status,
          finishedAt: Date.now(),
          error: failed ? primaryError : null,
        }),
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      // Retention includes completion observers: the repository cannot disappear
      // while they inspect the operation's result.
      await settle.release?.();
    } catch (error) {
      failures.push(error);
    } finally {
      this.#outstanding--;
      settle.completeTurn();
    }

    if (failures.length === 0) {
      settle.resolveResult(value);
    } else if (failures.length === 1) {
      settle.rejectResult(failures[0]);
    } else {
      settle.rejectResult(
        new AggregateError(failures, "Repository operation and its completion failed", {
          cause: failures[0],
        }),
      );
    }
  }
};
