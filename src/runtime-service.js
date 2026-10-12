/**
 * @public
 * @status public
 *
 * Renderer-runtime readiness and unhandled-error events.
 */
class RuntimeService {
  constructor(lumineEnvironment) {
    this.lumineEnvironment = lumineEnvironment;
  }

  /** @category Event Subscription */

  /**
   * @public
   * @status extended
   *
   * Subscribe before an unhandled renderer error is reported.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillThrowError(callback) {
    return this.lumineEnvironment.emitter.on("will-throw-error", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Subscribe after an unhandled renderer error is reported.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidThrowError(callback) {
    return this.lumineEnvironment.emitter.on("did-throw-error", callback);
  }

  /** @category Shell Environment */

  /**
   * @public
   * @status extended
   *
   * Wait until the current renderer has loaded its shell environment.
   *
   * @returns {Promise} that resolves once environment loading is complete.
   */
  whenShellEnvironmentLoaded() {
    if (this.lumineEnvironment.shellEnvironmentLoaded) return Promise.resolve();
    return new Promise((resolve) =>
      this.lumineEnvironment.emitter.once("loaded-shell-environment", resolve),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Get the time taken to load the shell environment.
   *
   * @returns {Number|null} The shell-environment load time captured at bootstrap, or `null` when no timing was recorded.
   */
  getShellLoadTime() {
    return this.lumineEnvironment.applicationDelegate.getWindowLoadSettings().shellLoadTime ?? null;
  }
}

module.exports = RuntimeService;
