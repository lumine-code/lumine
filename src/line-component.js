const {
  textDecorationsEqual,
  ZERO_WIDTH_NBSP_CHARACTER,
} = require("./text-editor-component-helpers");

module.exports = class LineComponent {
  constructor(props) {
    const { nodePool, screenRow, screenLine, lineComponentsByScreenLineId, offScreen } = props;
    this.props = props;
    this.element = nodePool.getElement("DIV", this.buildClassName(), null);
    this.element.dataset.screenRow = screenRow;
    this.textNodes = [];

    if (offScreen) {
      this.element.style.position = "absolute";
      this.element.style.visibility = "hidden";
      this.element.dataset.offScreen = true;
    }

    this.appendContents();
    lineComponentsByScreenLineId.set(screenLine.id, this);
  }

  update(newProps) {
    if (this.props.lineDecoration !== newProps.lineDecoration) {
      this.props.lineDecoration = newProps.lineDecoration;
      this.element.className = this.buildClassName();
    }

    if (this.props.screenRow !== newProps.screenRow) {
      this.props.screenRow = newProps.screenRow;
      this.element.dataset.screenRow = newProps.screenRow;
    }

    if (!textDecorationsEqual(this.props.textDecorations, newProps.textDecorations)) {
      this.props.textDecorations = newProps.textDecorations;
      // Remove every child, not just the scope span: appendContents() adds
      // the empty-line placeholder and fold-marker text nodes directly to
      // the element, and any survivor shifts all subsequent renders right.
      while (this.element.firstChild) this.element.firstChild.remove();
      this.appendContents();
    }
  }

  destroy() {
    const {
      nodePool,
      lineComponentsByScreenLineId,
      horizontalPixelPositionsByScreenLineId,
      screenLine,
    } = this.props;

    if (lineComponentsByScreenLineId.get(screenLine.id) === this) {
      lineComponentsByScreenLineId.delete(screenLine.id);
      // Evict this line's cached horizontal pixel positions. The cache is keyed
      // by screen-line id, which changes on every edit, so without eviction it
      // grows unbounded for the life of the editor. Scoping it to currently
      // rendered lines keeps it bounded by the viewport; a line scrolled back
      // into view is re-measured cheaply on its next update.
      if (horizontalPixelPositionsByScreenLineId) {
        horizontalPixelPositionsByScreenLineId.delete(screenLine.id);
      }
    }

    this.element.remove();
    nodePool.release(this.element);
  }

  appendContents() {
    const { displayLayer, nodePool, screenLine, textDecorations } = this.props;

    this.textNodes.length = 0;

    const { lineText, tags } = screenLine;
    let openScopeNode = nodePool.getElement("SPAN", null, null);
    this.element.appendChild(openScopeNode);

    let decorationIndex = 0;
    let column = 0;
    let activeClassName = null;
    let activeStyle = null;
    let nextDecoration = textDecorations ? textDecorations[decorationIndex] : null;
    if (nextDecoration && nextDecoration.column === 0) {
      column = nextDecoration.column;
      activeClassName = nextDecoration.className;
      activeStyle = nextDecoration.style;
      nextDecoration = textDecorations[++decorationIndex];
    }

    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (tag !== 0) {
        if (displayLayer.isCloseTag(tag)) {
          openScopeNode = openScopeNode.parentElement;
        } else if (displayLayer.isOpenTag(tag)) {
          const newScopeNode = nodePool.getElement("SPAN", displayLayer.classNameForTag(tag), null);
          openScopeNode.appendChild(newScopeNode);
          openScopeNode = newScopeNode;
        } else {
          const nextTokenColumn = column + tag;
          while (nextDecoration && nextDecoration.column <= nextTokenColumn) {
            const text = lineText.substring(column, nextDecoration.column);
            this.appendTextNode(openScopeNode, text, activeClassName, activeStyle);
            column = nextDecoration.column;
            activeClassName = nextDecoration.className;
            activeStyle = nextDecoration.style;
            nextDecoration = textDecorations[++decorationIndex];
          }

          if (column < nextTokenColumn) {
            const text = lineText.substring(column, nextTokenColumn);
            this.appendTextNode(openScopeNode, text, activeClassName, activeStyle);
            column = nextTokenColumn;
          }
        }
      }
    }

    if (column === 0) {
      const textNode = nodePool.getTextNode(" ");
      this.element.appendChild(textNode);
      this.textNodes.push(textNode);
    }

    if (lineText.endsWith(displayLayer.foldCharacter)) {
      // Insert a zero-width non-breaking whitespace, so that LinesYardstick can
      // take the fold-marker::after pseudo-element into account during
      // measurements when such marker is the last character on the line.
      const textNode = nodePool.getTextNode(ZERO_WIDTH_NBSP_CHARACTER);
      this.element.appendChild(textNode);
      this.textNodes.push(textNode);
    }
  }

  appendTextNode(openScopeNode, text, activeClassName, activeStyle) {
    const { nodePool } = this.props;

    if (activeClassName || activeStyle) {
      const decorationNode = nodePool.getElement("SPAN", activeClassName, activeStyle);
      openScopeNode.appendChild(decorationNode);
      openScopeNode = decorationNode;
    }

    const textNode = nodePool.getTextNode(text);
    openScopeNode.appendChild(textNode);
    this.textNodes.push(textNode);
  }

  buildClassName() {
    const { lineDecoration } = this.props;
    let className = "line";
    if (lineDecoration != null) className = className + " " + lineDecoration;
    return className;
  }
};
