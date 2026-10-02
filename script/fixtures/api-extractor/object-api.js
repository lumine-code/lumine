/**
 * @public
 * @status public
 *
 * An object API with methods, accessors and constants. See {@link .normalize}.
 *
 * @memberof lumine.tools
 */
const fixtureTools = {
  /**
   * @public
   * @status public
   *
   * The format version.
   *
   * @type {String}
   */
  version: "1",

  /**
   * @public
   * @status public
   *
   * Normalize a value using a separately declared implementation.
   *
   * @param {String} input - The input value.
   * @returns {String} The normalized value.
   */
  normalize: normalize,

  /**
   * @public
   * @status public
   *
   * Whether the object is ready.
   *
   * @returns {Boolean} The readiness state.
   */
  get ready() {
    return true;
  },

  /**
   * @private
   */
  hidden() {},
};

/**
 * @public
 * @status public
 *
 * Render a fixture. See {@link lumine.tools.markdown.render}.
 *
 * @alias render
 * @memberof lumine.tools.markdown
 * @param {String} input - Input value.
 * @param {Object} [options] - Rendering options.
 * @param {String} [options.prefix] - Text to prepend.
 * @returns {String} The rendered value.
 */
function renderFixture(input = "", options = {}) {
  return (options.prefix || "") + input;
}

module.exports.fixtureTools = fixtureTools;
