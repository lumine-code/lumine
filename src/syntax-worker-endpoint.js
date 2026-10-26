function cancelled() {
  const error = new Error("Syntax request was cancelled");
  error.name = "AbortError";
  return error;
}

// Shared by the browser bootstrap and Node transport tests. Every stream has
// at most one unacknowledged packet, including while a caller is cancelling it.
class SyntaxWorkerEndpoint {
  constructor({ send, dispatch, control = () => {} }) {
    this.send = send;
    this.dispatch = dispatch;
    this.control = control;
    this.jobs = new Map();
    this.cancelledBeforeStart = new Set();
    this.highestRequest = 0;
  }

  receive(message) {
    if (this.closed) return;
    if (message.type === "control") {
      this.control(message);
      return;
    }
    const job = this.jobs.get(message.id);
    if (message.type === "cancel") {
      if (job) {
        job.controller.abort(cancelled());
        job.waiting?.reject(job.controller.signal.reason);
        job.waiting = null;
      } else if (message.id > this.highestRequest) this.cancelledBeforeStart.add(message.id);
      return;
    }
    if (message.type === "ack") {
      if (job?.waiting && job.waiting.sequence === message.sequence) {
        job.waiting.resolve(message.value);
        job.waiting = null;
      }
      return;
    }
    if (message.type !== "request") return;
    this.highestRequest = Math.max(this.highestRequest, message.id);
    if (this.cancelledBeforeStart.delete(message.id)) return;
    if (this.jobs.has(message.id)) return;
    const controller = new AbortController();
    const next = { controller, sequence: 0, waiting: null };
    this.jobs.set(message.id, next);
    void this.execute(message, next);
  }

  async execute(message, job) {
    const signal = job.controller.signal;
    const emit = async (value, transfer = []) => {
      signal.throwIfAborted();
      if (job.waiting) throw new Error("Syntax streams must await each packet");
      const sequence = job.sequence++;
      const promise = new Promise((resolve, reject) => {
        job.waiting = { sequence, resolve, reject };
      });
      try {
        this.send({ type: "chunk", id: message.id, sequence, value }, transfer);
      } catch (error) {
        job.waiting.reject(error);
        job.waiting = null;
      }
      const response = await promise;
      signal.throwIfAborted();
      return response;
    };
    try {
      const value = await this.dispatch(message.operation, message.data, { signal, emit });
      signal.throwIfAborted();
      this.send({ type: "result", id: message.id, value });
    } catch (error) {
      this.send({
        type: "error",
        id: message.id,
        error: {
          name: error.name ?? "Error",
          message: String(error.message ?? error),
          stack: error.stack,
          code: error.code,
          reason: error.reason,
        },
      });
    } finally {
      // Dispatch may finish through a session-level cancellation while emit
      // is still awaiting an acknowledgement. Release that transport wait.
      job.controller.abort(cancelled());
      job.waiting?.reject(job.controller.signal.reason);
      job.waiting = null;
      this.jobs.delete(message.id);
    }
  }

  close() {
    this.closed = true;
    for (const job of this.jobs.values()) {
      job.controller.abort(cancelled());
      job.waiting?.reject(job.controller.signal.reason);
      job.waiting = null;
    }
    this.cancelledBeforeStart.clear();
    this.jobs.clear();
  }
}

module.exports = SyntaxWorkerEndpoint;
