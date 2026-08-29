const TextEditor = require("./text-editor");
const LineComponent = require("./line-component");
const { arraysEqual, textDecorationsEqual } = require("./text-editor-component-helpers");

module.exports = class LinesTileComponent {
  constructor(props) {
    this.props = props;
    const document = props.document || globalThis.document;

    // Lines and block decorations are manually inserted into this container
    // for efficiency.
    this.element = document.createElement("div");
    const style = this.element.style;
    style.contain = "layout style";
    style.position = "absolute";
    style.height = props.height + "px";
    style.width = props.width + "px";
    // Position with layout `margin-top`, not `transform`: a fractional
    // translateY gives the tile its own pixel-snapping space, painting a
    // hairline seam between adjacent tiles whenever the line height is
    // fractional. A margin offsets the box during layout instead, keeping all
    // tiles in one snapping space, while the absent `top` keeps the tile
    // anchored at its static position so padding/margins on the lines
    // container still shift the text as they always have.
    style.marginTop = props.top + "px";

    this.createLines();
    this.updateBlockDecorations({}, props);
  }

  update(newProps) {
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

  createLines() {
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
        screenLine: screenLines[i],
        screenRow: tileStartRow + i,
        lineDecoration: lineDecorations[i],
        textDecorations: textDecorations[i],
        displayLayer,
        nodePool,
        lineComponentsByScreenLineId,
        horizontalPixelPositionsByScreenLineId,
      });
      this.element.appendChild(component.element);
      this.lineComponents.push(component);
    }
  }

  updateLines(oldProps, newProps) {
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
              this.getFirstElementForScreenLine(oldProps, oldScreenLine),
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

  getFirstElementForScreenLine(oldProps, screenLine) {
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
          !blockDecorationElementsBeforeOldScreenLine.includes(
            blockDecorationElement.previousSibling,
          )
        ) {
          return blockDecorationElement;
        }
      }
    }

    return oldProps.lineComponentsByScreenLineId.get(screenLine.id).element;
  }

  updateBlockDecorations(oldProps, newProps) {
    const { blockDecorations, lineComponentsByScreenLineId } = newProps;

    if (oldProps.blockDecorations) {
      oldProps.blockDecorations.forEach((oldDecorations, screenLineId) => {
        const newDecorations = newProps.blockDecorations
          ? newProps.blockDecorations.get(screenLineId)
          : null;
        for (let i = 0; i < oldDecorations.length; i++) {
          const oldDecoration = oldDecorations[i];
          if (newDecorations && newDecorations.includes(oldDecoration)) continue;

          const element = TextEditor.viewForItem(oldDecoration.item);
          if (element.parentElement !== this.element) continue;

          element.remove();
        }
      });
    }

    if (blockDecorations) {
      blockDecorations.forEach((newDecorations, screenLineId) => {
        const oldDecorations = oldProps.blockDecorations
          ? oldProps.blockDecorations.get(screenLineId)
          : null;
        const lineComponent = lineComponentsByScreenLineId.get(screenLineId);
        // Skip block decorations whose screen line is not in this tile.
        // This can happen when decorations are destroyed or moved between
        // tiles during the same update cycle.
        if (!lineComponent) return;
        const lineNode = lineComponent.element;
        let lastAfter = lineNode;

        for (let i = 0; i < newDecorations.length; i++) {
          const newDecoration = newDecorations[i];
          const element = TextEditor.viewForItem(newDecoration.item);

          if (oldDecorations && oldDecorations.includes(newDecoration)) {
            if (newDecoration.position === "after") {
              lastAfter = element;
            }
            continue;
          }

          if (newDecoration.position === "after") {
            this.element.insertBefore(element, lastAfter.nextSibling);
            lastAfter = element;
          } else {
            this.element.insertBefore(element, lineNode);
          }
        }
      });
    }
  }

  shouldUpdate(newProps) {
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
