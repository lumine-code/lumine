const Pane = require("./pane");

/**
 * A one-item pane presented outside the tiled pane tree.
 *
 * Detached panes still belong to the workspace center. Their separate type
 * exists to keep their capacity, routing, lifecycle, and serialization rules
 * out of the ordinary pane implementation.
 */
module.exports = class DetachedPane extends Pane {
  static deserialize(state, { deserializers, applicationDelegate, config, notifications, views }) {
    const item = deserializers.deserialize(state.item);
    if (!item) return;

    return new DetachedPane({
      id: state.id,
      item,
      returnPaneId: state.returnTarget && state.returnTarget.paneId,
      returnItemIndex: state.returnTarget && state.returnTarget.itemIndex,
      surfaceState: state.surface,
      applicationDelegate,
      config,
      notificationManager: notifications,
      deserializerManager: deserializers,
      viewRegistry: views,
    });
  }

  constructor(params = {}) {
    const item = params.item;
    super(Object.assign({}, params, { items: item ? [item] : [] }));
    this.returnPaneId = params.returnPaneId;
    this.returnItemIndex = params.returnItemIndex != null ? params.returnItemIndex : 0;
    this.surfaceState = params.surfaceState || null;
  }

  isDetached() {
    return true;
  }

  isActive() {
    return this.isAlive();
  }

  onDidChangeActive(callback) {
    return this.emitter.on("did-change-detached-active", callback);
  }

  canAcceptItem(item) {
    return this.items.length === 0 || this.items.includes(item);
  }

  getReturnPaneId() {
    return this.returnPaneId;
  }

  getReturnItemIndex() {
    return this.returnItemIndex;
  }

  setReturnTarget(pane, itemIndex = 0) {
    this.returnPaneId = pane && pane.id;
    this.returnItemIndex = itemIndex;
  }

  getReturnPane() {
    return this.container && this.container.resolveReturnPane(this);
  }

  getSurfaceState() {
    return this.surfaceState;
  }

  setSurfaceState(surfaceState) {
    this.surfaceState = surfaceState;
  }

  serialize() {
    const item = this.getActiveItem();
    if (!item || typeof item.serialize !== "function") return null;
    return {
      deserializer: "DetachedPane",
      id: this.id,
      item: item.serialize(),
      returnTarget: {
        paneId: this.returnPaneId,
        itemIndex: this.returnItemIndex,
      },
      surface: this.surfaceState,
    };
  }

  addItem(item, options = {}) {
    if (this.canAcceptItem(item)) return super.addItem(item, options);
    const target = this.getReturnPane();
    if (!target) throw new Error("Detached pane has no tiled insertion target");
    return target.addItem(item, options);
  }

  activateItem(item, options = {}) {
    if (this.items.includes(item) || this.items.length === 0) {
      return super.activateItem(item, options);
    }
    const target = this.getReturnPane();
    if (!target) throw new Error("Detached pane has no tiled insertion target");
    this.container.focusPrimaryWindow?.();
    target.activateItem(item, options);
    target.activate();
    return item;
  }

  setPendingItem(_item) {}

  togglePendingItem() {}

  increaseSize() {}

  decreaseSize() {}

  attach(options) {
    if (!this.container) return;
    return this.container.detachedPaneAttacher
      ? this.container.detachedPaneAttacher(this, options)
      : this.container.attachDetachedPane(this, options);
  }

  splitLeft(params) {
    return this.splitTiled("splitLeft", params);
  }

  splitRight(params) {
    return this.splitTiled("splitRight", params);
  }

  splitUp(params) {
    return this.splitTiled("splitUp", params);
  }

  splitDown(params) {
    return this.splitTiled("splitDown", params);
  }

  splitTiled(method, params = {}) {
    const target = this.getReturnPane();
    this.container.focusPrimaryWindow?.();
    const splitParams = Object.assign({}, params);
    const moveActiveItem = splitParams.moveActiveItem;
    const copyActiveItem = splitParams.copyActiveItem;
    delete splitParams.moveActiveItem;
    delete splitParams.copyActiveItem;

    if (copyActiveItem) {
      const copy = this.copyActiveItem();
      if (copy) splitParams.items = (splitParams.items || []).concat(copy);
    }

    const newPane = target[method](splitParams);
    if (moveActiveItem) {
      const attached = this.attach({ pane: newPane, index: 0 });
      if (attached?.then) return attached.then(() => newPane);
    }
    return newPane;
  }

  findLeftmostSibling() {
    return this.getReturnPane().findLeftmostSibling();
  }

  findRightmostSibling() {
    return this.getReturnPane().findRightmostSibling();
  }

  findOrCreateLeftmostSibling(params) {
    return this.getReturnPane().findOrCreateLeftmostSibling(params);
  }

  findOrCreateRightmostSibling(params) {
    return this.getReturnPane().findOrCreateRightmostSibling(params);
  }

  findTopmostSibling() {
    return this.getReturnPane().findTopmostSibling();
  }

  findBottommostSibling() {
    return this.getReturnPane().findBottommostSibling();
  }

  findOrCreateTopmostSibling(params) {
    return this.getReturnPane().findOrCreateTopmostSibling(params);
  }

  findOrCreateBottommostSibling(params) {
    return this.getReturnPane().findOrCreateBottommostSibling(params);
  }
};
