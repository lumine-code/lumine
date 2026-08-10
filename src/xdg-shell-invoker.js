class XdgShellInvoker {
  constructor(shell, { env = process.env, platform = process.platform } = {}) {
    this.shell = shell;
    this.env = env;
    this.platform = platform;
    this.pendingXdgInvocation = Promise.resolve();
  }

  invoke(action, target) {
    if (!this.shouldRestoreOriginalDesktop(action)) {
      return this.shell[action](target);
    }

    const invoke = () => this.invokeWithOriginalDesktop(action, target);
    const result = this.pendingXdgInvocation.then(invoke, invoke);
    this.pendingXdgInvocation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      return await this.shell[action](target);
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
