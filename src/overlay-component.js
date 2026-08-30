module.exports = class OverlayComponent {
  constructor(props) {
    this.props = props;
    this.element = document.createElement("lumine-overlay");
    if (this.props.className != null) this.element.classList.add(this.props.className);
    this.element.appendChild(this.props.element);
    this.element.style.position = "fixed";
    // No z-index here: `lumine-overlay` carries one in core-ui, and an inline
    // declaration would outrank every stylesheet without `!important` —
    // including the packages that deliberately raise theirs to clear the docks.
    this.element.style.top = (this.props.pixelTop || 0) + "px";
    this.element.style.left = (this.props.pixelLeft || 0) + "px";
    this.applyAnchor();
    this.currentContentRect = null;

    // Synchronous DOM updates in response to resize events might trigger a
    // "loop limit exceeded" error. We disconnect the observer before
    // potentially mutating the DOM, and then reconnect it on the next tick.
    // Note: ResizeObserver calls its callback when .observe is called
    this.resizeObserver = new ResizeObserver((entries) => {
      const { contentRect } = entries[0];

      if (
        this.currentContentRect &&
        (this.currentContentRect.width !== contentRect.width ||
          this.currentContentRect.height !== contentRect.height)
      ) {
        this.resizeObserver.disconnect();
        this.props.didResize(this);
        process.nextTick(() => {
          this.resizeObserver.observe(this.props.element);
        });
      }

      this.currentContentRect = contentRect;
    });
    this.didAttach();
    this.props.overlayComponents.add(this);
  }

  destroy() {
    this.props.overlayComponents.delete(this);
    this.didDetach();
  }

  getNextUpdatePromise() {
    if (!this.nextUpdatePromise) {
      this.nextUpdatePromise = new Promise((resolve) => {
        this.resolveNextUpdatePromise = () => {
          this.nextUpdatePromise = null;
          this.resolveNextUpdatePromise = null;
          resolve();
        };
      });
    }
    return this.nextUpdatePromise;
  }

  update(newProps) {
    const oldProps = this.props;
    this.props = Object.assign({}, oldProps, newProps);
    if (this.props.pixelTop != null) this.element.style.top = this.props.pixelTop + "px";
    if (this.props.pixelLeft != null) this.element.style.left = this.props.pixelLeft + "px";
    if (newProps.className !== oldProps.className) {
      if (oldProps.className != null) this.element.classList.remove(oldProps.className);
      if (newProps.className != null) this.element.classList.add(newProps.className);
    }
    this.applyAnchor();

    if (this.resolveNextUpdatePromise) this.resolveNextUpdatePromise();
  }

  // Publishes where the annotated position ended up, so that an overlay
  // drawing a pointer at it can follow the fit: `above` when the overlay was
  // flipped over the line to stay in the window, the offset of the position
  // inside the item's own box, and the item's margin — the distance between
  // the item and this wrapper, for a pointer drawn on the wrapper because the
  // item clips its overflow. `displaced` says the overlay was pushed off its
  // line to clear another one, and so is not touching the position it
  // annotates any more: a pointer would aim at whatever sits in between.
  applyAnchor() {
    this.element.dataset.overlayPosition = this.props.flipped ? "above" : "below";
    if (this.props.displaced) {
      this.element.dataset.overlayDisplaced = "";
    } else {
      delete this.element.dataset.overlayDisplaced;
    }
    this.element.style.setProperty("--overlay-anchor-offset", `${this.props.anchorOffset || 0}px`);
    this.element.style.setProperty("--overlay-margin-left", `${this.props.marginLeft || 0}px`);
  }

  didAttach() {
    this.resizeObserver.observe(this.props.element);
  }

  didDetach() {
    this.resizeObserver.disconnect();
  }
};
