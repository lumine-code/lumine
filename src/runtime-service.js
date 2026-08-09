// Public: Renderer-runtime readiness and unhandled-error events.
class RuntimeService {
  constructor(atomEnvironment) {
    this.atomEnvironment = atomEnvironment;
  }

  // Extended: Subscribe before an unhandled renderer error is reported.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onWillThrowError(callback) {
    return this.atomEnvironment.emitter.on("will-throw-error", callback);
  }

  // Extended: Subscribe after an unhandled renderer error is reported.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidThrowError(callback) {
    return this.atomEnvironment.emitter.on("did-throw-error", callback);
  }

  // Extended: Wait until the current renderer has loaded its shell environment.
  //
  // Returns a {Promise} that resolves once environment loading is complete.
  whenShellEnvironmentLoaded() {
    if (this.atomEnvironment.shellEnvironmentLoaded) return Promise.resolve();
    return new Promise((resolve) =>
      this.atomEnvironment.emitter.once("loaded-shell-environment", resolve),
    );
  }

  // Extended: Return the shell-environment load time captured at bootstrap.
  //
  // Returns a {Number}, or `null` when no timing was recorded.
  getShellLoadTime() {
    return this.atomEnvironment.applicationDelegate.getWindowLoadSettings().shellLoadTime ?? null;
  }
}

module.exports = RuntimeService;
