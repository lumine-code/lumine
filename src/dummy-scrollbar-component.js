module.exports = class DummyScrollbarComponent {
  constructor(props) {
    this.props = props;
    this.didMouseDown = this.didMouseDown.bind(this);

    const { orientation } = props;
    this.element = document.createElement("div");
    this.element.className = `${orientation}-scrollbar`;
    this.innerElement = document.createElement("div");
    this.element.appendChild(this.innerElement);
    this.element.addEventListener("scroll", (event) => this.props.didScroll(event));
    this.element.addEventListener("mousedown", this.didMouseDown);

    const outerStyle = this.element.style;
    const innerStyle = this.innerElement.style;
    outerStyle.position = "absolute";
    outerStyle.contain = "content";
    outerStyle.zIndex = 1;
    outerStyle.willChange = "transform";
    outerStyle.cursor = "default";
    if (orientation === "horizontal") {
      outerStyle.bottom = 0;
      outerStyle.left = 0;
      outerStyle.height = "15px";
      outerStyle.overflowY = "hidden";
      innerStyle.height = "15px";
    } else {
      outerStyle.right = 0;
      outerStyle.top = 0;
      outerStyle.width = "15px";
      outerStyle.overflowX = "hidden";
      innerStyle.width = "15px";
    }
    this.updateStyles({});
  }

  update(newProps) {
    const oldProps = this.props;
    this.props = newProps;
    this.updateStyles(oldProps);

    const shouldFlushScrollPosition =
      newProps.scrollTop !== oldProps.scrollTop || newProps.scrollLeft !== oldProps.scrollLeft;
    if (shouldFlushScrollPosition) this.flushScrollPosition();
  }

  // Synchronizes only the native scrollbar position during a smooth-scroll
  // frame. Geometry and visibility still go through update(), where their
  // dependencies are reconciled together.
  updateScrollPosition(position) {
    if (this.props.orientation === "horizontal") {
      if (position === this.props.scrollLeft) return;
      this.props.scrollLeft = position;
    } else {
      if (position === this.props.scrollTop) return;
      this.props.scrollTop = position;
    }
    this.flushScrollPosition();
  }

  destroy() {
    this.element.remove();
  }

  // Writes only the styles whose inputs changed since the given previous
  // props, so per-frame updates with unchanged geometry don't touch the DOM.
  updateStyles(oldProps) {
    const {
      orientation,
      scrollWidth,
      scrollHeight,
      verticalScrollbarWidth,
      horizontalScrollbarHeight,
      canScroll,
      forceScrollbarVisible,
    } = this.props;

    if (canScroll !== oldProps.canScroll) {
      this.element.style.visibility = canScroll ? "" : "hidden";
    }

    if (orientation === "horizontal") {
      if (verticalScrollbarWidth !== oldProps.verticalScrollbarWidth) {
        this.element.style.right = (verticalScrollbarWidth || 0) + "px";
      }
      if (forceScrollbarVisible !== oldProps.forceScrollbarVisible) {
        this.element.style.overflowX = forceScrollbarVisible ? "scroll" : "auto";
      }
      if (scrollWidth !== oldProps.scrollWidth) {
        this.innerElement.style.width = (scrollWidth || 0) + "px";
      }
    } else {
      if (horizontalScrollbarHeight !== oldProps.horizontalScrollbarHeight) {
        this.element.style.bottom = (horizontalScrollbarHeight || 0) + "px";
      }
      if (forceScrollbarVisible !== oldProps.forceScrollbarVisible) {
        this.element.style.overflowY = forceScrollbarVisible ? "scroll" : "auto";
      }
      if (scrollHeight !== oldProps.scrollHeight) {
        this.innerElement.style.height = (scrollHeight || 0) + "px";
      }
    }
  }

  flushScrollPosition() {
    if (this.props.orientation === "horizontal") {
      this.element.scrollLeft = this.props.scrollLeft;
    } else {
      this.element.scrollTop = this.props.scrollTop;
    }
  }

  didMouseDown(event) {
    let { bottom, right } = this.element.getBoundingClientRect();
    const clickedOnScrollbar =
      this.props.orientation === "horizontal"
        ? event.clientY >= bottom - this.getRealScrollbarHeight()
        : event.clientX >= right - this.getRealScrollbarWidth();
    if (!clickedOnScrollbar) this.props.didMouseDown(event);
  }

  getRealScrollbarWidth() {
    return this.element.offsetWidth - this.element.clientWidth;
  }

  getRealScrollbarHeight() {
    return this.element.offsetHeight - this.element.clientHeight;
  }
};
