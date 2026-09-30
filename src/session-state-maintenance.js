const ChildProcess = require("child_process");
const path = require("path");

// Inspecting old JSON snapshots can be expensive. The application only owns
// the schedule and live-window identities; SQLite work runs in a short-lived
// Node child, away from both the renderer and Electron's main event loop.
module.exports = class SessionStateMaintenance {
  constructor({ storagePath, getProtectedWindowIds, spawnWorker, delay = 5000, timeout = 60000 }) {
    this.storagePath = storagePath;
    this.getProtectedWindowIds = getProtectedWindowIds;
    this.spawnWorker = spawnWorker || (() => this.forkWorker());
    this.delay = delay;
    this.timeout = timeout;
    this.closed = false;
    this.reschedule = false;
    this.timer = null;
    this.worker = null;
    this.job = null;
  }

  forkWorker() {
    return ChildProcess.fork(require.resolve("./session-state-worker-bootstrap"), [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
      },
      execArgv: [],
      silent: true,
      windowsHide: true,
    });
  }

  schedule() {
    if (this.closed) return;
    if (this.job) {
      this.reschedule = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run().catch((error) => console.error("Unable to prune retired window states", error));
    }, this.delay);
    this.timer.unref?.();
  }

  run() {
    if (this.closed) return Promise.resolve(null);
    if (this.job) return this.job;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    let resolveJob, rejectJob;
    this.job = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = this.job;
    let worker, deadline, result, failure;
    const finish = () => {
      clearTimeout(deadline);
      this.worker = null;
      this.job = null;
      if (this.closed) resolveJob(null);
      else if (failure) rejectJob(failure);
      else if (result) resolveJob(result);
      else rejectJob(new Error("Session-state worker exited before completing its sweep"));
      if (this.reschedule && !this.closed) {
        this.reschedule = false;
        this.schedule();
      }
    };

    try {
      worker = this.spawnWorker();
      this.worker = worker;
      worker.on("message", (message) => {
        if (this.closed) return;
        if (message?.type === "candidates-ready") {
          // Fetch these after enumeration. Newly created snapshots are outside
          // the candidate set, and windows opened during the scan are protected.
          try {
            const protectedWindowIds = [...this.getProtectedWindowIds()];
            worker.send({ type: "prune", protectedWindowIds });
          } catch (error) {
            failure = error;
            worker.kill();
          }
        } else if (message?.type === "complete") {
          result = message.result;
        } else if (message?.type === "failure") {
          failure = new Error(message.message);
        }
      });
      worker.on("error", (error) => {
        failure = error;
      });
      worker.once("close", finish);
      // Drain diagnostics so a full stderr pipe cannot stall child shutdown.
      worker.stdout?.resume();
      worker.stderr?.resume();
      deadline = setTimeout(() => {
        failure = new Error("Session-state cleanup exceeded its time limit");
        worker.kill();
      }, this.timeout);
      deadline.unref?.();
      worker.send({ type: "scan", databasePath: path.join(this.storagePath, "session-store.db") });
    } catch (error) {
      failure = error;
      if (worker) worker.kill();
      else finish();
    }
    return job;
  }

  async close() {
    this.closed = true;
    this.reschedule = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const job = this.job;
    this.worker?.kill();
    await job?.catch(() => {});
  }
};
