const {
  textDecorationsEqual,
  ZERO_WIDTH_NBSP_CHARACTER,
} = require("./text-editor-component-helpers");

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\r": "&#13;" };
const escapeHTML = (text) => text.replace(/[&<>"\r]/g, (character) => HTML_ESCAPES[character]);
const scopeMarkup = new Map();
function scopeOpeningTag(className) {
  let html = scopeMarkup.get(className);
  if (html === undefined) {
    html = `<span class="${escapeHTML(className)}">`;
    // Class strings are immutable, unlike scope IDs across grammar changes.
    // Bound this shared cache so retired grammars cannot accumulate markup.
    if (scopeMarkup.size === 256) scopeMarkup.delete(scopeMarkup.keys().next().value);
    scopeMarkup.set(className, html);
  }
  return html;
}

module.exports = class LineComponent {
  constructor(props) {
    const { nodePool, screenRow, screenLine, lineComponentsByScreenLineId, offScreen } = props;
    this.props = props;
    this.element = nodePool.getElement("DIV", this.buildClassName(), null);
    this.element.dataset.screenRow = screenRow;
    this.cachedTextNodes = null;
    this.updateHorizontalPosition(props);

    if (offScreen) {
      this.element.style.position = "absolute";
      this.element.style.visibility = "hidden";
      this.element.dataset.offScreen = true;
    }

    this.appendContents();
    lineComponentsByScreenLineId.set(screenLine.id, this);
  }

  update(newProps) {
    this.updateHorizontalPosition(newProps);
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
      // The rebuild can change rendered glyph widths (bold ranges, injected
      // ::before content), so this line's cached horizontal pixel positions
      // are stale; evict them so cursors and highlights re-measure.
      const { horizontalPixelPositionsByScreenLineId, screenLine } = this.props;
      if (horizontalPixelPositionsByScreenLineId) {
        horizontalPixelPositionsByScreenLineId.delete(screenLine.id);
      }
    }
  }

  updateHorizontalPosition(props) {
    if (props.renderOriginLeft !== undefined) this.props.renderOriginLeft = props.renderOriginLeft;
    if (props.baseCharacterWidth !== undefined)
      this.props.baseCharacterWidth = props.baseCharacterWidth;
    const offset =
      (this.props.screenLine.startPixelColumn || 0) * (this.props.baseCharacterWidth || 0) -
      (this.props.renderOriginLeft || 0);
    // A short line far left of the viewport remains invisible without sending
    // an unrepresentable negative coordinate into Blink's layout engine.
    this.element.style.textIndent = Math.max(-1000000, offset) + "px";
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
    // HTML-built descendants were never borrowed from the pool. Retain only
    // the line shell, rather than accumulating unused token nodes there.
    if (this.unpooledContents) this.element.replaceChildren();
    nodePool.release(this.element);
  }

  appendContents() {
    const { screenLine, textDecorations } = this.props;
    this.unpooledContents =
      this.canRenderHTMLDecorations(textDecorations) &&
      screenLine.tags.length >= 8 &&
      !screenLine.lineText.includes("\0");
    if (this.unpooledContents) return this.appendHTMLContents();
    this.appendPooledContents();
  }

  get textNodes() {
    // Painting HTML needs no JavaScript references to each text node. Most
    // rows scrolled through never participate in cursor or range measurement.
    if (this.cachedTextNodes == null) this.collectTextNodes();
    return this.cachedTextNodes;
  }

  set textNodes(nodes) {
    this.cachedTextNodes = nodes;
  }

  collectTextNodes() {
    const nodes = (this.cachedTextNodes ??= []);
    nodes.length = 0;
    const walker = this.element.ownerDocument.createTreeWalker(this.element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  }

  canRenderHTMLDecorations(decorations) {
    if (!decorations) return true;
    let previous = -1;
    for (const { column, style, className } of decorations) {
      // Keep arbitrary inline styles on the DOM path. Duplicate or malformed
      // boundaries can produce empty Text nodes that HTML parsing would drop.
      // HTML also replaces NUL in attributes, unlike a direct className write.
      if (
        style ||
        (className && String(className).includes("\0")) ||
        !Number.isSafeInteger(column) ||
        column < 0 ||
        column <= previous
      )
        return false;
      previous = column;
    }
    return true;
  }

  appendHTMLContents() {
    const { displayLayer, screenLine, textDecorations } = this.props;
    if (!this.canRenderHTMLDecorations(textDecorations)) {
      this.unpooledContents = false;
      return this.appendPooledContents();
    }
    const { lineText, tags } = screenLine;
    let html = "<span>",
      column = 0,
      depth = 0,
      decorationIndex = 0,
      activeClassName = null;
    let nextDecoration = textDecorations?.[decorationIndex];
    if (nextDecoration?.column === 0) {
      activeClassName = nextDecoration.className;
      nextDecoration = textDecorations[++decorationIndex];
    }
    const appendText = (text) => {
      html += activeClassName
        ? scopeOpeningTag(String(activeClassName)) + escapeHTML(text) + "</span>"
        : escapeHTML(text);
    };
    for (const tag of tags) {
      if (tag === 0) continue;
      if (displayLayer.isCloseTag(tag)) {
        html += "</span>";
        depth--;
      } else if (displayLayer.isOpenTag(tag)) {
        // HTML parsers flatten extremely deep markup. Preserve the exact
        // scope ancestry with DOM construction for such lines.
        if (++depth > 256) {
          this.unpooledContents = false;
          return this.appendPooledContents();
        }
        html += scopeOpeningTag(displayLayer.classNameForTag(tag) || "");
      } else {
        // Decorated text remains a leaf span inside the current syntax scope;
        // a decoration crossing scopes is reopened in each scope as before.
        if (depth >= 256 && (activeClassName || nextDecoration)) {
          this.unpooledContents = false;
          return this.appendPooledContents();
        }
        const nextTokenColumn = column + tag;
        while (nextDecoration && nextDecoration.column <= nextTokenColumn) {
          appendText(lineText.substring(column, nextDecoration.column));
          column = nextDecoration.column;
          activeClassName = nextDecoration.className;
          nextDecoration = textDecorations[++decorationIndex];
        }
        if (column < nextTokenColumn) {
          appendText(lineText.substring(column, nextTokenColumn));
          column = nextTokenColumn;
        }
      }
    }
    html += "</span>";
    if (column === 0) html += " ";
    if (lineText.endsWith(displayLayer.foldCharacter)) html += ZERO_WIDTH_NBSP_CHARACTER;
    this.element.innerHTML = html;
    // Once exposed, keep the same array current through decoration rebuilds.
    if (this.cachedTextNodes != null) this.collectTextNodes();
  }

  appendPooledContents() {
    const { displayLayer, nodePool, screenLine, textDecorations } = this.props;

    (this.cachedTextNodes ??= []).length = 0;

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
