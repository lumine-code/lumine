// Persistent summaries share the immutable identities used by text snapshots.
// A changed row reuses unchanged subtrees instead of rebuilding every chunk.
const EMPTY = Object.freeze({
  length: 0,
  tabs: 0,
  width: 0,
  firstTab: -1,
  firstNonWhitespace: Infinity,
  lastNonWhitespace: -1,
  firstUnit: NaN,
  lastUnit: NaN,
});

class UnwrappedTextMetrics {
  constructor(tabLength) {
    this.tabLength = tabLength;
    this.nodes = new WeakMap();
  }

  measure(source) {
    const iterator = source.snapshotNodes(this.nodes);
    for (let step = iterator.next(); ; step = iterator.next()) {
      if (step.done) return step.value ? this.nodes.get(step.value) : EMPTY;
      const entry = step.value;
      let node;
      if (entry.text !== undefined) {
        const text = entry.text;
        let width = 0,
          previous = 0,
          tabs = 0;
        const firstTab = text.indexOf("\t");
        for (let index = firstTab; index >= 0; index = text.indexOf("\t", previous)) {
          width += index - previous;
          width += this.tabLength - (width % this.tabLength);
          previous = index + 1;
          tabs++;
        }
        width += text.length - previous;
        const first = text.search(/[^ \t]/),
          last = /[^ \t](?=[ \t]*$)/.exec(text);
        node = {
          text,
          length: text.length,
          tabs,
          width,
          firstTab,
          firstNonWhitespace: first < 0 ? Infinity : first,
          lastNonWhitespace: last ? last.index : -1,
          firstUnit: text.charCodeAt(0),
          lastUnit: text.charCodeAt(text.length - 1),
        };
      } else {
        const left = this.nodes.get(entry.left),
          right = this.nodes.get(entry.right);
        node = {
          left,
          right,
          length: left.length + right.length,
          tabs: left.tabs + right.tabs,
          width: this.advance(right, left.width),
          firstTab: left.tabs ? left.firstTab : right.tabs ? left.length + right.firstTab : -1,
          firstNonWhitespace: Number.isFinite(left.firstNonWhitespace)
            ? left.firstNonWhitespace
            : left.length + right.firstNonWhitespace,
          lastNonWhitespace:
            right.lastNonWhitespace >= 0
              ? left.length + right.lastNonWhitespace
              : left.lastNonWhitespace,
          firstUnit: left.firstUnit,
          lastUnit: right.lastUnit,
        };
      }
      this.nodes.set(entry.identity, Object.freeze(node));
    }
  }

  advance(node, column) {
    if (!node.tabs) return column + node.length;
    const zero = node.firstTab + this.tabLength - (node.firstTab % this.tabLength);
    const first = column + node.firstTab;
    return first + this.tabLength - (first % this.tabLength) + node.width - zero;
  }

  findLeaf(node, target, column, fromScreen) {
    let offset = 0;
    while (node.left) {
      const middle = this.advance(node.left, column);
      if (target >= (fromScreen ? middle : offset + node.left.length)) {
        column = middle;
        offset += node.left.length;
        node = node.right;
      } else node = node.left;
    }
    return { node, offset, column };
  }

  *runs(node, column, start, end, offset = 0) {
    const stop = this.advance(node, column);
    if (stop <= start || column >= end || !node.length) return;
    if (node.left) {
      yield* this.runs(node.left, column, start, end, offset);
      yield* this.runs(
        node.right,
        this.advance(node.left, column),
        start,
        end,
        offset + node.left.length,
      );
    } else yield { node, offset, column, endColumn: stop };
  }
}

class UnwrappedPixelMetrics {
  constructor(metrics, measure, spaceRatio) {
    this.metrics = metrics;
    this.measure = measure;
    this.spaceRatio = Number.isFinite(spaceRatio) && spaceRatio >= 0 ? spaceRatio : 1;
    this.widths = new WeakMap();
    this.lowSurrogateWidths = new Map();
  }

  width(node, column, previousCode) {
    if (!node.length) return 0;
    let zero = this.widths.get(node);
    if (zero === undefined) {
      zero = node.left
        ? this.width(node.left, 0, NaN) +
          this.width(node.right, node.left.width, node.left.lastUnit)
        : this.measure(node.text, 0, 0, NaN, Infinity, Infinity).pixel;
      this.widths.set(node, zero);
    }
    let width = zero + (this.metrics.advance(node, column) - column - node.width) * this.spaceRatio;
    if (
      node.firstUnit >= 0xdc00 &&
      node.firstUnit <= 0xdfff &&
      previousCode >= 0xd800 &&
      previousCode <= 0xdbff
    ) {
      let correction = this.lowSurrogateWidths.get(node.firstUnit);
      if (correction === undefined) {
        correction = this.measure(
          String.fromCharCode(node.firstUnit),
          0,
          0,
          NaN,
          Infinity,
          Infinity,
        ).pixel;
        this.lowSurrogateWidths.set(node.firstUnit, correction);
      }
      width -= correction;
    }
    return width;
  }

  findLeaf(node, target, column, pixel, previousCode, fromPixel) {
    let offset = 0;
    while (node.left) {
      const middleColumn = this.metrics.advance(node.left, column);
      const middlePixel = pixel + this.width(node.left, column, previousCode);
      // Pixel inversion stops at the first column reaching the target.
      // Equality must stay on the left: its suffix may contain zero-width
      // code units that a scalar walk has not consumed yet.
      if (fromPixel ? target > middlePixel : target >= middleColumn) {
        previousCode = node.left.lastUnit;
        offset += node.left.length;
        column = middleColumn;
        pixel = middlePixel;
        node = node.right;
      } else node = node.left;
    }
    return { node, offset, column, pixel, previousCode };
  }
}

module.exports = { UnwrappedTextMetrics, UnwrappedPixelMetrics };
