function aborted() {
  const error = new Error("Parsing was cancelled");
  error.name = "AbortError";
  return error;
}

// One renderer-wide budget leaves capacity in libuv for filesystem work.
// A caller supplies a lazily evaluated priority and owns its cancellation.
class TreeSitterScheduler {
  constructor(concurrency = 2) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new RangeError("Invalid parser concurrency");
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
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
