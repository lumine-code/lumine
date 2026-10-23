const fs = require("fs/promises");

class XdgShellInvoker {
  constructor(
    shell,
    {
      env = process.env,
      platform = process.platform,
      timeout = 60_000,
      accessPath = (target) => fs.access(target),
    } = {},
  ) {
    this.shell = shell;
    this.env = env;
    this.platform = platform;
    this.timeout = timeout;
    this.accessPath = accessPath;
    this.pendingXdgInvocation = Promise.resolve();
  }

  invoke(action, target) {
    if (action !== "openPath" && action !== "openExternal") {
      return this.shell[action](target);
    }
    if (!this.shouldRestoreOriginalDesktop(action)) {
      return this.invokeOpen(action, target);
    }

    const invoke = () => this.invokeWithOriginalDesktop(action, target);
    const result = this.pendingXdgInvocation.then(invoke, invoke);
    this.pendingXdgInvocation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async invokeOpen(action, target) {
    let timedOut = false;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new Error(
          "Timed out waiting for the system to open the target; the operation may still complete.",
        );
        error.code = "ETIMEDOUT";
        reject(error);
      }, this.timeout);
    });
    const operation = async () => {
      // Missing paths can make Windows display a modal error before returning.
      // An asynchronous preflight also leaves the deadline effective for slow disks.
      if (action === "openPath") await this.accessPath(target);
      if (timedOut) return;
      const message = await this.shell[action](target);
      if (action === "openPath" && message) {
        const error = new Error(message);
        error.code = "EOPENFAILED";
        throw error;
      }
    };
    try {
      // The deadline settles our request; it cannot cancel an operating-system dialog.
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  shouldRestoreOriginalDesktop(action) {
    // Electron identifies itself as Unity on Linux, which can make xdg-open
    // choose a desktop's fallback application instead of the user's default.
    return (
      this.platform === "linux" &&
      (action === "openPath" || action === "openExternal") &&
      typeof this.env.ORIGINAL_XDG_CURRENT_DESKTOP === "string" &&
      this.env.ORIGINAL_XDG_CURRENT_DESKTOP.length > 0
    );
  }

  async invokeWithOriginalDesktop(action, target) {
    const hadCurrentDesktop = Object.prototype.hasOwnProperty.call(this.env, "XDG_CURRENT_DESKTOP");
    const currentDesktop = this.env.XDG_CURRENT_DESKTOP;
    this.env.XDG_CURRENT_DESKTOP = this.env.ORIGINAL_XDG_CURRENT_DESKTOP;

    try {
      return await this.invokeOpen(action, target);
    } finally {
      if (hadCurrentDesktop) {
        this.env.XDG_CURRENT_DESKTOP = currentDesktop;
      } else {
        delete this.env.XDG_CURRENT_DESKTOP;
      }
    }
  }
}

module.exports = XdgShellInvoker;
