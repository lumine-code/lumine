/**
 * @public
 * @status essential
 *
 * The public editor surface.
 */
class Environment {
  constructor() {
    /**
     * @public
     * @status public
     *
     * The fixture service.
     *
     * @type {FixtureService}
     */
    this.fixture = new FixtureService();
  }
}

/**
 * @public
 * @status extended
 *
 * Exercises the extractor.
 */
class FixtureService {
  /**
   * @public
   * @status public
   *
   * Create a service.
   *
   * @returns {FixtureService} A service instance.
   */
  static create() {
    return new FixtureService();
  }

  /**
   * @public
   * @status experimental
   *
   * Transform a value.
   *
   * @param {String} value - Input value.
   * @param {Object} [options={}] - Optional settings.
   * @param {String} [options.prefix] - Text to prepend.
   * @returns {Promise<String>} The transformed value.
   * @category Transformation
   */
  async transform(value, options = {}) {
    return (await Promise.resolve(options?.prefix ?? "")) + value;
  }

  /**
   * @public
   * @status public
   *
   * Collect values. See {@link FixtureService#transform transform} on
   * {@link FixtureService|the fixture service}.
   *
   * @param {...String} values - Values to collect.
   * @returns {Array<String>} The collected values.
   */
  collect(...values) {
    return values;
  }

  /**
   * @public
   * @status public
   *
   * Whether the service is ready.
   *
   * @returns {Boolean} The readiness state.
   */
  get ready() {
    return true;
  }

  /**
   * @public
   * @status public
   *
   * Change the service label.
   *
   * @param {String} value - The new label.
   */
  set label(value) {
    this.value = value;
  }

  /**
   * @category Internal
   */
  undocumented() {}

  /** Internal implementation.
   * @private
   */
  hidden() {}
}

/**
 * @public
 * @status public
 *
 * Normalize a fixture value.
 *
 * @param {String} [input=""] - Input value.
 * @returns {String} The normalized value.
 */
function normalize(input = "") {
  return input.trim();
}

module.exports = { FixtureService, Environment, normalize };
