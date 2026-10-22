const crypto = require("node:crypto");

// A reporter belongs to its creating renderer generation. Main-process cleanup
// handles a crash; explicit disposal handles a package unloading normally.
module.exports = class TaskProgress {
  constructor(applicationDelegate) {
    this.applicationDelegate = applicationDelegate;
    this.id = crypto.randomUUID();
    this.disposed = false;
    this.disposal = null;
  }

  update(status) {
    if (this.disposed) return Promise.reject(new Error("The task progress reporter is disposed"));
    return this.invoke("setTaskProgress", this.id, status);
  }

  dispose() {
    this.disposed = true;
    if (!this.disposal) {
      this.disposal = this.invoke("removeTaskProgress", this.id).catch((error) => {
        // A failed IPC must not make a subsequent cleanup attempt a no-op.
        this.disposal = null;
        throw error;
      });
    }
    return this.disposal;
  }

  invoke(action, ...args) {
    try {
      return Promise.resolve(this.applicationDelegate.invokeApp(action, ...args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
};
