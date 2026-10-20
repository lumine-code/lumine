// Native disposers cannot be interrupted. Prefer a pause between interactions,
// and yield between jobs. The pressure threshold prevents indefinite typing
// from postponing every release; the time budget is soft for a single job.
class IdleDisposalQueue {
  constructor({
    now = () => performance.now(),
    schedule = (callback, delay) => setTimeout(callback, delay),
    quietMs = 250,
    budgetMs = 2,
    pressureLimit = 2048,
  } = {}) {
    this.now = now;
    this.schedule = schedule;
    this.quietMs = quietMs;
    this.budgetMs = budgetMs;
    this.pressureLimit = pressureLimit;
    this.pending = [];
    this.offset = 0;
    this.lastActivity = -Infinity;
    this.scheduled = false;
  }

  didEdit() {
    this.didInteract();
  }

  didInteract() {
    this.lastActivity = this.now();
  }

  add(value, dispose) {
    this.pending.push({ value, dispose });
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.drain(), 0);
    }
  }

  drain() {
    const wait = Math.max(0, this.lastActivity + this.quietMs - this.now());
    if (wait && this.pending.length - this.offset <= this.pressureLimit) {
      this.schedule(() => this.drain(), wait);
      return;
    }
    const deadline = this.now() + this.budgetMs;
    try {
      do {
        const { value, dispose } = this.pending[this.offset];
        this.pending[this.offset++] = null;
        dispose(value);
      } while (
        this.offset < this.pending.length &&
        this.now() < deadline &&
        (!wait || this.pending.length - this.offset > this.pressureLimit)
      );
    } finally {
      if (this.offset < this.pending.length) {
        if (this.offset >= 1024 && this.offset * 2 >= this.pending.length) {
          this.pending = this.pending.slice(this.offset);
          this.offset = 0;
        }
        this.schedule(() => this.drain(), 0);
      } else {
        this.pending = [];
        this.offset = 0;
        this.scheduled = false;
      }
    }
  }
}

module.exports = { IdleDisposalQueue, idleDisposals: new IdleDisposalQueue() };
