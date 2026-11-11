// This factory is also sent to isolated output documents. Keep it independent
// of Node, the global environment and package identities.
function createScrollbarRuntime() {
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const finite = (value) => (Number.isFinite(value) ? Math.max(0, value) : 0);

  // Visibility is independent of geometry. Extending the deadline does not
  // replace a timer on every scroll frame or repeated navigation command.
  class ScrollbarActivity {
    constructor({ window, onChange, delay = 700 }) {
      this.window = window;
      this.onChange = onChange;
      this.delay = delay;
      this.active = false;
      this.timer = null;
    }

    reveal(duration = this.delay) {
      if (this.disposed) return;
      this.deadline = this.window.performance.now() + duration;
      if (!this.active) {
        this.active = true;
        this.onChange(true);
      }
      if (this.timer === null) this.schedule(duration);
    }

    schedule(delay) {
      this.timer = this.window.setTimeout(() => {
        this.timer = null;
        if (this.disposed) return;
        const remaining = this.deadline - this.window.performance.now();
        if (remaining > 0) this.schedule(remaining);
        else {
          this.active = false;
          this.onChange(false);
        }
      }, delay);
    }

    clear() {
      if (this.timer !== null) this.window.clearTimeout(this.timer);
      this.timer = null;
      if (this.active) {
        this.active = false;
        this.onChange(false);
      }
    }

    dispose() {
      this.disposed = true;
      if (this.timer !== null) this.window.clearTimeout(this.timer);
      this.timer = null;
      this.active = false;
    }
  }

  function scrollbarSize(element, editor = false) {
    const window = element.ownerDocument.defaultView;
    if (!window) return 10;
    const style = window.getComputedStyle(element);
    const value = parseFloat(
      style.getPropertyValue(editor ? "--scrollbar-size-editor" : "--scrollbar-size"),
    );
    return Number.isFinite(value) ? clamp(value, 4, 40) : 10;
  }

  function scrollbarPresentation(element, options = {}) {
    const item = element.closest(".item-views > *");
    const window = element.ownerDocument.defaultView;
    const requestedLayout = options.layout || element.dataset.scrollbarLayout;
    const explicitLayout = ["overlay", "gutter"].includes(requestedLayout) ? requestedLayout : null;
    const inheritedGutter = element.parentElement?.closest("[data-scrollbar-layout='gutter']");
    const gutter = explicitLayout === "gutter" || (!explicitLayout && !!inheritedGutter);
    let primary = !!item && !gutter;
    if (
      element.closest(
        ".panel.modal,[role='dialog'],[role='menu'],[role='listbox'],.select-list,.popover,.tooltip",
      )
    )
      primary = false;
    if (primary && element !== item) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = window?.getComputedStyle(ancestor);
        if (style && /auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) {
          primary = false;
          break;
        }
        if (ancestor === item) break;
      }
    }
    const requestedKind =
      options.kind ||
      element.dataset.scrollbarKind ||
      (primary
        ? element.parentElement?.closest("[data-scrollbar-kind]")?.dataset.scrollbarKind
        : null);
    const kind = ["document", "panel", "inline"].includes(requestedKind)
      ? requestedKind
      : primary
        ? element.closest("lumine-dock")
          ? "panel"
          : "document"
        : "inline";
    const layout = explicitLayout || (inheritedGutter || kind === "inline" ? "gutter" : "overlay");
    const requestedPolicy = options.policy || element.dataset.scrollbar;
    const policy =
      requestedPolicy && requestedPolicy !== "auto"
        ? requestedPolicy
        : layout === "overlay" && kind === "panel"
          ? "hover"
          : "always";
    return {
      layout,
      kind,
      policy,
      primary,
      focusOwner:
        options.focusOwner || (primary ? element.closest("lumine-pane") : element) || element,
    };
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
    "div,section,article,main,nav,aside,pre,ul,ol,textarea,dialog,[data-scrollbar],[data-scrollbar-kind],[data-scrollbar-layout],[data-scrollbar-z-index]";
  const excluded =
    "lumine-text-editor,.lumine-scrollbar,.lumine-scrollbar-overlay,[data-scrollbar='none'],.xterm";
  const owners = new WeakMap();

  class DOMScrollbarController {
    constructor(manager, element, options = {}) {
      // Capture the initial native offsets before chrome changes styles. This
      // distinguishes a real first movement from a delayed duplicate event,
      // including a scrollport restored to a nonzero offset before attaching.
      this.scrollTop = element.scrollTop;
      this.scrollLeft = element.scrollLeft;
      this.positionVersion = 0;
      this.layoutVersion = 0;
      owners.get(element)?.destroy();
      owners.set(element, this);
      this.manager = manager;
      this.element = element;
      this.options = options;
      this.callbacks = new Set();
      this.endStyles = new Map(
        ["padding-bottom", "scroll-padding-bottom"].map((property) => [
          property,
          {
            authored: {
              value: element.style.getPropertyValue(property),
              priority: element.style.getPropertyPriority(property),
            },
            chromeValues: new Set(),
          },
        ]),
      );
      this.layer = element.ownerDocument.createElement("div");
      this.layer.className = "lumine-scrollbar-overlay";
      this.layer.dataset.scrollbarChrome = "";
      this.layer.setAttribute("aria-hidden", "true");
      this.wheel = (event) => this.routeWheel(event);
      // This non-passive listener belongs only to the interactive chrome.
      // Ordinary content scrolling keeps the browser's compositor fast path.
      this.layer.addEventListener("wheel", this.wheel, { passive: false });
      this.previousScrollbarWidth = element.style.scrollbarWidth;
      element.classList.add("lumine-scrollport");
      element.style.scrollbarWidth = "none";
      this.layout = scrollbarPresentation(element, options).layout;
      element.classList.toggle("lumine-scrollport-gutter", this.layout === "gutter");
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
      this.observer = new element.ownerDocument.defaultView.ResizeObserver((entries) => {
        let stylesChanged = false;
        for (const entry of entries) {
          if (entry.target !== element) continue;
          const box = entry.borderBoxSize[0];
          const size = `${box.inlineSize}:${box.blockSize}`;
          stylesChanged ||= size !== this.borderBoxSize;
          this.borderBoxSize = size;
        }
        manager.invalidate(this, stylesChanged);
      });
      this.observeChildren();
      this.refresh();
    }

    observeChildren() {
      this.observer.disconnect();
      this.observer.observe(this.element, { box: "border-box" });
      for (const child of this.element.children)
        if (!child.classList.contains("lumine-scrollbar-overlay")) this.observer.observe(child);
    }

    captureAuthoredPadding() {
      const style = this.element.style;
      for (const [property, state] of this.endStyles) {
        if (!state.managed) continue;
        if (
          style.getPropertyValue(property) === state.managed &&
          style.getPropertyPriority(property) === "important"
        )
          continue;
        state.authored = {
          value: style.getPropertyValue(property),
          priority: style.getPropertyPriority(property),
        };
        state.managed = null;
        state.requested = null;
      }
    }

    restorePadding() {
      this.captureAuthoredPadding();
      let changed = false;
      for (const [property, state] of this.endStyles) {
        if (!state.managed) continue;
        const { value, priority } = state.authored;
        if (value) this.element.style.setProperty(property, value, priority);
        else this.element.style.removeProperty(property);
        state.managed = null;
        state.requested = null;
        changed = true;
      }
      return changed;
    }

    prepareRead() {
      this.captureAuthoredPadding();
      // Re-evaluate authored CSS only after style, theme or border-box changes.
      // Restore all affected ports before the manager's shared read phase;
      // ordinary content mutations and scrolling never need this baseline probe.
      if (this.paddingStyleDirty) this.paddingProbe = this.restorePadding();
      this.paddingStyleDirty = false;
    }

    finishRead(snapshot) {
      if (!this.paddingProbe || !snapshot) return;
      this.paddingProbe = false;
      if (this.paddingScrollPosition?.expected === null)
        this.paddingScrollPosition.expected = snapshot.scrollTop;
      // End every baseline probe before yielding to queued writers. A stale
      // snapshot must never leave the scrollport without its managed reserve.
      snapshot.endPaddingChanged = this.updateEndPadding(snapshot);
    }

    restorePaddingScrollPosition() {
      const position = this.paddingScrollPosition;
      if (!position || position.expected === null || this.element.scrollTop !== position.expected)
        return;
      // Reapply the native offset in the same cycle as the reserve. The browser
      // clamps against the actual extent, including percentage-height content.
      this.element.scrollTo({
        top: position.atEnd ? this.element.scrollHeight : position.top,
        behavior: "instant",
      });
      position.expected = this.element.scrollTop;
    }

    preservePaddingScrollPosition() {
      if (this.paddingStyleDirty && this.endStyles.get("padding-bottom").managed) {
        const top = this.element.scrollTop;
        const maximum = this.element.scrollHeight - this.element.clientHeight;
        this.paddingScrollPosition = {
          top,
          expected: null,
          atEnd: maximum > 0 && top >= maximum - 1,
        };
      }
    }

    updateEndPadding(snapshot) {
      if (!snapshot.scrollEndInset) return this.restorePadding();
      let changed = false;
      for (const [property, state] of this.endStyles) {
        const requested = `calc(${state.base} + ${snapshot.scrollEndInset}px)`;
        if (state.requested === requested) continue;
        const maximum = snapshot.scrollHeight - snapshot.viewportHeight;
        if (!this.paddingScrollPosition && maximum > 0 && snapshot.scrollTop >= maximum - 1)
          this.paddingScrollPosition = {
            top: snapshot.scrollTop,
            expected: snapshot.scrollTop,
            atEnd: true,
          };
        this.element.style.setProperty(property, requested, "important");
        const value = this.element.style.getPropertyValue(property);
        state.chromeValues.add(`${value}:important`);
        if (state.chromeValues.size > 8)
          state.chromeValues.delete(state.chromeValues.values().next().value);
        state.managed = value;
        state.requested = requested;
        changed = true;
      }
      return changed;
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
      this.captureAuthoredPadding();
      const style = window.getComputedStyle(element);
      this.readAuthoredPadding(style);
      const styles = new Map([[element, style]]);
      const styleFor = (node) => {
        if (!styles.has(node)) styles.set(node, window.getComputedStyle(node));
        return styles.get(node);
      };
      this.rtl = style.direction === "rtl";
      const size = scrollbarSize(element);
      const width = element.clientWidth;
      const height = element.clientHeight;
      const scrollWidth = element.scrollWidth;
      const scrollHeight = element.scrollHeight;
      const presentation = scrollbarPresentation(element, this.options);
      const gutter = presentation.layout === "gutter";
      const verticalGutter = gutter
        ? Math.max(
            0,
            element.offsetWidth -
              width -
              (parseFloat(style.borderLeftWidth) || 0) -
              (parseFloat(style.borderRightWidth) || 0),
          )
        : 0;
      const horizontalGutter = gutter
        ? Math.max(
            0,
            element.offsetHeight -
              height -
              (parseFloat(style.borderTopWidth) || 0) -
              (parseFloat(style.borderBottomWidth) || 0),
          )
        : 0;
      const leftGutter = gutter
        ? Math.max(0, element.clientLeft - (parseFloat(style.borderLeftWidth) || 0))
        : 0;
      const edge = gutter
        ? leftGutter
          ? "left"
          : "right"
        : this.options.edge || (this.rtl ? "left" : "right");
      const layerWidth = width + verticalGutter;
      const layerHeight = height + horizontalGutter;
      const configuredZIndex = this.options.zIndex ?? Number(element.dataset.scrollbarZIndex);
      const x =
        this.options.horizontal !== false &&
        (/auto|scroll/.test(style.overflowX) || this.options.horizontal === true);
      const y =
        this.options.vertical !== false &&
        (/auto|scroll/.test(style.overflowY) || this.options.vertical === true);
      const canScrollHorizontally = x && scrollWidth > width + 0.5;
      const canScrollVertically = y && scrollHeight > height + 0.5;
      const documentTrack = !gutter && presentation.kind === "document";
      const verticalSlot = canScrollVertically || documentTrack;
      const rect = element.getBoundingClientRect();
      // Mount in the existing containing block: never wrap/reparent authored
      // content or change which ancestor positions a package's own overlays.
      let parent = element.offsetParent;
      if (!parent) {
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (styleFor(ancestor).position !== "static") {
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
        const ancestorStyle = styleFor(ancestor);
        if (
          !/(auto|scroll|hidden|clip)/.test(`${ancestorStyle.overflowX} ${ancestorStyle.overflowY}`)
        )
          continue;
        const bounds = ancestor.getBoundingClientRect();
        const top = rect.top + element.clientTop;
        const left = rect.left + element.clientLeft - leftGutter;
        if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowY)) {
          clipTop = Math.max(clipTop, bounds.top + ancestor.clientTop - top);
          clipBottom = Math.max(
            clipBottom,
            top + layerHeight - bounds.top - ancestor.clientTop - ancestor.clientHeight,
          );
        }
        if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowX)) {
          clipLeft = Math.max(clipLeft, bounds.left + ancestor.clientLeft - left);
          clipRight = Math.max(
            clipRight,
            left + layerWidth - bounds.left - ancestor.clientLeft - ancestor.clientWidth,
          );
        }
      }
      const persistent = presentation.policy === "always";
      const nativeScrollLeft = element.scrollLeft;
      const scrollLeft = this.rtl
        ? Math.max(0, scrollWidth - width) + nativeScrollLeft
        : nativeScrollLeft;
      const wheelChain = [];
      const scrollAncestors = [];
      for (let node = element; node; node = node.parentElement) {
        if (node !== element) scrollAncestors.push(node);
        if (typeof node.scrollBy !== "function") continue;
        const nodeStyle = styleFor(node);
        let overflowX = nodeStyle.overflowX;
        let overflowY = nodeStyle.overflowY;
        const viewport = node === element.ownerDocument.scrollingElement;
        if (
          viewport &&
          node === element.ownerDocument.documentElement &&
          element.ownerDocument.body
        ) {
          const bodyStyle = styleFor(element.ownerDocument.body);
          if (overflowX === "visible") overflowX = bodyStyle.overflowX;
          if (overflowY === "visible") overflowY = bodyStyle.overflowY;
        }
        const horizontal =
          /auto|scroll/.test(overflowX) ||
          (viewport && overflowX !== "hidden" && overflowX !== "clip") ||
          (node === element && this.options.horizontal === true);
        const vertical =
          /auto|scroll/.test(overflowY) ||
          (viewport && overflowY !== "hidden" && overflowY !== "clip") ||
          (node === element && this.options.vertical === true);
        if (horizontal || vertical)
          wheelChain.push({
            element: node,
            horizontal,
            vertical,
            containX:
              nodeStyle.overscrollBehaviorX === "contain" ||
              nodeStyle.overscrollBehaviorX === "none",
            containY:
              nodeStyle.overscrollBehaviorY === "contain" ||
              nodeStyle.overscrollBehaviorY === "none",
          });
      }
      this.manager.updateScrollRouting(this, scrollAncestors);
      return {
        owner: presentation.focusOwner,
        scrollAncestors,
        parent,
        layout: presentation.layout,
        documentTrack,
        layerWidth,
        layerHeight,
        followSibling,
        stacking: Number.isFinite(configuredZIndex)
          ? String(Math.trunc(configuredZIndex))
          : followSibling
            ? style.zIndex
            : "10",
        left:
          rect.left +
          element.clientLeft -
          leftGutter -
          parentRect.left -
          parent.clientLeft +
          parent.scrollLeft,
        top: rect.top + element.clientTop - parentRect.top - parent.clientTop + parent.scrollTop,
        clip: `inset(${Math.max(0, clipTop)}px ${Math.max(0, clipRight)}px ${Math.max(0, clipBottom)}px ${Math.max(0, clipLeft)}px)`,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden",
        persistent,
        edge,
        verticalSize: size,
        horizontalSize: size,
        scrollEndInset: !gutter && canScrollHorizontally ? size : 0,
        viewportWidth: width,
        viewportHeight: height,
        // The vertical rail owns the intersection in every layout, including
        // the space reserved by the native horizontal gutter.
        verticalTrackSize: layerHeight,
        horizontalTrackSize: Math.max(0, width - (!gutter && verticalSlot ? size : 0)),
        horizontalInset: gutter ? leftGutter : edge === "left" && verticalSlot ? size : 0,
        scrollWidth,
        scrollHeight,
        canScrollHorizontally,
        canScrollVertically,
        scrollTop: element.scrollTop,
        scrollLeft,
        positionVersion: this.positionVersion,
        layoutVersion: this.layoutVersion,
        wheelChain,
        wheelLineHeight: parseFloat(style.lineHeight) || 16,
        // Match native defaults: macOS preserves the delivered axes; other
        // platforms use Shift+Y for horizontal scrolling.
        wheelShiftHorizontal: !/Mac/i.test(window.navigator.platform),
      };
    }

    readAuthoredPadding(style) {
      for (const [property, state] of this.endStyles)
        if (!state.managed) {
          state.authored = {
            value: this.element.style.getPropertyValue(property),
            priority: this.element.style.getPropertyPriority(property),
          };
          const base = style.getPropertyValue(property).trim();
          state.base = base && base !== "auto" ? base : "0px";
        }
    }

    write(snapshot) {
      if (this.destroyed || !snapshot) return;
      for (const [property, state] of this.endStyles) {
        const value = this.element.style.getPropertyValue(property);
        const priority = this.element.style.getPropertyPriority(property);
        if (
          value !== (state.managed || state.authored.value) ||
          priority !== (state.managed ? "important" : state.authored.priority)
        ) {
          // Adopt an authored write without exposing a frame that lost its end
          // reserve. Only this style race needs a synchronous baseline measure.
          this.captureAuthoredPadding();
          this.readAuthoredPadding(this.manager.window.getComputedStyle(this.element));
          const current = {
            ...snapshot,
            scrollTop: this.element.scrollTop,
            scrollHeight: this.element.scrollHeight,
            viewportHeight: this.element.clientHeight,
          };
          if (
            this.paddingScrollPosition?.atEnd &&
            current.scrollTop >= current.scrollHeight - current.viewportHeight - 1
          )
            this.paddingScrollPosition.expected = current.scrollTop;
          this.updateEndPadding(current);
          this.restorePaddingScrollPosition();
          this.manager.invalidate(this, true);
          return;
        }
      }
      if (snapshot.layoutVersion !== this.layoutVersion) return;
      if (this.paddingScrollPosition?.expected === null)
        this.paddingScrollPosition.expected = snapshot.scrollTop;
      if (this.layout !== snapshot.layout) {
        this.layout = snapshot.layout;
        this.element.classList.toggle("lumine-scrollport-gutter", this.layout === "gutter");
        this.manager.invalidate(this);
        return;
      }
      if (snapshot.endPaddingChanged || this.updateEndPadding(snapshot)) {
        if (!snapshot.endPaddingChanged) this.restorePaddingScrollPosition();
        // Padding changes the native extent (and may resize percentage-height
        // content). Publish only the next measured geometry, never an estimate.
        this.manager.invalidate(this);
        return;
      }
      if (snapshot.positionVersion !== this.positionVersion) {
        // Input may arrive between the shared read and write phases. Project
        // the latest captured native offsets without another layout read.
        snapshot.scrollTop = this.scrollTop;
        snapshot.scrollLeft = this.rtl
          ? Math.max(0, snapshot.scrollWidth - snapshot.viewportWidth) + this.scrollLeft
          : this.scrollLeft;
      }
      if (this.paddingScrollPosition) {
        const { top, expected, atEnd } = this.paddingScrollPosition;
        this.paddingScrollPosition = null;
        // A temporary baseline probe may clamp a native offset at the bottom.
        // Restore it after remeasurement, unless input moved away meanwhile.
        snapshot.scrollTop = this.element.scrollTop;
        if (snapshot.scrollTop === expected) {
          const maximum = Math.max(0, snapshot.scrollHeight - snapshot.viewportHeight);
          snapshot.scrollTop = atEnd ? maximum : clamp(top, 0, maximum);
          if (snapshot.scrollTop !== expected)
            this.element.scrollTo({ top: snapshot.scrollTop, behavior: "instant" });
        }
      }
      const old = this.geometry;
      this.geometry = snapshot;
      if (snapshot.followSibling) {
        if (this.element.nextSibling !== this.layer)
          snapshot.parent.insertBefore(this.layer, this.element.nextSibling);
      } else if (this.layer.parentElement !== snapshot.parent)
        snapshot.parent.appendChild(this.layer);
      this.owner = snapshot.owner;
      this.manager.updateRouting(this, snapshot);
      const style = this.layer.style;
      for (const [key, value] of Object.entries({
        left: `${snapshot.left}px`,
        top: `${snapshot.top}px`,
        width: `${snapshot.layerWidth}px`,
        height: `${snapshot.layerHeight}px`,
        clipPath: snapshot.clip,
        display: snapshot.visible ? "" : "none",
        zIndex: snapshot.stacking,
      }))
        if (style[key] !== value) style[key] = value;
      this.layer.classList.toggle("is-persistent", snapshot.persistent);
      this.layer.classList.toggle("is-document", snapshot.documentTrack);
      this.layer.classList.toggle("is-gutter", snapshot.layout === "gutter");
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
      this.horizontal.element.style.left = `${snapshot.horizontalInset}px`;
      const transient =
        !snapshot.persistent &&
        snapshot.layout === "overlay" &&
        snapshot.visible &&
        (snapshot.canScrollVertically || snapshot.canScrollHorizontally);
      if (transient && !this.activity)
        this.activity = new ScrollbarActivity({
          window: this.manager.window,
          onChange: () => this.syncVisibility(),
        });
      else if (!transient && this.activity) {
        this.activity.dispose();
        this.activity = null;
      }
      if (snapshot.persistent || snapshot.layout !== "overlay" || !snapshot.visible)
        this.pendingActivityDeadline = null;
      else if (this.pendingActivityDeadline != null) {
        const remaining = this.pendingActivityDeadline - this.manager.window.performance.now();
        if (remaining > 0 && this.activity) this.activity.reveal(remaining);
        if (remaining <= 0 || this.activity) this.pendingActivityDeadline = null;
      }
      this.syncVisibility();
      const keys = [
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
      ];
      this.publicGeometry = Object.fromEntries(keys.map((key) => [key, snapshot[key]]));
      if (!old || keys.some((key) => old[key] !== snapshot[key]))
        for (const callback of this.callbacks) callback(this.publicGeometry);
    }

    syncPosition() {
      const top = this.element.scrollTop;
      const left = this.element.scrollLeft;
      const moved = top !== this.scrollTop || left !== this.scrollLeft;
      this.scrollTop = top;
      this.scrollLeft = left;
      if (moved) this.positionVersion++;
      if (this.geometry) {
        this.vertical.updatePosition(top);
        this.horizontal.updatePosition(
          this.rtl ? this.geometry.scrollWidth - this.geometry.viewportWidth + left : left,
        );
      }
      if (moved) this.reveal();
    }

    routeWheel(event) {
      const element = this.element;
      const document = element.ownerDocument;
      const window = document.defaultView;
      if (
        this.destroyed ||
        !this.geometry ||
        event.defaultPrevented ||
        !element.isConnected ||
        document !== this.manager.document ||
        !window
      )
        return;
      // The chrome is a sibling of its scrollport. Forward its wheel through
      // the authored content path before emulating the uncancelled native
      // default; owned and ancestor bubble handlers see it exactly once.
      // Common ancestor capture observers have already seen the portal event;
      // cancellation there prevents replay, while uncancelled observers can
      // also see the forwarded event (whose isTrusted is false).
      event.stopPropagation();
      const forwarded = new window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        buttons: event.buttons,
      });
      Object.defineProperty(forwarded, "timeStamp", { value: event.timeStamp });
      if ("momentum" in event)
        Object.defineProperty(forwarded, "momentum", { value: event.momentum });
      if (!element.dispatchEvent(forwarded)) {
        event.preventDefault();
        return;
      }
      if (this.destroyed || !element.isConnected || element.ownerDocument !== document) return;
      // Pinch/zoom remains the browser's default when no authored handler
      // claims it; it is not a request to change a scroll offset.
      if (event.ctrlKey) return;
      let x = event.deltaX;
      let y = event.deltaY;
      if (event.deltaMode === 1) {
        x *= this.geometry.wheelLineHeight;
        y *= this.geometry.wheelLineHeight;
      } else if (event.deltaMode === 2) {
        x *= this.geometry.viewportWidth;
        y *= this.geometry.viewportHeight;
      }
      if (event.shiftKey && !x && this.geometry.wheelShiftHorizontal) {
        x = y;
        y = 0;
      }
      let pendingX = x !== 0;
      let pendingY = y !== 0;
      let claimed = false;
      for (const node of this.geometry.wheelChain) {
        const left = pendingX && node.horizontal ? x : 0;
        const top = pendingY && node.vertical ? y : 0;
        if (left || top) {
          const beforeLeft = node.element.scrollLeft;
          const beforeTop = node.element.scrollTop;
          node.element.scrollBy({ left, top, behavior: "instant" });
          if (node.element.scrollLeft !== beforeLeft) {
            pendingX = false;
            claimed = true;
          }
          if (node.element.scrollTop !== beforeTop) {
            pendingY = false;
            claimed = true;
          }
        }
        if (pendingX && node.horizontal && node.containX) {
          pendingX = false;
          claimed = true;
        }
        if (pendingY && node.vertical && node.containY) {
          pendingY = false;
          claimed = true;
        }
        if (!pendingX && !pendingY) break;
      }
      if (claimed) event.preventDefault();
    }

    syncVisibility() {
      if (!this.owner || this.destroyed) return;
      const visible =
        this.owner.matches(":hover") ||
        this.layer.matches(":hover") ||
        !!this.activity?.active ||
        !!this.vertical.drag ||
        !!this.horizontal.drag;
      this.layer.classList.toggle("is-revealed", visible);
    }

    reveal() {
      if (this.destroyed) return false;
      if (!this.activity) {
        // A handled expand/navigation can introduce overflow on the next
        // layout pass. Remember its deadline without measuring or a timer.
        if (
          !this.geometry ||
          (!this.geometry.persistent && this.geometry.layout === "overlay" && this.geometry.visible)
        )
          this.pendingActivityDeadline = this.manager.window.performance.now() + 700;
        return false;
      }
      this.activity.reveal();
      return true;
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
      this.activity?.dispose();
      this.activity = null;
      this.manager.removeRouting(this);
      this.observer.disconnect();
      this.layer.removeEventListener("wheel", this.wheel);
      this.vertical.destroy();
      this.horizontal.destroy();
      this.layer.remove();
      this.manager.retiredEndStyles.set(this.element, this.endStyles);
      this.restorePadding();
      this.element.classList.remove("lumine-scrollport");
      this.element.classList.remove("lumine-scrollport-gutter");
      if (this.element.style.scrollbarWidth === "none")
        this.element.style.scrollbarWidth = this.previousScrollbarWidth;
      if (owners.get(this.element) === this) owners.delete(this.element);
      this.callbacks.clear();
      this.manager.controllers.delete(this.element);
      this.manager.dirty.delete(this);
      this.manager.window.queueMicrotask(() => {
        if (this.manager.retiredEndStyles.get(this.element) === this.endStyles)
          this.manager.retiredEndStyles.delete(this.element);
      });
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
      this.visibilityTargets = new Map();
      this.scrollDependents = new Map();
      this.retiredEndStyles = new WeakMap();
      this.dirty = new Set();
      this.roots = new Set([document.body]);
      this.listeners = {
        scroll: (event) => {
          this.controllers.get(event.target)?.syncPosition();
          const dependents = this.scrollDependents.get(event.target);
          if (dependents) for (const controller of dependents) this.invalidate(controller);
        },
        pointerover: (event) => this.syncVisibility(event),
        pointerout: (event) => this.syncVisibility(event),
      };
      for (const [name, callback] of Object.entries(this.listeners))
        document.addEventListener(name, callback, true);
      this.resize = () => this.refresh();
      this.window.addEventListener("resize", this.resize);
      this.mutations = new this.window.MutationObserver((records) => {
        const affected = new Map();
        const stylesChanged = new Set();
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
              if (target.contains(current.element)) {
                if (!affected.has(current)) affected.set(current, false);
                stylesChanged.add(current);
              }
          } else {
            for (const node of record.addedNodes)
              if (node.nodeType === 1 && !node.closest(excluded)) this.addRoot(node);
          }
        }
        if (!relevant) return;
        for (const [controller, childrenChanged] of affected) {
          if (childrenChanged) controller.observeChildren();
          this.invalidate(controller, stylesChanged.has(controller));
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
        attributeFilter: [
          "class",
          "style",
          "data-scrollbar",
          "data-scrollbar-layout",
          "data-scrollbar-kind",
          "data-scrollbar-z-index",
          "hidden",
          "open",
        ],
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
            .filter(
              (name) => name && name !== "lumine-scrollport" && name !== "lumine-scrollport-gutter",
            )
            .sort()
            .join(" ");
        return (
          withoutChrome(record.oldValue || "") ===
          withoutChrome(record.target.getAttribute("class") || "")
        );
      }
      if (record.attributeName !== "style") return false;
      this.attributeStyle ??= this.document.createElement("span").style;
      const controller = this.controllers.get(record.target);
      const endStyles = controller?.endStyles || this.retiredEndStyles.get(record.target);
      if (controller)
        for (const [property, state] of controller.endStyles)
          if (
            state.managed &&
            (record.target.style.getPropertyValue(property) !== state.managed ||
              record.target.style.getPropertyPriority(property) !== "important")
          )
            return false;
      const withoutChrome = (value) => {
        this.attributeStyle.cssText = value || "";
        this.attributeStyle.removeProperty("scrollbar-width");
        if (endStyles)
          for (const [property, state] of endStyles) {
            const value = this.attributeStyle.getPropertyValue(property);
            const priority = this.attributeStyle.getPropertyPriority(property);
            if (
              state.chromeValues.has(`${value}:${priority}`) ||
              (value === state.authored.value && priority === state.authored.priority)
            )
              this.attributeStyle.removeProperty(property);
          }
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

    reveal(element) {
      return this.controllers.get(element)?.reveal() ?? false;
    }

    scan(root) {
      if (!root?.isConnected || root.closest(excluded)) return;
      const inspect = (element) => {
        const current = this.controllers.get(element);
        if (current) {
          // A same-document move can preserve size while changing containing
          // block, clipping and panel reveal policy.
          this.invalidate(current, true);
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

    invalidate(controller, stylesChanged = false) {
      if (this.destroyed || controller.destroyed) return;
      controller.layoutVersion++;
      controller.paddingStyleDirty ||= stylesChanged;
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
        const dirty = [...this.dirty];
        for (const controller of dirty) controller.preservePaddingScrollPosition();
        for (const controller of dirty) controller.prepareRead();
        const measured = dirty.map((controller) => [controller, controller.read()]);
        // Measure every authored baseline before reinstating any managed
        // padding, then restore all offsets before the queued write phase.
        for (const [controller, snapshot] of measured) controller.finishRead(snapshot);
        for (const [controller, snapshot] of measured)
          if (snapshot?.endPaddingChanged) controller.restorePaddingScrollPosition();
        this.dirty.clear();
        this.writeRequest = this.scheduleWrite(() => {
          this.writeRequest = null;
          if (this.destroyed) return;
          for (const [controller, snapshot] of measured) controller.write(snapshot);
        });
      });
    }

    updateRouting(controller, snapshot) {
      const previous = controller.routing;
      const hover = snapshot.visible && !snapshot.persistent;
      if (previous?.owner === snapshot.owner && previous.hover === hover) return;
      this.removeVisibilityRouting(controller);
      const add = (index, target) => {
        let group = index.get(target);
        if (!group) index.set(target, (group = new Set()));
        group.add(controller);
      };
      if (hover) {
        add(this.visibilityTargets, snapshot.owner);
        add(this.visibilityTargets, controller.layer);
      }
      controller.routing = { owner: snapshot.owner, hover };
    }

    updateScrollRouting(controller, ancestors) {
      const previous = controller.scrollAncestors;
      if (
        previous?.length === ancestors.length &&
        previous.every((node, index) => node === ancestors[index])
      )
        return;
      this.removeScrollRouting(controller);
      for (const ancestor of [...ancestors, this.document]) {
        let group = this.scrollDependents.get(ancestor);
        if (!group) this.scrollDependents.set(ancestor, (group = new Set()));
        group.add(controller);
      }
      controller.scrollAncestors = ancestors;
    }

    removeScrollRouting(controller) {
      if (!controller.scrollAncestors) return;
      for (const ancestor of [...controller.scrollAncestors, this.document]) {
        const group = this.scrollDependents.get(ancestor);
        if (!group) continue;
        group.delete(controller);
        if (!group.size) this.scrollDependents.delete(ancestor);
      }
      controller.scrollAncestors = null;
    }

    removeVisibilityRouting(controller) {
      const routing = controller.routing;
      if (!routing) return;
      const remove = (index, target) => {
        const group = index.get(target);
        if (!group) return;
        group.delete(controller);
        if (!group.size) index.delete(target);
      };
      if (routing.hover) {
        remove(this.visibilityTargets, routing.owner);
        remove(this.visibilityTargets, controller.layer);
      }
      controller.routing = null;
    }

    removeRouting(controller) {
      this.removeVisibilityRouting(controller);
      this.removeScrollRouting(controller);
    }

    pointerControllers(target, relatedTarget, affected) {
      const related = relatedTarget?.nodeType ? relatedTarget : null;
      for (
        let node = target?.nodeType === 1 ? target : target?.parentElement;
        node;
        node = node.parentElement
      ) {
        const group = this.visibilityTargets.get(node);
        if (!group || (related && node.contains(related))) continue;
        affected ??= new Set();
        for (const controller of group) affected.add(controller);
      }
      return affected;
    }

    syncVisibility(event) {
      let affected = this.pointerControllers(event.target, event.relatedTarget);
      affected = this.pointerControllers(event.relatedTarget, event.target, affected);
      if (affected) for (const controller of affected) controller.syncVisibility();
    }
    refresh() {
      for (const controller of this.controllers.values()) {
        controller.paddingStyleDirty = true;
        this.dirty.add(controller);
      }
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
      this.visibilityTargets.clear();
      this.scrollDependents.clear();
      this.roots.clear();
      this.dirty.clear();
    }
  }
  return {
    ScrollbarActivity,
    OverlayScrollbar,
    DOMScrollbarManager,
    scrollbarSize,
    scrollbarPresentation,
  };
}

module.exports = { ...createScrollbarRuntime(), createScrollbarRuntime };
