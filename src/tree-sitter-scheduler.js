function aborted() {
  const error = new Error("Parsing was cancelled");
  error.name = "AbortError";
  return error;
}

// All documents and injection layers share one synchronous allowance per
// renderer task. Resumable WASM work yields between bounded slices.
class TreeSitterScheduler {
  constructor(concurrency = 2) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new RangeError("Invalid parser concurrency");
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.turnDeadline = null;
  }

  deadline(timeoutMicros) {
    const deadline = performance.now() + timeoutMicros / 1000;
    if (this.turnDeadline === null) {
      this.turnDeadline = deadline;
      setImmediate(() => {
        this.turnDeadline = null;
      });
    } else {
      this.turnDeadline = Math.min(this.turnDeadline, deadline);
    }
    return this.turnDeadline;
  }

  hasBudget(timeoutMicros) {
    return performance.now() < this.deadline(timeoutMicros);
  }

  run(operation, { signal, priority = () => 0 } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const job = { operation, signal, priority, resolve, reject, started: false };
      job.cancel = () => {
        if (job.started) return;
        const index = this.queue.indexOf(job);
        if (index !== -1) this.queue.splice(index, 1);
        signal.removeEventListener("abort", job.cancel);
        reject(aborted());
      };
      signal?.addEventListener("abort", job.cancel, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  drain() {
    while (this.active < this.concurrency && this.queue.length) {
      this.queue.sort((a, b) => a.priority() - b.priority());
      const job = this.queue.shift();
      job.started = true;
      job.signal?.removeEventListener("abort", job.cancel);
      if (job.signal?.aborted) {
        job.reject(aborted());
        continue;
      }
      this.active++;
      Promise.resolve()
        .then(() => {
          if (job.signal?.aborted) throw aborted();
          return job.operation();
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}

module.exports = new TreeSitterScheduler();
module.exports.TreeSitterScheduler = TreeSitterScheduler;
