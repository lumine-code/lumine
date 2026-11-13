const fs = require("node:fs");
const path = require("node:path");
const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const {
  DOMScrollbarManager,
  ScrollbarActivity,
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
   * @param {Object} [options] - kind (document, panel or inline), layout (overlay or gutter), policy (auto, always or hover), edge (left or right), focusOwner, zIndex and horizontal/vertical axis overrides. Kind selects semantic defaults: persistent document overlays with a separator, transient panel overlays, or reserved always-visible inline gutters. Location supplies the default kind; explicit options or data-scrollbar-kind can select a utility panel even in the center.
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
   * Reveal transient overlay chrome after a handled navigation action, even at a boundary.
   * Hover and dragging retain visibility; activity expires 700 ms after the last action.
   * @param {HTMLElement} element - Editor element or the actual DOM scrollport, already attached.
   * @returns {Boolean} Whether transient chrome accepted the activity. Persistent surfaces are unchanged.
   * @category DOM Surfaces
   */
  reveal(element) {
    if (element.matches("lumine-text-editor"))
      return element.getComponent?.()?.revealScrollbars() ?? false;
    return this.documents.get(element.ownerDocument)?.reveal(element) ?? false;
  }

  /**
   * @public
   * @status public
   *
   * Apply shared scrollbar activity to an explicit group of handled navigation commands.
   * Register the returned map with commands.add; its scope, availability and disposal stay with that registration.
   * @param {HTMLElement|Function} element - Actual scrollport or a resolver returning that element or null. A resolver runs after the handler's synchronous return, with the same receiver and arguments, so it can select the current port after a view update.
   * @param {Object} commands - Navigation command names mapped to handlers or command descriptors. Include boundary operations even when they do not move the viewport; omit commands that abort or delegate their key binding.
   * @returns {Object} Wrapped command map preserving descriptor metadata and each handler's exact return value, including its original Promise. A thrown handler does not reveal chrome; asynchronous completion does not postpone the activity deadline.
   * @category DOM Surfaces
   */
  navigationCommands(element, commands) {
    const scrollbars = this;
    return Object.fromEntries(
      Object.entries(commands).map(([name, listener]) => {
        const handler = typeof listener === "function" ? listener : listener?.didDispatch;
        if (typeof handler !== "function")
          throw new TypeError(`Navigation command '${name}' requires a handler.`);
        const wrapped = function (...args) {
          const result = handler.apply(this, args);
          const scrollport = typeof element === "function" ? element.apply(this, args) : element;
          if (scrollport) scrollbars.reveal(scrollport);
          return result;
        };
        return [
          name,
          typeof listener === "function"
            ? Object.assign(wrapped, listener)
            : { ...listener, didDispatch: wrapped },
        ];
      }),
    );
  }

  /**
   * @public
   * @status public
   *
   * Create the shared activity timer for renderer-owned scrollbar chrome.
   * @param {HTMLElement} element - Surface whose document owns the timer.
   * @param {Function} onChange - Receives the active Boolean when recent activity starts or expires; combine it with hover and dragging in the renderer.
   * @returns {Object|null} Controller with active, reveal(), clear() and dispose(), or null for an inert document. Dispose when the surface is removed or moves to another document.
   * @category DOM Surfaces
   */
  createActivity(element, onChange) {
    const window = element.ownerDocument.defaultView;
    return window ? new ScrollbarActivity({ window, onChange }) : null;
  }

  /**
   * @public
   * @status public
   *
   * Read track thickness and viewport/document extents in CSS pixels.
   * Thickness stays stable when a thumb is hidden or content fits the viewport.
   * @param {HTMLElement} element - Editor element or native DOM scrollport.
   * @returns {Object} layout (overlay or gutter); CSS-pixel verticalSize and horizontalSize track thicknesses, scrollEndInset (extra bottom extent for an overflowing horizontal overlay), viewportWidth and viewportHeight excluding reserved gutters, verticalTrackSize and horizontalTrackSize lengths (vertical spans the full height including any horizontal gutter, horizontal excludes the vertical rail), scrollWidth and scrollHeight, canScrollVertically and canScrollHorizontally. Editor snapshots also include rowGeometryVersion for marker projection invalidation.
   * @category Geometry
   */
  getGeometry(element) {
    const component = element.matches("lumine-text-editor") ? element.getComponent?.() : null;
    if (component)
      return {
        layout: component.getScrollbarLayout(),
        verticalSize: component.getVerticalScrollbarWidth(),
        horizontalSize: component.getHorizontalScrollbarHeight(),
        scrollEndInset: component.getScrollEndInset(),
        viewportWidth: component.getScrollContainerClientWidth(),
        viewportHeight: component.getScrollContainerClientHeight(),
        verticalTrackSize: Math.max(0, component.getScrollContainerHeight()),
        horizontalTrackSize: Math.max(
          0,
          component.getScrollContainerWidth() - component.getHorizontalScrollbarTrackInset(),
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
    const { layout, kind } = scrollbarPresentation(element);
    const style =
      layout === "gutter" ? element.ownerDocument.defaultView?.getComputedStyle(element) : null;
    return {
      layout,
      verticalSize: size,
      horizontalSize: size,
      scrollEndInset: 0,
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
      verticalTrackSize:
        layout === "gutter"
          ? Math.max(
              0,
              element.offsetHeight -
                (parseFloat(style?.borderTopWidth) || 0) -
                (parseFloat(style?.borderBottomWidth) || 0),
            )
          : element.clientHeight,
      horizontalTrackSize: Math.max(
        0,
        element.clientWidth -
          (layout === "overlay" &&
          (kind === "document" || element.scrollHeight > element.clientHeight)
            ? size
            : 0),
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
        "scrollEndInset",
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
