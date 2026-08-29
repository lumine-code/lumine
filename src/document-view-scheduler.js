const { Disposable } = require("@lumine-code/event-kit");

module.exports = class DocumentViewScheduler {
  constructor(document) {
    this.document = document;
    this.window = document.defaultView;
    this.writers = [];
    this.readers = [];
    this.frame = null;
    this.performing = false;
    this.perform = this.perform.bind(this);
  }

  updateDocument(callback) {
    this.writers.push(callback);
    this.request();
    return new Disposable(() => {
      const index = this.writers.indexOf(callback);
      if (index >= 0) this.writers.splice(index, 1);
    });
  }

  readDocument(callback) {
    this.readers.push(callback);
    this.request();
    return new Disposable(() => {
      const index = this.readers.indexOf(callback);
      if (index >= 0) this.readers.splice(index, 1);
    });
  }

  getNextUpdatePromise() {
    if (!this.nextUpdatePromise) {
      this.nextUpdatePromise = new Promise((resolve) => {
        this.resolveNextUpdatePromise = resolve;
      });
    }
    return this.nextUpdatePromise;
  }

  hasPendingWork() {
    return (
      this.performing || this.frame != null || this.writers.length > 0 || this.readers.length > 0
    );
  }

  getPendingUpdatePromise() {
    return this.hasPendingWork() ? this.getNextUpdatePromise() : null;
  }

  request() {
    if (this.frame == null) this.frame = this.window.requestAnimationFrame(this.perform);
  }

  perform() {
    this.frame = null;
    this.performing = true;
    let completed = false;
    try {
      let callback;
      while ((callback = this.writers.shift())) callback();
      while ((callback = this.readers.shift())) callback();
      while ((callback = this.writers.shift())) callback();
      completed = true;
    } finally {
      this.performing = false;
      const hasPendingWork = this.writers.length > 0 || this.readers.length > 0;
      if (hasPendingWork) this.request();
      if (completed || !hasPendingWork) {
        const resolve = this.resolveNextUpdatePromise;
        this.nextUpdatePromise = null;
        this.resolveNextUpdatePromise = null;
        resolve?.();
      }
    }
  }

  clear() {
    if (this.frame != null) this.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.performing = false;
    this.writers = [];
    this.readers = [];
    this.resolveNextUpdatePromise?.();
    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;
  }

  destroy() {
    this.clear();
  }
};
