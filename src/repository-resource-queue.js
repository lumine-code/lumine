// Linked worktrees have separate indexes but share refs, configuration and
// objects. Reserve the common metadata domain for a complete write/workflow.
// Distinct repositories retain independent queues.
module.exports = class RepositoryResourceQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, callback) {
    const previous = this.tails.get(key);
    let release;
    const turn = new Promise((resolve) => (release = resolve));
    const tail = previous ? previous.then(() => turn) : turn;
    this.tails.set(key, tail);
    const complete = () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    if (previous) return previous.then(callback).finally(complete);
    try {
      return Promise.resolve(callback()).finally(complete);
    } catch (error) {
      complete();
      return Promise.reject(error);
    }
  }
};
