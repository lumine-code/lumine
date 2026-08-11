/**
 * The public editor surface.
 *
 * @public
 * @api-status Essential
 */
class LumineEnvironment {
  constructor() {
    /**
     * The fixture service.
     *
     * @type {FixtureService}
     * @public
     * @api-status Public
     */
    this.fixture = new FixtureService();
  }
}

/**
 * Exercises the extractor.
 *
 * @public
 * @api-status Extended
 */
class FixtureService {
  /**
   * Create a service.
   *
   * @returns {FixtureService} A service instance.
   * @public
   * @api-status Public
   */
  static create() {
    return new FixtureService();
  }

  /**
   * Transform a value.
   *
   * @param {String} value - Input value.
   * @param {Object} [options={}] - Optional settings.
   * @param {String} [options.prefix] - Text to prepend.
   * @returns {Promise<String>} The transformed value.
   * @category Transformation
   * @public
   * @api-status Experimental
   */
  async transform(value, options = {}) {
    return (await Promise.resolve(options?.prefix ?? "")) + value;
  }

  /**
   * Collect values. See {@link FixtureService#transform transform} on
   * {@link FixtureService|the fixture service}.
   *
   * @param {...String} values - Values to collect.
   * @returns {Array<String>} The collected values.
   * @public
   * @api-status Public
   */
  collect(...values) {
    return values;
  }

  /**
   * Whether the service is ready.
   *
   * @returns {Boolean} The readiness state.
   * @public
   * @api-status Public
   */
  get ready() {
    return true;
  }

  /**
   * Change the service label.
   *
   * @param {String} value - The new label.
   * @public
   * @api-status Public
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
 * Normalize a fixture value.
 *
 * @param {String} [input=""] - Input value.
 * @returns {String} The normalized value.
 * @public
 * @api-status Public
 */
function normalize(input = "") {
  return input.trim();
}

module.exports = { FixtureService, LumineEnvironment, normalize };
