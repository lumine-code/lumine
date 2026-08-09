const NodePool = require("./node-pool");
const {
  arraysEqual,
  ceilToPhysicalPixelBoundary,
  roundToPhysicalPixelBoundary,
  NBSP_CHARACTER,
} = require("./text-editor-component-helpers");

module.exports = class GutterContainerComponent {
  constructor(props) {
    this.props = props;
    this.refs = {};
    this.gutterComponentsByGutter = new Map();
    this.lastTransform = null;

    this.element = document.createElement("div");
    this.element.className = "gutter-container";
    const style = this.element.style;
    style.position = "relative";
    style.zIndex = 1;
    style.backgroundColor = "inherit";
    this.refs.gutterContainer = this.element;

    this.innerElement = document.createElement("div");
    // No `will-change: transform`; see the note in
    // TextEditorComponent::updateContentElement. A compositing layer here would
    // cost the line numbers their subpixel antialiasing. Themes that set
    // `-webkit-font-smoothing: antialiased` on `.line-number` opt out of it
    // anyway, but that should be the theme's call, not the component's.
    this.innerElement.style.display = "flex";
    this.element.appendChild(this.innerElement);

    this.updateGutters();
  }

  update(props) {
    if (this.shouldUpdate(props)) {
      this.props = props;
      this.updateGutters();
    }
  }

  shouldUpdate(props) {
    return (
      !props.measuredContent || props.lineNumberGutterWidth !== this.props.lineNumberGutterWidth
    );
  }

  // Reconciles one gutter component per rendered gutter, keyed by the gutter
  // model object, preserving the DOM order of guttersToRender. Hidden
  // line-number gutters unmount entirely; hidden custom gutters stay mounted
  // with display: none.
  updateGutters() {
    const { hasInitialMeasurements, scrollHeight, guttersToRender, decorationsToRender } =
      this.props;

    if (hasInitialMeasurements) this.updateScrollTop(this.props.scrollTop);

    const seenGutters = new Set();
    let previousElement = null;
    for (let i = 0; i < guttersToRender.length; i++) {
      const gutter = guttersToRender[i];
      let gutterComponent = this.gutterComponentsByGutter.get(gutter);

      if (gutter.type === "line-number") {
        if (!gutter.isVisible()) {
          if (gutterComponent) this.unmountGutter(gutter, gutterComponent);
          continue;
        }

        const gutterProps = this.buildLineNumberGutterProps(gutter);
        if (gutterComponent) {
          gutterComponent.update(gutterProps);
        } else {
          gutterComponent = new LineNumberGutterComponent(gutterProps);
          this.gutterComponentsByGutter.set(gutter, gutterComponent);
          if (gutter.name === "line-number") this.refs.lineNumberGutter = gutterComponent;
        }
      } else {
        const gutterProps = {
          element: gutter.getElement(),
          name: gutter.name,
          visible: gutter.isVisible(),
          height: scrollHeight,
          decorations: decorationsToRender.customGutter.get(gutter.name),
        };
        if (gutterComponent) {
          gutterComponent.update(gutterProps);
        } else {
          gutterComponent = new CustomGutterComponent(gutterProps);
          this.gutterComponentsByGutter.set(gutter, gutterComponent);
        }
      }

      seenGutters.add(gutter);
      const element = gutterComponent.element;
      if (previousElement == null) {
        if (this.innerElement.firstChild !== element) {
          this.innerElement.insertBefore(element, this.innerElement.firstChild);
        }
      } else if (element.previousSibling !== previousElement) {
        this.innerElement.insertBefore(element, previousElement.nextSibling);
      }
      previousElement = element;
    }

    this.gutterComponentsByGutter.forEach((gutterComponent, gutter) => {
      if (!seenGutters.has(gutter)) this.unmountGutter(gutter, gutterComponent);
    });
  }

  // Moves the already-rendered gutter tiles without reconciling their rows or
  // decorations. TextEditorComponent calls this only while its mounted tile
  // window still covers the viewport.
  updateScrollTop(scrollTop) {
    this.props.scrollTop = scrollTop;
    const transform = `translateY(${-roundToPhysicalPixelBoundary(scrollTop)}px)`;
    if (transform !== this.lastTransform) {
      this.innerElement.style.transform = transform;
      this.lastTransform = transform;
    }
  }

  unmountGutter(gutter, gutterComponent) {
    if (gutterComponent.destroy) {
      gutterComponent.destroy();
    } else {
      gutterComponent.element.remove();
    }
    if (this.refs.lineNumberGutter === gutterComponent) {
      delete this.refs.lineNumberGutter;
    }
    this.gutterComponentsByGutter.delete(gutter);
  }

  buildLineNumberGutterProps(gutter) {
    const {
      rootComponent,
      showLineNumbers,
      hasInitialMeasurements,
      lineNumbersToRender,
      renderedStartRow,
      renderedEndRow,
      rowsPerTile,
      decorationsToRender,
      didMeasureVisibleBlockDecoration,
      scrollHeight,
      lineNumberGutterWidth,
      lineHeight,
    } = this.props;

    const oneTrueLineNumberGutter = gutter.name === "line-number";
    const width = oneTrueLineNumberGutter ? lineNumberGutterWidth : undefined;

    if (hasInitialMeasurements) {
      const { maxDigits, keys, bufferRows, screenRows, softWrappedFlags, foldableFlags } =
        lineNumbersToRender;
      return {
        element: gutter.getElement(),
        name: gutter.name,
        className: gutter.className,
        labelFn: gutter.labelFn,
        onMouseDown: gutter.onMouseDown,
        onMouseMove: gutter.onMouseMove,
        rootComponent: rootComponent,
        startRow: renderedStartRow,
        endRow: renderedEndRow,
        rowsPerTile: rowsPerTile,
        maxDigits: maxDigits,
        keys: keys,
        bufferRows: bufferRows,
        screenRows: screenRows,
        softWrappedFlags: softWrappedFlags,
        foldableFlags: foldableFlags,
        decorations: decorationsToRender.lineNumbers.get(gutter.name) || [],
        blockDecorations: decorationsToRender.blocks,
        didMeasureVisibleBlockDecoration: didMeasureVisibleBlockDecoration,
        height: scrollHeight,
        width,
        lineHeight: lineHeight,
        showLineNumbers,
      };
    } else {
      return {
        element: gutter.getElement(),
        name: gutter.name,
        className: gutter.className,
        onMouseDown: gutter.onMouseDown,
        onMouseMove: gutter.onMouseMove,
        maxDigits: lineNumbersToRender.maxDigits,
        showLineNumbers,
      };
    }
  }
};

class LineNumberGutterComponent {
  // Adopts the gutter model's element (`props.element`) and renders a hidden
  // measurement placeholder followed by one absolutely-positioned tile per
  // rendered tile, each holding pooled LineNumberComponents keyed by row key.
  constructor(props) {
    this.props = props;
    this.element = this.props.element;
    this.nodePool = new NodePool();
    this.didMouseDown = this.didMouseDown.bind(this);
    this.didMouseMove = this.didMouseMove.bind(this);
    this.tilesById = new Map();
    this.lastClassName = null;
    this.lastHeight = null;
    this.lastPlaceholderText = undefined;
    this.placeholderTextNode = null;

    this.element.setAttribute("gutter-name", props.name);
    this.element.style.position = "relative";
    this.element.addEventListener("mousedown", this.didMouseDown);
    this.element.addEventListener("mousemove", this.didMouseMove);

    this.placeholderElement = document.createElement("div");
    this.placeholderElement.className = "line-number dummy";
    this.placeholderElement.style.visibility = "hidden";
    this.placeholderIconElement = document.createElement("div");
    this.placeholderIconElement.className = "icon-right";
    this.placeholderElement.appendChild(this.placeholderIconElement);
    this.element.appendChild(this.placeholderElement);

    this.updateGutter();
  }

  update(newProps) {
    if (this.shouldUpdate(newProps)) {
      this.props = newProps;
      this.updateGutter();
    }
  }

  destroy() {
    // The adopted element belongs to the Gutter model and is re-adopted by a
    // fresh component when the gutter is hidden and shown again; remove the
    // children and listeners this component installed so re-adoption starts
    // clean, but leave any foreign nodes packages may have added.
    this.element.removeEventListener("mousedown", this.didMouseDown);
    this.element.removeEventListener("mousemove", this.didMouseMove);
    this.placeholderElement.remove();
    this.tilesById.forEach((tile) => {
      tile.element.remove();
    });
    this.tilesById.clear();
    this.element.remove();
  }

  updateGutter() {
    const { height, className, maxDigits, showLineNumbers } = this.props;

    let rootClassName = "gutter line-numbers";
    if (className) {
      rootClassName += " " + className;
    }
    if (rootClassName !== this.lastClassName) {
      this.element.className = rootClassName;
      this.lastClassName = rootClassName;
    }

    const heightPx = ceilToPhysicalPixelBoundary(height) + "px";
    if (heightPx !== this.lastHeight) {
      this.element.style.height = heightPx;
      this.lastHeight = heightPx;
    }

    const placeholderText = showLineNumbers ? "0".repeat(maxDigits) : null;
    if (placeholderText !== this.lastPlaceholderText) {
      if (this.placeholderTextNode) {
        this.placeholderTextNode.remove();
        this.placeholderTextNode = null;
      }
      if (placeholderText != null) {
        this.placeholderTextNode = document.createTextNode(placeholderText);
        this.placeholderElement.insertBefore(this.placeholderTextNode, this.placeholderIconElement);
      }
      this.lastPlaceholderText = placeholderText;
    }

    this.updateTiles();
  }

  updateTiles() {
    const { rootComponent, bufferRows, endRow, rowsPerTile, width } = this.props;

    const seenTileIds = new Set();
    let previousElement = this.placeholderElement;

    if (bufferRows) {
      for (let i = 0; i < rootComponent.renderedTileStartRows.length; i++) {
        const tileStartRow = rootComponent.renderedTileStartRows[i];
        const tileEndRow = Math.min(endRow, tileStartRow + rowsPerTile);
        const tileId = rootComponent.idsByTileStartRow.get(tileStartRow);
        seenTileIds.add(tileId);

        let tile = this.tilesById.get(tileId);
        if (!tile) {
          const tileElement = document.createElement("div");
          const style = tileElement.style;
          style.contain = "layout style";
          style.position = "absolute";
          tile = {
            element: tileElement,
            lineNumbersByKey: new Map(),
            height: null,
            width: null,
            top: null,
          };
          this.tilesById.set(tileId, tile);
        }

        const tileTop = rootComponent.pixelPositionBeforeBlocksForRow(tileStartRow);
        const tileBottom = rootComponent.pixelPositionBeforeBlocksForRow(tileEndRow);
        const tileHeight = tileBottom - tileTop;
        const tileWidth = width != null && width > 0 ? width + "px" : "";
        if (tile.height !== tileHeight) {
          tile.element.style.height = tileHeight + "px";
          tile.height = tileHeight;
        }
        if (tile.width !== tileWidth) {
          tile.element.style.width = tileWidth;
          tile.width = tileWidth;
        }
        if (tile.top !== tileTop) {
          // Layout `top`, not `transform`: a fractional translateY gives the
          // tile its own pixel-snapping space, painting a hairline seam
          // between adjacent tiles (see LinesTileComponent, which uses
          // `margin-top` because its tiles are static-position anchored).
          tile.element.style.top = tileTop + "px";
          tile.top = tileTop;
        }

        this.updateTileLineNumbers(tile, tileStartRow, tileEndRow);

        if (tile.element.previousSibling !== previousElement) {
          this.element.insertBefore(tile.element, previousElement.nextSibling);
        }
        previousElement = tile.element;
      }
    }

    this.tilesById.forEach((tile, tileId) => {
      if (!seenTileIds.has(tileId)) {
        tile.lineNumbersByKey.forEach((lineNumberComponent) => {
          lineNumberComponent.destroy();
        });
        tile.element.remove();
        this.tilesById.delete(tileId);
      }
    });
  }

  updateTileLineNumbers(tile, tileStartRow, tileEndRow) {
    const {
      rootComponent,
      showLineNumbers,
      width,
      startRow,
      maxDigits,
      keys,
      bufferRows,
      screenRows,
      softWrappedFlags,
      foldableFlags,
      decorations,
    } = this.props;

    const rowCount = tileEndRow - tileStartRow;
    const rowPropsByIndex = new Array(rowCount);
    const newKeys = new Set();
    for (let row = tileStartRow; row < tileEndRow; row++) {
      const indexInTile = row - tileStartRow;
      const j = row - startRow;
      const key = keys[j];
      const softWrapped = softWrappedFlags[j];
      const foldable = foldableFlags[j];
      const bufferRow = bufferRows[j];
      const screenRow = screenRows[j];

      let className = "line-number";
      if (foldable) className = className + " foldable";

      const decorationsForRow = decorations[row - startRow];
      if (decorationsForRow) className = className + " " + decorationsForRow;

      let number = null;
      if (showLineNumbers) {
        if (this.props.labelFn == null) {
          number = softWrapped ? "•" : bufferRow + 1;
          number = NBSP_CHARACTER.repeat(maxDigits - number.length) + number;
        } else {
          number = this.props.labelFn({
            bufferRow,
            screenRow,
            foldable,
            softWrapped,
            maxDigits,
          });
        }
      }

      // We need to adjust the line number position to account for block
      // decorations preceding the current row and following the preceding
      // row. Note that we ignore the latter when the line number starts at
      // the beginning of the tile, because the tile will already be
      // positioned to take into account block decorations added after the
      // last row of the previous tile.
      let marginTop = rootComponent.heightForBlockDecorationsBeforeRow(row);
      if (indexInTile > 0) marginTop += rootComponent.heightForBlockDecorationsAfterRow(row - 1);

      rowPropsByIndex[indexInTile] = {
        key,
        className,
        width,
        bufferRow,
        screenRow,
        number,
        marginTop,
        nodePool: this.nodePool,
      };
      newKeys.add(key);
    }

    tile.lineNumbersByKey.forEach((lineNumberComponent, key) => {
      if (!newKeys.has(key)) {
        lineNumberComponent.destroy();
        tile.lineNumbersByKey.delete(key);
      }
    });

    // Walk backwards so each element can be positioned before its successor
    // with a single insertBefore when it is new or out of order.
    let nextElement = null;
    for (let i = rowCount - 1; i >= 0; i--) {
      const rowProps = rowPropsByIndex[i];
      let lineNumberComponent = tile.lineNumbersByKey.get(rowProps.key);
      if (lineNumberComponent) {
        lineNumberComponent.update(rowProps);
      } else {
        lineNumberComponent = new LineNumberComponent(rowProps);
        tile.lineNumbersByKey.set(rowProps.key, lineNumberComponent);
      }
      const element = lineNumberComponent.element;
      if (element.parentNode !== tile.element || element.nextSibling !== nextElement) {
        tile.element.insertBefore(element, nextElement);
      }
      nextElement = element;
    }
  }

  shouldUpdate(newProps) {
    const oldProps = this.props;

    if (oldProps.showLineNumbers !== newProps.showLineNumbers) return true;
    if (oldProps.height !== newProps.height) return true;
    if (oldProps.width !== newProps.width) return true;
    if (oldProps.lineHeight !== newProps.lineHeight) return true;
    if (oldProps.startRow !== newProps.startRow) return true;
    if (oldProps.endRow !== newProps.endRow) return true;
    if (oldProps.rowsPerTile !== newProps.rowsPerTile) return true;
    if (oldProps.maxDigits !== newProps.maxDigits) return true;
    if (oldProps.labelFn !== newProps.labelFn) return true;
    if (oldProps.className !== newProps.className) return true;
    if (newProps.didMeasureVisibleBlockDecoration) return true;
    if (!arraysEqual(oldProps.keys, newProps.keys)) return true;
    if (!arraysEqual(oldProps.bufferRows, newProps.bufferRows)) return true;
    if (!arraysEqual(oldProps.foldableFlags, newProps.foldableFlags)) return true;
    if (!arraysEqual(oldProps.decorations, newProps.decorations)) return true;

    let oldTileStartRow = oldProps.startRow;
    let newTileStartRow = newProps.startRow;
    while (oldTileStartRow < oldProps.endRow || newTileStartRow < newProps.endRow) {
      let oldTileBlockDecorations = oldProps.blockDecorations.get(oldTileStartRow);
      let newTileBlockDecorations = newProps.blockDecorations.get(newTileStartRow);

      if (oldTileBlockDecorations && newTileBlockDecorations) {
        if (oldTileBlockDecorations.size !== newTileBlockDecorations.size) return true;

        let blockDecorationsChanged = false;

        oldTileBlockDecorations.forEach((oldDecorations, screenLineId) => {
          if (!blockDecorationsChanged) {
            const newDecorations = newTileBlockDecorations.get(screenLineId);
            blockDecorationsChanged =
              newDecorations == null || !arraysEqual(oldDecorations, newDecorations);
          }
        });
        if (blockDecorationsChanged) return true;

        newTileBlockDecorations.forEach((newDecorations, screenLineId) => {
          if (!blockDecorationsChanged) {
            const oldDecorations = oldTileBlockDecorations.get(screenLineId);
            blockDecorationsChanged = oldDecorations == null;
          }
        });
        if (blockDecorationsChanged) return true;
      } else if (oldTileBlockDecorations) {
        return true;
      } else if (newTileBlockDecorations) {
        return true;
      }

      oldTileStartRow += oldProps.rowsPerTile;
      newTileStartRow += newProps.rowsPerTile;
    }

    return false;
  }

  didMouseDown(event) {
    if (this.props.onMouseDown == null) {
      this.props.rootComponent.didMouseDownOnLineNumberGutter(event);
    } else {
      const { bufferRow, screenRow } = event.target.dataset;
      this.props.onMouseDown({
        bufferRow: parseInt(bufferRow, 10),
        screenRow: parseInt(screenRow, 10),
        domEvent: event,
      });
    }
  }

  didMouseMove(event) {
    if (this.props.onMouseMove != null) {
      const { bufferRow, screenRow } = event.target.dataset;
      this.props.onMouseMove({
        bufferRow: parseInt(bufferRow, 10),
        screenRow: parseInt(screenRow, 10),
        domEvent: event,
      });
    }
  }
}

class LineNumberComponent {
  constructor(props) {
    const { className, width, marginTop, bufferRow, screenRow, number, nodePool } = props;
    this.props = props;
    const style = {};
    if (width != null && width > 0) style.width = width + "px";
    if (marginTop != null && marginTop > 0) style.marginTop = marginTop + "px";
    this.element = nodePool.getElement("DIV", className, style);
    this.element.dataset.bufferRow = bufferRow;
    this.element.dataset.screenRow = screenRow;
    if (number) this.element.appendChild(nodePool.getTextNode(number));
    this.element.appendChild(nodePool.getElement("DIV", "icon-right", null));
  }

  destroy() {
    this.element.remove();
    this.props.nodePool.release(this.element);
  }

  update(props) {
    const { nodePool, className, width, marginTop, bufferRow, screenRow, number } = props;

    if (this.props.bufferRow !== bufferRow) this.element.dataset.bufferRow = bufferRow;
    if (this.props.screenRow !== screenRow) this.element.dataset.screenRow = screenRow;
    if (this.props.className !== className) this.element.className = className;
    if (this.props.width !== width) {
      if (width != null && width > 0) {
        this.element.style.width = width + "px";
      } else {
        this.element.style.width = "";
      }
    }
    if (this.props.marginTop !== marginTop) {
      if (marginTop != null && marginTop > 0) {
        this.element.style.marginTop = marginTop + "px";
      } else {
        this.element.style.marginTop = "";
      }
    }

    if (this.props.number !== number) {
      if (this.props.number != null) {
        const numberNode = this.element.firstChild;
        numberNode.remove();
        nodePool.release(numberNode);
      }

      if (number != null) {
        this.element.insertBefore(nodePool.getTextNode(number), this.element.firstChild);
      }
    }

    this.props = props;
  }
}

class CustomGutterComponent {
  // Adopts the gutter model's element (`props.element`); the element outlives
  // this component, so destroy only detaches it from the container.
  constructor(props) {
    this.props = props;
    this.element = this.props.element;
    this.decorationComponents = [];
    this.lastClassName = null;
    this.lastVisible = null;
    this.lastHeight = null;

    this.element.setAttribute("gutter-name", props.name);
    this.decorationsElement = document.createElement("div");
    this.decorationsElement.className = "custom-decorations";
    this.element.appendChild(this.decorationsElement);

    this.updateGutter();
  }

  update(props) {
    this.props = props;
    this.updateGutter();
  }

  destroy() {
    this.element.remove();
  }

  updateGutter() {
    let className = "gutter";
    if (this.props.className) {
      className += " " + this.props.className;
    }
    if (className !== this.lastClassName) {
      this.element.className = className;
      this.lastClassName = className;
    }

    const visible = this.props.visible;
    if (visible !== this.lastVisible) {
      this.element.style.display = visible ? "" : "none";
      this.lastVisible = visible;
    }

    const height = this.props.height;
    if (height !== this.lastHeight) {
      this.decorationsElement.style.height = height + "px";
      this.lastHeight = height;
    }

    this.updateDecorations();
  }

  // Syncs decoration components positionally, matching the unkeyed child
  // reconciliation the previous virtual-DOM diff performed.
  updateDecorations() {
    const decorations = this.props.decorations || [];

    while (this.decorationComponents.length > decorations.length) {
      this.decorationComponents.pop().element.remove();
    }

    for (let i = 0; i < decorations.length; i++) {
      const { className, element, top, height } = decorations[i];
      const decorationProps = { className, element, top, height };
      if (i < this.decorationComponents.length) {
        this.decorationComponents[i].update(decorationProps);
      } else {
        const component = new CustomGutterDecorationComponent(decorationProps);
        this.decorationsElement.appendChild(component.element);
        this.decorationComponents.push(component);
      }
    }
  }
}

class CustomGutterDecorationComponent {
  constructor(props) {
    this.props = props;
    this.element = document.createElement("div");
    const { top, height, className, element } = this.props;

    this.element.style.position = "absolute";
    this.element.style.top = top + "px";
    this.element.style.height = height + "px";
    if (className != null) this.element.className = className;
    if (element != null) {
      this.element.appendChild(element);
      element.style.height = height + "px";
    }
  }

  update(newProps) {
    const oldProps = this.props;
    this.props = newProps;

    if (newProps.top !== oldProps.top) this.element.style.top = newProps.top + "px";
    if (newProps.height !== oldProps.height) {
      this.element.style.height = newProps.height + "px";
      if (newProps.element) newProps.element.style.height = newProps.height + "px";
    }
    if (newProps.className !== oldProps.className)
      this.element.className = newProps.className || "";
    if (newProps.element !== oldProps.element) {
      if (this.element.firstChild) this.element.firstChild.remove();
      if (newProps.element != null) {
        this.element.appendChild(newProps.element);
        newProps.element.style.height = newProps.height + "px";
      }
    }
  }
}
