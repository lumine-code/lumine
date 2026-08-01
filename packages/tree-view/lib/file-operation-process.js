const ChildProcess = require("child_process");
const path = require("path");

const IDLE_SHUTDOWN_DELAY = 30_000;

function notify(listener, label, payload) {
  try {
    listener?.(payload);
  } catch (error) {
    console.error(`File operation ${label} listener failed`, error);
  }
}

// Serializes disk-heavy work through a lazily-created child. Keeping the child
// briefly after completion amortizes process startup across multi-entry pastes
// without paying for an idle process throughout the editor session.
module.exports = class FileOperationProcess {
  constructor({ onDidStart, onDidProgress, onDidFinish, onDidChange, onConflict } = {}) {
    this.onDidStart = onDidStart;
    this.onDidProgress = onDidProgress;
    this.onDidFinish = onDidFinish;
    this.onDidChange = onDidChange;
    this.onConflict = onConflict;
    this.queue = [];
    this.nextJobId = 1;
    this.destroyed = false;
  }

  run(operation, sourcePath, destinationPath) {
    if (this.destroyed) {
      return Promise.reject(new Error("The file operation process has been destroyed."));
    }

    const id = this.nextJobId++;
    const promise = new Promise((resolve, reject) => {
      this.queue.push({
        id,
        operation,
        sourcePath,
        destinationPath,
        resolve,
        reject,
      });
      this.pump();
      this.didChange();
    });
    promise.operationId = id;
    return promise;
  }

  getOperations() {
    const summarize = (job, state) => ({
      id: job.id,
      operation: job.operation,
      sourcePath: job.sourcePath,
      destinationPath: job.destinationPath,
      phase: job.phase,
      entries: job.entries,
      bytesTotal: job.bytesTotal,
      cancelRequested: job.cancelRequested === true,
      state,
    });
    return [
      ...(this.current ? [summarize(this.current, "running")] : []),
      ...this.queue.map((job) => summarize(job, "queued")),
    ];
  }

  cancel(jobId) {
    const queuedIndex = this.queue.findIndex((job) => job.id === jobId);
    if (queuedIndex !== -1) {
      const [job] = this.queue.splice(queuedIndex, 1);
      job.resolve({ cancelled: true });
      this.didChange();
      return true;
    }

    if (this.current?.id !== jobId || this.current.cancelRequested) return false;
    this.current.cancelRequested = true;
    this.current.phase = "cancelling";
    notify(this.onDidProgress, "progress", { ...this.current });
    this.didChange();
    try {
      this.childProcess?.send({ type: "cancel", jobId });
    } catch (error) {
      this.finishCurrent(error);
    }
    return true;
  }

  didChange() {
    notify(this.onDidChange, "change", this.getOperations());
  }

  pump() {
    if (this.current || this.destroyed) return;

    const job = this.queue.shift();
    if (!job) {
      this.scheduleIdleShutdown();
      return;
    }

    clearTimeout(this.idleShutdownTimer);
    this.idleShutdownTimer = null;
    this.current = job;
    notify(this.onDidStart, "start", job);
    this.didChange();

    try {
      const child = this.getChildProcess();
      child.send({
        type: "run",
        jobId: job.id,
        operation: job.operation,
        sourcePath: job.sourcePath,
        destinationPath: job.destinationPath,
      });
      if (job.cancelRequested) child.send({ type: "cancel", jobId: job.id });
    } catch (error) {
      this.finishCurrent(error);
    }
  }

  getChildProcess() {
    if (this.childProcess?.connected) return this.childProcess;

    const workerPath = path.join(__dirname, "file-operation-worker.js");
    const child = ChildProcess.fork(workerPath, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.childProcess = child;
    child.on("message", (message) => this.handleMessage(child, message));
    child.on("error", (error) => this.handleChildFailure(child, error));
    child.on("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      this.handleChildFailure(child, new Error(`File operation process stopped (${detail}).`));
    });
    return child;
  }

  handleMessage(child, message) {
    if (child !== this.childProcess || message?.jobId !== this.current?.id) return;

    switch (message.type) {
      case "progress":
        Object.assign(this.current, message.progress);
        if (this.current.cancelRequested) this.current.phase = "cancelling";
        notify(this.onDidProgress, "progress", { ...this.current });
        break;
      case "conflict":
        this.resolveConflict(child, message);
        break;
      case "complete":
        this.finishCurrent(null, message.result);
        break;
      case "error":
        this.finishCurrent(this.deserializeError(message.error));
        break;
    }
  }

  resolveConflict(child, message) {
    let resolution = "cancel";
    try {
      resolution = this.onConflict?.(message.conflict) ?? resolution;
    } catch (error) {
      console.error("Unable to resolve file operation conflict", error);
    }

    if (!["replace", "skip", "cancel"].includes(resolution)) resolution = "cancel";
    try {
      child.send({
        type: "resolve-conflict",
        jobId: message.jobId,
        conflictId: message.conflictId,
        resolution,
      });
    } catch (error) {
      this.finishCurrent(error);
    }
  }

  deserializeError(serialized = {}) {
    const error = new Error(serialized.message || "File operation failed.");
    if (serialized.code) error.code = serialized.code;
    if (serialized.stack) error.stack = serialized.stack;
    return error;
  }

  finishCurrent(error, result) {
    const job = this.current;
    if (!job) return;

    this.current = null;
    notify(this.onDidFinish, "finish", { ...job, error, result });
    if (error) {
      job.reject(error);
    } else {
      job.resolve(result);
    }
    this.pump();
    this.didChange();
  }

  handleChildFailure(child, error) {
    if (child !== this.childProcess) return;

    child.removeAllListeners();
    this.childProcess = null;
    if (child.exitCode == null && child.signalCode == null) child.kill();
    if (this.current) this.finishCurrent(error);
  }

  scheduleIdleShutdown() {
    if (!this.childProcess || this.idleShutdownTimer) return;
    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = null;
      this.stopChildProcess();
    }, IDLE_SHUTDOWN_DELAY);
  }

  stopChildProcess() {
    const child = this.childProcess;
    if (!child) return;

    this.childProcess = null;
    child.removeAllListeners();
    child.kill();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.idleShutdownTimer);
    this.idleShutdownTimer = null;

    const error = new Error("The file operation was cancelled because tree-view closed.");
    if (this.current) {
      const job = this.current;
      this.current = null;
      notify(this.onDidFinish, "finish", { ...job, error });
      job.reject(error);
    }
    for (const job of this.queue.splice(0)) job.reject(error);
    this.stopChildProcess();
  }
};
