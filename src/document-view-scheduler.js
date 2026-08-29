const { Disposable } = require("@lumine-code/event-kit");

module.exports = class DocumentViewScheduler {
  constructor(document) {
    this.document = document;
    this.window = document.defaultView;
    this.writers = [];
    this.readers = [];
    this.frame = null;
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
    if (!this.nextPromise) {
      this.nextPromise = new Promise((resolve) => {
        this.resolveNextPromise = resolve;
      });
    }
    return this.nextPromise;
  }

  request() {
    if (this.frame == null) this.frame = this.window.requestAnimationFrame(this.perform);
  }

  perform() {
    this.frame = null;
    let completed = false;
    try {
      let callback;
      while ((callback = this.writers.shift())) callback();
      while ((callback = this.readers.shift())) callback();
      while ((callback = this.writers.shift())) callback();
      completed = true;
    } finally {
      const hasPendingWork = this.writers.length > 0 || this.readers.length > 0;
      if (hasPendingWork) this.request();
      if (completed || !hasPendingWork) {
        const resolve = this.resolveNextPromise;
        this.nextPromise = null;
        this.resolveNextPromise = null;
        resolve?.();
      }
    }
  }

  clear() {
    if (this.frame != null) this.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.writers = [];
    this.readers = [];
    this.resolveNextPromise?.();
    this.nextPromise = null;
    this.resolveNextPromise = null;
  }

  destroy() {
    this.clear();
  }
};
