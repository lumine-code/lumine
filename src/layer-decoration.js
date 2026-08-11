var idCounter = 0;

var nextId = function () {
  return idCounter++;
};

/**
 * Represents a decoration that applies to every marker on a given
 * layer. Created via {@link TextEditor#decorateMarkerLayer}.
 *
 * @public
 * @api-status Essential
 */
module.exports = class LayerDecoration {
  constructor(markerLayer, decorationManager, properties1) {
    this.markerLayer = markerLayer;
    this.decorationManager = decorationManager;
    this.properties = properties1;
    this.id = nextId();
    this.destroyed = false;
    this.markerLayerDestroyedDisposable = this.markerLayer.onDidDestroy(() => this.destroy());
    this.overridePropertiesByMarker = null;
  }

  /**
   * Destroys the decoration.
   *
   * @public
   * @api-status Essential
   */
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.markerLayerDestroyedDisposable.dispose();
    this.markerLayerDestroyedDisposable = null;
    this.destroyed = true;
    this.decorationManager.didDestroyLayerDecoration(this);
  }

  /**
   * Determine whether this decoration is destroyed.
   *
   * @returns {Boolean}
   * @public
   * @api-status Essential
   */
  isDestroyed() {
    return this.destroyed;
  }

  getId() {
    return this.id;
  }

  getMarkerLayer() {
    return this.markerLayer;
  }

  /**
   * Get this decoration's properties.
   *
   * @returns {Object}
   * @public
   * @api-status Essential
   */
  getProperties() {
    return this.properties;
  }

  /**
   * Set this decoration's properties.
   *
   * @param newProperties - See {@link TextEditor#decorateMarker} for more information on the properties. The `type` of `gutter` and `overlay` are not supported on layer decorations.
   * @public
   * @api-status Essential
   */
  setProperties(newProperties) {
    if (this.destroyed) {
      return;
    }
    this.properties = newProperties;
    this.decorationManager.emitDidUpdateDecorations();
  }

  /**
   * Override the decoration properties for a specific marker.
   *
   * @param marker - The {@link DisplayMarker} or `Marker` for which to override properties.
   * @param properties - An `Object` containing properties to apply to this marker. Pass `null` to clear the override.
   * @public
   * @api-status Essential
   */
  setPropertiesForMarker(marker, properties) {
    if (this.destroyed) {
      return;
    }
    if (this.overridePropertiesByMarker == null) {
      this.overridePropertiesByMarker = new Map();
    }
    marker = this.markerLayer.getMarker(marker.id);
    if (properties != null) {
      this.overridePropertiesByMarker.set(marker, properties);
    } else {
      this.overridePropertiesByMarker.delete(marker);
    }
    this.decorationManager.emitDidUpdateDecorations();
  }

  getPropertiesForMarker(marker) {
    if (!this.overridePropertiesByMarker) {
      return undefined;
    }
    return this.overridePropertiesByMarker.get(marker);
  }
};
