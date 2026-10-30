const TextEditor = require("./text-editor");
const LineComponent = require("./line-component");
const { arraysEqual, textDecorationsEqual } = require("./text-editor-component-helpers");

module.exports = class LinesTileComponent {
  constructor(props) {
    this.props = props;

    // Lines and block decorations are manually inserted into this container
    // for efficiency.
    this.element = document.createElement("div");
    const style = this.element.style;
    // The .lines parent already supplies strict containment, and an absolutely
    // positioned tile establishes its own formatting context. Keep only style
    // containment here: layout or paint containment makes Chromium rasterize
    // each tile in an independent pixel-snapping space, so adjacent lines at a
    // fractional tile boundary both paint the same physical pixel and double-
    // blend translucent line decorations.
    style.contain = "style";
    style.position = "absolute";
    style.height = props.height + "px";
    style.width = props.width + "px";
    // Position with layout `margin-top`, not `transform`: a fractional
    // translateY also gives the tile its own pixel-snapping space. A margin
    // offsets the box during layout instead, while the absent `top` keeps the
    // tile anchored at its static position so padding/margins on the lines
    // container still shift the text as they always have.
    style.marginTop = props.top + "px";

    this.createLines();
    this.updateBlockDecorations({}, props);
  }

  update(newProps) {
    if (this.updating) {
      this.pendingProps = newProps;
      return;
    }
    this.updating = true;
    try {
      do {
        this.pendingProps = null;
        this.performUpdate(newProps);
        newProps = this.pendingProps;
      } while (newProps);
    } finally {
      this.updating = false;
    }
  }

  performUpdate(newProps) {
    if (this.shouldUpdate(newProps)) {
      const oldProps = this.props;
      this.props = newProps;

      if (newProps.height !== oldProps.height) {
        this.element.style.height = newProps.height + "px";
      }
      if (newProps.width !== oldProps.width) {
        this.element.style.width = newProps.width + "px";
      }
      if (newProps.top !== oldProps.top) {
        this.element.style.marginTop = newProps.top + "px";
      }

      if (
        newProps.renderOriginLeft !== oldProps.renderOriginLeft ||
        newProps.baseCharacterWidth !== oldProps.baseCharacterWidth
      ) {
        for (const line of this.lineComponents) line.updateHorizontalPosition(newProps);
      }
      if (!newProps.measuredContent) {
        this.updateLines(oldProps, newProps);
        this.updateBlockDecorations(oldProps, newProps);
      }
    }
  }

  destroy() {
    for (let i = 0; i < this.lineComponents.length; i++) {
      this.lineComponents[i].destroy();
    }
    this.lineComponents.length = 0;

    this.element.remove();
  }

  createLines(target = this.element) {
    const {
      tileStartRow,
      screenLines,
      lineDecorations,
      textDecorations,
      nodePool,
      displayLayer,
      lineComponentsByScreenLineId,
      horizontalPixelPositionsByScreenLineId,
    } = this.props;

    this.lineComponents = [];
    for (let i = 0, length = screenLines.length; i < length; i++) {
      const component = new LineComponent({
        renderOriginLeft: this.props.renderOriginLeft,
        baseCharacterWidth: this.props.baseCharacterWidth,
        screenLine: screenLines[i],
        screenRow: tileStartRow + i,
        lineDecoration: lineDecorations[i],
        textDecorations: textDecorations[i],
        displayLayer,
        nodePool,
        lineComponentsByScreenLineId,
        horizontalPixelPositionsByScreenLineId,
      });
      target.appendChild(component.element);
      this.lineComponents.push(component);
    }
  }

  updateLines(oldProps, newProps) {
    // A resize may follow a retired/detached line or an interrupted update.
    // Rebuild the owned rows before using any old element as an insertion
    // anchor. Keep block and package-owned siblings for their normal reconcile.
    if (
      this.lineComponents.length !== oldProps.screenLines.length ||
      this.lineComponents.some(
        (line, index) =>
          line.destroyed ||
          !line.ownsElement() ||
          line.element.parentNode !== this.element ||
          line.props.screenLine !== oldProps.screenLines[index],
      )
    ) {
      const owned = new Set(this.lineComponents.map((line) => line.element));
      const last = [...this.element.childNodes].findLast((node) => owned.has(node));
      const anchor = last?.nextSibling ?? null;
      for (const line of this.lineComponents) line.destroy();
      const fragment = this.element.ownerDocument.createDocumentFragment();
      this.createLines(fragment);
      this.element.insertBefore(fragment, anchor?.parentNode === this.element ? anchor : null);
      return;
    }
    // A distant scroll replaces the entire tile. Detach its old rows together,
    // then build the replacement off-document so the live tree sees two child
    // mutations instead of a remove/insert pair per row. Retain the incremental
    // path for overlapping rows, block items, focused content and extra DOM children.
    if (
      !oldProps.blockDecorations?.size &&
      !newProps.blockDecorations?.size &&
      !this.element.contains(this.element.ownerDocument.activeElement) &&
      this.element.childNodes.length === this.lineComponents.length &&
      this.lineComponents.every((line) => line.element.parentNode === this.element) &&
      !oldProps.screenLines.some((line) => newProps.screenLines.includes(line))
    ) {
      if (this.canRetargetRows(oldProps, newProps)) {
        for (let index = 0; index < this.lineComponents.length; index++) {
          const line = this.lineComponents[index];
          const props = {
            ...line.props,
            screenLine: newProps.screenLines[index],
            screenRow: newProps.tileStartRow + index,
            lineDecoration: newProps.lineDecorations[index],
            textDecorations: newProps.textDecorations[index],
            displayLayer: newProps.displayLayer,
            nodePool: newProps.nodePool,
            lineComponentsByScreenLineId: newProps.lineComponentsByScreenLineId,
            horizontalPixelPositionsByScreenLineId: newProps.horizontalPixelPositionsByScreenLineId,
            renderOriginLeft: newProps.renderOriginLeft,
            baseCharacterWidth: newProps.baseCharacterWidth,
          };
          if (line.retarget(props)) continue;
          const replacement = new LineComponent(props);
          line.element.replaceWith(replacement.element);
          line.destroy();
          this.lineComponents[index] = replacement;
        }
        return;
      }
      this.element.replaceChildren();
      for (const line of this.lineComponents) line.destroy();
      const fragment = this.element.ownerDocument.createDocumentFragment();
      this.createLines(fragment);
      this.element.appendChild(fragment);
      return;
    }

    const {
      screenLines,
      tileStartRow,
      lineDecorations,
      textDecorations,
      nodePool,
      displayLayer,
      lineComponentsByScreenLineId,
      horizontalPixelPositionsByScreenLineId,
    } = newProps;

    const oldScreenLines = oldProps.screenLines;
    const newScreenLines = screenLines;
    const oldScreenLinesEndIndex = oldScreenLines.length;
    const newScreenLinesEndIndex = newScreenLines.length;
    let oldScreenLineIndex = 0;
    let newScreenLineIndex = 0;
    let lineComponentIndex = 0;

    while (
      oldScreenLineIndex < oldScreenLinesEndIndex ||
      newScreenLineIndex < newScreenLinesEndIndex
    ) {
      const oldScreenLine = oldScreenLines[oldScreenLineIndex];
      const newScreenLine = newScreenLines[newScreenLineIndex];

      if (oldScreenLineIndex >= oldScreenLinesEndIndex) {
        var newScreenLineComponent = new LineComponent({
          renderOriginLeft: this.props.renderOriginLeft,
          baseCharacterWidth: this.props.baseCharacterWidth,
          screenLine: newScreenLine,
          screenRow: tileStartRow + newScreenLineIndex,
          lineDecoration: lineDecorations[newScreenLineIndex],
          textDecorations: textDecorations[newScreenLineIndex],
          displayLayer,
          nodePool,
          lineComponentsByScreenLineId,
          horizontalPixelPositionsByScreenLineId,
        });
        this.element.appendChild(newScreenLineComponent.element);
        this.lineComponents.push(newScreenLineComponent);

        newScreenLineIndex++;
        lineComponentIndex++;
      } else if (newScreenLineIndex >= newScreenLinesEndIndex) {
        this.lineComponents[lineComponentIndex].destroy();
        this.lineComponents.splice(lineComponentIndex, 1);

        oldScreenLineIndex++;
      } else if (oldScreenLine === newScreenLine) {
        const lineComponent = this.lineComponents[lineComponentIndex];
        lineComponent.update({
          renderOriginLeft: this.props.renderOriginLeft,
          baseCharacterWidth: this.props.baseCharacterWidth,
          screenRow: tileStartRow + newScreenLineIndex,
          lineDecoration: lineDecorations[newScreenLineIndex],
          textDecorations: textDecorations[newScreenLineIndex],
        });

        oldScreenLineIndex++;
        newScreenLineIndex++;
        lineComponentIndex++;
      } else {
        const oldScreenLineIndexInNewScreenLines = newScreenLines.indexOf(oldScreenLine);
        const newScreenLineIndexInOldScreenLines = oldScreenLines.indexOf(newScreenLine);
        if (
          newScreenLineIndex < oldScreenLineIndexInNewScreenLines &&
          oldScreenLineIndexInNewScreenLines < newScreenLinesEndIndex
        ) {
          const newScreenLineComponents = [];
          while (newScreenLineIndex < oldScreenLineIndexInNewScreenLines) {
            // eslint-disable-next-line no-redeclare
            var newScreenLineComponent = new LineComponent({
              renderOriginLeft: this.props.renderOriginLeft,
              baseCharacterWidth: this.props.baseCharacterWidth,
              screenLine: newScreenLines[newScreenLineIndex],
              screenRow: tileStartRow + newScreenLineIndex,
              lineDecoration: lineDecorations[newScreenLineIndex],
              textDecorations: textDecorations[newScreenLineIndex],
              displayLayer,
              nodePool,
              lineComponentsByScreenLineId,
              horizontalPixelPositionsByScreenLineId,
            });
            this.element.insertBefore(
              newScreenLineComponent.element,
              this.getFirstElementForScreenLine(
                oldProps,
                oldScreenLine,
                this.lineComponents[lineComponentIndex],
              ),
            );
            newScreenLineComponents.push(newScreenLineComponent);

            newScreenLineIndex++;
          }

          this.lineComponents.splice(lineComponentIndex, 0, ...newScreenLineComponents);
          lineComponentIndex = lineComponentIndex + newScreenLineComponents.length;
        } else if (
          oldScreenLineIndex < newScreenLineIndexInOldScreenLines &&
          newScreenLineIndexInOldScreenLines < oldScreenLinesEndIndex
        ) {
          while (oldScreenLineIndex < newScreenLineIndexInOldScreenLines) {
            this.lineComponents[lineComponentIndex].destroy();
            this.lineComponents.splice(lineComponentIndex, 1);

            oldScreenLineIndex++;
          }
        } else {
          const oldScreenLineComponent = this.lineComponents[lineComponentIndex];
          // eslint-disable-next-line no-redeclare
          var newScreenLineComponent = new LineComponent({
            renderOriginLeft: this.props.renderOriginLeft,
            baseCharacterWidth: this.props.baseCharacterWidth,
            screenLine: newScreenLines[newScreenLineIndex],
            screenRow: tileStartRow + newScreenLineIndex,
            lineDecoration: lineDecorations[newScreenLineIndex],
            textDecorations: textDecorations[newScreenLineIndex],
            displayLayer,
            nodePool,
            lineComponentsByScreenLineId,
            horizontalPixelPositionsByScreenLineId,
          });
          this.element.insertBefore(newScreenLineComponent.element, oldScreenLineComponent.element);
          oldScreenLineComponent.destroy();
          this.lineComponents[lineComponentIndex] = newScreenLineComponent;

          oldScreenLineIndex++;
          newScreenLineIndex++;
          lineComponentIndex++;
        }
      }
    }
  }

  canRetargetRows(oldProps, newProps) {
    return (
      oldProps.screenLines.length === newProps.screenLines.length &&
      this.lineComponents.some(
        (line, index) =>
          line.unpooledContents &&
          newProps.screenLines[index].tags.length >= 8 &&
          line.canRenderHTMLDecorations(newProps.textDecorations[index]),
      )
    );
  }

  getFirstElementForScreenLine(oldProps, screenLine, lineComponent) {
    const blockDecorations = oldProps.blockDecorations
      ? oldProps.blockDecorations.get(screenLine.id)
      : null;
    if (blockDecorations) {
      const blockDecorationElementsBeforeOldScreenLine = [];
      for (let i = 0; i < blockDecorations.length; i++) {
        const decoration = blockDecorations[i];
        if (decoration.position !== "after") {
          blockDecorationElementsBeforeOldScreenLine.push(TextEditor.viewForItem(decoration.item));
        }
      }

      for (let i = 0; i < blockDecorationElementsBeforeOldScreenLine.length; i++) {
        const blockDecorationElement = blockDecorationElementsBeforeOldScreenLine[i];
        if (
          blockDecorationElement.parentNode === this.element &&
          !blockDecorationElementsBeforeOldScreenLine.includes(
            blockDecorationElement.previousSibling,
          )
        ) {
          return blockDecorationElement;
        }
      }
    }

    // Another tile may already have created the same screen line while rows
    // shift between tiles. The shared lookup then names that replacement;
    // insertion still belongs before this tile's existing component.
    return lineComponent.element;
  }

  updateBlockDecorations(oldProps, newProps) {
    const { blockDecorations, lineComponentsByScreenLineId } = newProps;

    if (oldProps.blockDecorations) {
      // A screen line or decoration descriptor can be replaced while the
      // resolved view stays alive. Retention belongs to that view, across all
      // keys in this tile's new block map.
      const retainedElements = new Set();
      blockDecorations?.forEach((decorations) => {
        for (const decoration of decorations)
          retainedElements.add(TextEditor.viewForItem(decoration.item));
      });
      oldProps.blockDecorations.forEach((oldDecorations) => {
        for (let i = 0; i < oldDecorations.length; i++) {
          const oldDecoration = oldDecorations[i];
          const element = TextEditor.viewForItem(oldDecoration.item);
          if (retainedElements.has(element)) continue;
          if (element.parentElement !== this.element) continue;

          element.remove();
        }
      });
    }

    if (blockDecorations) {
      const place = (element, nextElement) => {
        if (
          element === nextElement ||
          (element.parentNode === this.element && element.nextSibling === nextElement)
        )
          return;
        // Detaching a live result destroys its native scroll offsets,
        // focus and other browser-owned state, even within the same tile.
        if (
          element.isConnected &&
          this.element.isConnected &&
          element.ownerDocument === this.element.ownerDocument
        )
          this.element.moveBefore(element, nextElement);
        else this.element.insertBefore(element, nextElement);
      };
      blockDecorations.forEach((newDecorations, screenLineId) => {
        let lineComponent = lineComponentsByScreenLineId.get(screenLineId);
        // Overlapping tiles share the lookup, so a neighbor can register a
        // replacement first. Placement still needs this tile's owned anchor.
        if (lineComponent?.element.parentNode !== this.element)
          lineComponent = this.lineComponents.find(
            (component) =>
              component.props.screenLine.id === screenLineId &&
              component.element.parentNode === this.element,
          );
        // Skip block decorations whose screen line is not in this tile.
        // This can happen when decorations are destroyed or moved between
        // tiles during the same update cycle.
        if (!lineComponent) return;
        const lineNode = lineComponent.element;

        // Walk backwards toward the line so already ordered before-items
        // remain untouched instead of moving each past its siblings.
        let nextBefore = lineNode;
        for (let i = newDecorations.length - 1; i >= 0; i--) {
          const decoration = newDecorations[i];
          if (decoration.position === "after") continue;
          const element = TextEditor.viewForItem(decoration.item);
          place(element, nextBefore);
          nextBefore = element;
        }

        let lastAfter = lineNode;
        for (let i = 0; i < newDecorations.length; i++) {
          const decoration = newDecorations[i];
          if (decoration.position !== "after") continue;
          const element = TextEditor.viewForItem(decoration.item);
          place(element, lastAfter.nextSibling);
          lastAfter = element;
        }
      });
    }
  }

  shouldUpdate(newProps) {
    if (
      newProps.renderOriginLeft !== this.props.renderOriginLeft ||
      newProps.baseCharacterWidth !== this.props.baseCharacterWidth
    )
      return true;
    const oldProps = this.props;
    if (oldProps.top !== newProps.top) return true;
    if (oldProps.height !== newProps.height) return true;
    if (oldProps.width !== newProps.width) return true;
    if (oldProps.lineHeight !== newProps.lineHeight) return true;
    if (oldProps.tileStartRow !== newProps.tileStartRow) return true;
    if (oldProps.tileEndRow !== newProps.tileEndRow) return true;
    if (!arraysEqual(oldProps.screenLines, newProps.screenLines)) return true;
    if (!arraysEqual(oldProps.lineDecorations, newProps.lineDecorations)) return true;

    if (oldProps.blockDecorations && newProps.blockDecorations) {
      if (oldProps.blockDecorations.size !== newProps.blockDecorations.size) return true;

      let blockDecorationsChanged = false;

      oldProps.blockDecorations.forEach((oldDecorations, screenLineId) => {
        if (!blockDecorationsChanged) {
          const newDecorations = newProps.blockDecorations.get(screenLineId);
          blockDecorationsChanged =
            newDecorations == null || !arraysEqual(oldDecorations, newDecorations);
        }
      });
      if (blockDecorationsChanged) return true;

      newProps.blockDecorations.forEach((newDecorations, screenLineId) => {
        if (!blockDecorationsChanged) {
          const oldDecorations = oldProps.blockDecorations.get(screenLineId);
          blockDecorationsChanged = oldDecorations == null;
        }
      });
      if (blockDecorationsChanged) return true;
    } else if (oldProps.blockDecorations) {
      return true;
    } else if (newProps.blockDecorations) {
      return true;
    }

    if (oldProps.textDecorations.length !== newProps.textDecorations.length) return true;
    for (let i = 0; i < oldProps.textDecorations.length; i++) {
      if (!textDecorationsEqual(oldProps.textDecorations[i], newProps.textDecorations[i]))
        return true;
    }

    return false;
  }
};
