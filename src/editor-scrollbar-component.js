const { OverlayScrollbar } = require("./overlay-scrollbar");

// The editor owns logical geometry and syntax publication. This adapter only
// projects that state onto the shared custom rail, without a native scroller
// or any document-sized DOM element.
module.exports = class EditorScrollbarComponent {
  constructor(props) {
    this.props = props;
    this.scrollbar = new OverlayScrollbar({
      document: props.document,
      orientation: props.orientation,
      onScroll: (position, { jump }) => {
        this.props[this.props.orientation === "horizontal" ? "scrollLeft" : "scrollTop"] = position;
        this.props.didScroll({ orientation: this.props.orientation, position, jump });
      },
      onDragChange: (dragging) =>
        this.props.didDragChange?.({ orientation: this.props.orientation, dragging }),
    });
    this.element = this.scrollbar.element;
    this.element.classList.add(`${props.orientation}-scrollbar`, "editor-scrollbar");
    this.update(props);
  }

  update(props) {
    this.props = props;
    const horizontal = props.orientation === "horizontal";
    const opposite = horizontal ? props.verticalScrollbarWidth : props.horizontalScrollbarHeight;
    const edge = horizontal ? "right" : "bottom";
    const value = (opposite || 0) + "px";
    if (this.element.style[edge] !== value) this.element.style[edge] = value;
    this.scrollbar.update({
      extent: horizontal ? props.scrollWidth : props.scrollHeight,
      viewport: props.viewportExtent,
      trackSize: Math.max(0, (props.trackExtent || props.viewportExtent || 0) - (opposite || 0)),
      position: horizontal ? props.scrollLeft : props.scrollTop,
      canScroll: props.canScroll,
      thickness: horizontal ? props.horizontalScrollbarHeight : props.verticalScrollbarWidth,
    });
  }

  updateScrollPosition(position) {
    this.props[this.props.orientation === "horizontal" ? "scrollLeft" : "scrollTop"] = position;
    this.scrollbar.updatePosition(position);
  }

  updatePositionBeforeRender(props) {
    for (const key of [
      "scrollWidth",
      "scrollHeight",
      "viewportExtent",
      "trackExtent",
      "verticalScrollbarWidth",
      "horizontalScrollbarHeight",
      "canScroll",
    ]) {
      if (props[key] !== this.props[key]) return;
    }
    this.updateScrollPosition(
      props.orientation === "horizontal" ? props.scrollLeft : props.scrollTop,
    );
  }

  flushScrollPosition() {
    this.updateScrollPosition(
      this.props.orientation === "horizontal" ? this.props.scrollLeft : this.props.scrollTop,
    );
  }

  destroy() {
    this.scrollbar.destroy();
  }
};
