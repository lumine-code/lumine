// This factory is also sent to isolated output documents. Keep it independent
// of Node, the global environment and package identities.
function createScrollbarRuntime() {
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const finite = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

  function scrollbarSize(element, editor = false) {
    const window = element.ownerDocument.defaultView;
    if (!window) return 10;
    const style = window.getComputedStyle(element);
    const value = parseFloat(
      style.getPropertyValue(editor ? "--scrollbar-size-editor" : "--scrollbar-size"),
    );
    return Number.isFinite(value) ? clamp(value, 4, 40) : 10;
  }

  class OverlayScrollbar {
    constructor({ document, orientation = "vertical", onScroll, onDragChange = () => {} }) {
      this.orientation = orientation;
      this.onScroll = onScroll;
      this.onDragChange = onDragChange;
      this.element = document.createElement("div");
      this.element.className = `lumine-scrollbar ${orientation}`;
      this.element.dataset.scrollbarChrome = "";
      this.element.setAttribute("role", "presentation");
      this.element.setAttribute("aria-hidden", "true");
      this.thumb = document.createElement("div");
      this.thumb.className = "scrollbar-thumb";
      this.element.appendChild(this.thumb);
      this.metrics = {};
      this.listeners = {
        pointerdown: (event) => this.pointerDown(event),
        pointermove: (event) => this.pointerMove(event),
        pointerup: (event) => {
          if (this.drag?.id !== event.pointerId) return;
          this.pointerMove(event);
          this.endDrag();
        },
        pointercancel: (event) => {
          if (this.drag?.id === event.pointerId) this.endDrag();
        },
        lostpointercapture: (event) => {
          if (this.drag?.id === event.pointerId) this.endDrag();
        },
        mousedown: (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        click: (event) => event.stopPropagation(),
      };
      for (const [name, callback] of Object.entries(this.listeners))
        this.element.addEventListener(name, callback);
    }

    update(metrics) {
      const old = this.metrics;
      this.metrics = {
        extent: finite(metrics.extent),
        viewport: finite(metrics.viewport),
        trackSize: finite(metrics.trackSize ?? metrics.viewport),
        position: finite(metrics.position),
        canScroll: metrics.canScroll !== false,
        thickness: finite(metrics.thickness) || 10,
      };
      this.maximum = Math.max(0, this.metrics.extent - this.metrics.viewport);
      this.thumbSize = Math.min(
        this.metrics.trackSize,
        Math.max(
          20,
          this.metrics.extent
            ? (this.metrics.trackSize * this.metrics.viewport) / this.metrics.extent
            : 0,
        ),
      );
      this.travel = Math.max(0, this.metrics.trackSize - this.thumbSize);
      this.element.classList.toggle("is-scrollable", this.metrics.canScroll && this.maximum > 0);
      const horizontal = this.orientation === "horizontal";
      const sizeKey = horizontal ? "width" : "height";
      const thicknessKey = horizontal ? "height" : "width";
      if (old.trackSize !== this.metrics.trackSize)
        this.element.style[sizeKey] = `${this.metrics.trackSize}px`;
      if (old.thickness !== this.metrics.thickness)
        this.element.style[thicknessKey] = `${this.metrics.thickness}px`;
      if (this.lastThumbSize !== this.thumbSize) {
        this.thumb.style[sizeKey] = `${this.thumbSize}px`;
        this.lastThumbSize = this.thumbSize;
      }
      if (
        this.drag &&
        (old.trackSize !== this.metrics.trackSize || old.viewport !== this.metrics.viewport)
      )
        this.drag.geometryDirty = true;
      this.updatePosition(this.metrics.position);
    }

    updatePosition(position) {
      this.metrics.position = clamp(finite(position), 0, this.maximum || 0);
      const offset = this.maximum ? (this.metrics.position / this.maximum) * this.travel : 0;
      if (offset === this.lastOffset) return;
      this.lastOffset = offset;
      this.thumb.style.transform =
        this.orientation === "horizontal" ? `translateX(${offset}px)` : `translateY(${offset}px)`;
    }

    pointerDown(event) {
      if (this.destroyed || event.button !== 0 || !this.metrics.canScroll || !this.maximum) return;
      event.preventDefault();
      event.stopPropagation();
      this.endDrag();
      const rect = this.element.getBoundingClientRect();
      const horizontal = this.orientation === "horizontal";
      const coordinate = horizontal ? event.clientX : event.clientY;
      const start = horizontal ? rect.left : rect.top;
      const onThumb = event.target === this.thumb || this.thumb.contains(event.target);
      this.drag = {
        id: event.pointerId,
        start,
        offset: onThumb ? coordinate - start - this.lastOffset : this.thumbSize / 2,
        geometryDirty: false,
      };
      this.element.classList.add("is-dragging");
      this.onDragChange(true, this.metrics.position);
      try {
        this.element.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer tests do not create an active platform pointer.
      }
      const position = onThumb ? this.metrics.position : this.positionForCoordinate(coordinate);
      this.updatePosition(position);
      this.onScroll(position, { jump: !onThumb });
    }

    positionForCoordinate(coordinate) {
      if (!this.travel) return 0;
      return (
        clamp((coordinate - this.drag.start - this.drag.offset) / this.travel, 0, 1) * this.maximum
      );
    }

    pointerMove(event) {
      if (!this.drag || this.drag.id !== event.pointerId || this.destroyed) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.drag.geometryDirty) {
        const rect = this.element.getBoundingClientRect();
        this.drag.start = this.orientation === "horizontal" ? rect.left : rect.top;
        this.drag.geometryDirty = false;
      }
      const coordinate = this.orientation === "horizontal" ? event.clientX : event.clientY;
      const position = this.positionForCoordinate(coordinate);
      if (position === this.metrics.position) return;
      this.updatePosition(position);
      this.onScroll(position, { jump: false });
    }

    endDrag() {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      this.element.classList.remove("is-dragging");
      if (this.element.hasPointerCapture?.(drag.id)) this.element.releasePointerCapture(drag.id);
      this.onDragChange(false, this.metrics.position);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.endDrag();
      for (const [name, callback] of Object.entries(this.listeners))
        this.element.removeEventListener(name, callback);
      this.element.remove();
    }
  }

  const candidates =
    "div,section,article,main,nav,aside,pre,ul,ol,textarea,dialog,[data-scrollbar]";
  const excluded =
    "lumine-text-editor,.lumine-scrollbar,.lumine-scrollbar-overlay,[data-scrollbar='none'],.xterm";
  const owners = new WeakMap();

  class DOMScrollbarController {
    constructor(manager, element, options = {}) {
      owners.get(element)?.destroy();
      owners.set(element, this);
      this.manager = manager;
      this.element = element;
      this.options = options;
      this.callbacks = new Set();
      this.layer = element.ownerDocument.createElement("div");
      this.layer.className = "lumine-scrollbar-overlay";
      this.layer.dataset.scrollbarChrome = "";
      this.layer.setAttribute("aria-hidden", "true");
      this.previousScrollbarWidth = element.style.scrollbarWidth;
      element.classList.add("lumine-scrollport");
      element.style.scrollbarWidth = "none";
      const create = (orientation) =>
        new OverlayScrollbar({
          document: element.ownerDocument,
          orientation,
          onScroll: (position) => {
            // A scrollbar gesture owns its position immediately, including a
            // thumb claim that cancels an authored smooth-scroll animation.
            if (orientation === "vertical")
              element.scrollTo({ top: position, behavior: "instant" });
            else
              element.scrollTo({
                left: this.rtl
                  ? position - Math.max(0, this.geometry.scrollWidth - this.geometry.viewportWidth)
                  : position,
                behavior: "instant",
              });
          },
          onDragChange: () => this.syncVisibility(),
        });
      this.vertical = create("vertical");
      this.horizontal = create("horizontal");
      this.layer.append(this.vertical.element, this.horizontal.element);
      this.observer = new element.ownerDocument.defaultView.ResizeObserver(() =>
        manager.invalidate(this),
      );
      this.observeChildren();
      this.refresh();
    }

    observeChildren() {
      this.observer.disconnect();
      this.observer.observe(this.element);
      for (const child of this.element.children)
        if (!child.classList.contains("lumine-scrollbar-overlay")) this.observer.observe(child);
    }

    read() {
      const element = this.element;
      if (
        !element.isConnected ||
        element.ownerDocument !== this.manager.document ||
        !element.ownerDocument.defaultView
      )
        return null;
      const window = element.ownerDocument.defaultView;
      const style = window.getComputedStyle(element);
      this.rtl = style.direction === "rtl";
      const size = scrollbarSize(element);
      const width = element.clientWidth;
      const height = element.clientHeight;
      const scrollWidth = element.scrollWidth;
      const scrollHeight = element.scrollHeight;
      const x =
        this.options.horizontal !== false &&
        (/auto|scroll/.test(style.overflowX) || this.options.horizontal === true);
      const y =
        this.options.vertical !== false &&
        (/auto|scroll/.test(style.overflowY) || this.options.vertical === true);
      const canScrollHorizontally = x && scrollWidth > width + 0.5;
      const canScrollVertically = y && scrollHeight > height + 0.5;
      const rect = element.getBoundingClientRect();
      // Mount in the existing containing block: never wrap/reparent authored
      // content or change which ancestor positions a package's own overlays.
      let parent = element.offsetParent;
      if (!parent) {
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (window.getComputedStyle(ancestor).position !== "static") {
            parent = ancestor;
            break;
          }
        }
      }
      parent ||= element.ownerDocument.body;
      const followSibling = style.position === "fixed" && element.parentElement === parent;
      const parentRect = parent.getBoundingClientRect();
      let clipTop = 0,
        clipRight = 0,
        clipBottom = 0,
        clipLeft = 0;
      for (
        let ancestor = element.parentElement;
        ancestor && ancestor !== parent;
        ancestor = ancestor.parentElement
      ) {
        const ancestorStyle = window.getComputedStyle(ancestor);
        if (
          !/(auto|scroll|hidden|clip)/.test(`${ancestorStyle.overflowX} ${ancestorStyle.overflowY}`)
        )
          continue;
        const bounds = ancestor.getBoundingClientRect();
        const top = rect.top + element.clientTop;
        const left = rect.left + element.clientLeft;
        if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowY)) {
          clipTop = Math.max(clipTop, bounds.top + ancestor.clientTop - top);
          clipBottom = Math.max(
            clipBottom,
            top + height - bounds.top - ancestor.clientTop - ancestor.clientHeight,
          );
        }
        if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowX)) {
          clipLeft = Math.max(clipLeft, bounds.left + ancestor.clientLeft - left);
          clipRight = Math.max(
            clipRight,
            left + width - bounds.left - ancestor.clientLeft - ancestor.clientWidth,
          );
        }
      }
      this.owner = this.options.focusOwner || element.closest("lumine-pane") || element;
      const policy = this.options.policy || element.dataset.scrollbar;
      const persistent =
        policy === "always" ||
        (policy !== "hover" && !element.closest("lumine-dock") && !!element.closest("lumine-pane"));
      const scrollLeft = this.rtl
        ? Math.max(0, scrollWidth - width) + element.scrollLeft
        : element.scrollLeft;
      return {
        parent,
        followSibling,
        stacking: followSibling ? style.zIndex : "10",
        left:
          rect.left + element.clientLeft - parentRect.left - parent.clientLeft + parent.scrollLeft,
        top: rect.top + element.clientTop - parentRect.top - parent.clientTop + parent.scrollTop,
        clip: `inset(${Math.max(0, clipTop)}px ${Math.max(0, clipRight)}px ${Math.max(0, clipBottom)}px ${Math.max(0, clipLeft)}px)`,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden",
        persistent,
        edge: this.options.edge || (this.rtl ? "left" : "right"),
        verticalSize: size,
        horizontalSize: size,
        viewportWidth: width,
        viewportHeight: height,
        verticalTrackSize: Math.max(0, height - (canScrollHorizontally ? size : 0)),
        horizontalTrackSize: Math.max(0, width - (canScrollVertically ? size : 0)),
        scrollWidth,
        scrollHeight,
        canScrollHorizontally,
        canScrollVertically,
        scrollTop: element.scrollTop,
        scrollLeft,
      };
    }

    write(snapshot) {
      if (this.destroyed || !snapshot) return;
      const old = this.geometry;
      this.geometry = snapshot;
      if (snapshot.followSibling) {
        if (this.element.nextSibling !== this.layer)
          snapshot.parent.insertBefore(this.layer, this.element.nextSibling);
      } else if (this.layer.parentElement !== snapshot.parent)
        snapshot.parent.appendChild(this.layer);
      const style = this.layer.style;
      for (const [key, value] of Object.entries({
        left: `${snapshot.left}px`,
        top: `${snapshot.top}px`,
        width: `${snapshot.viewportWidth}px`,
        height: `${snapshot.viewportHeight}px`,
        clipPath: snapshot.clip,
        display: snapshot.visible ? "" : "none",
        zIndex: snapshot.stacking,
      }))
        if (style[key] !== value) style[key] = value;
      this.layer.classList.toggle("is-persistent", snapshot.persistent);
      this.layer.classList.toggle("is-document", snapshot.persistent);
      this.layer.classList.toggle("is-left", snapshot.edge === "left");
      this.vertical.update({
        extent: snapshot.scrollHeight,
        viewport: snapshot.viewportHeight,
        trackSize: snapshot.verticalTrackSize,
        position: snapshot.scrollTop,
        thickness: snapshot.verticalSize,
        canScroll: snapshot.canScrollVertically,
      });
      this.horizontal.update({
        extent: snapshot.scrollWidth,
        viewport: snapshot.viewportWidth,
        trackSize: snapshot.horizontalTrackSize,
        position: snapshot.scrollLeft,
        thickness: snapshot.horizontalSize,
        canScroll: snapshot.canScrollHorizontally,
      });
      this.syncVisibility();
      const keys = [
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
      ];
      this.publicGeometry = Object.fromEntries(keys.map((key) => [key, snapshot[key]]));
      if (!old || keys.some((key) => old[key] !== snapshot[key]))
        for (const callback of this.callbacks) callback(this.publicGeometry);
    }

    syncPosition() {
      if (!this.geometry) return;
      this.vertical.updatePosition(this.element.scrollTop);
      this.horizontal.updatePosition(
        this.rtl
          ? this.geometry.scrollWidth - this.geometry.viewportWidth + this.element.scrollLeft
          : this.element.scrollLeft,
      );
    }

    syncVisibility() {
      if (!this.owner) return;
      const document = this.element.ownerDocument;
      const visible =
        this.owner.matches(":hover") ||
        this.owner.contains(document.activeElement) ||
        this.layer.matches(":hover") ||
        !!this.vertical.drag ||
        !!this.horizontal.drag;
      this.layer.classList.toggle("is-revealed", visible);
    }

    refresh() {
      this.manager.invalidate(this);
    }
    dispose() {
      this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.observer.disconnect();
      this.vertical.destroy();
      this.horizontal.destroy();
      this.layer.remove();
      this.element.classList.remove("lumine-scrollport");
      if (this.element.style.scrollbarWidth === "none")
        this.element.style.scrollbarWidth = this.previousScrollbarWidth;
      if (owners.get(this.element) === this) owners.delete(this.element);
      this.callbacks.clear();
      this.manager.controllers.delete(this.element);
      this.manager.dirty.delete(this);
    }
  }

  class DOMScrollbarManager {
    constructor({ document, scheduleRead, scheduleWrite } = {}) {
      this.document = document;
      this.window = document.defaultView;
      this.scheduleRead =
        scheduleRead ||
        ((callback) => {
          const handle = this.window.requestAnimationFrame(callback);
          return { dispose: () => this.window.cancelAnimationFrame(handle) };
        });
      this.scheduleWrite = scheduleWrite || ((callback) => callback());
      this.controllers = new Map();
      this.dirty = new Set();
      this.roots = new Set([document.body]);
      this.listeners = {
        scroll: (event) => {
          this.controllers.get(event.target)?.syncPosition();
          for (const controller of this.controllers.values())
            if (event.target !== controller.element && event.target.contains?.(controller.element))
              this.invalidate(controller);
        },
        pointerover: () => this.syncVisibility(),
        pointerout: () => this.syncVisibility(),
        focusin: () => this.syncVisibility(),
        focusout: () =>
          this.window.queueMicrotask(() => {
            if (!this.destroyed) this.syncVisibility();
          }),
      };
      for (const [name, callback] of Object.entries(this.listeners))
        document.addEventListener(name, callback, true);
      this.resize = () => this.refresh();
      this.window.addEventListener("resize", this.resize);
      this.mutations = new this.window.MutationObserver((records) => {
        const affected = new Map();
        const ignored = new Set();
        let relevant = false;
        for (const record of records) {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (!target || ignored.has(target)) continue;
          if (target.closest(excluded)) {
            ignored.add(target);
            if (target.dataset.scrollbar === "none") {
              for (const controller of [...this.controllers.values()])
                if (target.contains(controller.element)) controller.destroy();
            }
            continue;
          }
          if (record.type === "attributes" && this.isChromeAttribute(record)) continue;
          relevant = true;
          const controller = this.nearestController(target);
          if (controller) {
            const directChildrenChanged =
              record.type === "childList" && target === controller.element;
            affected.set(controller, affected.get(controller) || directChildrenChanged);
          }
          if (record.type === "attributes") {
            this.addRoot(target);
            // An ancestor's visibility, overflow or positioning can change the
            // geometry and clipping of scrollports below it.
            for (const current of this.controllers.values())
              if (target.contains(current.element) && !affected.has(current))
                affected.set(current, false);
          } else {
            for (const node of record.addedNodes)
              if (node.nodeType === 1 && !node.closest(excluded)) this.addRoot(node);
          }
        }
        if (!relevant) return;
        for (const [controller, childrenChanged] of affected) {
          if (childrenChanged) controller.observeChildren();
          this.invalidate(controller);
        }
        if (
          this.roots.size ||
          this.dirty.size ||
          [...this.controllers.keys()].some(
            (element) => !element.isConnected || element.ownerDocument !== this.document,
          )
        )
          this.schedule();
      });
      this.mutations.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["class", "style", "data-scrollbar", "hidden", "open"],
      });
      this.schedule();
    }

    nearestController(node) {
      for (
        let element = node.nodeType === 1 ? node : node.parentElement;
        element;
        element = element.parentElement
      ) {
        const controller = this.controllers.get(element);
        if (controller) return controller;
      }
      return null;
    }

    // Mount/unmount owns only this class and the native chrome override. Ignore
    // those mutations while still observing authored changes on a scrollport.
    isChromeAttribute(record) {
      if (record.attributeName === "class") {
        const withoutChrome = (value) =>
          value
            .split(/\s+/)
            .filter((name) => name && name !== "lumine-scrollport")
            .sort()
            .join(" ");
        return (
          withoutChrome(record.oldValue || "") ===
          withoutChrome(record.target.getAttribute("class") || "")
        );
      }
      if (record.attributeName !== "style") return false;
      this.attributeStyle ??= this.document.createElement("span").style;
      const withoutChrome = (value) => {
        this.attributeStyle.cssText = value || "";
        this.attributeStyle.removeProperty("scrollbar-width");
        return this.attributeStyle.cssText;
      };
      return withoutChrome(record.oldValue) === withoutChrome(record.target.getAttribute("style"));
    }

    addRoot(root) {
      for (let ancestor = root; ancestor; ancestor = ancestor.parentElement)
        if (this.roots.has(ancestor)) return;
      this.roots.add(root);
    }

    attach(element, options = {}) {
      let controller = this.controllers.get(element);
      if (!controller) {
        controller = new DOMScrollbarController(this, element, options);
        this.controllers.set(element, controller);
      } else {
        Object.assign(controller.options, options);
        this.invalidate(controller);
      }
      return controller;
    }

    scan(root) {
      if (!root?.isConnected || root.closest(excluded)) return;
      const inspect = (element) => {
        const current = this.controllers.get(element);
        if (current) {
          // A same-document move can preserve size while changing containing
          // block, clipping and panel reveal policy.
          this.invalidate(current);
          return;
        }
        const style = this.window.getComputedStyle(element);
        if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) this.attach(element);
      };
      if (root.matches(candidates)) inspect(root);
      const { NodeFilter } = this.window;
      const walker = this.document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (element) =>
          element.matches(excluded)
            ? NodeFilter.FILTER_REJECT
            : element.matches(candidates)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP,
      });
      while (walker.nextNode()) inspect(walker.currentNode);
    }

    invalidate(controller) {
      if (this.destroyed || controller.destroyed) return;
      this.dirty.add(controller);
      this.schedule();
    }

    schedule() {
      if (this.pending || this.destroyed) return;
      this.pending = this.scheduleRead(() => {
        this.pending = null;
        if (this.destroyed) return;
        if (!this.document.defaultView) {
          this.dispose();
          return;
        }
        for (const [element, controller] of this.controllers)
          if (!element.isConnected || element.ownerDocument !== this.document) controller.destroy();
        const roots = [...this.roots].filter((root) => {
          for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement)
            if (this.roots.has(ancestor)) return false;
          return true;
        });
        this.roots.clear();
        for (const root of roots) this.scan(root);
        const measured = [...this.dirty].map((controller) => [controller, controller.read()]);
        this.dirty.clear();
        this.writeRequest = this.scheduleWrite(() => {
          this.writeRequest = null;
          if (this.destroyed) return;
          for (const [controller, snapshot] of measured) controller.write(snapshot);
        });
      });
    }

    syncVisibility() {
      for (const controller of this.controllers.values()) controller.syncVisibility();
    }
    refresh() {
      for (const controller of this.controllers.values()) this.dirty.add(controller);
      this.schedule();
    }
    dispose() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.pending?.dispose?.();
      this.writeRequest?.dispose?.();
      this.mutations.disconnect();
      this.window.removeEventListener("resize", this.resize);
      for (const [name, callback] of Object.entries(this.listeners))
        this.document.removeEventListener(name, callback, true);
      for (const controller of [...this.controllers.values()]) controller.destroy();
      this.roots.clear();
      this.dirty.clear();
    }
  }
  return { OverlayScrollbar, DOMScrollbarManager, scrollbarSize };
}

module.exports = { ...createScrollbarRuntime(), createScrollbarRuntime };
