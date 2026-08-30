module.exports = class HighlightsComponent {
  constructor(props) {
    this.props = {};
    this.element = document.createElement("div");
    this.element.className = "highlights";
    this.element.style.contain = "strict";
    this.element.style.position = "absolute";
    this.element.style.overflow = "hidden";
    this.element.style.userSelect = "none";
    this.highlightComponentsByKey = new Map();
    this.update(props);
  }

  destroy() {
    this.highlightComponentsByKey.forEach((highlightComponent) => {
      highlightComponent.destroy();
    });
    this.highlightComponentsByKey.clear();
  }

  update(newProps) {
    if (this.shouldUpdate(newProps)) {
      this.props = newProps;
      const { height, width, lineHeight, highlightDecorations } = this.props;

      this.element.style.height = height + "px";
      this.element.style.width = width + "px";

      const visibleHighlightDecorations = new Set();
      if (highlightDecorations) {
        for (let i = 0; i < highlightDecorations.length; i++) {
          const highlightDecoration = highlightDecorations[i];
          const highlightProps = Object.assign({ lineHeight }, highlightDecorations[i]);

          let highlightComponent = this.highlightComponentsByKey.get(highlightDecoration.key);
          if (highlightComponent) {
            highlightComponent.update(highlightProps);
          } else {
            highlightComponent = new HighlightComponent(highlightProps);
            this.element.appendChild(highlightComponent.element);
            this.highlightComponentsByKey.set(highlightDecoration.key, highlightComponent);
          }

          highlightDecorations[i].flashRequested = false;
          visibleHighlightDecorations.add(highlightDecoration.key);
        }
      }

      this.highlightComponentsByKey.forEach((highlightComponent, key) => {
        if (!visibleHighlightDecorations.has(key)) {
          highlightComponent.destroy();
          this.highlightComponentsByKey.delete(key);
        }
      });
    }
  }

  shouldUpdate(newProps) {
    const oldProps = this.props;

    if (!newProps.hasInitialMeasurements) return false;

    if (oldProps.width !== newProps.width) return true;
    if (oldProps.height !== newProps.height) return true;
    if (oldProps.lineHeight !== newProps.lineHeight) return true;
    if (!oldProps.highlightDecorations && newProps.highlightDecorations) return true;
    if (oldProps.highlightDecorations && !newProps.highlightDecorations) return true;
    if (oldProps.highlightDecorations && newProps.highlightDecorations) {
      if (oldProps.highlightDecorations.length !== newProps.highlightDecorations.length)
        return true;

      for (let i = 0, length = oldProps.highlightDecorations.length; i < length; i++) {
        const oldHighlight = oldProps.highlightDecorations[i];
        const newHighlight = newProps.highlightDecorations[i];
        if (oldHighlight.className !== newHighlight.className) return true;
        if (newHighlight.flashRequested) return true;
        if (oldHighlight.startRects !== newHighlight.startRects) return true;
        if (oldHighlight.endRects !== newHighlight.endRects) return true;
        if (oldHighlight.startPixelTop !== newHighlight.startPixelTop) return true;
        if (oldHighlight.endPixelTop !== newHighlight.endPixelTop) return true;
        if (!oldHighlight.screenRange.isEqual(newHighlight.screenRange)) return true;
      }
    }
  }
};

class HighlightComponent {
  constructor(props) {
    this.props = props;
    this.element = document.createElement("div");
    this.lastClassName = null;
    this.renderRegions();
    if (this.props.flashRequested) this.performFlash();
  }

  destroy() {
    if (this.timeoutsByClassName) {
      this.timeoutsByClassName.forEach((timeout) => {
        window.clearTimeout(timeout);
      });
      this.timeoutsByClassName.clear();
    }

    this.element.remove();
  }

  update(newProps) {
    this.props = newProps;
    this.renderRegions();
    if (newProps.flashRequested) this.performFlash();
  }

  performFlash() {
    const { flashClass, flashDuration } = this.props;
    if (!this.timeoutsByClassName) this.timeoutsByClassName = new Map();

    // If a flash of this class is already in progress, clear it early and
    // flash again on the next frame to ensure CSS transitions apply to the
    // second flash.
    if (this.timeoutsByClassName.has(flashClass)) {
      window.clearTimeout(this.timeoutsByClassName.get(flashClass));
      this.timeoutsByClassName.delete(flashClass);
      this.element.classList.remove(flashClass);
      requestAnimationFrame(() => this.performFlash());
    } else {
      this.element.classList.add(flashClass);
      this.timeoutsByClassName.set(
        flashClass,
        window.setTimeout(() => {
          this.element.classList.remove(flashClass);
        }, flashDuration),
      );
    }
  }

  // Rebuilds the region children from the current props. The containing
  // HighlightsComponent only calls in when the highlight actually changed, so
  // recreating the handful of region nodes is cheap. The root class name is
  // only written when its computed value changes so that in-progress flash
  // classes added by performFlash survive unrelated updates.
  renderRegions() {
    const { className, screenRange, lineHeight, startPixelTop, startRects, endPixelTop, endRects } =
      this.props;
    const regionClassName = "region " + className;

    const rootClassName = "highlight " + className;
    if (rootClassName !== this.lastClassName) {
      this.element.className = rootClassName;
      this.lastClassName = rootClassName;
    }

    const children = [];
    if (screenRange.start.row === screenRange.end.row) {
      // Single line select.
      //
      // On both the starting and ending lines, we might need to draw more than
      // one decoration if there’s a mix of LTR and RTL text.
      for (const r of startRects) {
        // `startPixelTop` is the best indicator of where the decoration
        // should start vertically; the `rect` just gets used for its
        // `left` and `width`.
        children.push(
          buildRegion(regionClassName, {
            top: startPixelTop + "px",
            left: r.left + "px",
            width: r.width + "px",
            height: lineHeight + "px",
          }),
        );
      }
    } else {
      // Multi-line select.
      // Rightmost highlight extends all the way to the end of the line.
      let rightmostRect;
      for (let startRect of startRects) {
        if (!rightmostRect || startRect.right > rightmostRect.right) {
          rightmostRect = startRect;
        }
      }
      for (const r of startRects) {
        const style = {
          top: startPixelTop + "px",
          left: r.left + "px",
          height: lineHeight + "px",
        };

        if (r === rightmostRect) {
          style.right = 0;
        } else {
          style.width = r.width + "px";
        }

        children.push(buildRegion(regionClassName, style));
      }

      if (screenRange.end.row - screenRange.start.row > 1) {
        // If there's at least one fully selected row in between the starting
        // and ending lines of the selection, we can represent all of it with a
        // single decoration.
        children.push(
          buildRegion(regionClassName, {
            top: startPixelTop + lineHeight + "px",
            left: 0,
            right: 0,
            height: endPixelTop - startPixelTop - lineHeight * 2 + "px",
          }),
        );
      }

      if (endRects) {
        // Leftmost highlight extends all the way to the start of the line.
        let leftmostRect;
        for (const endRect of endRects) {
          if (!leftmostRect || endRect.left < leftmostRect.left) {
            leftmostRect = endRect;
          }
        }
        for (const r of endRects) {
          const style = {
            top: endPixelTop - lineHeight + "px",
            left: r.left + "px",
            width: r.width + "px",
            height: lineHeight + "px",
          };
          if (r === leftmostRect) {
            style.width = r.left + r.width + "px";
            style.left = 0;
          }
          children.push(buildRegion(regionClassName, style));
        }
      }
    }

    this.element.replaceChildren(...children);
  }
}

function buildRegion(className, style) {
  const region = document.createElement("div");
  region.className = className;
  region.style.position = "absolute";
  region.style.boxSizing = "border-box";
  for (const key in style) {
    region.style[key] = style[key];
  }
  return region;
}
