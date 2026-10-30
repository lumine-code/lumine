const fs = require("node:fs");
const path = require("node:path");
const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const {
  DOMScrollbarManager,
  scrollbarSize,
  createScrollbarRuntime,
  scrollbarPresentation,
} = require("./overlay-scrollbar");

/**
 * @public
 * @status public
 *
 * Shared scrollbar presentation and local geometry for document and package views.
 * Access this namespace through `lumine.scrollbars`.
 */
module.exports = class ScrollbarManager {
  constructor(environment) {
    this.environment = environment;
    this.documents = new Map();
    this.observations = new Set();
  }

  initialize() {
    this.clear();
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      this.environment.workspace.observeWindows((window) => {
        const document = window.getDocument();
        if (!document?.body) return;
        this.forDocument(document);
        this.subscriptions?.add(window.onDidDestroy(() => this.releaseDocument(document)));
      }),
      this.environment.themes.onDidChangeVariables(() => this.refresh()),
    );
    if (this.environment.document?.body) this.forDocument(this.environment.document);
  }

  forDocument(document) {
    if (!document.defaultView) return null;
    let manager = this.documents.get(document);
    if (!manager || manager.destroyed) {
      manager = new DOMScrollbarManager({
        document,
        scheduleRead: (callback) =>
          this.environment.views.readDocument(() => {
            for (const observation of this.observations) observation.rebind?.();
            callback();
          }),
        scheduleWrite: (callback) => this.environment.views.updateDocument(callback),
      });
      this.documents.set(document, manager);
    }
    return manager;
  }

  /**
   * @public
   * @status public
   *
   * Attach shared scrollbar chrome without wrapping or reparenting the scrollport.
   * @param {HTMLElement} element - Existing DOM scrollport.
   * @param {Object} [options] - layout (overlay or gutter), policy (auto, always or hover), edge (left or right), focusOwner, zIndex and horizontal/vertical axis overrides. Defaults use overlays for primary pane scrollports and reserved, always-visible gutters for nested surfaces.
   * @returns {Object|null} A controller with refresh() and dispose(), or null for an inert document.
   * @category DOM Surfaces
   */
  attach(element, options = {}) {
    return this.forDocument(element.ownerDocument)?.attach(element, options) ?? null;
  }

  /**
   * @public
   * @status public
   *
   * Read track thickness and viewport/document extents in CSS pixels.
   * Thickness stays stable when a thumb is hidden or content fits the viewport.
   * @param {HTMLElement} element - Editor element or native DOM scrollport.
   * @returns {Object} layout (overlay or gutter); CSS-pixel verticalSize and horizontalSize track thicknesses, viewportWidth and viewportHeight excluding reserved gutters, verticalTrackSize and horizontalTrackSize lengths excluding the opposite rail, scrollWidth and scrollHeight, canScrollVertically and canScrollHorizontally. Editor snapshots also include rowGeometryVersion for marker projection invalidation.
   * @category Geometry
   */
  getGeometry(element) {
    const component = element.matches("lumine-text-editor") ? element.getComponent?.() : null;
    if (component)
      return {
        layout: component.getScrollbarLayout(),
        verticalSize: component.getVerticalScrollbarWidth(),
        horizontalSize: component.getHorizontalScrollbarHeight(),
        viewportWidth: component.getScrollContainerClientWidth(),
        viewportHeight: component.getScrollContainerClientHeight(),
        verticalTrackSize: Math.max(
          0,
          component.getScrollContainerHeight() -
            (component.canScrollHorizontally() ? component.getHorizontalScrollbarHeight() : 0),
        ),
        horizontalTrackSize: Math.max(
          0,
          component.getScrollContainerWidth() -
            (!component.props.model.getAutoWidth() || component.canScrollVertically()
              ? component.getVerticalScrollbarWidth()
              : 0),
        ),
        scrollWidth: component.getScrollWidth(),
        scrollHeight: component.getScrollHeight(),
        canScrollVertically: component.canScrollVertically(),
        canScrollHorizontally: component.canScrollHorizontally(),
        rowGeometryVersion: component.getRowGeometryVersion(),
      };
    const controller = this.documents.get(element.ownerDocument)?.controllers.get(element);
    if (controller?.publicGeometry) return controller.publicGeometry;
    const size = scrollbarSize(element);
    const layout = scrollbarPresentation(element).layout;
    return {
      layout,
      verticalSize: size,
      horizontalSize: size,
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
      verticalTrackSize: Math.max(
        0,
        element.clientHeight -
          (layout === "overlay" && element.scrollWidth > element.clientWidth ? size : 0),
      ),
      horizontalTrackSize: Math.max(
        0,
        element.clientWidth -
          (layout === "overlay" && element.scrollHeight > element.clientHeight ? size : 0),
      ),
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      canScrollVertically: element.scrollHeight > element.clientHeight,
      canScrollHorizontally: element.scrollWidth > element.clientWidth,
    };
  }

  /**
   * @public
   * @status public
   *
   * Obtain the local vertical track for a noninteractive marker canvas.
   * A DOM scrollport is attached to the shared manager if needed.
   * @param {HTMLElement} element - Editor element or native DOM scrollport.
   * @returns {HTMLElement|null} Track owned by this scroll surface.
   * @category Geometry
   */
  getVerticalTrack(element) {
    if (element.matches("lumine-text-editor"))
      return element.getComponent?.()?.refs.verticalScrollbar?.element ?? null;
    const manager = this.forDocument(element.ownerDocument);
    if (!manager) return null;
    return (manager.controllers.get(element) || manager.attach(element)).vertical.element;
  }

  /**
   * @public
   * @status public
   *
   * Observe geometry changes, independently of thumb movement.
   * @param {HTMLElement} element - Editor element or native DOM scrollport.
   * @param {Function} callback - Receives an immediate getGeometry(element) snapshot, then changed layout or geometry; scroll position alone does not trigger it.
   * @returns {Disposable} Removes exactly this observation.
   * @category Geometry
   */
  observe(element, callback) {
    let disposed = false;
    let scheduled;
    let previous;
    const publish = () => {
      scheduled = null;
      if (disposed) return;
      const geometry = this.getGeometry(element);
      const signature = JSON.stringify(geometry, [
        "layout",
        "verticalSize",
        "horizontalSize",
        "viewportWidth",
        "viewportHeight",
        "verticalTrackSize",
        "horizontalTrackSize",
        "scrollWidth",
        "scrollHeight",
        "canScrollVertically",
        "canScrollHorizontally",
        "rowGeometryVersion",
      ]);
      if (signature !== previous) {
        previous = signature;
        callback(geometry);
      }
    };
    const schedule = () => {
      if (!scheduled && !disposed) scheduled = this.environment.views.readDocument(publish);
    };
    const subscriptions = new CompositeDisposable();
    let window = null;
    let resizeObserver = null;
    let controller = null;
    let controllerSubscription = null;
    const model = element.matches("lumine-text-editor") ? element.getModel?.() : null;
    if (model) {
      for (const name of ["onDidChange", "onDidChangeSoftWrapped", "onDidUpdateDecorations"])
        if (typeof model[name] === "function") subscriptions.add(model[name](schedule));
      for (const name of ["onDidChangeScrollGeometry", "onDidAttach"])
        if (typeof element[name] === "function") subscriptions.add(element[name](schedule));
    }
    subscriptions.add(this.environment.themes.onDidChangeVariables(schedule));
    const observation = new Disposable(() => {
      disposed = true;
      scheduled?.dispose();
      resizeObserver?.disconnect();
      controllerSubscription?.dispose();
      controllerSubscription = controller = null;
      subscriptions.dispose();
      this.observations.delete(observation);
    });
    observation.rebind = (notify = true) => {
      if (disposed) return;
      let changed = false;
      const nextWindow = element.ownerDocument.defaultView;
      if (window !== nextWindow) {
        resizeObserver?.disconnect();
        resizeObserver = null;
        window = nextWindow;
        if (window) {
          resizeObserver = new window.ResizeObserver(schedule);
          resizeObserver.observe(element);
        }
        changed = true;
      }
      if (!model) {
        let nextController = this.documents.get(element.ownerDocument)?.controllers.get(element);
        if (nextController?.destroyed) nextController = null;
        if (!nextController && window && element.isConnected) nextController = this.attach(element);
        nextController ??= null;
        if (controller !== nextController) {
          controllerSubscription?.dispose();
          controllerSubscription = null;
          controller = nextController;
          if (controller) {
            const current = controller;
            current.callbacks.add(schedule);
            controllerSubscription = new Disposable(() => current.callbacks.delete(schedule));
          }
          changed = true;
        }
      }
      if (changed) {
        previous = null;
        if (notify) schedule();
      }
    };
    observation.element = element;
    this.observations.add(observation);
    observation.rebind(false);
    publish();
    return observation;
  }

  /**
   * @public
   * @status public
   *
   * Get the same DOM scrollbar runtime and styles for a trusted isolated frame.
   * @returns {String} Standalone browser script; contains no Node integration.
   * @category Isolated Documents
   */
  getFrameSource() {
    const css = fs.readFileSync(
      path.join(__dirname, "..", "static", "core-ui", "scrollbars.css"),
      "utf8",
    );
    return `window.LumineScrollbars = (${createScrollbarRuntime.toString()})();\n{const style=document.createElement('style');style.dataset.scrollbarChrome='';style.textContent=${JSON.stringify(css)};document.head.appendChild(style);}`;
  }

  refresh() {
    for (const [document, manager] of this.documents) {
      manager.roots.add(document.body);
      manager.refresh();
    }
  }
  releaseDocument(document) {
    for (const observation of [...this.observations])
      if (observation.element.ownerDocument === document) observation.dispose();
    this.documents.get(document)?.dispose();
    this.documents.delete(document);
  }
  clear() {
    this.subscriptions?.dispose();
    for (const observation of [...this.observations]) observation.dispose();
    for (const manager of this.documents.values()) manager.dispose();
    this.documents.clear();
  }
  destroy() {
    this.clear();
  }
};
