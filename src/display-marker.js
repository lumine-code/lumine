const { Emitter, Disposable } = require("@lumine-code/event-kit");

/**
 * Represents a buffer annotation that remains logically stationary
 * even as the buffer changes. This is used to represent cursors, folds, snippet
 * targets, misspelled words, and anything else that needs to track a logical
 * location in the buffer over time.
 *
 * ### DisplayMarker Creation
 *
 * Use {@link DisplayMarkerLayer#markBufferRange} or {@link DisplayMarkerLayer#markScreenRange}
 * rather than creating Markers directly.
 *
 * ### Head and Tail
 *
 * Markers always have a *head* and sometimes have a *tail*. If you think of a
 * marker as an editor selection, the tail is the part that's stationary and the
 * head is the part that moves when the mouse is moved. A marker without a tail
 * always reports an empty range at the head position. A marker with a head position
 * greater than the tail is in a "normal" orientation. If the head precedes the
 * tail the marker is in a "reversed" orientation.
 *
 * ### Validity
 *
 * Markers are considered *valid* when they are first created. Depending on the
 * invalidation strategy you choose, certain changes to the buffer can cause a
 * marker to become invalid, for example if the text surrounding the marker is
 * deleted. The strategies, in order of descending fragility:
 *
 * * __never__: The marker is never marked as invalid. This is a good choice for
 *   markers representing selections in an editor.
 * * __surround__: The marker is invalidated by changes that completely surround it.
 * * __overlap__: The marker is invalidated by changes that surround the
 *   start or end of the marker. This is the default.
 * * __inside__: The marker is invalidated by changes that extend into the
 *   inside of the marker. Changes that end at the marker's start or
 *   start at the marker's end do not invalidate the marker.
 * * __touch__: The marker is invalidated by a change that touches the marked
 *   region in any way, including changes that end at the marker's
 *   start or start at the marker's end. This is the most fragile strategy.
 *
 * See {@link TextBuffer#markRange} for usage.
 *
 * @public
 * @api-status Essential
 */
class DisplayMarker {
  /**
   * @category Construction and Destruction
   */

  constructor(layer, bufferMarker) {
    this.layer = layer;
    this.bufferMarker = bufferMarker;
    ({ id: this.id } = this.bufferMarker);
    this.hasChangeObservers = false;
    this.emitter = new Emitter();
    this.bufferMarkerSubscription = null;
  }

  /**
   * Destroys the marker, causing it to emit the 'destroyed' event. Once
   * destroyed, a marker cannot be restored by undo/redo operations.
   *
   * @public
   * @api-status Essential
   */
  destroy() {
    if (!this.isDestroyed()) {
      this.bufferMarker.destroy();
    }
  }

  didDestroyBufferMarker() {
    this.emitter.emit("did-destroy");
    this.layer.didDestroyMarker(this);
    this.emitter.dispose();
    this.bufferMarkerSubscription?.dispose();
  }

  /**
   * Creates and returns a new {@link DisplayMarker} with the same properties as
   * this marker.
   *
   * {@link Selection} markers (markers with a custom property `type: "selection"`)
   * should be copied with a different `type` value, for example with
   * `marker.copy({type: null})`. Otherwise, the new marker's selection will
   * be merged with this marker's selection, and a `null` value will be
   * returned.
   *
   * @param {Object} [params] - properties to associate with the new marker. The new marker's properties are computed by extending this marker's properties with `params`.
   * @returns {DisplayMarker}
   * @public
   * @api-status Essential
   */
  copy(params) {
    return this.layer.getMarker(this.bufferMarker.copy(params).id);
  }

  /**
   * @category Event Subscription
   */

  /**
   * Invoke the given callback when the state of the marker changes.
   *
   * @param {Function} callback - to be called when the marker changes.
   * @param {Object} callback.event - with the following keys:
   * @param {Point} callback.event.oldHeadBufferPosition - representing the former head buffer position
   * @param {Point} callback.event.newHeadBufferPosition - representing the new head buffer position
   * @param {Point} callback.event.oldTailBufferPosition - representing the former tail buffer position
   * @param {Point} callback.event.newTailBufferPosition - representing the new tail buffer position
   * @param {Point} callback.event.oldHeadScreenPosition - representing the former head screen position
   * @param {Point} callback.event.newHeadScreenPosition - representing the new head screen position
   * @param {Point} callback.event.oldTailScreenPosition - representing the former tail screen position
   * @param {Point} callback.event.newTailScreenPosition - representing the new tail screen position
   * @param {Boolean} callback.event.wasValid - indicating whether the marker was valid before the change
   * @param {Boolean} callback.event.isValid - indicating whether the marker is now valid
   * @param {Boolean} callback.event.hadTail - indicating whether the marker had a tail before the change
   * @param {Boolean} callback.event.hasTail - indicating whether the marker now has a tail
   * @param {Object} callback.event.oldProperties - containing the marker's custom properties before the change.
   * @param {Object} callback.event.newProperties - containing the marker's custom properties after the change.
   * @param {Boolean} callback.event.textChanged - indicating whether this change was caused by a textual change to the buffer or whether the marker was manipulated directly via its public API.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  onDidChange(callback) {
    if (!this.hasChangeObservers) {
      this.oldHeadBufferPosition = this.getHeadBufferPosition();
      this.oldHeadScreenPosition = this.getHeadScreenPosition();
      this.oldTailBufferPosition = this.getTailBufferPosition();
      this.oldTailScreenPosition = this.getTailScreenPosition();
      this.wasValid = this.isValid();
      this.bufferMarkerSubscription = this.bufferMarker.onDidChange((event) =>
        this.notifyObservers(event.textChanged),
      );
      this.hasChangeObservers = true;
    }
    const subscription = this.emitter.on("did-change", callback);
    return new Disposable(() => {
      subscription.dispose();
      if (!this.emitter.disposed && this.emitter.listenerCountForEventName("did-change") === 0) {
        this.bufferMarkerSubscription?.dispose();
        this.bufferMarkerSubscription = null;
        this.hasChangeObservers = false;
      }
    });
  }

  /**
   * Invoke the given callback when the marker is destroyed.
   *
   * @param {Function} callback - to be called when the marker is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Essential
   */
  onDidDestroy(callback) {
    this.layer.markersWithDestroyListeners.add(this);
    const subscription = this.emitter.on("did-destroy", callback);
    return new Disposable(() => {
      subscription.dispose();
      if (!this.emitter.disposed && this.emitter.listenerCountForEventName("did-destroy") === 0) {
        this.layer.markersWithDestroyListeners.delete(this);
      }
    });
  }

  /**
   * @category TextEditorMarker Details
   */

  /**
   * @returns {Boolean} indicating whether the marker is valid. Markers can be invalidated when a region surrounding them in the buffer is changed.
   * @public
   * @api-status Essential
   */
  isValid() {
    return this.bufferMarker.isValid();
  }

  /**
   * @returns {Boolean} indicating whether the marker has been destroyed. A marker can be invalid without being destroyed, in which case undoing the invalidating operation would restore the marker. Once a marker is destroyed by calling {@link DisplayMarker#destroy}, no undo/redo operation can ever bring it back.
   * @public
   * @api-status Essential
   */
  isDestroyed() {
    return this.layer.isDestroyed() || this.bufferMarker.isDestroyed();
  }

  /**
   * @returns {Boolean} indicating whether the head precedes the tail.
   * @public
   * @api-status Essential
   */
  isReversed() {
    return this.bufferMarker.isReversed();
  }

  /**
   * @returns {Boolean} indicating whether changes that occur exactly at the marker's head or tail cause it to move.
   * @public
   * @api-status Essential
   */
  isExclusive() {
    return this.bufferMarker.isExclusive();
  }

  /**
   * Get the invalidation strategy for this marker.
   *
   * Valid values include: `never`, `surround`, `overlap`, `inside`, and `touch`.
   *
   * @returns {String}
   * @public
   * @api-status Essential
   */
  getInvalidationStrategy() {
    return this.bufferMarker.getInvalidationStrategy();
  }

  /**
   * @returns {Object} containing any custom properties associated with the marker.
   * @public
   * @api-status Essential
   */
  getProperties() {
    return this.bufferMarker.getProperties();
  }

  /**
   * Merges an `Object` containing new properties into the marker's
   * existing properties.
   *
   * @param {Object} properties
   * @public
   * @api-status Essential
   */
  setProperties(properties) {
    return this.bufferMarker.setProperties(properties);
  }

  /**
   * @returns {Boolean} whether this marker matches the given parameters. The parameters are the same as {@link DisplayMarkerLayer#findMarkers}.
   * @public
   * @api-status Essential
   */
  matchesProperties(attributes) {
    attributes = this.layer.translateToBufferMarkerParams(attributes);
    return this.bufferMarker.matchesParams(attributes);
  }

  /**
   * @category Comparing to other markers
   */

  /**
   * Compares this marker to another based on their ranges.
   *
   * @param {DisplayMarker} otherMarker - The marker to compare.
   * @returns {Number} The ordering of this marker relative to `otherMarker`.
   * @public
   * @api-status Essential
   */
  compare(otherMarker) {
    return this.bufferMarker.compare(otherMarker.bufferMarker);
  }

  /**
   * @param {DisplayMarker} other - other marker
   * @returns {Boolean} indicating whether this marker is equivalent to another marker, meaning they have the same range and options.
   * @public
   * @api-status Essential
   */
  isEqual(other) {
    if (!(other instanceof this.constructor)) {
      return false;
    }
    return this.bufferMarker.isEqual(other.bufferMarker);
  }

  /**
   * @category Managing the marker's range
   */

  /**
   * Gets the buffer range of this marker.
   *
   * @returns {Range}
   * @public
   * @api-status Essential
   */
  getBufferRange() {
    return this.bufferMarker.getRange();
  }

  /**
   * Gets the screen range of this marker.
   *
   * @returns {Range}
   * @public
   * @api-status Essential
   */
  getScreenRange() {
    return this.layer.translateBufferRange(this.getBufferRange());
  }

  /**
   * Modifies the buffer range of this marker.
   *
   * @param bufferRange - The new {@link Range} to use
   * @param {Object} [properties] - properties to associate with the marker.
   * @param {Boolean} properties.reversed - If true, the marker will to be in a reversed orientation.
   * @public
   * @api-status Essential
   */
  setBufferRange(bufferRange, properties) {
    return this.bufferMarker.setRange(bufferRange, properties);
  }

  /**
   * Modifies the screen range of this marker.
   *
   * @param screenRange - The new {@link Range} to use
   * @param [options] - An `Object` with the following keys:
   * @param {Boolean} options.reversed - If true, the marker will to be in a reversed orientation.
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'` and applies to both ends of the range.
   * @public
   * @api-status Essential
   */
  setScreenRange(screenRange, options) {
    return this.setBufferRange(this.layer.translateScreenRange(screenRange, options), options);
  }

  /**
   * Retrieves the buffer position of the marker's head.
   *
   * @returns {Point}
   * @public
   * @api-status Extended
   */
  getHeadBufferPosition() {
    return this.bufferMarker.getHeadPosition();
  }

  /**
   * Sets the buffer position of the marker's head.
   *
   * @param bufferPosition - The new {@link Point} to use
   * @public
   * @api-status Extended
   */
  setHeadBufferPosition(bufferPosition) {
    return this.bufferMarker.setHeadPosition(bufferPosition);
  }

  /**
   * Retrieves the screen position of the marker's head.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's head screen position.
   * @public
   * @api-status Extended
   */
  getHeadScreenPosition(options) {
    return this.layer.translateBufferPosition(this.bufferMarker.getHeadPosition(), options);
  }

  /**
   * Sets the screen position of the marker's head.
   *
   * @param screenPosition - The new {@link Point} to use
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @public
   * @api-status Extended
   */
  setHeadScreenPosition(screenPosition, options) {
    return this.setHeadBufferPosition(this.layer.translateScreenPosition(screenPosition, options));
  }

  /**
   * Retrieves the buffer position of the marker's tail.
   *
   * @returns {Point}
   * @public
   * @api-status Extended
   */
  getTailBufferPosition() {
    return this.bufferMarker.getTailPosition();
  }

  /**
   * Sets the buffer position of the marker's tail.
   *
   * @param bufferPosition - The new {@link Point} to use
   * @public
   * @api-status Extended
   */
  setTailBufferPosition(bufferPosition) {
    return this.bufferMarker.setTailPosition(bufferPosition);
  }

  /**
   * Retrieves the screen position of the marker's tail.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's tail screen position.
   * @public
   * @api-status Extended
   */
  getTailScreenPosition(options) {
    return this.layer.translateBufferPosition(this.bufferMarker.getTailPosition(), options);
  }

  /**
   * Sets the screen position of the marker's tail.
   *
   * @param screenPosition - The new {@link Point} to use
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @public
   * @api-status Extended
   */
  setTailScreenPosition(screenPosition, options) {
    return this.bufferMarker.setTailPosition(
      this.layer.translateScreenPosition(screenPosition, options),
    );
  }

  /**
   * Retrieves the buffer position of the marker's start. This will always be
   * less than or equal to the result of {@link DisplayMarker#getEndBufferPosition}.
   *
   * @returns {Point}
   * @public
   * @api-status Extended
   */
  getStartBufferPosition() {
    return this.bufferMarker.getStartPosition();
  }

  /**
   * Retrieves the screen position of the marker's start. This will always be
   * less than or equal to the result of {@link DisplayMarker#getEndScreenPosition}.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's start screen position.
   * @public
   * @api-status Essential
   */
  getStartScreenPosition(options) {
    return this.layer.translateBufferPosition(this.getStartBufferPosition(), options);
  }

  /**
   * Retrieves the buffer position of the marker's end. This will always be
   * greater than or equal to the result of {@link DisplayMarker#getStartBufferPosition}.
   *
   * @returns {Point}
   * @public
   * @api-status Extended
   */
  getEndBufferPosition() {
    return this.bufferMarker.getEndPosition();
  }

  /**
   * Retrieves the screen position of the marker's end. This will always be
   * greater than or equal to the result of {@link DisplayMarker#getStartScreenPosition}.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's end screen position.
   * @public
   * @api-status Essential
   */
  getEndScreenPosition(options) {
    return this.layer.translateBufferPosition(this.getEndBufferPosition(), options);
  }

  /**
   * @returns {Boolean} indicating whether the marker has a tail.
   * @public
   * @api-status Extended
   */
  hasTail() {
    return this.bufferMarker.hasTail();
  }

  /**
   * Plants the marker's tail at the current head position. After calling
   * the marker's tail position will be its head position at the time of the
   * call, regardless of where the marker's head is moved.
   *
   * @public
   * @api-status Extended
   */
  plantTail() {
    return this.bufferMarker.plantTail();
  }

  /**
   * Removes the marker's tail. After calling the marker's head position
   * will be reported as its current tail position until the tail is planted
   * again.
   *
   * @public
   * @api-status Extended
   */
  clearTail() {
    return this.bufferMarker.clearTail();
  }

  toString() {
    return `[Marker ${this.id}, bufferRange: ${this.getBufferRange()}, screenRange: ${this.getScreenRange()}}]`;
  }

  /**
   * @category Private
   */

  inspect() {
    return this.toString();
  }

  notifyObservers(textChanged) {
    if (!this.hasChangeObservers) {
      return;
    }
    if (textChanged == null) {
      textChanged = false;
    }

    const newHeadBufferPosition = this.getHeadBufferPosition();
    const newHeadScreenPosition = this.getHeadScreenPosition();
    const newTailBufferPosition = this.getTailBufferPosition();
    const newTailScreenPosition = this.getTailScreenPosition();
    const isValid = this.isValid();

    if (
      isValid === this.wasValid &&
      newHeadBufferPosition.isEqual(this.oldHeadBufferPosition) &&
      newHeadScreenPosition.isEqual(this.oldHeadScreenPosition) &&
      newTailBufferPosition.isEqual(this.oldTailBufferPosition) &&
      newTailScreenPosition.isEqual(this.oldTailScreenPosition)
    ) {
      return;
    }

    const changeEvent = {
      oldHeadScreenPosition: this.oldHeadScreenPosition,
      newHeadScreenPosition,
      oldTailScreenPosition: this.oldTailScreenPosition,
      newTailScreenPosition,
      oldHeadBufferPosition: this.oldHeadBufferPosition,
      newHeadBufferPosition,
      oldTailBufferPosition: this.oldTailBufferPosition,
      newTailBufferPosition,
      textChanged,
      wasValid: this.wasValid,
      isValid,
    };

    this.oldHeadBufferPosition = newHeadBufferPosition;
    this.oldHeadScreenPosition = newHeadScreenPosition;
    this.oldTailBufferPosition = newTailBufferPosition;
    this.oldTailScreenPosition = newTailScreenPosition;
    this.wasValid = isValid;

    return this.emitter.emit("did-change", changeEvent);
  }
}

module.exports = DisplayMarker;
