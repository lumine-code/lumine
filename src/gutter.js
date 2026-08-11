const { Emitter } = require("@lumine-code/event-kit");

const DefaultPriority = -100;

/**
 * Represents a gutter within a {@link TextEditor}.
 *
 * See {@link TextEditor#addGutter} for information on creating a gutter.
 *
 * @public
 * @api-status Extended
 */
module.exports = class Gutter {
  constructor(gutterContainer, options) {
    this.gutterContainer = gutterContainer;
    this.name = options && options.name;
    this.priority = options && options.priority != null ? options.priority : DefaultPriority;
    this.visible = options && options.visible != null ? options.visible : true;
    this.type = options && options.type != null ? options.type : "decorated";
    this.labelFn = options && options.labelFn;
    this.className = options && options.class;

    this.onMouseDown = options && options.onMouseDown;
    this.onMouseMove = options && options.onMouseMove;

    this.emitter = new Emitter();
  }

  /**
   * @category Gutter Destruction
   */

  /**
   * Destroys the gutter.
   *
   * @public
   * @api-status Essential
   */
  destroy() {
    if (this.name === "line-number") {
      throw new Error("The line-number gutter cannot be destroyed.");
    } else {
      this.gutterContainer.removeGutter(this);
      this.emitter.emit("did-destroy");
      this.emitter.dispose();
    }
  }

  /**
   * @category Event Subscription
   */

  /**
   * Calls your `callback` when the gutter's visibility changes.
   *
   * @param {Function} callback
   * @param callback.gutter - The gutter whose visibility changed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  onDidChangeVisible(callback) {
    return this.emitter.on("did-change-visible", callback);
  }

  /**
   * Calls your `callback` when the gutter is destroyed.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * @category Visibility
   */

  /**
   * Hide the gutter.
   *
   * @public
   * @api-status Essential
   */
  hide() {
    if (this.visible) {
      this.visible = false;
      this.gutterContainer.scheduleComponentUpdate();
      this.emitter.emit("did-change-visible", this);
    }
  }

  /**
   * Show the gutter.
   *
   * @public
   * @api-status Essential
   */
  show() {
    if (!this.visible) {
      this.visible = true;
      this.gutterContainer.scheduleComponentUpdate();
      this.emitter.emit("did-change-visible", this);
    }
  }

  /**
   * Determine whether the gutter is visible.
   *
   * @returns {Boolean}
   * @public
   * @api-status Essential
   */
  isVisible() {
    return this.visible;
  }

  /**
   * Add a decoration that tracks a {@link DisplayMarker}. When the marker moves,
   * is invalidated, or is destroyed, the decoration will be updated to reflect
   * the marker's state.
   *
   * ## Arguments
   *
   * @param marker - A {@link DisplayMarker} you want this decoration to follow.
   * @param options - An `Object` representing the decoration. It is passed to {@link TextEditor#decorateMarker} as its options argument and so supports all options documented there.
   * @param options.type - __Caveat__: set to `'line-number'` if this is the line-number gutter, `'gutter'` otherwise. This cannot be overridden.
   * @returns {Decoration} object
   * @public
   * @api-status Essential
   */
  decorateMarker(marker, options) {
    return this.gutterContainer.addGutterDecoration(this, marker, options);
  }

  getElement() {
    if (this.element == null) this.element = document.createElement("div");
    return this.element;
  }
};
