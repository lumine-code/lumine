const { Emitter, Disposable } = require("@lumine-code/event-kit");
const Range = require("./range");

/**
 * @public
 * @status essential
 *
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
   * @public
   * @status essential
   *
   * Destroys the marker, causing it to emit the 'destroyed' event. Once
   * destroyed, a marker cannot be restored by undo/redo operations.
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
   * @public
   * @status essential
   *
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
   */
  copy(params) {
    return this.layer.getMarker(this.bufferMarker.copy(params).id);
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status essential
   *
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
   */
  onDidChange(callback) {
    if (!this.hasChangeObservers) {
      this.oldHeadBufferPosition = this.getHeadBufferPosition().freeze();
      this.oldHeadScreenPosition = this.getHeadScreenPosition().freeze();
      this.oldTailBufferPosition = this.getTailBufferPosition().freeze();
      this.oldTailScreenPosition = this.getTailScreenPosition().freeze();
      this.wasValid = this.isValid();
      this.stampPositionCacheGenerations();
      this.bufferMarkerSubscription = this.bufferMarker.onDidChange((event) =>
        this.notifyObservers(event),
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
   * @public
   * @status essential
   *
   * Invoke the given callback when the marker is destroyed.
   *
   * @param {Function} callback - to be called when the marker is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
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
   * @public
   * @status essential
   *
   * @returns {Boolean} indicating whether the marker is valid. Markers can be invalidated when a region surrounding them in the buffer is changed.
   */
  isValid() {
    return this.bufferMarker.isValid();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Boolean} indicating whether the marker has been destroyed. A marker can be invalid without being destroyed, in which case undoing the invalidating operation would restore the marker. Once a marker is destroyed by calling {@link DisplayMarker#destroy}, no undo/redo operation can ever bring it back.
   */
  isDestroyed() {
    return this.layer.isDestroyed() || this.bufferMarker.isDestroyed();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Boolean} indicating whether the head precedes the tail.
   */
  isReversed() {
    return this.bufferMarker.isReversed();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Boolean} indicating whether changes that occur exactly at the marker's head or tail cause it to move.
   */
  isExclusive() {
    return this.bufferMarker.isExclusive();
  }

  /**
   * @public
   * @status essential
   *
   * Get the invalidation strategy for this marker.
   *
   * Valid values include: `never`, `surround`, `overlap`, `inside`, and `touch`.
   *
   * @returns {String}
   */
  getInvalidationStrategy() {
    return this.bufferMarker.getInvalidationStrategy();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Object} containing any custom properties associated with the marker.
   */
  getProperties() {
    return this.bufferMarker.getProperties();
  }

  /**
   * @public
   * @status essential
   *
   * Merges an `Object` containing new properties into the marker's
   * existing properties.
   *
   * @param {Object} properties
   */
  setProperties(properties) {
    return this.bufferMarker.setProperties(properties);
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Boolean} whether this marker matches the given parameters. The parameters are the same as {@link DisplayMarkerLayer#findMarkers}.
   */
  matchesProperties(attributes) {
    attributes = this.layer.translateToBufferMarkerParams(attributes);
    return this.bufferMarker.matchesParams(attributes);
  }

  /**
   * @category Comparing to other markers
   */

  /**
   * @public
   * @status essential
   *
   * Compares this marker to another based on their ranges.
   *
   * @param {DisplayMarker} otherMarker - The marker to compare.
   * @returns {Number} The ordering of this marker relative to `otherMarker`.
   */
  compare(otherMarker) {
    return this.bufferMarker.compare(otherMarker.bufferMarker);
  }

  /**
   * @public
   * @status essential
   *
   * @param {DisplayMarker} other - other marker
   * @returns {Boolean} indicating whether this marker is equivalent to another marker, meaning they have the same range and options.
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
   * @public
   * @status essential
   *
   * Gets the buffer range of this marker.
   *
   * @returns {Range}
   */
  getBufferRange() {
    this.refreshBufferPositionCacheIfNeeded();
    if (this.hasCurrentBufferPositionCache()) {
      return new Range(this.oldHeadBufferPosition.copy(), this.oldTailBufferPosition.copy());
    }
    return this.bufferMarker.getRange();
  }

  /**
   * @public
   * @status essential
   *
   * Gets the screen range of this marker.
   *
   * @returns {Range}
   */
  getScreenRange() {
    this.refreshScreenPositionCacheIfNeeded();
    if (this.hasCurrentScreenPositionCache()) {
      return new Range(this.oldHeadScreenPosition.copy(), this.oldTailScreenPosition.copy());
    }
    return this.layer.translateBufferRange(this.getBufferRange());
  }

  /**
   * @public
   * @status essential
   *
   * Modifies the buffer range of this marker.
   *
   * @param bufferRange - The new {@link Range} to use
   * @param {Object} [properties] - properties to associate with the marker.
   * @param {Boolean} properties.reversed - If true, the marker will to be in a reversed orientation.
   */
  setBufferRange(bufferRange, properties) {
    return this.bufferMarker.setRange(bufferRange, properties);
  }

  /**
   * @public
   * @status essential
   *
   * Modifies the screen range of this marker.
   *
   * @param screenRange - The new {@link Range} to use
   * @param [options] - An `Object` with the following keys:
   * @param {Boolean} options.reversed - If true, the marker will to be in a reversed orientation.
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'` and applies to both ends of the range.
   */
  setScreenRange(screenRange, options) {
    return this.setBufferRange(this.layer.translateScreenRange(screenRange, options), options);
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the buffer position of the marker's head.
   *
   * @returns {Point}
   */
  getHeadBufferPosition() {
    this.refreshBufferPositionCacheIfNeeded();
    if (this.hasCurrentBufferPositionCache()) return this.oldHeadBufferPosition.copy();
    return this.bufferMarker.getHeadPosition();
  }

  /**
   * @public
   * @status extended
   *
   * Sets the buffer position of the marker's head.
   *
   * @param bufferPosition - The new {@link Point} to use
   */
  setHeadBufferPosition(bufferPosition) {
    return this.bufferMarker.setHeadPosition(bufferPosition);
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the screen position of the marker's head.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's head screen position.
   */
  getHeadScreenPosition(options) {
    if (options == null) this.refreshScreenPositionCacheIfNeeded();
    if (this.hasCurrentScreenPositionCache() && options == null) {
      return this.oldHeadScreenPosition.copy();
    }
    return this.layer.translateBufferPosition(this.bufferMarker.getHeadPosition(), options);
  }

  /**
   * @public
   * @status extended
   *
   * Sets the screen position of the marker's head.
   *
   * @param screenPosition - The new {@link Point} to use
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   */
  setHeadScreenPosition(screenPosition, options) {
    return this.setHeadBufferPosition(this.layer.translateScreenPosition(screenPosition, options));
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the buffer position of the marker's tail.
   *
   * @returns {Point}
   */
  getTailBufferPosition() {
    this.refreshBufferPositionCacheIfNeeded();
    if (this.hasCurrentBufferPositionCache()) return this.oldTailBufferPosition.copy();
    return this.bufferMarker.getTailPosition();
  }

  /**
   * @public
   * @status extended
   *
   * Sets the buffer position of the marker's tail.
   *
   * @param bufferPosition - The new {@link Point} to use
   */
  setTailBufferPosition(bufferPosition) {
    return this.bufferMarker.setTailPosition(bufferPosition);
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the screen position of the marker's tail.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's tail screen position.
   */
  getTailScreenPosition(options) {
    if (options == null) this.refreshScreenPositionCacheIfNeeded();
    if (this.hasCurrentScreenPositionCache() && options == null) {
      return this.oldTailScreenPosition.copy();
    }
    return this.layer.translateBufferPosition(this.bufferMarker.getTailPosition(), options);
  }

  /**
   * @public
   * @status extended
   *
   * Sets the screen position of the marker's tail.
   *
   * @param screenPosition - The new {@link Point} to use
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   */
  setTailScreenPosition(screenPosition, options) {
    return this.bufferMarker.setTailPosition(
      this.layer.translateScreenPosition(screenPosition, options),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the buffer position of the marker's start. This will always be
   * less than or equal to the result of {@link DisplayMarker#getEndBufferPosition}.
   *
   * @returns {Point}
   */
  getStartBufferPosition() {
    this.refreshBufferPositionCacheIfNeeded();
    if (this.hasCurrentBufferPositionCache()) return this.getBufferRange().start;
    return this.bufferMarker.getStartPosition();
  }

  /**
   * @public
   * @status essential
   *
   * Retrieves the screen position of the marker's start. This will always be
   * less than or equal to the result of {@link DisplayMarker#getEndScreenPosition}.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's start screen position.
   */
  getStartScreenPosition(options) {
    return this.layer.translateBufferPosition(this.getStartBufferPosition(), options);
  }

  /**
   * @public
   * @status extended
   *
   * Retrieves the buffer position of the marker's end. This will always be
   * greater than or equal to the result of {@link DisplayMarker#getStartBufferPosition}.
   *
   * @returns {Point}
   */
  getEndBufferPosition() {
    this.refreshBufferPositionCacheIfNeeded();
    if (this.hasCurrentBufferPositionCache()) return this.getBufferRange().end;
    return this.bufferMarker.getEndPosition();
  }

  /**
   * @public
   * @status essential
   *
   * Retrieves the screen position of the marker's end. This will always be
   * greater than or equal to the result of {@link DisplayMarker#getStartScreenPosition}.
   *
   * @param [options] - An `Object` with the following keys:
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The marker's end screen position.
   */
  getEndScreenPosition(options) {
    return this.layer.translateBufferPosition(this.getEndBufferPosition(), options);
  }

  /**
   * @public
   * @status extended
   *
   * @returns {Boolean} indicating whether the marker has a tail.
   */
  hasTail() {
    return this.bufferMarker.hasTail();
  }

  /**
   * @public
   * @status extended
   *
   * Plants the marker's tail at the current head position. After calling
   * the marker's tail position will be its head position at the time of the
   * call, regardless of where the marker's head is moved.
   */
  plantTail() {
    return this.bufferMarker.plantTail();
  }

  /**
   * @public
   * @status extended
   *
   * Removes the marker's tail. After calling the marker's head position
   * will be reported as its current tail position until the tail is planted
   * again.
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

  hasCurrentBufferPositionCache() {
    return (
      this.hasChangeObservers &&
      !this.layer.bufferMarkerPositionsDirty &&
      this.cachedBufferMarkerPositionGeneration === this.bufferMarker.positionGeneration &&
      this.cachedBufferLayerPositionGeneration === this.layer.bufferMarkerPositionGeneration
    );
  }

  hasCurrentScreenPositionCache() {
    return (
      this.hasCurrentBufferPositionCache() &&
      !this.layer.screenPositionsDirty &&
      this.cachedScreenPositionGeneration === this.layer.screenPositionGeneration
    );
  }

  refreshBufferPositionCacheIfNeeded() {
    if (
      !this.hasChangeObservers ||
      this.hasCurrentBufferPositionCache() ||
      this.layer.bufferMarkerPositionsDirty ||
      this.bufferMarker.changeEventDepth > 0
    ) {
      return;
    }

    this.oldHeadBufferPosition = this.bufferMarker.getHeadPosition().freeze();
    this.oldTailBufferPosition = this.bufferMarker.getTailPosition().freeze();
    this.cachedBufferMarkerPositionGeneration = this.bufferMarker.positionGeneration;
    this.cachedBufferLayerPositionGeneration = this.layer.bufferMarkerPositionGeneration;
  }

  refreshScreenPositionCacheIfNeeded() {
    if (!this.hasChangeObservers || this.hasCurrentScreenPositionCache()) return;
    this.refreshBufferPositionCacheIfNeeded();
    if (
      !this.hasCurrentBufferPositionCache() ||
      this.layer.screenPositionsDirty ||
      this.bufferMarker.changeEventDepth > 0
    ) {
      return;
    }

    this.oldHeadScreenPosition = this.layer
      .translateBufferPosition(this.oldHeadBufferPosition)
      .freeze();
    this.oldTailScreenPosition = this.layer
      .translateBufferPosition(this.oldTailBufferPosition)
      .freeze();
    this.cachedScreenPositionGeneration = this.layer.screenPositionGeneration;
  }

  stampPositionCacheGenerations() {
    this.cachedBufferMarkerPositionGeneration = this.bufferMarker.positionGeneration;
    this.cachedBufferLayerPositionGeneration = this.layer.bufferMarkerPositionGeneration;
    this.cachedScreenPositionGeneration = this.layer.screenPositionGeneration;
  }

  notifyObservers(change) {
    if (!this.hasChangeObservers) {
      return;
    }

    // A direct BufferMarker change cannot have changed the display mapping, so
    // an endpoint whose buffer position stayed put keeps its cached screen
    // position. The boolean form comes from DisplayMarkerLayer after folds or
    // wrapping changed; that path deliberately re-translates everything.
    const markerChange = change != null && typeof change === "object" ? change : null;
    const textChanged = markerChange ? markerChange.textChanged : Boolean(change);
    const directMarkerChange = markerChange && !textChanged;
    // Always re-read. Text-change events can carry another edit session's
    // selection snapshot, and an earlier listener can move the BufferMarker
    // reentrantly before this listener receives a direct event.
    const newHeadBufferPosition = this.bufferMarker.getHeadPosition();
    const newTailBufferPosition = this.bufferMarker.getTailPosition();
    const canReuseScreenPosition =
      directMarkerChange &&
      !this.layer.bufferMarkerPositionsDirty &&
      !this.layer.screenPositionsDirty &&
      this.cachedBufferLayerPositionGeneration === this.layer.bufferMarkerPositionGeneration &&
      this.cachedScreenPositionGeneration === this.layer.screenPositionGeneration;
    const newHeadScreenPosition =
      canReuseScreenPosition && newHeadBufferPosition.isEqual(this.oldHeadBufferPosition)
        ? this.oldHeadScreenPosition
        : this.layer.translateBufferPosition(newHeadBufferPosition);
    const newTailScreenPosition =
      canReuseScreenPosition && newTailBufferPosition.isEqual(this.oldTailBufferPosition)
        ? this.oldTailScreenPosition
        : this.layer.translateBufferPosition(newTailBufferPosition);
    const isValid = this.isValid();

    if (
      isValid === this.wasValid &&
      newHeadBufferPosition.isEqual(this.oldHeadBufferPosition) &&
      newHeadScreenPosition.isEqual(this.oldHeadScreenPosition) &&
      newTailBufferPosition.isEqual(this.oldTailBufferPosition) &&
      newTailScreenPosition.isEqual(this.oldTailScreenPosition)
    ) {
      this.stampPositionCacheGenerations();
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

    // Cached positions are also returned by the public getters. Keep them
    // immutable so mutating a returned Point cannot corrupt future reads or
    // change-event comparisons.
    this.oldHeadBufferPosition = newHeadBufferPosition.freeze();
    this.oldHeadScreenPosition = newHeadScreenPosition.freeze();
    this.oldTailBufferPosition = newTailBufferPosition.freeze();
    this.oldTailScreenPosition = newTailScreenPosition.freeze();
    this.wasValid = isValid;
    this.stampPositionCacheGenerations();

    return this.emitter.emit("did-change", changeEvent);
  }
}

module.exports = DisplayMarker;
