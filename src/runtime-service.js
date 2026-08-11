/**
 * Renderer-runtime readiness and unhandled-error events.
 *
 * @public
 * @api-status Public
 */
class RuntimeService {
  constructor(lumineEnvironment) {
    this.lumineEnvironment = lumineEnvironment;
  }

  /**
   * Subscribe before an unhandled renderer error is reported.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onWillThrowError(callback) {
    return this.lumineEnvironment.emitter.on("will-throw-error", callback);
  }

  /**
   * Subscribe after an unhandled renderer error is reported.
   *
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Extended
   */
  onDidThrowError(callback) {
    return this.lumineEnvironment.emitter.on("did-throw-error", callback);
  }

  /**
   * Wait until the current renderer has loaded its shell environment.
   *
   * @returns {Promise} that resolves once environment loading is complete.
   * @public
   * @api-status Extended
   */
  whenShellEnvironmentLoaded() {
    if (this.lumineEnvironment.shellEnvironmentLoaded) return Promise.resolve();
    return new Promise((resolve) =>
      this.lumineEnvironment.emitter.once("loaded-shell-environment", resolve),
    );
  }

  /**
   * @returns {Number|null} The shell-environment load time captured at bootstrap, or `null` when no timing was recorded.
   * @public
   * @api-status Extended
   */
  getShellLoadTime() {
    return this.lumineEnvironment.applicationDelegate.getWindowLoadSettings().shellLoadTime ?? null;
  }
}

module.exports = RuntimeService;
