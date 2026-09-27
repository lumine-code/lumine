const { Disposable } = require("@lumine-code/event-kit");

function validateURI(uri) {
  if (typeof uri !== "string" || !/^https?:\/\//i.test(uri)) {
    throw new TypeError("External URI openers accept only HTTP and HTTPS URIs");
  }
}

/**
 * @public
 * @status public
 *
 * Routes HTTP and HTTPS links to package-provided openers before Lumine falls
 * back to the operating system.
 */
module.exports = class ExternalURIRegistry {
  constructor() {
    this.openers = [];
    this.nextSequence = 0;
    this.destroyed = false;
  }

  /**
   * @public
   * @status public
   *
   * Register an opener. It returns `true` after handling a URI and `false` or
   * `undefined` to let the next opener try it.
   *
   * @param opener - A function receiving `(uri, context)`.
   * @param priority - Higher-priority openers run first.
   * @returns {Disposable} which removes the opener.
   */
  addOpener(opener, { priority = 0 } = {}) {
    if (typeof opener !== "function")
      throw new TypeError("An external URI opener must be a function");
    if (!Number.isFinite(priority))
      throw new TypeError("External URI opener priority must be finite");
    if (this.destroyed) throw new Error("Cannot register an opener on a destroyed registry");

    const registration = { opener, priority, sequence: this.nextSequence++ };
    this.openers.push(registration);
    this.openers.sort(
      (first, second) => second.priority - first.priority || first.sequence - second.sequence,
    );
    return new Disposable(() => {
      const index = this.openers.indexOf(registration);
      if (index >= 0) this.openers.splice(index, 1);
    });
  }

  /**
   * @public
   * @status public
   *
   * Ask registered openers to handle an HTTP or HTTPS URI.
   *
   * @returns {Promise<Boolean>} whether an opener handled the URI.
   */
  async open(uri, context = {}) {
    validateURI(uri);
    if (this.destroyed) return false;

    for (const { opener } of Array.from(this.openers)) {
      const result = await opener(uri, context);
      if (result === true || result?.handled === true) return true;
    }
    return false;
  }

  hasOpeners() {
    return !this.destroyed && this.openers.length > 0;
  }

  clear() {
    if (!this.destroyed) this.openers = [];
  }

  destroy() {
    this.destroyed = true;
    this.openers = [];
  }
};
