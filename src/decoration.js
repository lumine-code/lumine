const { Emitter } = require("@lumine-code/event-kit");

let idCounter = 0;
const nextId = () => idCounter++;

const normalizeDecorationProperties = function (decoration, decorationParams) {
  decorationParams.id = decoration.id;

  if (decorationParams.type === "line-number" && decorationParams.gutterName == null) {
    decorationParams.gutterName = "line-number";
  }

  if (decorationParams.order == null) {
    decorationParams.order = Infinity;
  }

  return decorationParams;
};

/**
 * Represents a decoration that follows a {@link DisplayMarker}. A decoration is
 * basically a visual representation of a marker. It allows you to add CSS
 * classes to line numbers in the gutter, lines, and add selection-line regions
 * around marked ranges of text.
 *
 * {@link Decoration} objects are not meant to be created directly, but created with
 * {@link TextEditor#decorateMarker}. eg.
 *
 * ```js
 * const range = editor.getSelectedBufferRange() // any range you like
 * const marker = editor.markBufferRange(range)
 * const decoration = editor.decorateMarker(marker, { type: 'line', class: 'my-line-class' })
 * ```
 *
 * Best practice for destroying the decoration is by destroying the {@link DisplayMarker}.
 *
 * ```js
 * marker.destroy()
 * ```
 *
 * You should only use {@link Decoration#destroy} when you still need or do not own
 * the marker.
 *
 * @public
 * @api-status Essential
 */
module.exports = class Decoration {
  /**
   * Check if the `decorationProperties.type` matches `type`
   *
   * @param {Object} decorationProperties - eg. `{type: 'line-number', class: 'my-new-class'}`
   * @param {String} type - type like `'line-number'`, `'line'`, etc. `type` can also be an `Array` of `Strings`, where it will return true if the decoration's type matches any in the array.
   * @returns {Boolean} Note: 'line-number' is a special subtype of the 'gutter' type. I.e., a 'line-number' is a 'gutter', but a 'gutter' is not a 'line-number'.
   * @private
   */
  static isType(decorationProperties, type) {
    // 'line-number' is a special case of 'gutter'.
    if (Array.isArray(decorationProperties.type)) {
      if (decorationProperties.type.includes(type)) {
        return true;
      }

      if (type === "gutter" && decorationProperties.type.includes("line-number")) {
        return true;
      }

      return false;
    } else {
      if (type === "gutter") {
        return ["gutter", "line-number"].includes(decorationProperties.type);
      } else {
        return type === decorationProperties.type;
      }
    }
  }

  /**
   * @category Construction and Destruction
   */

  constructor(marker, decorationManager, properties) {
    this.marker = marker;
    this.decorationManager = decorationManager;
    this.emitter = new Emitter();
    this.id = nextId();
    this.setProperties(properties);
    this.destroyed = false;
    this.markerDestroyDisposable = this.marker.onDidDestroy(() => this.destroy());
  }

  /**
   * Destroy this marker decoration.
   *
   * You can also destroy the marker if you own it, which will destroy this
   * decoration.
   *
   * @public
   * @api-status Essential
   */
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.markerDestroyDisposable.dispose();
    this.markerDestroyDisposable = null;
    this.destroyed = true;
    this.decorationManager.didDestroyMarkerDecoration(this);
    this.emitter.emit("did-destroy");
    return this.emitter.dispose();
  }

  isDestroyed() {
    return this.destroyed;
  }

  /**
   * @category Event Subscription
   */

  /**
   * When the {@link Decoration} is updated via {@link Decoration#setProperties}.
   *
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {Object} callback.event.oldProperties - the decoration's previous properties
   * @param {Object} callback.event.newProperties - the decoration's new properties
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  onDidChangeProperties(callback) {
    return this.emitter.on("did-change-properties", callback);
  }

  /**
   * Invoke the given callback when the {@link Decoration} is destroyed
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
   * @category Decoration Details
   */

  /**
   * An id unique across all {@link Decoration} objects
   *
   * @public
   * @api-status Essential
   */
  getId() {
    return this.id;
  }

  /**
   * @returns {DisplayMarker} marker associated with this {@link Decoration}
   * @public
   * @api-status Essential
   */
  getMarker() {
    return this.marker;
  }

  /**
   * Check if this decoration is of type `type`
   *
   * @param {String} type - type like `'line-number'`, `'line'`, etc. `type` can also be an `Array` of `Strings`, where it will return true if the decoration's type matches any in the array.
   * @returns {Boolean}
   * @public
   * @api-status Public
   */
  isType(type) {
    return Decoration.isType(this.properties, type);
  }

  /**
   * @category Properties
   */

  /**
   * @returns {Object} The decoration's properties.
   * @public
   * @api-status Essential
   */
  getProperties() {
    return this.properties;
  }

  /**
   * Update the marker with new Properties. Allows you to change the decoration's class.
   *
   * ## Examples
   *
   * ```js
   * decoration.setProperties({ type: 'line-number', class: 'my-new-class' })
   * ```
   *
   * @param {Object} newProperties - eg. `{type: 'line-number', class: 'my-new-class'}`
   * @public
   * @api-status Essential
   */
  setProperties(newProperties) {
    if (this.destroyed) {
      return;
    }
    const oldProperties = this.properties;
    this.properties = normalizeDecorationProperties(this, newProperties);
    if (newProperties.type != null) {
      this.decorationManager.decorationDidChangeType(this);
    }
    this.decorationManager.emitDidUpdateDecorations();
    return this.emitter.emit("did-change-properties", {
      oldProperties,
      newProperties,
    });
  }

  /**
   * @category Utility
   */

  inspect() {
    return `<Decoration ${this.id}>`;
  }

  /**
   * @category Private methods
   */

  matchesPattern(decorationPattern) {
    if (decorationPattern == null) {
      return false;
    }
    for (let key in decorationPattern) {
      const value = decorationPattern[key];
      if (this.properties[key] !== value) {
        return false;
      }
    }
    return true;
  }

  flash(klass, duration) {
    if (duration == null) {
      duration = 500;
    }
    this.properties.flashRequested = true;
    this.properties.flashClass = klass;
    this.properties.flashDuration = duration;
    this.decorationManager.emitDidUpdateDecorations();
    return this.emitter.emit("did-flash");
  }
};
