const RepositoryOperationQueue = require("./repository-operation-queue");

// Workspace operations own a destination path rather than an existing
// repository. Each path uses the same lifecycle engine as repository writes.
module.exports = class WorkspaceOperationQueue {
  #keyForPath;
  #nextId;
  #execute;
  #emit;
  #snapshot;
  #queues = new Map();

  constructor({ keyForPath, nextId, execute, emit, snapshot }) {
    this.#keyForPath = keyForPath;
    this.#nextId = nextId;
    this.#execute = execute;
    this.#emit = emit;
    this.#snapshot = snapshot;
  }

  enqueue(name, workingDirectory, args = []) {
    let key;
    try {
      key = this.#keyForPath(workingDirectory);
    } catch (error) {
      return Promise.reject(error);
    }
    let queue = this.#queues.get(key);
    if (!queue) {
      queue = new RepositoryOperationQueue({
        repository: null,
        nextId: this.#nextId,
        execute: this.#execute,
        emit: this.#emit,
        snapshot: this.#snapshot,
      });
      // Queued observers can enqueue recursively. They must see this engine
      // and its reserved tail instead of creating a second queue for the path.
      this.#queues.set(key, queue);
    }
    const result = queue.enqueue(name, args, { workingDirectory });
    const removeIdleQueue = () => {
      if (this.#queues.get(key) === queue && queue.isIdle()) this.#queues.delete(key);
    };
    // Pending state disappears before finish observers and asynchronous release
    // complete. Evict only after every operation in this engine is fully done.
    void result.then(removeIdleQueue, removeIdleQueue);
    return result;
  }

  getPendingOperations() {
    return Object.freeze(
      [...this.#queues.values()]
        .flatMap((queue) => queue.getPendingOperations())
        .sort((first, second) => first.id - second.id),
    );
  }
};
