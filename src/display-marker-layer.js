const { Emitter, CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const DisplayMarker = require("./display-marker");
const Range = require("./range");
const Point = require("./point");

/**
 * @public
 * @status experimental
 *
 * A container for a related set of markers at the `DisplayLayer` level. Wraps
 * an underlying {@link MarkerLayer} on the {@link TextBuffer}.
 */
class DisplayMarkerLayer {
  constructor(displayLayer, bufferMarkerLayer, ownsBufferMarkerLayer) {
    this.displayLayer = displayLayer;
    this.bufferMarkerLayer = bufferMarkerLayer;
    this.ownsBufferMarkerLayer = ownsBufferMarkerLayer;
    this.id = this.bufferMarkerLayer.id;
    this.bufferMarkerLayer.displayMarkerLayers.add(this);
    this.markersById = new Map();
    this.destroyed = false;
    this.bufferMarkerPositionsDirty = false;
    this.screenPositionsDirty = false;
    this.bufferMarkerPositionGeneration = 0;
    this.screenPositionGeneration = 0;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.markersWithDestroyListeners = new Set();
    this.subscriptions.add(this.bufferMarkerLayer.onDidUpdate(this.emitDidUpdate.bind(this)));
  }

  /**
   * @category Lifecycle
   */

  /**
   * @public
   * @status essential
   *
   * Destroy this layer.
   * @returns {void}
   */
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    if (this.ownsBufferMarkerLayer) {
      this.clear();
    }
    this.subscriptions.dispose();
    this.bufferMarkerLayer.displayMarkerLayers.delete(this);
    if (this.ownsBufferMarkerLayer) {
      this.bufferMarkerLayer.destroy();
    }
    this.displayLayer.didDestroyMarkerLayer(this.id);

    this.emitter.emit("did-destroy");
    this.emitter.clear();
  }

  /**
   * @public
   * @status public
   *
   * Destroy all markers in this layer.
   * @returns {void}
   */
  clear() {
    this.bufferMarkerLayer.clear();
  }

  didClearBufferMarkerLayer() {
    for (let marker of this.markersWithDestroyListeners) {
      marker.didDestroyBufferMarker();
    }
    this.markersById = new Map();
  }

  /**
   * @public
   * @status essential
   *
   * Determine whether this layer has been destroyed.
   *
   * @returns {Boolean}
   */
  isDestroyed() {
    return this.destroyed;
  }

  /**
   * @category Range Tracking
   */

  /**
   * @public
   * @status experimental
   *
   * Set this layer's custom range tracker in buffer coordinates. See
   * {@link MarkerLayer#setRangeTracker} for the callback contract.
   *
   * @param {Function|null} [callback] - A range tracker, or `null` to disable it.
   */
  setRangeTracker(callback) {
    this.bufferMarkerLayer.setRangeTracker(callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Get the custom tracker used for buffer-coordinate ranges.
   *
   * @returns {Function|null} The custom range tracker, or `null` when native tracking is used.
   */
  getRangeTracker() {
    return this.bufferMarkerLayer.getRangeTracker();
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status public
   *
   * Subscribe to be notified synchronously when this layer is destroyed.
   *
   * @param {Function} callback
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to be notified whenever markers are
   * created, updated, or destroyed on this layer. *Prefer this method for
   * optimal performance when interacting with layers that could contain large
   * numbers of markers.*
   *
   *
   * Changes made within a {@link TextBuffer#transact} block are batched: subscribers
   * are notified once, at the end of the transaction. Changes made outside a
   * transaction notify subscribers synchronously per change. You should re-query the layer
   * to determine the state of markers in which you're interested in. It may
   * be counter-intuitive, but this is much more efficient than subscribing to
   * events on individual markers, which are expensive to deliver.
   *
   * @param {Function} callback - A `Function` that will be called with no arguments when changes occur on this layer.
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe to be notified synchronously whenever markers are created
   * on this layer. *Avoid this method for optimal performance when interacting
   * with layers that could contain large numbers of markers.*
   *
   *
   * You should prefer {@link #onDidUpdate} when synchronous notifications aren't
   * absolutely necessary.
   *
   * @param {Function} callback - A `Function` that will be called with a {@link DisplayMarker} whenever a new marker is created.
   * @param {DisplayMarker} callback.marker - The newly created marker.
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidCreateMarker(callback) {
    const subscription = this.bufferMarkerLayer.onDidCreateMarker((bufferMarker) => {
      return callback(this.getMarker(bufferMarker.id));
    });
    // Track the subscription so it doesn't outlive this layer when the
    // underlying buffer marker layer isn't owned by it.
    this.subscriptions.add(subscription);
    return new Disposable(() => {
      this.subscriptions.remove(subscription);
      subscription.dispose();
    });
  }

  /**
   * @category Marker Creation
   */

  /**
   * @public
   * @status public
   *
   * Create a marker with the given screen range.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} screenRange - The range to mark; compatible arrays and coordinate objects are accepted.
   * @param {Object} [options] - Marker options and custom properties.
   * @param {Boolean} [options.reversed=false] - Place the head at the earlier endpoint.
   * @param {String} [options.invalidate='overlap'] - Invalidation strategy: `never`, `surround`, `overlap`, `inside`, or `touch`. See {@link DisplayMarker} for the strategy definitions.
   * @param {Boolean} [options.exclusive] - Keep endpoint insertions outside the marker. Defaults to `false`, or `true` with the `inside` invalidation strategy.
   * @param {String} [options.clipDirection='closest'] - Clip invalid screen positions `backward`, `forward`, or to the `closest` valid position.
   * @returns {DisplayMarker} The new marker.
   */
  markScreenRange(screenRange, options) {
    screenRange = Range.fromObject(screenRange);
    const bufferRange = this.displayLayer.translateScreenRange(screenRange, options);
    return this.getMarker(this.bufferMarkerLayer.markRange(bufferRange, options).id);
  }

  /**
   * @public
   * @status public
   *
   * Create a marker with its head at the given screen position and no tail.
   *
   * @param {Point|Array<Number>|Object} screenPosition - The position to mark; compatible arrays and coordinate objects are accepted.
   * @param {Object} [options] - Marker options and custom properties.
   * @param {String} [options.invalidate='overlap'] - Invalidation strategy: `never`, `surround`, `overlap`, `inside`, or `touch`. See {@link DisplayMarker} for the strategy definitions.
   * @param {Boolean} [options.exclusive] - Keep endpoint insertions outside the marker. Defaults to `true` for markers without a tail.
   * @param {String} [options.clipDirection='closest'] - Clip invalid screen positions `backward`, `forward`, or to the `closest` valid position.
   * @returns {DisplayMarker} The new marker.
   */
  markScreenPosition(screenPosition, options) {
    screenPosition = Point.fromObject(screenPosition);
    const bufferPosition = this.displayLayer.translateScreenPosition(screenPosition, options);
    return this.getMarker(this.bufferMarkerLayer.markPosition(bufferPosition, options).id);
  }

  /**
   * @public
   * @status public
   *
   * Create a marker with the given buffer range.
   *
   * @param {Range|Array<Point|Array<Number>>|Object} bufferRange - The range to mark; compatible arrays and coordinate objects are accepted.
   * @param {Object} [options] - Marker options and custom properties.
   * @param {Boolean} [options.reversed=false] - Place the head at the earlier endpoint.
   * @param {String} [options.invalidate='overlap'] - Invalidation strategy: `never`, `surround`, `overlap`, `inside`, or `touch`. See {@link DisplayMarker} for the strategy definitions.
   * @param {Boolean} [options.exclusive] - Keep endpoint insertions outside the marker. Defaults to `false`, or `true` with the `inside` invalidation strategy.
   * @returns {DisplayMarker} The new marker.
   */
  markBufferRange(bufferRange, options) {
    bufferRange = Range.fromObject(bufferRange);
    return this.getMarker(this.bufferMarkerLayer.markRange(bufferRange, options).id);
  }

  /**
   * @public
   * @status public
   *
   * Create a marker with its head at the given buffer position and no tail.
   *
   * @param {Point|Array<Number>|Object} bufferPosition - The position to mark; compatible arrays and coordinate objects are accepted.
   * @param {Object} [options] - Marker options and custom properties.
   * @param {String} [options.invalidate='overlap'] - Invalidation strategy: `never`, `surround`, `overlap`, `inside`, or `touch`. See {@link DisplayMarker} for the strategy definitions.
   * @param {Boolean} [options.exclusive] - Keep endpoint insertions outside the marker. Defaults to `true` for markers without a tail.
   * @returns {DisplayMarker} The new marker.
   */
  markBufferPosition(bufferPosition, options) {
    return this.getMarker(
      this.bufferMarkerLayer.markPosition(Point.fromObject(bufferPosition), options).id,
    );
  }

  /**
   * @category Querying
   */

  /**
   * @public
   * @status essential
   *
   * Get an existing marker by its id.
   *
   * @param {Number|String} id
   * @returns {DisplayMarker|undefined} The marker, or `undefined` when no marker with that id exists.
   */
  getMarker(id) {
    id = parseInt(id);
    const displayMarker = this.markersById.get(id);
    if (displayMarker) {
      return displayMarker;
    }
    const bufferMarker = this.bufferMarkerLayer.getMarker(id);
    if (bufferMarker) {
      const marker = new DisplayMarker(this, bufferMarker);
      this.markersById.set(id, marker);
      return marker;
    }
  }

  /**
   * @public
   * @status essential
   *
   * Get all markers in the layer.
   *
   * @returns {Array<DisplayMarker>} All markers in the layer.
   */
  getMarkers() {
    return this.bufferMarkerLayer.getMarkers().map(({ id }) => this.getMarker(id));
  }

  /**
   * @public
   * @status public
   *
   * Get the number of markers in the marker layer.
   *
   * @returns {Number} The number of markers in this layer.
   */
  getMarkerCount() {
    return this.bufferMarkerLayer.getMarkerCount();
  }

  /**
   * @public
   * @status public
   *
   * Find markers in the layer conforming to the given parameters.
   *
   * This method finds markers based on the given properties. Markers can be
   * associated with custom properties that will be compared with deep equality.
   * In addition, there are several special properties that will be compared
   * with the range of the markers rather than their properties.
   *
   * @param {Object} params - An `Object` containing properties that each returned marker must satisfy. Markers can be associated with custom properties, which are compared with deep equality. In addition, several reserved properties can be used to filter markers based on their current range:
   * @param {Point|Array<Number>|Object} [params.startBufferPosition] - Only include markers starting at this {@link Point} in buffer coordinates.
   * @param {Point|Array<Number>|Object} [params.endBufferPosition] - Only include markers ending at this {@link Point} in buffer coordinates.
   * @param {Point|Array<Number>|Object} [params.startScreenPosition] - Only include markers starting at this {@link Point} in screen coordinates.
   * @param {Point|Array<Number>|Object} [params.endScreenPosition] - Only include markers ending at this {@link Point} in screen coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.startsInBufferRange] - Only include markers starting inside this {@link Range} in buffer coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.endsInBufferRange] - Only include markers ending inside this {@link Range} in buffer coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.startsInScreenRange] - Only include markers starting inside this {@link Range} in screen coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.endsInScreenRange] - Only include markers ending inside this {@link Range} in screen coordinates.
   * @param {Number} [params.startBufferRow] - Only include markers starting at this row in buffer coordinates.
   * @param {Number} [params.endBufferRow] - Only include markers ending at this row in buffer coordinates.
   * @param {Number} [params.startScreenRow] - Only include markers starting at this row in screen coordinates.
   * @param {Number} [params.endScreenRow] - Only include markers ending at this row in screen coordinates.
   * @param {Array<Number>} [params.intersectsBufferRowRange] - Only include markers intersecting this `Array` of `[startRow, endRow]` in buffer coordinates.
   * @param {Array<Number>} [params.intersectsScreenRowRange] - Only include markers intersecting this `Array` of `[startRow, endRow]` in screen coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.containsBufferRange] - Only include markers containing this {@link Range} in buffer coordinates.
   * @param {Point|Array<Number>|Object} [params.containsBufferPosition] - Only include markers containing this {@link Point} in buffer coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.containedInBufferRange] - Only include markers contained in this {@link Range} in buffer coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.containedInScreenRange] - Only include markers contained in this {@link Range} in screen coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.intersectsBufferRange] - Only include markers intersecting this {@link Range} in buffer coordinates.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.intersectsScreenRange] - Only include markers intersecting this {@link Range} in screen coordinates.
   * @param {Point|Array<Number>|Object} [params.containsScreenPosition] - Include markers containing this screen position.
   * @param {Range|Array<Point|Array<Number>>|Object} [params.containsScreenRange] - Include markers containing this screen range.
   * @returns {Array<DisplayMarker>} Matching markers ordered by start position, then descending end position and id.
   */
  findMarkers(params) {
    params = this.translateToBufferMarkerLayerFindParams(params);
    return this.bufferMarkerLayer
      .findMarkers(params)
      .map((stringMarker) => this.getMarker(stringMarker.id));
  }

  /**
   * @category Private
   */

  translateBufferPosition(bufferPosition, options) {
    return this.displayLayer.translateBufferPosition(bufferPosition, options);
  }

  translateBufferRange(bufferRange, options) {
    return this.displayLayer.translateBufferRange(bufferRange, options);
  }

  translateScreenPosition(screenPosition, options) {
    return this.displayLayer.translateScreenPosition(screenPosition, options);
  }

  translateScreenRange(screenRange, options) {
    return this.displayLayer.translateScreenRange(screenRange, options);
  }

  emitDidUpdate() {
    return this.emitter.emit("did-update");
  }

  notifyObserversIfMarkerScreenPositionsChanged() {
    if (!this.screenPositionsDirty) this.markScreenPositionsDirty();
    let completed = false;
    try {
      for (let marker of this.getMarkers()) {
        marker.notifyObservers(false);
      }
      completed = true;
    } finally {
      // If an observer throws, later markers still hold positions from the old
      // display mapping. Leave the layer dirty so their getters take the live
      // path until a later successful pass refreshes every cache.
      if (completed) this.screenPositionsDirty = false;
    }
  }

  bufferMarkerRangesDidChange() {
    this.bufferMarkerPositionGeneration++;
    this.bufferMarkerPositionsDirty = true;
  }

  markScreenPositionsDirty() {
    this.screenPositionGeneration++;
    this.screenPositionsDirty = true;
  }

  didEmitBufferMarkerChangeEvents() {
    this.bufferMarkerPositionsDirty = false;
    this.screenPositionsDirty = false;
  }

  destroyMarker(id) {
    const marker = this.markersById.get(id);
    if (marker) {
      return marker.didDestroyBufferMarker();
    }
  }

  didDestroyMarker(marker) {
    this.markersWithDestroyListeners.delete(marker);
    return this.markersById.delete(marker.id);
  }

  translateToBufferMarkerLayerFindParams(params) {
    const bufferMarkerLayerFindParams = {};
    for (let key in params) {
      let value = params[key];
      switch (key) {
        case "startBufferPosition":
          key = "startPosition";
          break;
        case "endBufferPosition":
          key = "endPosition";
          break;
        case "startScreenPosition":
          key = "startPosition";
          value = this.displayLayer.translateScreenPosition(value);
          break;
        case "endScreenPosition":
          key = "endPosition";
          value = this.displayLayer.translateScreenPosition(value);
          break;
        case "startsInBufferRange":
          key = "startsInRange";
          break;
        case "endsInBufferRange":
          key = "endsInRange";
          break;
        case "startsInScreenRange":
          key = "startsInRange";
          value = this.displayLayer.translateScreenRange(value);
          break;
        case "endsInScreenRange":
          key = "endsInRange";
          value = this.displayLayer.translateScreenRange(value);
          break;
        case "startBufferRow":
          key = "startRow";
          break;
        case "endBufferRow":
          key = "endRow";
          break;
        case "startScreenRow":
          key = "startsInRange";
          var startBufferPosition = this.displayLayer.translateScreenPosition(Point(value, 0));
          var endBufferPosition = this.displayLayer.translateScreenPosition(Point(value, Infinity));
          value = Range(startBufferPosition, endBufferPosition);
          break;
        case "endScreenRow":
          key = "endsInRange";
          startBufferPosition = this.displayLayer.translateScreenPosition(Point(value, 0));
          endBufferPosition = this.displayLayer.translateScreenPosition(Point(value, Infinity));
          value = Range(startBufferPosition, endBufferPosition);
          break;
        case "intersectsBufferRowRange":
          key = "intersectsRowRange";
          break;
        case "intersectsScreenRowRange":
          key = "intersectsRange";
          var [startScreenRow, endScreenRow] = Array.from(value);
          startBufferPosition = this.displayLayer.translateScreenPosition(Point(startScreenRow, 0));
          endBufferPosition = this.displayLayer.translateScreenPosition(
            Point(endScreenRow, Infinity),
          );
          value = Range(startBufferPosition, endBufferPosition);
          break;
        case "containsBufferRange":
          key = "containsRange";
          break;
        case "containsScreenRange":
          key = "containsRange";
          value = this.displayLayer.translateScreenRange(value);
          break;
        case "containsBufferPosition":
          key = "containsPosition";
          break;
        case "containsScreenPosition":
          key = "containsPosition";
          value = this.displayLayer.translateScreenPosition(value);
          break;
        case "containedInBufferRange":
          key = "containedInRange";
          break;
        case "containedInScreenRange":
          key = "containedInRange";
          value = this.displayLayer.translateScreenRange(value);
          break;
        case "intersectsBufferRange":
          key = "intersectsRange";
          break;
        case "intersectsScreenRange":
          key = "intersectsRange";
          value = this.displayLayer.translateScreenRange(value);
          break;
      }
      bufferMarkerLayerFindParams[key] = value;
    }

    return bufferMarkerLayerFindParams;
  }
}

module.exports = DisplayMarkerLayer;
