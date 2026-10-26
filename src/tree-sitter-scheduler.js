function aborted() {
  const error = new Error("Parsing was cancelled");
  error.name = "AbortError";
  return error;
}

// All documents and injection layers share one synchronous allowance per
// renderer task. Resumable WASM work yields between bounded slices.
class TreeSitterScheduler {
  constructor(
    concurrency = 2,
    {
      now = () => performance.now(),
      defer = setImmediate,
      maxCallbacksPerTurn = 8,
      agingMs = 100,
    } = {},
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new RangeError("Invalid parser concurrency");
    if (!Number.isSafeInteger(maxCallbacksPerTurn) || maxCallbacksPerTurn < 1)
      throw new RangeError("Invalid parser callback limit");
    if (!Number.isFinite(agingMs) || agingMs < 0)
      throw new RangeError("Invalid parser aging interval");
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.turnDeadline = null;
    this.now = now;
    this.defer = defer;
    this.maxCallbacksPerTurn = maxCallbacksPerTurn;
    this.agingMs = agingMs;
    this.slices = [];
    this.sliceDrainScheduled = false;
    this.drainingSlices = false;
  }

  deadline(timeoutMicros) {
    const deadline = this.now() + timeoutMicros / 1000;
    if (this.turnDeadline === null) {
      this.turnDeadline = deadline;
      this.defer(() => {
        this.turnDeadline = null;
      });
    } else {
      this.turnDeadline = Math.min(this.turnDeadline, deadline);
    }
    return this.turnDeadline;
  }

  hasBudget(timeoutMicros) {
    return this.now() < this.deadline(timeoutMicros);
  }

  // A callback performs one synchronous, resumable step and returns an
  // IteratorResult: {done: false} to yield, or {done: true, value} to finish.
  // Unlike run(), a suspended parse holds no concurrency slot. Its next slice
  // competes with every other document, including newly focused documents.
  runSlices(operation, { signal, priority = () => 0, timeoutMicros = 4000 } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (!Number.isFinite(timeoutMicros) || timeoutMicros <= 0)
      return Promise.reject(new RangeError("Invalid parser slice duration"));
    return new Promise((resolve, reject) => {
      const job = {
        operation,
        signal,
        priority,
        timeoutMicros,
        resolve,
        reject,
        queuedAt: this.now(),
        settled: false,
      };
      job.cancel = () => this.finishSlice(job, false, aborted());
      signal?.addEventListener("abort", job.cancel, { once: true });
      this.slices.push(job);
      this.scheduleSlices();
    });
  }

  finishSlice(job, completed, value) {
    if (job.settled) return;
    job.settled = true;
    const index = this.slices.indexOf(job);
    if (index !== -1) this.slices.splice(index, 1);
    job.signal?.removeEventListener("abort", job.cancel);
    if (completed) job.resolve(value);
    else job.reject(value);
  }

  scheduleSlices() {
    if (this.sliceDrainScheduled || this.drainingSlices || !this.slices.length) return;
    this.sliceDrainScheduled = true;
    this.defer(() => {
      this.sliceDrainScheduled = false;
      this.drainSlices();
    });
  }

  takeSlice() {
    const now = this.now();
    let selected,
      selectedPriority = Infinity;
    // An overdue job gets a slice before ordinary priority ordering. Aging
    // restarts after each slice, so background work progresses without keeping
    // the foreground behind a long parse. Queue order breaks equal priorities.
    for (const job of [...this.slices]) {
      if (job.signal?.aborted) {
        this.finishSlice(job, false, aborted());
        continue;
      }
      let priority;
      try {
        priority = job.priority();
        if (!Number.isFinite(priority)) throw new TypeError("Invalid parser priority");
      } catch (error) {
        this.finishSlice(job, false, error);
        continue;
      }
      if (job.settled) continue;
      const overdue = now - job.queuedAt >= this.agingMs;
      const selectedOverdue = selected && now - selected.queuedAt >= this.agingMs;
      if (
        !selected ||
        (overdue && (!selectedOverdue || job.queuedAt < selected.queuedAt)) ||
        (!overdue && !selectedOverdue && priority < selectedPriority)
      ) {
        selected = job;
        selectedPriority = priority;
      }
    }
    if (selected?.settled) return this.takeSlice();
    if (selected) this.slices.splice(this.slices.indexOf(selected), 1);
    return selected;
  }

  drainSlices() {
    this.drainingSlices = true;
    try {
      const turnDeadline = this.deadline(4000);
      for (let count = 0; count < this.maxCallbacksPerTurn && this.now() < turnDeadline; count++) {
        const job = this.takeSlice();
        if (!job) break;
        if (job.signal?.aborted || job.settled) {
          this.finishSlice(job, false, aborted());
          continue;
        }
        try {
          const deadline = Math.min(turnDeadline, this.now() + job.timeoutMicros / 1000);
          if (this.now() >= deadline) {
            this.slices.unshift(job);
            break;
          }
          const result = job.operation(deadline);
          if (result?.then) {
            // Observe an accidental async callback before rejecting its contract.
            Promise.resolve(result).catch(() => {});
            throw new TypeError("Parser slice callbacks must be synchronous");
          }
          if (typeof result?.done !== "boolean")
            throw new TypeError("Parser slices must return an IteratorResult");
          if (job.settled) continue;
          if (result.done) this.finishSlice(job, true, result.value);
          else {
            job.queuedAt = this.now();
            this.slices.push(job);
          }
        } catch (error) {
          this.finishSlice(job, false, error);
        }
      }
    } finally {
      this.drainingSlices = false;
      this.scheduleSlices();
    }
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
