const { Point, Range } = require("./text-buffer");
const LineTopIndex = require("line-top-index");
const TextEditor = require("./text-editor");
const ScrollAnimator = require("./scroll-animator");
const { isPairedCharacter, hasRtlText } = require("./text-utils");
const electron = require("electron");
const clipboard = electron.clipboard;
const NodePool = require("./node-pool");
const DummyScrollbarComponent = require("./dummy-scrollbar-component");
const GutterContainerComponent = require("./gutter-container-component");
const CursorsAndInputComponent = require("./cursors-and-input-component");
const LinesTileComponent = require("./lines-tile-component");
const LineComponent = require("./line-component");
const HighlightsComponent = require("./highlights-component");
const OverlayComponent = require("./overlay-component");
const {
  roundToPhysicalPixelBoundary,
  ceilToPhysicalPixelBoundary,
  floorToPhysicalPixelBoundary,
} = require("./text-editor-component-helpers");

let TextEditorElement;

const DEFAULT_ROWS_PER_TILE = 6;
const NORMAL_WIDTH_CHARACTER = "x";
const DOUBLE_WIDTH_CHARACTER = "我";
const HALF_WIDTH_CHARACTER = "ﾊ";
const KOREAN_CHARACTER = "세";
const MOUSE_DRAG_AUTOSCROLL_MARGIN = 40;
// The legacy `mousewheel` handler consumed `wheelDelta` (120 per notch); the
// standard `wheel` event reports `deltaY` of 100 per notch. This factor
// preserves the historical scroll speed at a given scroll sensitivity.
const WHEEL_DELTA_PARITY = 1.2;
const CURSOR_BLINK_RESUME_DELAY = 300;
const CURSOR_BLINK_PERIOD = 800;

function scaleMouseDragAutoscrollDelta(delta) {
  return Math.pow(delta / 3, 3) / 280;
}

// The document scheduler used to batch DOM reads and writes across editor
// updates. In a Lumine window this is the view registry (`atom.views`),
// installed at window initialization. Standalone component usage outside a
// full editor environment falls back to etch's default scheduler — the module
// is loaded in every window anyway for the dock and several bundled packages.
let scheduler = null;

function getScheduler() {
  if (!scheduler) scheduler = require("@lumine-code/etch").getScheduler();
  return scheduler;
}

module.exports = class TextEditorComponent {
  static setScheduler(newScheduler) {
    scheduler = newScheduler;
  }

  static getScheduler() {
    return getScheduler();
  }

  static didUpdateStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach((component) => {
        component.didUpdateStyles();
      });
    }
  }

  static didUpdateScrollbarStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach((component) => {
        component.didUpdateScrollbarStyles();
      });
    }
  }

  constructor(props) {
    this.props = props;

    if (!props.model) {
      props.model = new TextEditor({
        mini: props.mini,
        readOnly: props.readOnly,
      });
    }
    this.props.model.component = this;

    if (props.element) {
      this.element = props.element;
    } else {
      if (!TextEditorElement) TextEditorElement = require("./text-editor-element");
      this.element = TextEditorElement.createTextEditorElement();
    }
    this.element.initialize(this);
    this.refs = {};

    this.updateSync = this.updateSync.bind(this);
    this.didBlurHiddenInput = this.didBlurHiddenInput.bind(this);
    this.didFocusHiddenInput = this.didFocusHiddenInput.bind(this);
    this.didCopy = this.didCopy.bind(this);
    this.didCut = this.didCut.bind(this);
    this.didPaste = this.didPaste.bind(this);
    this.didTextInput = this.didTextInput.bind(this);
    this.didKeydown = this.didKeydown.bind(this);
    this.didKeyup = this.didKeyup.bind(this);
    this.didKeypress = this.didKeypress.bind(this);
    this.didCompositionStart = this.didCompositionStart.bind(this);
    this.didCompositionUpdate = this.didCompositionUpdate.bind(this);
    this.didCompositionEnd = this.didCompositionEnd.bind(this);

    this.updatedSynchronously = this.props.updatedSynchronously;
    this.didScrollDummyScrollbar = this.didScrollDummyScrollbar.bind(this);
    this.didMouseDownOnContent = this.didMouseDownOnContent.bind(this);
    this.didMouseWheel = this.didMouseWheel.bind(this);
    this.debouncedResumeCursorBlinking = debounce(
      this.resumeCursorBlinking.bind(this),
      this.props.cursorBlinkResumeDelay || CURSOR_BLINK_RESUME_DELAY,
    );
    this.lineTopIndex = new LineTopIndex();
    this.lineNodesPool = new NodePool();
    this.updateScheduled = false;
    this.suppressUpdates = false;
    this.hasInitialMeasurements = false;
    this.pendingNativePasteOperation = null;
    this.measurements = {
      lineHeight: 0,
      baseCharacterWidth: 0,
      doubleWidthCharacterWidth: 0,
      halfWidthCharacterWidth: 0,
      koreanCharacterWidth: 0,
      gutterContainerWidth: 0,
      lineNumberGutterWidth: 0,
      clientContainerHeight: 0,
      clientContainerWidth: 0,
      verticalScrollbarWidth: 0,
      horizontalScrollbarHeight: 0,
      longestLineWidth: 0,
    };
    this.derivedDimensionsCache = {};
    this.observingClientContainer = false;
    this.visible = false;
    this.cursorsBlinking = false;
    this.cursorsBlinkedOff = false;
    this.nextUpdateOnlyBlinksCursors = null;
    this.linesToMeasure = new Map();
    this.extraRenderedScreenLines = new Map();
    this.horizontalPositionsToMeasure = new Map(); // Keys are rows with positions we want to measure, values are arrays of columns to measure
    this.horizontalPixelPositionsByScreenLineId = new Map(); // Values are maps from column to horizontal pixel positions
    this.blockDecorationsToMeasure = new Set();
    this.blockDecorationsByElement = new WeakMap();
    this.blockDecorationSentinel = document.createElement("div");
    this.blockDecorationSentinel.style.height = "1px";
    this.heightsByBlockDecoration = new WeakMap();
    this.blockDecorationResizeObserver = new ResizeObserver(
      this.didResizeBlockDecorations.bind(this),
    );
    this.lineComponentsByScreenLineId = new Map();
    this.overlayComponents = new Set();
    this.shouldRenderDummyScrollbars = true;
    this.remeasureScrollbars = false;
    this.pendingAutoscroll = null;
    this.scrollTopPending = false;
    this.scrollLeftPending = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollAnchorBeforeReset = null;
    // A viewport anchor captured just before a display-layer reset, to be
    // re-applied on the next update once the spatial index has been repopulated.
    // The restore is deferred (rather than run inside didResetDisplayLayer)
    // because the reset clears the spatial index, so scroll geometry read
    // synchronously there (e.g. getMaxScrollTop, which falls back to the
    // unwrapped buffer height while indexedBufferRowCount is 0) would be wrong.
    this.pendingReflowScrollAnchor = null;
    // The anchor inherited from the editor this one was copied from, kept
    // around after its first application. A new split pane passes through
    // several transient layouts (placeholder height, width still settling);
    // re-capturing an anchor from those would drift the viewport away from the
    // source position, so reflows re-apply this anchor instead until the user
    // scrolls, moves the cursor, or edits.
    this.settlingScrollAnchor = null;
    // Coalesces width-driven soft-wrap reflows when softWrapDebounceInterval > 0.
    this.softWrapDebounceTimer = null;
    this.flushingSoftWrapColumn = false;
    this.previousScrollWidth = 0;
    this.previousScrollHeight = 0;
    this.lastKeydown = null;
    this.lastKeydownBeforeKeypress = null;
    this.accentedCharacterMenuIsOpen = false;
    this.remeasureGutterDimensions = false;
    this.guttersToRender = [this.props.model.getLineNumberGutter()];
    this.guttersVisibility = [this.guttersToRender[0].visible];
    this.idsByTileStartRow = new Map();
    this.nextTileId = 0;
    this.renderedTileStartRows = [];
    this.showLineNumbers = this.props.model.doesShowLineNumbers();
    this.lineNumbersToRender = {
      maxDigits: 2,
      bufferRows: [],
      screenRows: [],
      keys: [],
      softWrappedFlags: [],
      foldableFlags: [],
    };
    this.decorationsToRender = {
      lineNumbers: new Map(),
      lines: null,
      highlights: [],
      cursors: [],
      overlays: [],
      customGutter: new Map(),
      blocks: new Map(),
      text: [],
    };
    this.decorationsToMeasure = {
      highlights: [],
      cursors: new Map(),
    };
    this.textDecorationsByMarker = new Map();
    this.textDecorationBoundaries = [];
    this.pendingScrollTopRow = this.props.initialScrollTopRow;
    this.pendingScrollLeftColumn = this.props.initialScrollLeftColumn;
    // A buffer-based scroll anchor (from a copied editor) takes precedence over
    // pendingScrollTopRow so the visual position survives a different width.
    this.pendingScrollAnchor = this.props.initialScrollAnchor;
    this.tabIndex =
      this.props.element && this.props.element.tabIndex ? this.props.element.tabIndex : -1;

    this.measuredContent = false;
    this.scrollAnimator = new ScrollAnimator(this);
    this.queryGuttersToRender();
    this.queryMaxLineNumberDigits();
    this.observeBlockDecorations();
    this.updateClassList();
    this.buildShell();
    this.renderSync();
  }

  update(props) {
    if (props.model !== this.props.model) {
      this.props.model.component = null;
      props.model.component = this;
    }
    this.props = props;
    this.scheduleUpdate();
  }

  pixelPositionForScreenPosition({ row, column }) {
    const top = this.pixelPositionAfterBlocksForRow(row);
    let left = this.pixelLeftForRowAndColumn(row, column);
    if (left == null) {
      this.requestHorizontalMeasurement(row, column);
      this.updateSync();
      left = this.pixelLeftForRowAndColumn(row, column);
    }
    return { top, left };
  }

  scheduleUpdate(nextUpdateOnlyBlinksCursors = false) {
    // These bail-outs resolve any pending update promise for the same reason
    // the mirrored ones in `updateSync` do: no update is going to happen, so a
    // caller already awaiting `getNextUpdatePromise()` would hang forever.
    if (!this.visible || this.suppressUpdates || this.props.model.isDestroyed()) {
      // A destroyed editor must never render. Destroying an attached editor
      // emits synchronous marker and decoration events mid-teardown; rendering
      // from those would repopulate the destroyed display layer's spatial index
      // and read a buffer whose native resources may already be released.
      if (this.resolveNextUpdatePromise) this.resolveNextUpdatePromise();
      return;
    }

    this.nextUpdateOnlyBlinksCursors =
      this.nextUpdateOnlyBlinksCursors !== false && nextUpdateOnlyBlinksCursors === true;

    if (this.updatedSynchronously) {
      this.updateSync();
    } else if (!this.updateScheduled) {
      this.updateScheduled = true;
      getScheduler().updateDocument(() => {
        if (this.updateScheduled) this.updateSync(true);
      });
    }
  }

  updateSync(useScheduler = false) {
    // Don't proceed if the model was destroyed (see scheduleUpdate; an
    // already-scheduled update can also land after a synchronous destroy).
    if (this.props.model.isDestroyed()) {
      if (this.resolveNextUpdatePromise) this.resolveNextUpdatePromise();
      this.updateScheduled = false;
      return;
    }

    // Don't proceed if we know we are not visible. Resolve rather than leak
    // the pending update promise - the component may never be shown again, and
    // a caller awaiting getNextUpdatePromise() would hang forever. The other
    // bail-outs in this method resolve it for the same reason.
    if (!this.visible) {
      if (this.resolveNextUpdatePromise) this.resolveNextUpdatePromise();
      this.updateScheduled = false;
      return;
    }

    // Don't proceed if we have to pay for a measurement anyway and detect
    // that we are no longer visible.
    if (
      (this.remeasureCharacterDimensions || this.remeasureAllBlockDecorations) &&
      !this.isVisible()
    ) {
      if (this.resolveNextUpdatePromise) this.resolveNextUpdatePromise();
      this.updateScheduled = false;
      return;
    }

    const onlyBlinkingCursors = this.nextUpdateOnlyBlinksCursors;
    this.nextUpdateOnlyBlinksCursors = null;
    if (useScheduler && onlyBlinkingCursors) {
      this.refs.cursorsAndInput.updateCursorBlinkSync(this.cursorsBlinkedOff);
      if (this.resolveNextUpdatePromise) this.resolveNextUpdatePromise();
      this.updateScheduled = false;
      return;
    }

    if (this.remeasureCharacterDimensions) {
      const originalLineHeight = this.getLineHeight();
      const originalBaseCharacterWidth = this.getBaseCharacterWidth();
      const scrollTopRow = this.getScrollTopRow();
      const scrollLeftColumn = this.getScrollLeftColumn();

      this.measureCharacterDimensions();
      this.measureGutterDimensions();
      this.queryLongestLine();

      if (this.getLineHeight() !== originalLineHeight) {
        this.setScrollTopRow(scrollTopRow);
      }
      if (this.getBaseCharacterWidth() !== originalBaseCharacterWidth) {
        this.setScrollLeftColumn(scrollLeftColumn);
      }
      this.remeasureCharacterDimensions = false;
    }

    if (this.isVisible()) this.measureBlockDecorations();

    this.updateSyncBeforeMeasuringContent();
    if (useScheduler === true) {
      const documentScheduler = getScheduler();
      documentScheduler.readDocument(() => {
        const restartFrame = this.measureContentDuringUpdateSync();
        documentScheduler.updateDocument(() => {
          if (restartFrame) {
            this.updateSync(true);
          } else {
            this.updateSyncAfterMeasuringContent();
          }
        });
      });
    } else {
      const restartFrame = this.measureContentDuringUpdateSync();
      if (restartFrame) {
        this.updateSync(false);
      } else {
        this.updateSyncAfterMeasuringContent();
      }
    }

    this.updateScheduled = false;
  }

  measureBlockDecorations() {
    if (this.remeasureAllBlockDecorations) {
      this.remeasureAllBlockDecorations = false;

      const decorations = this.props.model.getDecorations();
      for (let i = 0; i < decorations.length; i++) {
        const decoration = decorations[i];
        const marker = decoration.getMarker();
        if (marker.isValid() && decoration.getProperties().type === "block") {
          this.blockDecorationsToMeasure.add(decoration);
        }
      }

      // Update the width of the line tiles to ensure block decorations are
      // measured with the most recent width.
      if (this.blockDecorationsToMeasure.size > 0) {
        this.updateSyncBeforeMeasuringContent();
      }
    }

    if (this.blockDecorationsToMeasure.size > 0) {
      const { blockDecorationMeasurementArea } = this.refs;
      const sentinelElements = new Set();

      blockDecorationMeasurementArea.appendChild(document.createElement("div"));
      this.blockDecorationsToMeasure.forEach((decoration) => {
        const { item } = decoration.getProperties();
        const decorationElement = TextEditor.viewForItem(item);
        if (document.contains(decorationElement)) {
          const parentElement = decorationElement.parentElement;

          if (!decorationElement.previousSibling) {
            const sentinelElement = this.blockDecorationSentinel.cloneNode();
            parentElement.insertBefore(sentinelElement, decorationElement);
            sentinelElements.add(sentinelElement);
          }

          if (!decorationElement.nextSibling) {
            const sentinelElement = this.blockDecorationSentinel.cloneNode();
            parentElement.appendChild(sentinelElement);
            sentinelElements.add(sentinelElement);
          }

          this.didMeasureVisibleBlockDecoration = true;
        } else {
          blockDecorationMeasurementArea.appendChild(this.blockDecorationSentinel.cloneNode());
          blockDecorationMeasurementArea.appendChild(decorationElement);
          blockDecorationMeasurementArea.appendChild(this.blockDecorationSentinel.cloneNode());
        }
      });

      if (this.resizeBlockDecorationMeasurementsArea) {
        this.resizeBlockDecorationMeasurementsArea = false;
        const width = this.getScrollWidth() + "px";
        this.refs.blockDecorationMeasurementArea.style.width = width;
        this.lastBlockDecorationMeasurementAreaWidth = width;
      }

      this.blockDecorationsToMeasure.forEach((decoration) => {
        const { item } = decoration.getProperties();
        const decorationElement = TextEditor.viewForItem(item);
        const { previousSibling, nextSibling } = decorationElement;
        const height =
          nextSibling.getBoundingClientRect().top - previousSibling.getBoundingClientRect().bottom;
        this.heightsByBlockDecoration.set(decoration, height);
        this.lineTopIndex.resizeBlock(decoration, height);
      });

      sentinelElements.forEach((sentinelElement) => sentinelElement.remove());
      while (blockDecorationMeasurementArea.firstChild) {
        blockDecorationMeasurementArea.firstChild.remove();
      }
      this.blockDecorationsToMeasure.clear();
    }
  }

  updateSyncBeforeMeasuringContent() {
    this.measuredContent = false;
    this.derivedDimensionsCache = {};
    this.updateModelSoftWrapColumn();
    if (this.pendingAutoscroll) {
      let { screenRange, options } = this.pendingAutoscroll;
      this.autoscrollVertically(screenRange, options);
      this.requestHorizontalMeasurement(screenRange.start.row, screenRange.start.column);
      this.requestHorizontalMeasurement(screenRange.end.row, screenRange.end.column);
    }
    this.populateVisibleRowRange(this.getRenderedStartRow());
    this.populateVisibleTiles();
    // Now that the visible rows are indexed again, apply a copy's inherited
    // anchor once the layout is real, or re-apply the anchor captured before a
    // display-layer reset (soft-wrap toggle, resize, tab width, etc.). Scroll
    // geometry is trustworthy here, so a past-end/bottom anchor lands
    // correctly. If it moved the viewport, repopulate for the corrected range.
    const anchorRestored = this.pendingScrollAnchor
      ? this.flushPendingCopyScrollAnchor()
      : this.flushPendingReflowScrollAnchor();
    if (anchorRestored) {
      this.populateVisibleRowRange(this.getRenderedStartRow());
      this.populateVisibleTiles();
    }
    this.queryScreenLinesToRender();
    this.queryLongestLine();
    this.queryLineNumbersToRender();
    this.queryGuttersToRender();
    this.queryDecorationsToRender();
    this.queryExtraScreenLinesToRender();
    this.shouldRenderDummyScrollbars = !this.remeasureScrollbars;
    this.renderSync();
    this.updateClassList();
    this.shouldRenderDummyScrollbars = true;
    this.didMeasureVisibleBlockDecoration = false;
  }

  measureContentDuringUpdateSync() {
    let gutterDimensionsChanged = false;
    if (this.remeasureGutterDimensions) {
      gutterDimensionsChanged = this.measureGutterDimensions();
      this.remeasureGutterDimensions = false;
    }
    const wasHorizontalScrollbarVisible =
      this.canScrollHorizontally() && this.getHorizontalScrollbarHeight() > 0;

    this.measureLongestLineWidth();
    this.measureHorizontalPositions();
    this.updateAbsolutePositionedDecorations();

    const isHorizontalScrollbarVisible =
      this.canScrollHorizontally() && this.getHorizontalScrollbarHeight() > 0;

    if (this.pendingAutoscroll) {
      this.derivedDimensionsCache = {};
      const { screenRange, options } = this.pendingAutoscroll;
      this.autoscrollHorizontally(screenRange, options);

      if (!wasHorizontalScrollbarVisible && isHorizontalScrollbarVisible) {
        this.autoscrollVertically(screenRange, options);
      }
      this.pendingAutoscroll = null;
    }

    this.linesToMeasure.clear();
    this.measuredContent = true;

    return (
      gutterDimensionsChanged || wasHorizontalScrollbarVisible !== isHorizontalScrollbarVisible
    );
  }

  updateSyncAfterMeasuringContent() {
    this.derivedDimensionsCache = {};
    this.renderSync();

    this.currentFrameLineNumberGutterProps = null;
    this.scrollTopPending = false;
    this.scrollLeftPending = false;
    if (this.remeasureScrollbars) {
      // Flush stored scroll positions to the vertical and the horizontal
      // scrollbars. This is because they have just been destroyed and recreated
      // as a result of their remeasurement, but we could not assign the scroll
      // top while they were initialized because they were not attached to the
      // DOM yet.
      this.refs.verticalScrollbar.flushScrollPosition();
      this.refs.horizontalScrollbar.flushScrollPosition();

      this.measureScrollbarDimensions();
      this.remeasureScrollbars = false;
      this.renderSync();
    }

    this.derivedDimensionsCache = {};
    if (this.resolveNextUpdatePromise) this.resolveNextUpdatePromise();
  }

  // Builds the static DOM shell once, at construction. All dynamic
  // attributes, styles, and child component lifecycles are handled by
  // renderSync. The class name of the root element is managed separately by
  // this.updateClassList().
  buildShell() {
    this.rootCache = {};
    this.clientContainerCache = {};
    this.scrollContainerCache = {};
    this.contentCache = {};
    this.lineTilesCache = {};
    this.lineTileComponentsById = new Map();
    this.extraLineComponentsByKey = new Map();
    this.overlayComponentsByElement = new Map();
    this.placeholderTextElement = null;
    this.lastPlaceholderText = null;
    this.lastBlockDecorationMeasurementAreaWidth = null;

    this.element.tabIndex = -1;
    this.element.addEventListener("wheel", this.didMouseWheel);

    const clientContainer = document.createElement("div");
    let style = clientContainer.style;
    style.position = "relative";
    style.contain = "strict";
    style.overflow = "hidden";
    style.backgroundColor = "inherit";
    this.refs.clientContainer = clientContainer;
    this.element.appendChild(clientContainer);

    const scrollContainer = document.createElement("div");
    scrollContainer.className = "scroll-view";
    style = scrollContainer.style;
    style.position = "absolute";
    style.contain = "strict";
    style.overflow = "hidden";
    style.top = 0;
    style.bottom = 0;
    style.backgroundColor = "inherit";
    this.refs.scrollContainer = scrollContainer;
    clientContainer.appendChild(scrollContainer);

    const content = document.createElement("div");
    content.addEventListener("mousedown", this.didMouseDownOnContent);
    style = content.style;
    style.contain = "strict";
    style.overflow = "hidden";
    style.backgroundColor = "inherit";
    this.refs.content = content;
    scrollContainer.appendChild(content);

    const lineTiles = document.createElement("div");
    lineTiles.className = "lines";
    style = lineTiles.style;
    style.position = "absolute";
    style.contain = "strict";
    style.overflow = "hidden";
    this.refs.lineTiles = lineTiles;
    content.appendChild(lineTiles);

    this.highlightsComponent = new HighlightsComponent(this.buildHighlightsProps());
    lineTiles.appendChild(this.highlightsComponent.element);

    const cursorsAndInputComponent = new CursorsAndInputComponent(this.buildCursorsAndInputProps());
    this.refs.cursorsAndInput = cursorsAndInputComponent;
    lineTiles.appendChild(cursorsAndInputComponent.element);

    const blockDecorationMeasurementArea = document.createElement("div");
    style = blockDecorationMeasurementArea.style;
    style.contain = "strict";
    style.position = "absolute";
    style.visibility = "hidden";
    this.refs.blockDecorationMeasurementArea = blockDecorationMeasurementArea;
    content.appendChild(blockDecorationMeasurementArea);

    content.appendChild(this.buildCharacterMeasurementLine());
  }

  buildCharacterMeasurementLine() {
    const characterMeasurementLine = document.createElement("div");
    characterMeasurementLine.className = "line dummy";
    characterMeasurementLine.style.position = "absolute";
    characterMeasurementLine.style.visibility = "hidden";
    this.refs.characterMeasurementLine = characterMeasurementLine;

    // We used to put each of these characters inside the same block-level
    // element, but that resulted in different, less-accurate measurements
    // than when they each exist in isolation.
    const measurementSpans = [
      ["normalWidthCharacterSpan", NORMAL_WIDTH_CHARACTER],
      ["doubleWidthCharacterSpan", DOUBLE_WIDTH_CHARACTER],
      ["halfWidthCharacterSpan", HALF_WIDTH_CHARACTER],
      ["koreanCharacterSpan", KOREAN_CHARACTER],
    ];
    for (const [ref, character] of measurementSpans) {
      const wrapper = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = character;
      this.refs[ref] = span;
      wrapper.appendChild(span);
      characterMeasurementLine.appendChild(wrapper);
    }

    return characterMeasurementLine;
  }

  // Flushes the editor's state to the DOM: the manual equivalent of the
  // virtual-DOM diff this component previously performed. Regions are visited
  // in the same top-down order the diff used so that event and lifecycle
  // timing are unchanged.
  renderSync() {
    this.updateRootElement();
    this.updateClientContainerElement();
    this.syncGutterContainer();
    this.updateScrollContainerElement();
    this.updateContentElement();
    this.updateLineTilesElement();
    this.highlightsComponent.update(this.buildHighlightsProps());
    this.syncLineTiles();
    this.refs.cursorsAndInput.update(this.buildCursorsAndInputProps());
    this.updateBlockDecorationMeasurementArea();
    this.syncDummyScrollbars();
    this.syncOverlayDecorations();
  }

  updateRootElement() {
    const { model } = this.props;
    const cache = this.rootCache;

    const contain = !model.getAutoHeight() && !model.getAutoWidth() ? "size" : "";
    if (contain !== cache.contain) {
      this.element.style.contain = contain;
      cache.contain = contain;
    }

    // In auto-width mode the root width is pinned to min-content. Otherwise
    // the width is left alone: the previous virtual-DOM diff fed the current
    // inline width back into itself, i.e. a no-op.
    if (this.hasInitialMeasurements && model.getAutoWidth() && cache.width !== "min-content") {
      this.element.style.width = "min-content";
      cache.width = "min-content";
    }

    const mini = model.isMini();
    if (mini !== cache.mini) {
      if (mini) this.element.setAttribute("mini", "");
      else this.element.removeAttribute("mini");
      cache.mini = mini;
    }

    const readOnly = model.isReadOnly();
    if (readOnly !== cache.readOnly) {
      if (readOnly) this.element.setAttribute("readonly", "");
      else this.element.removeAttribute("readonly");
      cache.readOnly = readOnly;
    }

    const encoding = model.getEncoding();
    if (encoding !== cache.encoding) {
      this.element.dataset.encoding = encoding;
      cache.encoding = encoding;
    }

    const grammar = model.getGrammar();
    const grammarClass =
      grammar && grammar.scopeName ? grammar.scopeName.replace(/\./g, " ") : null;
    if (grammarClass !== cache.grammar) {
      if (grammarClass == null) delete this.element.dataset.grammar;
      else this.element.dataset.grammar = grammarClass;
      cache.grammar = grammarClass;
    }
  }

  updateClientContainerElement() {
    const { model } = this.props;
    const cache = this.clientContainerCache;

    let clientContainerHeight = "100%";
    let clientContainerWidth = "100%";
    if (this.hasInitialMeasurements) {
      if (model.getAutoHeight()) {
        clientContainerHeight =
          this.getContentHeight() + this.getHorizontalScrollbarHeight() + "px";
      }
      if (model.getAutoWidth()) {
        clientContainerWidth =
          this.getGutterContainerWidth() +
          this.getContentWidth() +
          this.getVerticalScrollbarWidth() +
          "px";
      }
    }

    const style = this.refs.clientContainer.style;
    if (clientContainerHeight !== cache.height) {
      style.height = clientContainerHeight;
      cache.height = clientContainerHeight;
    }
    if (clientContainerWidth !== cache.width) {
      style.width = clientContainerWidth;
      cache.width = clientContainerWidth;
    }

    // An editor can be switched to and from auto sizing at any time.
    this.updateClientContainerObservation();
  }

  syncGutterContainer() {
    if (this.props.model.isMini()) {
      if (this.refs.gutterContainer) {
        this.refs.gutterContainer.element.remove();
        delete this.refs.gutterContainer;
      }
    } else {
      const gutterContainerProps = {
        rootComponent: this,
        hasInitialMeasurements: this.hasInitialMeasurements,
        measuredContent: this.measuredContent,
        scrollTop: this.getScrollTop(),
        scrollHeight: this.getScrollHeight(),
        lineNumberGutterWidth: this.getLineNumberGutterWidth(),
        lineHeight: this.getLineHeight(),
        renderedStartRow: this.getRenderedStartRow(),
        renderedEndRow: this.getRenderedEndRow(),
        rowsPerTile: this.getRowsPerTile(),
        guttersToRender: this.guttersToRender,
        decorationsToRender: this.decorationsToRender,
        isLineNumberGutterVisible: this.props.model.isLineNumberGutterVisible(),
        showLineNumbers: this.showLineNumbers,
        lineNumbersToRender: this.lineNumbersToRender,
        didMeasureVisibleBlockDecoration: this.didMeasureVisibleBlockDecoration,
      };

      if (this.refs.gutterContainer) {
        this.refs.gutterContainer.update(gutterContainerProps);
      } else {
        const gutterContainerComponent = new GutterContainerComponent(gutterContainerProps);
        this.refs.gutterContainer = gutterContainerComponent;
        this.refs.clientContainer.insertBefore(
          gutterContainerComponent.element,
          this.refs.scrollContainer,
        );
      }
    }
  }

  updateScrollContainerElement() {
    const cache = this.scrollContainerCache;

    let left = null;
    let width = null;
    let right = null;
    if (this.hasInitialMeasurements) {
      left = this.getGutterContainerWidth() + "px";
      if (this.props.model.getAutoWidth()) {
        width = this.getScrollContainerWidth() + "px";
      } else {
        // Pin to the live right edge instead of a measured pixel width so the
        // dummy scrollbars stay attached while the editor is resized;
        // measurements only catch up on the next scheduled update.
        right = "0px";
      }
    }

    const style = this.refs.scrollContainer.style;
    if (left !== cache.left) {
      style.left = left == null ? "" : left;
      cache.left = left;
    }
    if (width !== cache.width) {
      style.width = width == null ? "" : width;
      cache.width = width;
    }
    if (right !== cache.right) {
      style.right = right == null ? "" : right;
      cache.right = right;
    }
  }

  updateContentElement() {
    if (this.hasInitialMeasurements) {
      const cache = this.contentCache;
      const style = this.refs.content.style;

      const width = ceilToPhysicalPixelBoundary(this.getScrollWidth()) + "px";
      const height = ceilToPhysicalPixelBoundary(this.getScrollHeight()) + "px";
      const transform = `translate(${-roundToPhysicalPixelBoundary(
        this.getScrollLeft(),
      )}px, ${-roundToPhysicalPixelBoundary(this.getScrollTop())}px)`;

      if (width !== cache.width) {
        style.width = width;
        cache.width = width;
      }
      if (height !== cache.height) {
        style.height = height;
        cache.height = height;
      }
      // Deliberately no `will-change: transform` here. It would promote the
      // content to its own compositing layer, and Chromium refuses subpixel
      // (ClearType) antialiasing on such a layer — a `will-change` layer may be
      // given an arbitrary transform at any time, so an opaque background does
      // not buy it back. The editor's text would then render grayscale-
      // antialiased while the rest of the UI renders with ClearType, which
      // reads as thin and blurry on Windows. Scrolling a full-window
      // 5000-line editor holds the display's refresh rate either way, because
      // the translate here only moves already-rasterized tiles.
      if (transform !== cache.transform) {
        style.transform = transform;
        cache.transform = transform;
      }
    }
  }

  updateLineTilesElement() {
    if (this.hasInitialMeasurements) {
      const cache = this.lineTilesCache;
      const style = this.refs.lineTiles.style;
      const width = this.getScrollWidth() + "px";
      const height = this.getScrollHeight() + "px";
      if (width !== cache.width) {
        style.width = width;
        cache.width = width;
      }
      if (height !== cache.height) {
        style.height = height;
        cache.height = height;
      }
    }
  }

  buildHighlightsProps() {
    return {
      hasInitialMeasurements: this.hasInitialMeasurements,
      highlightDecorations: this.decorationsToRender.highlights.slice(),
      width: this.getScrollWidth(),
      height: this.getScrollHeight(),
      lineHeight: this.getLineHeight(),
    };
  }

  buildCursorsAndInputProps() {
    return {
      didBlurHiddenInput: this.didBlurHiddenInput,
      didFocusHiddenInput: this.didFocusHiddenInput,
      didCopy: this.didCopy,
      didCut: this.didCut,
      didTextInput: this.didTextInput,
      didPaste: this.didPaste,
      didKeydown: this.didKeydown,
      didKeyup: this.didKeyup,
      didKeypress: this.didKeypress,
      didCompositionStart: this.didCompositionStart,
      didCompositionUpdate: this.didCompositionUpdate,
      didCompositionEnd: this.didCompositionEnd,
      measuredContent: this.measuredContent,
      lineHeight: this.getLineHeight(),
      scrollHeight: this.getScrollHeight(),
      scrollWidth: this.getScrollWidth(),
      decorationsToRender: this.decorationsToRender,
      cursorsBlinkedOff: this.cursorsBlinkedOff,
      hiddenInputPosition: this.hiddenInputPosition,
      tabIndex: this.tabIndex,
    };
  }

  // Reconciles the children of the .lines container: the highlights layer,
  // one LinesTileComponent per rendered tile (keyed by tile id), off-screen
  // measurement lines (keyed by screen line id), the placeholder text, and
  // the cursors layer, in that DOM order.
  syncLineTiles() {
    const lineTilesElement = this.refs.lineTiles;
    const orderedElements = [this.highlightsComponent.element];
    const seenTileIds = new Set();
    const seenExtraLineKeys = new Set();

    if (this.hasInitialMeasurements) {
      const { lineComponentsByScreenLineId } = this;

      const startRow = this.getRenderedStartRow();
      const endRow = this.getRenderedEndRow();
      const rowsPerTile = this.getRowsPerTile();
      const tileWidth = this.getScrollWidth();

      for (let i = 0; i < this.renderedTileStartRows.length; i++) {
        const tileStartRow = this.renderedTileStartRows[i];
        const tileEndRow = Math.min(endRow, tileStartRow + rowsPerTile);
        const tileHeight =
          this.pixelPositionBeforeBlocksForRow(tileEndRow) -
          this.pixelPositionBeforeBlocksForRow(tileStartRow);
        const tileId = this.idsByTileStartRow.get(tileStartRow);
        seenTileIds.add(tileId);

        const tileProps = {
          measuredContent: this.measuredContent,
          height: tileHeight,
          width: tileWidth,
          top: this.pixelPositionBeforeBlocksForRow(tileStartRow),
          lineHeight: this.getLineHeight(),
          renderedStartRow: startRow,
          tileStartRow,
          tileEndRow,
          screenLines: this.renderedScreenLines.slice(
            tileStartRow - startRow,
            tileEndRow - startRow,
          ),
          lineDecorations: this.decorationsToRender.lines.slice(
            tileStartRow - startRow,
            tileEndRow - startRow,
          ),
          textDecorations: this.decorationsToRender.text.slice(
            tileStartRow - startRow,
            tileEndRow - startRow,
          ),
          blockDecorations: this.decorationsToRender.blocks.get(tileStartRow),
          displayLayer: this.props.model.displayLayer,
          nodePool: this.lineNodesPool,
          lineComponentsByScreenLineId,
          horizontalPixelPositionsByScreenLineId: this.horizontalPixelPositionsByScreenLineId,
        };

        let tileComponent = this.lineTileComponentsById.get(tileId);
        if (tileComponent) {
          tileComponent.update(tileProps);
        } else {
          tileComponent = new LinesTileComponent(tileProps);
          this.lineTileComponentsById.set(tileId, tileComponent);
        }
        orderedElements.push(tileComponent.element);
      }

      this.extraRenderedScreenLines.forEach((screenLine, screenRow) => {
        if (screenRow < startRow || screenRow >= endRow) {
          const key = "extra-" + screenLine.id;
          seenExtraLineKeys.add(key);

          const lineProps = {
            offScreen: true,
            screenLine,
            screenRow,
            displayLayer: this.props.model.displayLayer,
            nodePool: this.lineNodesPool,
            lineComponentsByScreenLineId,
            horizontalPixelPositionsByScreenLineId: this.horizontalPixelPositionsByScreenLineId,
          };

          let lineComponent = this.extraLineComponentsByKey.get(key);
          if (lineComponent) {
            lineComponent.update(lineProps);
          } else {
            lineComponent = new LineComponent(lineProps);
            this.extraLineComponentsByKey.set(key, lineComponent);
          }
          orderedElements.push(lineComponent.element);
        }
      });
    }

    this.lineTileComponentsById.forEach((tileComponent, tileId) => {
      if (!seenTileIds.has(tileId)) {
        tileComponent.destroy();
        this.lineTileComponentsById.delete(tileId);
      }
    });

    this.extraLineComponentsByKey.forEach((lineComponent, key) => {
      if (!seenExtraLineKeys.has(key)) {
        lineComponent.destroy();
        this.extraLineComponentsByKey.delete(key);
      }
    });

    const { model } = this.props;
    let placeholderText = null;
    if (model.isEmpty()) {
      placeholderText = model.getPlaceholderText();
    }
    if (placeholderText != null) {
      if (!this.placeholderTextElement) {
        this.placeholderTextElement = document.createElement("div");
        this.placeholderTextElement.className = "placeholder-text";
      }
      if (placeholderText !== this.lastPlaceholderText) {
        this.placeholderTextElement.textContent = placeholderText;
        this.lastPlaceholderText = placeholderText;
      }
      orderedElements.push(this.placeholderTextElement);
    } else if (this.placeholderTextElement) {
      this.placeholderTextElement.remove();
      this.placeholderTextElement = null;
      this.lastPlaceholderText = null;
    }

    orderedElements.push(this.refs.cursorsAndInput.element);

    // Walk backwards so each element can be positioned before its successor
    // with a single insertBefore when it is new or out of order.
    let nextElement = null;
    for (let i = orderedElements.length - 1; i >= 0; i--) {
      const element = orderedElements[i];
      if (element.parentNode !== lineTilesElement || element.nextSibling !== nextElement) {
        lineTilesElement.insertBefore(element, nextElement);
      }
      nextElement = element;
    }
  }

  updateBlockDecorationMeasurementArea() {
    const width = this.getScrollWidth() + "px";
    if (width !== this.lastBlockDecorationMeasurementAreaWidth) {
      this.refs.blockDecorationMeasurementArea.style.width = width;
      this.lastBlockDecorationMeasurementAreaWidth = width;
    }
  }

  // Mounts, updates, or unmounts the dummy scrollbar pair and their corner.
  // During scrollbar remeasurement the pair is destroyed and recreated (the
  // same protocol the previous virtual-DOM diff performed via a null render),
  // and updateSyncAfterMeasuringContent flushes scroll positions afterwards
  // because they cannot be assigned before the elements are attached.
  syncDummyScrollbars() {
    if (this.shouldRenderDummyScrollbars && !this.props.model.isMini()) {
      let scrollHeight, scrollTop, horizontalScrollbarHeight;
      let scrollWidth, scrollLeft, verticalScrollbarWidth, forceScrollbarVisible;
      let canScrollHorizontally, canScrollVertically;

      if (this.hasInitialMeasurements) {
        scrollHeight = this.getScrollHeight();
        scrollWidth = this.getScrollWidth();
        scrollTop = this.getScrollTop();
        scrollLeft = this.getScrollLeft();
        canScrollHorizontally = this.canScrollHorizontally();
        canScrollVertically = this.canScrollVertically();
        horizontalScrollbarHeight = this.getHorizontalScrollbarHeight();
        verticalScrollbarWidth = this.getVerticalScrollbarWidth();
        forceScrollbarVisible = this.remeasureScrollbars;
      } else {
        forceScrollbarVisible = true;
      }

      const verticalScrollbarProps = {
        orientation: "vertical",
        didScroll: this.didScrollDummyScrollbar,
        didMouseDown: this.didMouseDownOnContent,
        canScroll: canScrollVertically,
        scrollHeight,
        scrollTop,
        horizontalScrollbarHeight,
        forceScrollbarVisible,
      };
      const horizontalScrollbarProps = {
        orientation: "horizontal",
        didScroll: this.didScrollDummyScrollbar,
        didMouseDown: this.didMouseDownOnContent,
        canScroll: canScrollHorizontally,
        scrollWidth,
        scrollLeft,
        verticalScrollbarWidth,
        forceScrollbarVisible,
      };

      if (this.refs.verticalScrollbar) {
        this.refs.verticalScrollbar.update(verticalScrollbarProps);
        this.refs.horizontalScrollbar.update(horizontalScrollbarProps);
      } else {
        const verticalScrollbar = new DummyScrollbarComponent(verticalScrollbarProps);
        const horizontalScrollbar = new DummyScrollbarComponent(horizontalScrollbarProps);

        // Force a "corner" to render where the two scrollbars meet at the lower right
        const scrollbarCorner = document.createElement("div");
        scrollbarCorner.className = "scrollbar-corner";
        const style = scrollbarCorner.style;
        style.position = "absolute";
        style.height = "20px";
        style.width = "20px";
        style.bottom = 0;
        style.right = 0;
        style.overflow = "scroll";

        this.refs.verticalScrollbar = verticalScrollbar;
        this.refs.horizontalScrollbar = horizontalScrollbar;
        this.refs.scrollbarCorner = scrollbarCorner;
        this.refs.scrollContainer.appendChild(verticalScrollbar.element);
        this.refs.scrollContainer.appendChild(horizontalScrollbar.element);
        this.refs.scrollContainer.appendChild(scrollbarCorner);
      }

      this.refs.scrollbarCorner.style.visibility =
        canScrollHorizontally && canScrollVertically ? "" : "hidden";
    } else if (this.refs.verticalScrollbar) {
      this.refs.verticalScrollbar.destroy();
      this.refs.horizontalScrollbar.destroy();
      this.refs.scrollbarCorner.remove();
      delete this.refs.verticalScrollbar;
      delete this.refs.horizontalScrollbar;
      delete this.refs.scrollbarCorner;
    }
  }

  // Reconciles overlay decoration components, keyed by their content element,
  // as children of the root element following the client container.
  syncOverlayDecorations() {
    const seenOverlayElements = new Set();
    const orderedElements = [];

    for (let i = 0; i < this.decorationsToRender.overlays.length; i++) {
      const overlayProps = this.decorationsToRender.overlays[i];
      seenOverlayElements.add(overlayProps.element);

      const componentProps = Object.assign(
        {
          overlayComponents: this.overlayComponents,
          didResize: (overlayComponent) => {
            this.updateOverlayToRender(overlayProps);
            overlayComponent.update(overlayProps);
          },
        },
        overlayProps,
      );

      let overlayComponent = this.overlayComponentsByElement.get(overlayProps.element);
      if (overlayComponent) {
        overlayComponent.update(componentProps);
      } else {
        overlayComponent = new OverlayComponent(componentProps);
        this.overlayComponentsByElement.set(overlayProps.element, overlayComponent);
      }
      orderedElements.push(overlayComponent.element);
    }

    this.overlayComponentsByElement.forEach((overlayComponent, element) => {
      if (!seenOverlayElements.has(element)) {
        overlayComponent.destroy();
        overlayComponent.element.remove();
        this.overlayComponentsByElement.delete(element);
      }
    });

    let nextElement = null;
    for (let i = orderedElements.length - 1; i >= 0; i--) {
      const element = orderedElements[i];
      if (element.parentNode !== this.element || element.nextSibling !== nextElement) {
        this.element.insertBefore(element, nextElement);
      }
      nextElement = element;
    }
  }

  // Imperatively manipulate the class list of the root element to avoid
  // clearing classes assigned by package authors.
  updateClassList() {
    const { model } = this.props;

    const oldClassList = this.classList;
    const newClassList = ["editor"];
    if (this.focused) newClassList.push("is-focused");
    if (model.isMini()) newClassList.push("mini");
    for (var i = 0; i < model.selections.length; i++) {
      if (!model.selections[i].isEmpty()) {
        newClassList.push("has-selection");
        break;
      }
    }

    if (oldClassList) {
      for (let i = 0; i < oldClassList.length; i++) {
        const className = oldClassList[i];
        if (!newClassList.includes(className)) {
          this.element.classList.remove(className);
        }
      }
    }

    for (let i = 0; i < newClassList.length; i++) {
      this.element.classList.add(newClassList[i]);
    }

    this.classList = newClassList;
  }

  queryScreenLinesToRender() {
    const { model } = this.props;

    this.renderedScreenLines = model.displayLayer.getScreenLines(
      this.getRenderedStartRow(),
      this.getRenderedEndRow(),
    );
  }

  queryLongestLine() {
    const { model } = this.props;

    const longestLineRow = model.getApproximateLongestScreenRow();
    const longestLine = model.screenLineForScreenRow(longestLineRow);
    if (longestLine !== this.previousLongestLine || this.remeasureCharacterDimensions) {
      this.requestLineToMeasure(longestLineRow, longestLine);
      this.longestLineToMeasure = longestLine;
      this.previousLongestLine = longestLine;
    }
  }

  queryExtraScreenLinesToRender() {
    this.extraRenderedScreenLines.clear();
    this.linesToMeasure.forEach((screenLine, row) => {
      if (row < this.getRenderedStartRow() || row >= this.getRenderedEndRow()) {
        this.extraRenderedScreenLines.set(row, screenLine);
      }
    });
  }

  queryLineNumbersToRender() {
    const { model } = this.props;
    if (!model.anyLineNumberGutterVisible()) return;
    if (this.showLineNumbers !== model.doesShowLineNumbers()) {
      this.remeasureGutterDimensions = true;
      this.showLineNumbers = model.doesShowLineNumbers();
    }

    this.queryMaxLineNumberDigits();

    const startRow = this.getRenderedStartRow();
    const endRow = this.getRenderedEndRow();
    const renderedRowCount = this.getRenderedRowCount();

    const bufferRows = model.bufferRowsForScreenRows(startRow, endRow);
    const screenRows = new Array(renderedRowCount);
    const keys = new Array(renderedRowCount);
    const foldableFlags = new Array(renderedRowCount);
    const softWrappedFlags = new Array(renderedRowCount);

    let previousBufferRow = startRow > 0 ? model.bufferRowForScreenRow(startRow - 1) : -1;
    let softWrapCount = 0;
    for (let row = startRow; row < endRow; row++) {
      const i = row - startRow;
      const bufferRow = bufferRows[i];
      if (bufferRow === previousBufferRow) {
        softWrapCount++;
        softWrappedFlags[i] = true;
        keys[i] = bufferRow + "-" + softWrapCount;
      } else {
        softWrapCount = 0;
        softWrappedFlags[i] = false;
        keys[i] = bufferRow;
      }

      const nextBufferRow = bufferRows[i + 1];
      if (bufferRow !== nextBufferRow) {
        foldableFlags[i] = model.isFoldableAtBufferRow(bufferRow);
      } else {
        foldableFlags[i] = false;
      }

      screenRows[i] = row;
      previousBufferRow = bufferRow;
    }

    // Delete extra buffer row at the end because it's not currently on screen.
    bufferRows.pop();

    this.lineNumbersToRender.bufferRows = bufferRows;
    this.lineNumbersToRender.screenRows = screenRows;
    this.lineNumbersToRender.keys = keys;
    this.lineNumbersToRender.foldableFlags = foldableFlags;
    this.lineNumbersToRender.softWrappedFlags = softWrappedFlags;
  }

  queryMaxLineNumberDigits() {
    const { model } = this.props;
    if (model.anyLineNumberGutterVisible()) {
      const maxDigits = Math.max(2, model.getLineCount().toString().length);
      if (maxDigits !== this.lineNumbersToRender.maxDigits) {
        this.remeasureGutterDimensions = true;
        this.lineNumbersToRender.maxDigits = maxDigits;
      }
    }
  }

  renderedScreenLineForRow(row) {
    return (
      this.renderedScreenLines[row - this.getRenderedStartRow()] ||
      this.extraRenderedScreenLines.get(row)
    );
  }

  queryGuttersToRender() {
    const oldGuttersToRender = this.guttersToRender;
    const oldGuttersVisibility = this.guttersVisibility;
    this.guttersToRender = this.props.model.getGutters();
    this.guttersVisibility = this.guttersToRender.map((g) => g.visible);

    if (!oldGuttersToRender || oldGuttersToRender.length !== this.guttersToRender.length) {
      this.remeasureGutterDimensions = true;
    } else {
      for (let i = 0, length = this.guttersToRender.length; i < length; i++) {
        if (
          this.guttersToRender[i] !== oldGuttersToRender[i] ||
          this.guttersVisibility[i] !== oldGuttersVisibility[i]
        ) {
          this.remeasureGutterDimensions = true;
          break;
        }
      }
    }
  }

  queryDecorationsToRender() {
    this.decorationsToRender.lineNumbers.clear();
    this.decorationsToRender.lines = [];
    this.decorationsToRender.overlays.length = 0;
    this.decorationsToRender.customGutter.clear();
    this.decorationsToRender.blocks = new Map();
    this.decorationsToRender.text = [];
    this.decorationsToMeasure.highlights.length = 0;
    this.decorationsToMeasure.cursors.clear();
    this.textDecorationsByMarker.clear();
    this.textDecorationBoundaries.length = 0;

    const decorationsByMarker =
      this.props.model.decorationManager.decorationPropertiesByMarkerForScreenRowRange(
        this.getRenderedStartRow(),
        this.getRenderedEndRow(),
      );

    decorationsByMarker.forEach((decorations, marker) => {
      const screenRange = marker.getScreenRange();
      const reversed = marker.isReversed();
      for (let i = 0; i < decorations.length; i++) {
        const decoration = decorations[i];
        this.addDecorationToRender(decoration.type, decoration, marker, screenRange, reversed);
      }
    });

    this.populateTextDecorationsToRender();
  }

  addDecorationToRender(type, decoration, marker, screenRange, reversed) {
    if (Array.isArray(type)) {
      for (let i = 0, length = type.length; i < length; i++) {
        this.addDecorationToRender(type[i], decoration, marker, screenRange, reversed);
      }
    } else {
      switch (type) {
        case "line":
        case "line-number":
          this.addLineDecorationToRender(type, decoration, screenRange, reversed);
          break;
        case "highlight":
          this.addHighlightDecorationToMeasure(decoration, screenRange, marker.id);
          break;
        case "cursor":
          this.addCursorDecorationToMeasure(decoration, marker, screenRange, reversed);
          break;
        case "overlay":
          this.addOverlayDecorationToRender(decoration, marker);
          break;
        case "gutter":
          this.addCustomGutterDecorationToRender(decoration, screenRange);
          break;
        case "block":
          this.addBlockDecorationToRender(decoration, screenRange, reversed);
          break;
        case "text":
          this.addTextDecorationToRender(decoration, screenRange, marker);
          break;
      }
    }
  }

  addLineDecorationToRender(type, decoration, screenRange, reversed) {
    let decorationsToRender;
    if (type === "line") {
      decorationsToRender = this.decorationsToRender.lines;
    } else {
      const gutterName = decoration.gutterName || "line-number";
      decorationsToRender = this.decorationsToRender.lineNumbers.get(gutterName);
      if (!decorationsToRender) {
        decorationsToRender = [];
        this.decorationsToRender.lineNumbers.set(gutterName, decorationsToRender);
      }
    }

    let omitLastRow = false;
    if (screenRange.isEmpty()) {
      if (decoration.onlyNonEmpty) return;
    } else {
      if (decoration.onlyEmpty) return;
      if (decoration.omitEmptyLastRow !== false) {
        omitLastRow = screenRange.end.column === 0;
      }
    }

    const renderedStartRow = this.getRenderedStartRow();
    let rangeStartRow = screenRange.start.row;
    let rangeEndRow = screenRange.end.row;

    if (decoration.onlyHead) {
      if (reversed) {
        rangeEndRow = rangeStartRow;
      } else {
        rangeStartRow = rangeEndRow;
      }
    }

    rangeStartRow = Math.max(rangeStartRow, this.getRenderedStartRow());
    rangeEndRow = Math.min(rangeEndRow, this.getRenderedEndRow() - 1);

    for (let row = rangeStartRow; row <= rangeEndRow; row++) {
      if (omitLastRow && row === screenRange.end.row) break;
      const currentClassName = decorationsToRender[row - renderedStartRow];
      const newClassName = currentClassName
        ? currentClassName + " " + decoration.class
        : decoration.class;
      decorationsToRender[row - renderedStartRow] = newClassName;
    }
  }

  addHighlightDecorationToMeasure(decoration, screenRange, key) {
    screenRange = constrainRangeToRows(
      screenRange,
      this.getRenderedStartRow(),
      this.getRenderedEndRow(),
    );
    if (screenRange.isEmpty()) return;

    const { class: className, flashRequested, flashClass, flashDuration } = decoration;
    decoration.flashRequested = false;
    this.decorationsToMeasure.highlights.push({
      screenRange,
      key,
      className,
      flashRequested,
      flashClass,
      flashDuration,
    });
    this.requestHorizontalMeasurement(screenRange.start.row, screenRange.start.column);
    this.requestHorizontalMeasurement(screenRange.end.row, screenRange.end.column);
  }

  addCursorDecorationToMeasure(decoration, marker, screenRange, reversed) {
    const { model } = this.props;

    let decorationToMeasure = this.decorationsToMeasure.cursors.get(marker);
    if (!decorationToMeasure) {
      const isLastCursor = model.getLastCursor().getMarker() === marker;
      const rawScreenPosition = reversed ? screenRange.start : screenRange.end;
      const { row } = rawScreenPosition;
      let { column } = rawScreenPosition;

      if (row < this.getRenderedStartRow() || row >= this.getRenderedEndRow()) return;

      // Clamp column to line length to prevent cursor rendering at invalid
      // positions due to intermittent timing issues with display layer updates
      const lineLength = model.lineLengthForScreenRow(row);
      if (column > lineLength) {
        column = lineLength;
      }

      const screenPosition = { row, column };
      this.requestHorizontalMeasurement(row, column);
      let columnWidth = 0;
      if (lineLength > column) {
        columnWidth = 1;
        this.requestHorizontalMeasurement(row, column + 1);
      }
      decorationToMeasure = { screenPosition, columnWidth, isLastCursor };
      this.decorationsToMeasure.cursors.set(marker, decorationToMeasure);
    }

    if (decoration.class) {
      if (decorationToMeasure.className) {
        decorationToMeasure.className += " " + decoration.class;
      } else {
        decorationToMeasure.className = decoration.class;
      }
    }

    if (decoration.style) {
      if (decorationToMeasure.style) {
        Object.assign(decorationToMeasure.style, decoration.style);
      } else {
        decorationToMeasure.style = Object.assign({}, decoration.style);
      }
    }
  }

  addOverlayDecorationToRender(decoration, marker) {
    const { class: className, item, position, avoidOverflow } = decoration;
    const element = TextEditor.viewForItem(item);
    const screenPosition =
      position === "tail" ? marker.getTailScreenPosition() : marker.getHeadScreenPosition();

    this.requestHorizontalMeasurement(screenPosition.row, screenPosition.column);
    this.decorationsToRender.overlays.push({
      className,
      element,
      avoidOverflow,
      screenPosition,
    });
  }

  addCustomGutterDecorationToRender(decoration, screenRange) {
    let decorations = this.decorationsToRender.customGutter.get(decoration.gutterName);
    if (!decorations) {
      decorations = [];
      this.decorationsToRender.customGutter.set(decoration.gutterName, decorations);
    }
    const top = this.pixelPositionAfterBlocksForRow(screenRange.start.row);
    const height = this.pixelPositionBeforeBlocksForRow(screenRange.end.row + 1) - top;

    decorations.push({
      className: "decoration" + (decoration.class ? " " + decoration.class : ""),
      element: TextEditor.viewForItem(decoration.item),
      top,
      height,
    });
  }

  addBlockDecorationToRender(decoration, screenRange, reversed) {
    const { row } = reversed ? screenRange.start : screenRange.end;
    if (row < this.getRenderedStartRow() || row >= this.getRenderedEndRow()) return;

    const tileStartRow = this.tileStartRowForRow(row);
    const screenLine = this.renderedScreenLines[row - this.getRenderedStartRow()];

    let decorationsByScreenLine = this.decorationsToRender.blocks.get(tileStartRow);
    if (!decorationsByScreenLine) {
      decorationsByScreenLine = new Map();
      this.decorationsToRender.blocks.set(tileStartRow, decorationsByScreenLine);
    }

    let decorations = decorationsByScreenLine.get(screenLine.id);
    if (!decorations) {
      decorations = [];
      decorationsByScreenLine.set(screenLine.id, decorations);
    }
    decorations.push(decoration);

    // Order block decorations by increasing values of their "order" property. Break ties with "id", which mirrors
    // their creation sequence.
    decorations.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id - b.id));
  }

  addTextDecorationToRender(decoration, screenRange, marker) {
    if (screenRange.isEmpty()) return;

    let decorationsForMarker = this.textDecorationsByMarker.get(marker);
    if (!decorationsForMarker) {
      decorationsForMarker = [];
      this.textDecorationsByMarker.set(marker, decorationsForMarker);
      this.textDecorationBoundaries.push({
        position: screenRange.start,
        starting: [marker],
      });
      this.textDecorationBoundaries.push({
        position: screenRange.end,
        ending: [marker],
      });
    }
    decorationsForMarker.push(decoration);
  }

  populateTextDecorationsToRender() {
    // Sort all boundaries in ascending order of position
    this.textDecorationBoundaries.sort((a, b) => a.position.compare(b.position));

    // Combine adjacent boundaries with the same position
    for (let i = 0; i < this.textDecorationBoundaries.length;) {
      const boundary = this.textDecorationBoundaries[i];
      const nextBoundary = this.textDecorationBoundaries[i + 1];
      if (nextBoundary && nextBoundary.position.isEqual(boundary.position)) {
        if (nextBoundary.starting) {
          if (boundary.starting) {
            boundary.starting.push(...nextBoundary.starting);
          } else {
            boundary.starting = nextBoundary.starting;
          }
        }

        if (nextBoundary.ending) {
          if (boundary.ending) {
            boundary.ending.push(...nextBoundary.ending);
          } else {
            boundary.ending = nextBoundary.ending;
          }
        }

        this.textDecorationBoundaries.splice(i + 1, 1);
      } else {
        i++;
      }
    }

    const renderedStartRow = this.getRenderedStartRow();
    const renderedEndRow = this.getRenderedEndRow();
    const containingMarkers = [];

    // Iterate over boundaries to build up text decorations.
    for (let i = 0; i < this.textDecorationBoundaries.length; i++) {
      const boundary = this.textDecorationBoundaries[i];

      // If multiple markers start here, sort them by order of nesting (markers ending later come first)
      if (boundary.starting && boundary.starting.length > 1) {
        boundary.starting.sort((a, b) => a.compare(b));
      }

      // If multiple markers start here, sort them by order of nesting (markers starting earlier come first)
      if (boundary.ending && boundary.ending.length > 1) {
        boundary.ending.sort((a, b) => b.compare(a));
      }

      // Remove markers ending here from containing markers array
      if (boundary.ending) {
        for (let j = boundary.ending.length - 1; j >= 0; j--) {
          containingMarkers.splice(containingMarkers.lastIndexOf(boundary.ending[j]), 1);
        }
      }
      // Add markers starting here to containing markers array
      if (boundary.starting) containingMarkers.push(...boundary.starting);

      // Determine desired className and style based on containing markers
      let className, style;
      for (let j = 0; j < containingMarkers.length; j++) {
        const marker = containingMarkers[j];
        const decorations = this.textDecorationsByMarker.get(marker);
        for (let k = 0; k < decorations.length; k++) {
          const decoration = decorations[k];
          if (decoration.class) {
            if (className) {
              className += " " + decoration.class;
            } else {
              className = decoration.class;
            }
          }
          if (decoration.style) {
            if (style) {
              Object.assign(style, decoration.style);
            } else {
              style = Object.assign({}, decoration.style);
            }
          }
        }
      }

      // Add decoration start with className/style for current position's column,
      // and also for the start of every row up until the next decoration boundary
      if (boundary.position.row >= renderedStartRow) {
        this.addTextDecorationStart(
          boundary.position.row,
          boundary.position.column,
          className,
          style,
        );
      }
      const nextBoundary = this.textDecorationBoundaries[i + 1];
      if (nextBoundary) {
        let row = Math.max(boundary.position.row + 1, renderedStartRow);
        const endRow = Math.min(nextBoundary.position.row, renderedEndRow);
        for (; row < endRow; row++) {
          this.addTextDecorationStart(row, 0, className, style);
        }

        if (row === nextBoundary.position.row && nextBoundary.position.column !== 0) {
          this.addTextDecorationStart(row, 0, className, style);
        }
      }
    }
  }

  addTextDecorationStart(row, column, className, style) {
    const renderedStartRow = this.getRenderedStartRow();
    let decorationStarts = this.decorationsToRender.text[row - renderedStartRow];
    if (!decorationStarts) {
      decorationStarts = [];
      this.decorationsToRender.text[row - renderedStartRow] = decorationStarts;
    }
    decorationStarts.push({ column, className, style });
  }

  updateAbsolutePositionedDecorations() {
    this.updateHighlightsToRender();
    this.updateCursorsToRender();
    this.updateOverlaysToRender();
  }

  updateHighlightsToRender() {
    this.decorationsToRender.highlights.length = 0;
    let originRect = this.refs.lineTiles.getBoundingClientRect();
    for (let i = 0; i < this.decorationsToMeasure.highlights.length; i++) {
      const highlight = this.decorationsToMeasure.highlights[i];
      const { start, end } = highlight.screenRange;

      // To know where to draw the selection highlights, we'll inspect the text
      // nodes themselves and get some `ClientRects`.
      let screenLineStart = this.renderedScreenLineForRow(start.row);
      let screenLineEnd = this.renderedScreenLineForRow(end.row);
      // A buffer change between measuring and rendering (e.g. a suggestion's
      // text edit inserting a newline) can shift screen lines so the marked
      // rows are no longer rendered. Skip the highlight for this frame; the
      // next update sees consistent state.
      let startComponent =
        screenLineStart && this.lineComponentsByScreenLineId.get(screenLineStart.id);
      let endComponent = screenLineEnd && this.lineComponentsByScreenLineId.get(screenLineEnd.id);
      if (!startComponent || !endComponent) continue;
      let { textNodes: startTextNodes } = startComponent;
      let { textNodes: endTextNodes } = endComponent;

      let startClientRects;
      let endClientRects = null;
      if (start.row !== end.row) {
        startClientRects = clientRectsForTextNodes(
          startTextNodes,
          start.column,
          Math.max(0, screenLineStart.lineText.length),
        );
        endClientRects = clientRectsForTextNodes(endTextNodes, 0, end.column);
      } else {
        startClientRects = clientRectsForTextNodes(startTextNodes, start.column, end.column);
      }

      highlight.startPixelTop = this.pixelPositionAfterBlocksForRow(start.row);
      // We use these `ClientRect`s for their X-axis coordinates;
      // `startPixelTop` above tells us where to start the highlight on the
      // Y-axis.
      highlight.startRects = [...startClientRects].map((r) => rectRelativeToOrigin(r, originRect));
      highlight.endPixelTop = this.pixelPositionAfterBlocksForRow(end.row) + this.getLineHeight();
      highlight.endRects = endClientRects
        ? [...endClientRects].map((r) => rectRelativeToOrigin(r, originRect))
        : null;

      this.decorationsToRender.highlights.push(highlight);
    }
  }

  updateCursorsToRender() {
    this.decorationsToRender.cursors.length = 0;

    this.decorationsToMeasure.cursors.forEach((cursor) => {
      const { screenPosition, className, style } = cursor;
      const { row, column } = screenPosition;

      const pixelTop = this.pixelPositionAfterBlocksForRow(row);
      const pixelLeft = this.pixelLeftForRowAndColumn(row, column);
      // A buffer change between measuring and rendering can shift screen lines
      // so this row's horizontal position was never measured. Skip the cursor
      // for this frame (as highlights do) rather than pushing a NaN pixelLeft/
      // pixelWidth; the next update sees consistent state.
      if (pixelLeft == null) return;
      let pixelWidth;
      if (cursor.columnWidth === 0) {
        pixelWidth = this.getBaseCharacterWidth();
      } else {
        const nextPixelLeft = this.pixelLeftForRowAndColumn(row, column + 1);
        pixelWidth =
          nextPixelLeft == null ? this.getBaseCharacterWidth() : nextPixelLeft - pixelLeft;
      }

      const cursorPosition = {
        pixelTop,
        pixelLeft,
        pixelWidth,
        className,
        style,
      };
      this.decorationsToRender.cursors.push(cursorPosition);
      if (cursor.isLastCursor) this.hiddenInputPosition = cursorPosition;
    });
  }

  updateOverlayToRender(
    decoration,
    contentClientRect = this.refs.content.getBoundingClientRect(),
    windowInnerHeight = this.getWindowInnerHeight(),
    windowInnerWidth = this.getWindowInnerWidth(),
  ) {
    const { element, screenPosition, avoidOverflow } = decoration;
    const { row, column } = screenPosition;
    let wrapperTop =
      contentClientRect.top + this.pixelPositionAfterBlocksForRow(row) + this.getLineHeight();
    let wrapperLeft = contentClientRect.left + this.pixelLeftForRowAndColumn(row, column);
    const clientRect = element.getBoundingClientRect();

    if (avoidOverflow !== false) {
      const computedStyle = window.getComputedStyle(element);
      const elementTop = wrapperTop + parseInt(computedStyle.marginTop);
      const elementBottom = elementTop + clientRect.height;
      const flippedElementTop =
        wrapperTop -
        this.getLineHeight() -
        clientRect.height -
        parseInt(computedStyle.marginBottom);
      const elementLeft = wrapperLeft + parseInt(computedStyle.marginLeft);
      const elementRight = elementLeft + clientRect.width;

      if (elementBottom > windowInnerHeight && flippedElementTop >= 0) {
        wrapperTop -= elementTop - flippedElementTop;
      }
      if (elementLeft < 0) {
        wrapperLeft -= elementLeft;
      } else if (elementRight > windowInnerWidth) {
        wrapperLeft -= elementRight - windowInnerWidth;
      }
    }

    decoration.pixelTop = Math.round(wrapperTop);
    decoration.pixelLeft = Math.round(wrapperLeft);
  }

  updateOverlaysToRender() {
    const overlayCount = this.decorationsToRender.overlays.length;
    if (overlayCount === 0) return null;

    // These are constant across every overlay this frame; read them once rather
    // than re-measuring the content rect (a layout read) per overlay.
    const contentClientRect = this.refs.content.getBoundingClientRect();
    const windowInnerHeight = this.getWindowInnerHeight();
    const windowInnerWidth = this.getWindowInnerWidth();

    for (let i = 0; i < overlayCount; i++) {
      const decoration = this.decorationsToRender.overlays[i];
      this.updateOverlayToRender(
        decoration,
        contentClientRect,
        windowInnerHeight,
        windowInnerWidth,
      );
    }
  }

  didAttach() {
    if (!this.attached) {
      this.attached = true;
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const { intersectionRect } = entries[entries.length - 1];
        if (intersectionRect.width > 0 || intersectionRect.height > 0) {
          this.didShow();
        } else {
          this.didHide();
        }
      });
      this.intersectionObserver.observe(this.element);

      this.resizeObserver = new ResizeObserver(this.didResize.bind(this));
      this.observeResizeTargets();

      if (this.refs.gutterContainer) {
        this.gutterContainerResizeObserver = new ResizeObserver(
          this.didResizeGutterContainer.bind(this),
        );
        this.gutterContainerResizeObserver.observe(this.refs.gutterContainer.element);
      }

      this.overlayComponents.forEach((component) => component.didAttach());

      if (this.isVisible()) {
        this.didShow();

        if (this.refs.verticalScrollbar) this.refs.verticalScrollbar.flushScrollPosition();
        if (this.refs.horizontalScrollbar) this.refs.horizontalScrollbar.flushScrollPosition();
      } else {
        this.didHide();
      }
      if (!this.constructor.attachedComponents) {
        this.constructor.attachedComponents = new Set();
      }
      this.constructor.attachedComponents.add(this);
    }
  }

  // Observes the boxes whose size the component's measurements depend on.
  //
  // The client container is observed alongside the editor element because it is the box that is
  // actually measured, and a package can resize it on its own: the minimap attaches as a flex
  // sibling of the client container and takes a tenth of the editor's width without the element
  // itself ever changing size. Auto-sized editors are left out, since there the component writes
  // that box on every update and would only measure back the size it just set.
  observeResizeTargets() {
    this.resizeObserver.observe(this.element);
    this.observingClientContainer = false;
    this.updateClientContainerObservation();
  }

  updateClientContainerObservation() {
    if (!this.attached) return;

    const { model } = this.props;
    const shouldObserve = !model.getAutoHeight() && !model.getAutoWidth();
    if (shouldObserve === this.observingClientContainer) return;

    if (shouldObserve) {
      this.resizeObserver.observe(this.refs.clientContainer);
    } else {
      this.resizeObserver.unobserve(this.refs.clientContainer);
    }
    this.observingClientContainer = shouldObserve;
  }

  didDetach() {
    if (this.attached) {
      this.scrollAnimator.cancel();
      if (this.softWrapDebounceTimer) {
        clearTimeout(this.softWrapDebounceTimer);
        this.softWrapDebounceTimer = null;
      }
      this.intersectionObserver.disconnect();
      this.resizeObserver.disconnect();
      if (this.gutterContainerResizeObserver) this.gutterContainerResizeObserver.disconnect();
      this.overlayComponents.forEach((component) => component.didDetach());

      this.didHide();
      this.attached = false;
      this.constructor.attachedComponents.delete(this);
    }
  }

  didShow() {
    if (!this.visible && this.isVisible()) {
      if (!this.hasInitialMeasurements) {
        this.measureDimensions();
      } else {
        // The pane may have changed size while the editor was hidden or
        // detached (e.g. a tab dragged into a split lands in a narrower
        // pane); refresh the container measurements so the reveal frame
        // renders at the real size instead of flashing the stale one.
        this.measureClientContainerWidth();
        this.measureClientContainerHeight();
      }
      this.visible = true;
      this.props.model.setVisible(true);
      this.resizeBlockDecorationMeasurementsArea = true;
      // A newly opened editor or one returning from a background pane must
      // wrap at its real width on the reveal paint; the debounce only
      // coalesces width changes that happen while the editor stays visible.
      if (this.softWrapDebounceTimer) {
        clearTimeout(this.softWrapDebounceTimer);
        this.softWrapDebounceTimer = null;
      }
      this.flushingSoftWrapColumn = true;
      this.updateSync();
      this.flushPendingLogicalScrollPosition();
    }
  }

  didHide() {
    if (this.visible) {
      this.visible = false;
      this.props.model.setVisible(false);
    }
  }

  // Called by TextEditorElement so that focus events can be handled before
  // the element is attached to the DOM.
  didFocus() {
    if (!this.visible) this.didShow();

    if (!this.focused) {
      this.focused = true;
      this.startCursorBlinking();
      this.scheduleUpdate();
    }

    this.getHiddenInput().focus({ preventScroll: true });
  }

  // Called by TextEditorElement so that this function is always the first
  // listener to be fired, even if other listeners are bound before creating
  // the component.
  didBlur(event) {
    if (event.relatedTarget === this.getHiddenInput()) {
      event.stopImmediatePropagation();
    }
  }

  didBlurHiddenInput(event) {
    if (this.element !== event.relatedTarget && !this.element.contains(event.relatedTarget)) {
      this.focused = false;
      this.stopCursorBlinking();
      this.scheduleUpdate();
      this.element.dispatchEvent(new FocusEvent(event.type, event));
    }
  }

  didFocusHiddenInput() {
    // Focusing the hidden input while it sits outside the viewport can make
    // the browser scroll the scroll container to reveal it. Our own focus()
    // calls pass preventScroll, but browser-initiated focus (window refocus,
    // IME, execCommand) does not, and since scrolling here is synthetic and
    // transform-based, any native scroll offset shears the rendered lines
    // ("half screen" bug). Always reset it.
    this.refs.scrollContainer.scrollTop = 0;
    this.refs.scrollContainer.scrollLeft = 0;

    if (!this.focused) {
      this.focused = true;
      this.startCursorBlinking();
      this.scheduleUpdate();
    }
  }

  didMouseWheel(event) {
    const { x, y } = this.normalizedWheelDeltas(event);
    if (this.applyWheelScroll(x, y)) event.preventDefault();
  }

  // Converts a `wheel` event into pre-sensitivity pixel deltas, applying
  // delta-mode normalization, the non-darwin shift swap, and the alt speed
  // multiplier. Both axes are preserved so diagonal trackpad gestures pan
  // smoothly instead of locking to the dominant axis per event.
  normalizedWheelDeltas(event) {
    let deltaX = event.deltaX || 0;
    let deltaY = event.deltaY || 0;

    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      // Fall back to a nominal line height if the wheel event arrives before
      // the initial measurement.
      const lineHeight = this.hasInitialMeasurements ? this.getLineHeight() : 16;
      deltaX *= lineHeight;
      deltaY *= lineHeight;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      deltaX *= this.element.offsetWidth;
      deltaY *= this.element.offsetHeight;
    }

    deltaX *= WHEEL_DELTA_PARITY;
    deltaY *= WHEEL_DELTA_PARITY;

    if (this.getPlatform() !== "darwin" && event.shiftKey) {
      const temp = deltaX;
      deltaX = deltaY;
      deltaY = temp;
    }

    const altWheelMultiplier = this.props.model.getAltWheelMultiplier();
    if (event.altKey && altWheelMultiplier !== 1) {
      deltaX *= altWheelMultiplier;
      deltaY *= altWheelMultiplier;
    }

    return { x: deltaX, y: deltaY };
  }

  // Scrolls this editor by pre-sensitivity pixel deltas, animating when smooth
  // scrolling is enabled. Returns whether the scroll was accepted, so wheel
  // events can chain to outer scroll containers when the editor is at an edge.
  applyWheelScroll(x, y) {
    const model = this.props.model;
    const scrollSensitivity = model.getScrollSensitivity() / 100;
    x *= scrollSensitivity;
    y *= scrollSensitivity;
    if (x === 0 && y === 0) return false;

    if (model.getSmoothScrolling() && !model.isMini()) {
      const accepted = this.scrollAnimator.scrollBy({
        x,
        y,
        smoothness: model.getWheelSmoothness(),
      });
      if (accepted) {
        // The user took over the viewport; stop pinning the inherited anchor.
        this.settlingScrollAnchor = null;
      }
      return accepted;
    }

    const scrollLeftChanged = x !== 0 && this.setScrollLeft(this.getScrollLeft() + x);
    const scrollTopChanged = y !== 0 && this.setScrollTop(this.getScrollTop() + y);

    if (scrollTopChanged) {
      // The user took over the viewport; stop pinning the inherited anchor.
      this.settlingScrollAnchor = null;
    }

    if (scrollLeftChanged || scrollTopChanged) {
      this.updateSync();
      return true;
    }
    return false;
  }

  didResize() {
    // Prevent the component from measuring the client container dimensions when
    // getting spurious resize events.
    if (this.isVisible()) {
      const clientContainerWidthChanged = this.measureClientContainerWidth();
      const clientContainerHeightChanged = this.measureClientContainerHeight();
      if (clientContainerWidthChanged || clientContainerHeightChanged) {
        if (clientContainerWidthChanged) {
          this.remeasureAllBlockDecorations = true;
        }

        this.resizeObserver.disconnect();
        // ResizeObserver fires after layout but before paint, so an immediate
        // update renders the new size (and applies a copy's inherited scroll
        // anchor) without flashing a stale frame — a scheduled update would
        // run at the next frame's rAF, after this frame painted.
        this.updateSync();
        process.nextTick(() => {
          if (this.attached) this.observeResizeTargets();
        });
      }
    }
  }

  didResizeGutterContainer() {
    // Prevent the component from measuring the gutter dimensions when getting
    // spurious resize events.
    if (this.isVisible() && this.measureGutterDimensions()) {
      this.gutterContainerResizeObserver.disconnect();
      this.scheduleUpdate();
      process.nextTick(() => {
        this.gutterContainerResizeObserver.observe(this.refs.gutterContainer.element);
      });
    }
  }

  didScrollDummyScrollbar() {
    let scrollTopChanged = false;
    let scrollLeftChanged = false;
    if (!this.scrollTopPending) {
      scrollTopChanged = this.setScrollTop(this.refs.verticalScrollbar?.element.scrollTop ?? 0);
      if (scrollTopChanged) {
        // The user took over the viewport; stop pinning the inherited anchor.
        this.settlingScrollAnchor = null;
      }
    }
    if (!this.scrollLeftPending) {
      scrollLeftChanged = this.setScrollLeft(
        this.refs.horizontalScrollbar?.element.scrollLeft ?? 0,
      );
    }
    if (scrollTopChanged || scrollLeftChanged) this.updateSync();
  }

  didUpdateStyles() {
    this.remeasureCharacterDimensions = true;
    this.horizontalPixelPositionsByScreenLineId.clear();
    this.scheduleUpdate();
  }

  didUpdateScrollbarStyles() {
    if (!this.props.model.isMini()) {
      this.remeasureScrollbars = true;
      this.scheduleUpdate();
    }
  }

  copySelectedText() {
    this.performClipboardOperation("copy", false);
  }

  copyOnlySelectedText() {
    this.performClipboardOperation("copy", true);
  }

  cutSelectedText() {
    this.performClipboardOperation("cut", false);
  }

  pasteText(options = {}, commandEvent = null) {
    if (
      commandEvent?.originalEvent?.type === "keydown" &&
      typeof commandEvent.abortKeyBinding === "function"
    ) {
      const nativeOperation = { options };
      this.pendingNativePasteOperation = nativeOperation;
      commandEvent.abortKeyBinding();
      setTimeout(() => {
        if (this.pendingNativePasteOperation === nativeOperation) {
          this.pendingNativePasteOperation = null;
        }
      }, 0);
      return;
    }

    // Renderer-initiated `execCommand("paste")` never fires a ClipboardEvent
    // (Chromium reserves paste for native keystrokes and menu actions), so a
    // paste command that did not arrive as a keystroke reads the clipboard
    // directly. Metadata copied in another window is unavailable here.
    const { skipPasteProviders, ...editorOptions } = options;
    const handledByProvider =
      !skipPasteProviders &&
      this.handlePasteProviders({
        clipboard: this.props.model.constructor.clipboard,
        options: editorOptions,
      });
    if (!handledByProvider) this.props.model.pasteText(editorOptions);
  }

  handlePasteProviders({ clipboard, clipboardData = null, options = {} }) {
    const { model } = this.props;
    const registry = model.constructor.pasteProviderRegistry;
    if (!registry) return false;

    return registry.handlePaste({
      target: { type: "text-editor", editor: model },
      clipboard,
      clipboardData,
      options,
    });
  }

  performClipboardOperation(type, onlySelectedText) {
    const operation = { type, onlySelectedText, handled: false };
    this.pendingClipboardOperation = operation;

    try {
      this.getHiddenInput().focus({ preventScroll: true });
      const { ownerDocument } = this.element;
      if (typeof ownerDocument.execCommand === "function") ownerDocument.execCommand(type);
    } catch {
      // Fall through to the existing direct clipboard implementation below.
    } finally {
      this.pendingClipboardOperation = null;
    }

    if (!operation.handled) {
      if (type === "cut") {
        this.props.model.cutSelectedText();
      } else if (onlySelectedText) {
        this.props.model.copyOnlySelectedText();
      } else {
        this.props.model.copySelectedText();
      }
    }
  }

  didCopy(event) {
    this.writeClipboardEvent(event, false);
  }

  didCut(event) {
    this.writeClipboardEvent(event, true);
  }

  writeClipboardEvent(event, isCut) {
    if (!event.clipboardData) return;

    const clipboard = this.props.model.constructor.clipboard.createDataTransferClipboard(
      event.clipboardData,
    );
    const operation = this.pendingClipboardOperation;

    if (isCut) {
      this.props.model.cutSelectedText({ clipboard });
    } else if (operation?.onlySelectedText) {
      this.props.model.copyOnlySelectedText(clipboard);
    } else {
      this.props.model.copySelectedText(clipboard);
    }

    const matchesPendingOperation = operation && operation.type === (isCut ? "cut" : "copy");
    if (clipboard.didWrite() || matchesPendingOperation) {
      event.preventDefault();
      if (matchesPendingOperation) operation.handled = true;
    }
  }

  didPaste(event) {
    const nativeOperation = this.pendingNativePasteOperation;
    this.pendingNativePasteOperation = null;
    if (event.clipboardData && (this.getPlatform() !== "linux" || nativeOperation)) {
      const clipboard = this.props.model.constructor.clipboard.createDataTransferClipboard(
        event.clipboardData,
      );
      const options = nativeOperation?.options || {};
      const { skipPasteProviders, ...editorOptions } = options;
      const handledByProvider =
        !skipPasteProviders &&
        this.handlePasteProviders({
          clipboard,
          clipboardData: event.clipboardData,
          options: editorOptions,
        });
      if (!handledByProvider) {
        this.props.model.pasteText({ ...editorOptions, clipboard });
      }
      event.preventDefault();
    } else if (this.getPlatform() === "linux") {
      // Chromium translates a middle-button mouse click into a mousedown and a
      // paste event on Linux. Preserve Lumine's existing suppression unless the
      // paste event was explicitly requested by the editor command above.
      event.preventDefault();
    }
  }

  didTextInput(event) {
    if (this.compositionCheckpoint) {
      this.props.model.revertToCheckpoint(this.compositionCheckpoint);
      this.compositionCheckpoint = null;
    }

    if (this.isInputEnabled()) {
      event.stopPropagation();

      // Prevent the default insertion into the hidden input for every
      // character, space included. The space exemption this branch used to
      // carry (a cancelled space fell back to the spacebar's page-scroll
      // action, while an un-cancelled one made the browser force-scroll the
      // scroll container to reveal the off-screen input — see
      // https://github.com/atom/atom/issues/16046) no longer reproduces on
      // Electron 43, verified with trusted `webContents.sendInputEvent`
      // input; see the hidden-input spec. Preventing space also keeps it
      // from scrolling scrollable ancestors outside the editor to reveal
      // the input, which no other character does.
      event.preventDefault();

      // If the input event is fired while the accented character menu is open it
      // means that the user has chosen one of the accented alternatives. Thus, we
      // will replace the original non accented character with the selected
      // alternative.
      if (this.accentedCharacterMenuIsOpen) {
        this.props.model.selectLeft();
      }

      // In overtype mode, expand empty selections over the following character
      // so the typed text overwrites it instead of being inserted before it.
      this.props.model.applyOvertype();

      this.props.model.insertText(event.data, { groupUndo: true });
    }
  }

  // We need to get clever to detect when the accented character menu is
  // opened on macOS. Usually, every keydown event that could cause input is
  // followed by a corresponding keypress. However, pressing and holding
  // long enough to open the accented character menu causes additional keydown
  // events to fire that aren't followed by their own keypress and textInput
  // events.
  //
  // Therefore, we assume the accented character menu has been deployed if,
  // before observing any keyup event, we observe events in the following
  // sequence:
  //
  // keydown(code: X), keypress, keydown(code: X)
  //
  // The code X must be the same in the keydown events that bracket the
  // keypress, meaning we're *holding* the _same_ key we initially pressed.
  // Got that?
  didKeydown(event) {
    // Stop dragging when user interacts with the keyboard. This prevents
    // unwanted selections in the case edits are performed while selecting text
    // at the same time. Modifier keys are exempt to preserve the ability to
    // add selections, shift-scroll horizontally while selecting.
    if (
      this.stopDragging &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Meta" &&
      event.key !== "Shift"
    ) {
      this.stopDragging();
    }

    if (this.lastKeydownBeforeKeypress != null) {
      if (this.lastKeydownBeforeKeypress.code === event.code) {
        this.accentedCharacterMenuIsOpen = true;
      }

      this.lastKeydownBeforeKeypress = null;
    }

    this.lastKeydown = event;
  }

  didKeypress(_event) {
    this.lastKeydownBeforeKeypress = this.lastKeydown;

    // This cancels the accented character behavior if we type a key normally
    // with the menu open.
    this.accentedCharacterMenuIsOpen = false;
  }

  didKeyup(event) {
    if (this.lastKeydownBeforeKeypress && this.lastKeydownBeforeKeypress.code === event.code) {
      this.lastKeydownBeforeKeypress = null;
    }
  }

  // The IME composition events work like this:
  //
  // User types 's', chromium pops up the completion helper
  //   1. compositionstart fired
  //   2. compositionupdate fired; event.data == 's'
  // User hits arrow keys to move around in completion helper
  //   3. compositionupdate fired; event.data == 's' for each arry key press
  // User escape to cancel OR User chooses a completion
  //   4. compositionend fired
  //   5. textInput fired; event.data == the completion string
  didCompositionStart() {
    // Workaround for Chromium not preventing composition events when
    // preventDefault is called on the keydown event that precipitated them.
    if (this.lastKeydown && this.lastKeydown.defaultPrevented) {
      this.getHiddenInput().disabled = true;
      process.nextTick(() => {
        // Disabling the hidden input makes it lose focus as well, so we have to
        // re-enable and re-focus it.
        this.getHiddenInput().disabled = false;
        this.getHiddenInput().focus({ preventScroll: true });
      });
      return;
    }

    this.compositionCheckpoint = this.props.model.createCheckpoint();
    if (this.accentedCharacterMenuIsOpen) {
      this.props.model.selectLeft();
    }
  }

  didCompositionUpdate(event) {
    this.props.model.insertText(event.data, { select: true });
  }

  didCompositionEnd(event) {
    event.target.value = "";
  }

  didMouseDownOnContent(event) {
    const { model } = this.props;
    const { target, button, detail, ctrlKey, shiftKey, metaKey } = event;
    const platform = this.getPlatform();

    // Ignore clicks on block decorations.
    if (target) {
      let element = target;
      while (element && element !== this.element) {
        if (this.blockDecorationsByElement.has(element)) {
          return;
        }

        element = element.parentElement;
      }
    }

    const screenPosition = this.screenPositionForMouseEvent(event);

    if (button === 1) {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });

      // On Linux, pasting happens on middle click. A textInput event with the
      // contents of the selection clipboard will be dispatched by the browser
      // automatically on mouseup if editor.selectionClipboard is set to true.
      if (
        platform === "linux" &&
        this.isInputEnabled() &&
        atom.config.get("editor.selectionClipboard")
      )
        model.insertText(clipboard.readText("selection"));
      return;
    }

    if (button !== 0) return;

    // Ctrl-click brings up the context menu on macOS
    if (platform === "darwin" && ctrlKey) return;

    if (target && target.matches(".fold-marker")) {
      const bufferPosition = model.bufferPositionForScreenPosition(screenPosition);
      model.destroyFoldsContainingBufferPositions([bufferPosition], false);
      return;
    }

    const allowMultiCursor = atom.config.get("editor.multiCursorOnClick");
    const addOrRemoveSelection =
      allowMultiCursor && (metaKey || (ctrlKey && platform !== "darwin"));

    switch (detail) {
      case 1:
        if (addOrRemoveSelection) {
          const existingSelection = model.getSelectionAtScreenPosition(screenPosition);
          if (existingSelection) {
            if (model.hasMultipleCursors()) existingSelection.destroy();
          } else {
            model.addCursorAtScreenPosition(screenPosition, {
              autoscroll: false,
            });
          }
        } else {
          if (shiftKey) {
            model.selectToScreenPosition(screenPosition, { autoscroll: false });
          } else {
            model.setCursorScreenPosition(screenPosition, {
              autoscroll: false,
            });
          }
        }
        break;
      case 2:
        if (addOrRemoveSelection)
          model.addCursorAtScreenPosition(screenPosition, {
            autoscroll: false,
          });
        model.getLastSelection().selectWord({ autoscroll: false });
        break;
      case 3:
        if (addOrRemoveSelection)
          model.addCursorAtScreenPosition(screenPosition, {
            autoscroll: false,
          });
        model.getLastSelection().selectLine(null, { autoscroll: false });
        break;
    }

    this.handleMouseDragUntilMouseUp({
      didDrag: (event) => {
        this.autoscrollOnMouseDrag(event);
        const screenPosition = this.screenPositionForMouseEvent(event);
        model.selectToScreenPosition(screenPosition, {
          suppressSelectionMerge: true,
          autoscroll: false,
        });
        this.updateSync();
      },
      didStopDragging: () => {
        model.finalizeSelections();
        model.mergeIntersectingSelections();
        this.updateSync();
      },
    });
  }

  didMouseDownOnLineNumberGutter(event) {
    const { model } = this.props;
    const { target, button, ctrlKey, shiftKey, metaKey } = event;

    // Only handle mousedown events for left mouse button
    if (button !== 0) return;

    const clickedScreenRow = this.screenPositionForMouseEvent(event).row;
    const startBufferRow = model.bufferPositionForScreenPosition([clickedScreenRow, 0]).row;

    if (
      target &&
      (target.matches(".foldable .icon-right") || target.matches(".folded .icon-right"))
    ) {
      model.toggleFoldAtBufferRow(startBufferRow);
      return;
    }

    const addOrRemoveSelection = metaKey || (ctrlKey && this.getPlatform() !== "darwin");
    const endBufferRow = model.bufferPositionForScreenPosition([clickedScreenRow, Infinity]).row;
    const clickedLineBufferRange = Range(Point(startBufferRow, 0), Point(endBufferRow + 1, 0));

    let initialBufferRange;
    if (shiftKey) {
      const lastSelection = model.getLastSelection();
      initialBufferRange = lastSelection.getBufferRange();
      lastSelection.setBufferRange(initialBufferRange.union(clickedLineBufferRange), {
        reversed: clickedScreenRow < lastSelection.getScreenRange().start.row,
        autoscroll: false,
        preserveFolds: true,
        suppressSelectionMerge: true,
      });
    } else {
      initialBufferRange = clickedLineBufferRange;
      if (addOrRemoveSelection) {
        model.addSelectionForBufferRange(clickedLineBufferRange, {
          autoscroll: false,
          preserveFolds: true,
        });
      } else {
        model.setSelectedBufferRange(clickedLineBufferRange, {
          autoscroll: false,
          preserveFolds: true,
        });
      }
    }

    const initialScreenRange = model.screenRangeForBufferRange(initialBufferRange);
    this.handleMouseDragUntilMouseUp({
      didDrag: (event) => {
        this.autoscrollOnMouseDrag(event, true);
        const dragRow = this.screenPositionForMouseEvent(event).row;
        const draggedLineScreenRange = Range(Point(dragRow, 0), Point(dragRow + 1, 0));
        model.getLastSelection().setScreenRange(draggedLineScreenRange.union(initialScreenRange), {
          reversed: dragRow < initialScreenRange.start.row,
          autoscroll: false,
          preserveFolds: true,
        });
        this.updateSync();
      },
      didStopDragging: () => {
        model.mergeIntersectingSelections();
        this.updateSync();
      },
    });
  }

  handleMouseDragUntilMouseUp({ didDrag, didStopDragging }) {
    let dragging = false;
    let lastMousemoveEvent;

    const animationFrameLoop = () => {
      window.requestAnimationFrame(() => {
        if (dragging && this.visible) {
          // IntersectionObserver reports visibility changes asynchronously. A
          // pane can therefore lose its layout while `visible` is still true;
          // avoid hit-testing text nodes whose client rects have disappeared.
          if (this.isVisible()) didDrag(lastMousemoveEvent);
          animationFrameLoop();
        }
      });
    };

    function didMouseMove(event) {
      lastMousemoveEvent = event;
      if (!dragging) {
        dragging = true;
        animationFrameLoop();
      }
    }

    function didMouseUp() {
      this.stopDragging = null;
      window.removeEventListener("mousemove", didMouseMove);
      window.removeEventListener("mouseup", didMouseUp, { capture: true });
      if (dragging) {
        dragging = false;
        didStopDragging();
      }
    }

    window.addEventListener("mousemove", didMouseMove);
    window.addEventListener("mouseup", didMouseUp, { capture: true });
    this.stopDragging = didMouseUp;
  }

  autoscrollOnMouseDrag({ clientX, clientY }, verticalOnly = false) {
    let { top, bottom, left, right } = this.refs.scrollContainer.getBoundingClientRect(); // Using var to avoid deopt on += assignments below
    top += MOUSE_DRAG_AUTOSCROLL_MARGIN;
    bottom -= MOUSE_DRAG_AUTOSCROLL_MARGIN;
    left += MOUSE_DRAG_AUTOSCROLL_MARGIN;
    right -= MOUSE_DRAG_AUTOSCROLL_MARGIN;

    let yDelta, yDirection;
    if (clientY < top) {
      yDelta = top - clientY;
      yDirection = -1;
    } else if (clientY > bottom) {
      yDelta = clientY - bottom;
      yDirection = 1;
    }

    let xDelta, xDirection;
    if (clientX < left) {
      xDelta = left - clientX;
      xDirection = -1;
    } else if (clientX > right) {
      xDelta = clientX - right;
      xDirection = 1;
    }

    let scrolled = false;
    if (yDelta != null) {
      let scaledDelta = scaleMouseDragAutoscrollDelta(yDelta) * yDirection;
      // Snap the delta to physical pixels, but do so in the direction of the
      // scroll. Err on the side of moving more in that direction rather than
      // less.
      scaledDelta =
        yDirection === 1
          ? ceilToPhysicalPixelBoundary(scaledDelta)
          : floorToPhysicalPixelBoundary(scaledDelta);
      scrolled = this.setScrollTop(this.getScrollTop() + scaledDelta);
    }

    if (!verticalOnly && xDelta != null) {
      let scaledDelta = scaleMouseDragAutoscrollDelta(xDelta) * xDirection;
      // Snap the delta to physical pixels, but do so in the direction of the
      // scroll. Err on the side of moving more in that direction rather than
      // less.
      scaledDelta =
        xDirection === 1
          ? ceilToPhysicalPixelBoundary(scaledDelta)
          : floorToPhysicalPixelBoundary(scaledDelta);
      scrolled = this.setScrollLeft(this.getScrollLeft() + scaledDelta);
    }

    if (scrolled) this.updateSync();
  }

  screenPositionForMouseEvent(event) {
    return this.screenPositionForPixelPosition(this.pixelPositionForMouseEvent(event));
  }

  pixelPositionForMouseEvent({ clientX, clientY }) {
    const scrollContainerRect = this.refs.scrollContainer.getBoundingClientRect();
    clientX = Math.min(scrollContainerRect.right, Math.max(scrollContainerRect.left, clientX));
    clientY = Math.min(scrollContainerRect.bottom, Math.max(scrollContainerRect.top, clientY));
    const linesRect = this.refs.lineTiles.getBoundingClientRect();
    return {
      top: clientY - linesRect.top,
      left: clientX - linesRect.left,
    };
  }

  didUpdateSelections() {
    this.pauseCursorBlinking();
    this.scheduleUpdate();
  }

  pauseCursorBlinking() {
    this.stopCursorBlinking();
    this.debouncedResumeCursorBlinking();
  }

  resumeCursorBlinking() {
    // Typing pauses the blink and schedules this resume on a debounce that
    // nothing cancels, so by the time it fires the editor may have blurred or
    // left the DOM — and blurring already stopped the blink. Restarting the
    // interval here would tick it forever on an editor nobody is looking at.
    // Focusing the editor again starts it through didFocus.
    if (!this.focused || !this.attached) return;
    this.cursorsBlinkedOff = true;
    this.startCursorBlinking();
  }

  stopCursorBlinking() {
    if (this.cursorsBlinking) {
      this.cursorsBlinkedOff = false;
      this.cursorsBlinking = false;
      window.clearInterval(this.cursorBlinkIntervalHandle);
      this.cursorBlinkIntervalHandle = null;
      this.scheduleUpdate();
    }
  }

  startCursorBlinking() {
    if (!this.cursorsBlinking) {
      this.cursorBlinkIntervalHandle = window.setInterval(
        () => {
          this.cursorsBlinkedOff = !this.cursorsBlinkedOff;
          this.scheduleUpdate(true);
        },
        (this.props.cursorBlinkPeriod || CURSOR_BLINK_PERIOD) / 2,
      );
      this.cursorsBlinking = true;
      this.scheduleUpdate(true);
    }
  }

  didRequestAutoscroll(autoscroll) {
    this.pendingAutoscroll = autoscroll;
    // The user took over the viewport; stop pinning the inherited anchor.
    this.settlingScrollAnchor = null;
    this.scheduleUpdate();
  }

  flushPendingLogicalScrollPosition() {
    let changedScrollTop = false;
    if (this.pendingScrollAnchor) {
      // May decline (and stay pending) while the container has no real height;
      // updateSyncBeforeMeasuringContent retries once the layout is real.
      changedScrollTop = this.flushPendingCopyScrollAnchor();
      if (!changedScrollTop && this.pendingScrollAnchor) {
        // Still pending: position provisionally (without consuming the anchor)
        // so any frame painted before the layout settles already shows the
        // right region instead of the top of the buffer. A row anchor doesn't
        // depend on the viewport height, so this is usually already exact; the
        // authoritative restore corrects any residue before the next paint.
        changedScrollTop = this.restoreScrollAnchor(this.pendingScrollAnchor);
      }
    } else if (this.pendingScrollTopRow > 0) {
      changedScrollTop = this.setScrollTopRow(this.pendingScrollTopRow, false);
      this.pendingScrollTopRow = null;
    }

    let changedScrollLeft = false;
    if (this.pendingScrollLeftColumn > 0) {
      changedScrollLeft = this.setScrollLeftColumn(this.pendingScrollLeftColumn, false);
      this.pendingScrollLeftColumn = null;
    }

    if (changedScrollTop || changedScrollLeft) {
      this.updateSync();
    }
  }

  // Applies the viewport anchor inherited from the editor this one was copied
  // from, restoring the source's visual position through this editor's own
  // (possibly different) soft-wrap geometry. Declines while the scroll
  // container has no real height yet — a freshly split pane is measured before
  // the layout settles, and an anchor restored (and later re-captured) against
  // that placeholder geometry drifts the viewport away from the source.
  flushPendingCopyScrollAnchor() {
    if (!this.pendingScrollAnchor || !this.hasInitialMeasurements) return false;
    if (this.getScrollContainerClientHeight() <= 0) return false;

    const anchor = this.pendingScrollAnchor;
    this.pendingScrollAnchor = null;
    this.pendingScrollTopRow = null;
    // Keep re-applying this anchor across the reflows a new split pane goes
    // through while the panes resize into place; drop any reflow anchor
    // captured from the transient geometry before this authoritative restore.
    this.settlingScrollAnchor = anchor;
    this.pendingReflowScrollAnchor = null;
    this.scrollAnchorBeforeReset = null;
    return this.restoreScrollAnchor(anchor);
  }

  autoscrollVertically(screenRange, options) {
    const screenRangeTop = this.pixelPositionAfterBlocksForRow(screenRange.start.row);
    const screenRangeBottom =
      this.pixelPositionAfterBlocksForRow(screenRange.end.row) + this.getLineHeight();
    const verticalScrollMargin = this.getVerticalAutoscrollMargin();

    let desiredScrollTop, desiredScrollBottom;
    if (options && options.center) {
      const desiredScrollCenter = (screenRangeTop + screenRangeBottom) / 2;
      desiredScrollTop = desiredScrollCenter - this.getScrollContainerClientHeight() / 2;
      desiredScrollBottom = desiredScrollCenter + this.getScrollContainerClientHeight() / 2;
    } else {
      desiredScrollTop = screenRangeTop - verticalScrollMargin;
      desiredScrollBottom = screenRangeBottom + verticalScrollMargin;
    }

    if (!options || options.reversed !== false) {
      if (desiredScrollBottom > this.getScrollBottom()) {
        this.setScrollBottom(desiredScrollBottom);
      }
      if (desiredScrollTop < this.getScrollTop()) {
        this.setScrollTop(desiredScrollTop);
      }
    } else {
      if (desiredScrollTop < this.getScrollTop()) {
        this.setScrollTop(desiredScrollTop);
      }
      if (desiredScrollBottom > this.getScrollBottom()) {
        this.setScrollBottom(desiredScrollBottom);
      }
    }

    return false;
  }

  autoscrollHorizontally(screenRange, options) {
    const horizontalScrollMargin = this.getHorizontalAutoscrollMargin();

    const gutterContainerWidth = this.getGutterContainerWidth();
    let left =
      this.pixelLeftForRowAndColumn(screenRange.start.row, screenRange.start.column) +
      gutterContainerWidth;
    let right =
      this.pixelLeftForRowAndColumn(screenRange.end.row, screenRange.end.column) +
      gutterContainerWidth;
    const desiredScrollLeft = Math.max(0, left - horizontalScrollMargin - gutterContainerWidth);
    const desiredScrollRight = Math.min(this.getScrollWidth(), right + horizontalScrollMargin);

    if (!options || options.reversed !== false) {
      if (desiredScrollRight > this.getScrollRight()) {
        this.setScrollRight(desiredScrollRight);
      }
      if (desiredScrollLeft < this.getScrollLeft()) {
        this.setScrollLeft(desiredScrollLeft);
      }
    } else {
      if (desiredScrollLeft < this.getScrollLeft()) {
        this.setScrollLeft(desiredScrollLeft);
      }
      if (desiredScrollRight > this.getScrollRight()) {
        this.setScrollRight(desiredScrollRight);
      }
    }
  }

  getVerticalAutoscrollMargin() {
    const maxMarginInLines = Math.floor(
      (this.getScrollContainerClientHeight() / this.getLineHeight() - 1) / 2,
    );
    const marginInLines = Math.min(this.props.model.verticalScrollMargin, maxMarginInLines);
    return marginInLines * this.getLineHeight();
  }

  getHorizontalAutoscrollMargin() {
    const maxMarginInBaseCharacters = Math.floor(
      (this.getScrollContainerClientWidth() / this.getBaseCharacterWidth() - 1) / 2,
    );
    const marginInBaseCharacters = Math.min(
      this.props.model.horizontalScrollMargin,
      maxMarginInBaseCharacters,
    );
    return marginInBaseCharacters * this.getBaseCharacterWidth();
  }

  // This method is called at the beginning of a frame render to relay any
  // potential changes in the editor's width into the model before proceeding.
  updateModelSoftWrapColumn() {
    const { model } = this.props;
    const newEditorWidthInChars = this.getScrollContainerClientWidthInBaseCharacters();
    if (newEditorWidthInChars === model.getEditorWidthInChars()) {
      this.flushingSoftWrapColumn = false;
      return;
    }

    // Optionally coalesce rapid width changes (e.g. while dragging a pane
    // divider) into fewer reflows on large files. The first change of a resize
    // applies synchronously, so a one-shot layout change (a pane split, a dock
    // toggle, a copy's pane settling) re-wraps on the frame it happens; only
    // changes arriving while a previous one is still within the interval are
    // deferred until the width has been stable for the interval. The trailing
    // flush re-enters this method with the flag set.
    const debounceInterval = model.getSoftWrapDebounceInterval();
    if (
      debounceInterval > 0 &&
      this.hasInitialMeasurements &&
      !this.flushingSoftWrapColumn &&
      model.isSoftWrapped()
    ) {
      if (this.softWrapDebounceTimer) {
        clearTimeout(this.softWrapDebounceTimer);
        this.softWrapDebounceTimer = setTimeout(() => {
          this.softWrapDebounceTimer = null;
          this.flushingSoftWrapColumn = true;
          this.scheduleUpdate();
        }, debounceInterval);
        return;
      }
      // Leading edge: open the coalescing window and fall through to apply
      // this change synchronously.
      this.softWrapDebounceTimer = setTimeout(() => {
        this.softWrapDebounceTimer = null;
      }, debounceInterval);
    }
    this.flushingSoftWrapColumn = false;

    this.suppressUpdates = true;

    const renderedStartRow = this.getRenderedStartRow();
    this.props.model.setEditorWidthInChars(newEditorWidthInChars);

    // Relaying a change in to the editor's client width may cause the
    // vertical scrollbar to appear or disappear, which causes the editor's
    // client width to change *again*. Make sure the display layer is fully
    // populated for the visible area before recalculating the editor's
    // width in characters. Then update the display layer *again* just in
    // case a change in scrollbar visibility causes lines to wrap
    // differently. We capture the renderedStartRow before resetting the
    // display layer because once it has been reset, we can't compute the
    // rendered start row accurately. 😥
    this.populateVisibleRowRange(renderedStartRow);
    this.props.model.setEditorWidthInChars(this.getScrollContainerClientWidthInBaseCharacters());
    this.derivedDimensionsCache = {};

    this.suppressUpdates = false;
  }

  // This method exists because it existed in the previous implementation and some
  // package tests relied on it
  measureDimensions() {
    this.measureCharacterDimensions();
    this.measureGutterDimensions();
    this.measureClientContainerHeight();
    this.measureClientContainerWidth();
    this.measureScrollbarDimensions();
    this.hasInitialMeasurements = true;
  }

  measureCharacterDimensions() {
    this.measurements.lineHeight = Math.max(
      1,
      // Each of the four characters below exists inside its own block-level
      // element, but each of those containers should have the same height. We
      // don't need to check more than one.
      this.refs.normalWidthCharacterSpan.parentNode.getBoundingClientRect().height,
    );

    this.measurements.baseCharacterWidth =
      this.refs.normalWidthCharacterSpan.getBoundingClientRect().width;
    this.measurements.doubleWidthCharacterWidth =
      this.refs.doubleWidthCharacterSpan.getBoundingClientRect().width;
    this.measurements.halfWidthCharacterWidth =
      this.refs.halfWidthCharacterSpan.getBoundingClientRect().width;
    this.measurements.koreanCharacterWidth =
      this.refs.koreanCharacterSpan.getBoundingClientRect().width;

    this.props.model.setLineHeightInPixels(this.measurements.lineHeight);
    this.props.model.setDefaultCharWidth(
      this.measurements.baseCharacterWidth,
      this.measurements.doubleWidthCharacterWidth,
      this.measurements.halfWidthCharacterWidth,
      this.measurements.koreanCharacterWidth,
    );
    this.lineTopIndex.setDefaultLineHeight(this.measurements.lineHeight);
  }

  measureGutterDimensions() {
    let dimensionsChanged = false;

    if (this.refs.gutterContainer) {
      const gutterContainerWidth = this.refs.gutterContainer.element.offsetWidth;
      if (gutterContainerWidth !== this.measurements.gutterContainerWidth) {
        dimensionsChanged = true;
        this.measurements.gutterContainerWidth = gutterContainerWidth;
      }
    } else {
      this.measurements.gutterContainerWidth = 0;
    }

    if (this.refs.gutterContainer && this.refs.gutterContainer.refs.lineNumberGutter) {
      const lineNumberGutterWidth =
        this.refs.gutterContainer.refs.lineNumberGutter.element.offsetWidth;
      if (lineNumberGutterWidth !== this.measurements.lineNumberGutterWidth) {
        dimensionsChanged = true;
        this.measurements.lineNumberGutterWidth = lineNumberGutterWidth;
      }
    } else {
      this.measurements.lineNumberGutterWidth = 0;
    }

    return dimensionsChanged;
  }

  measureClientContainerHeight() {
    const clientContainerHeight = this.refs.clientContainer.offsetHeight;
    if (clientContainerHeight !== this.measurements.clientContainerHeight) {
      this.measurements.clientContainerHeight = clientContainerHeight;
      return true;
    } else {
      return false;
    }
  }

  measureClientContainerWidth() {
    const clientContainerWidth = this.refs.clientContainer.offsetWidth;
    if (clientContainerWidth !== this.measurements.clientContainerWidth) {
      this.measurements.clientContainerWidth = clientContainerWidth;
      return true;
    } else {
      return false;
    }
  }

  measureScrollbarDimensions() {
    if (this.props.model.isMini()) {
      this.measurements.verticalScrollbarWidth = 0;
      this.measurements.horizontalScrollbarHeight = 0;
    } else {
      this.measurements.verticalScrollbarWidth =
        this.refs.verticalScrollbar.getRealScrollbarWidth();
      this.measurements.horizontalScrollbarHeight =
        this.refs.horizontalScrollbar.getRealScrollbarHeight();
    }
  }

  measureLongestLineWidth() {
    if (this.longestLineToMeasure) {
      const lineComponent = this.lineComponentsByScreenLineId.get(this.longestLineToMeasure.id);
      // This width must live on the same pixel grid as the horizontal
      // positions (see measureHorizontalPositionsOnLine): `.lines` width is
      // derived from it and the width specs assert it against the measured
      // position of the longest line's end, so the two paths must quantize
      // identically. Snapping the fractional bounding-box width to the
      // physical pixel grid guarantees that at every device pixel ratio; at a
      // ratio of 1 it equals the old integer `offsetWidth`. Do not mix grids
      // here (raw fractional or plain offsetWidth) — that desyncs the paths
      // and shifts `getContentWidth` by a pixel.
      this.measurements.longestLineWidth = roundToPhysicalPixelBoundary(
        lineComponent.element.firstChild.getBoundingClientRect().width,
      );
      this.longestLineToMeasure = null;
    }
  }

  requestLineToMeasure(row, screenLine) {
    this.linesToMeasure.set(row, screenLine);
  }

  requestHorizontalMeasurement(row, column) {
    const screenLine = this.props.model.screenLineForScreenRow(row);
    if (screenLine) {
      this.requestLineToMeasure(row, screenLine);

      let columns = this.horizontalPositionsToMeasure.get(row);
      if (columns == null) {
        columns = [];
        this.horizontalPositionsToMeasure.set(row, columns);
      }
      columns.push(column);
    }
  }

  measureHorizontalPositions() {
    this.horizontalPositionsToMeasure.forEach((columnsToMeasure, row) => {
      columnsToMeasure.sort((a, b) => a - b);

      const screenLine = this.renderedScreenLineForRow(row);

      // Skip rows whose screen line or line component is not currently
      // rendered. Measurements can be queued for non-rendered rows by calls
      // to pixelPositionForScreenPosition or pendingAutoscroll when block
      // decorations shift lines outside the rendered range. Because clear()
      // runs after the forEach, throwing here prevents it from ever being
      // reached, poisoning horizontalPositionsToMeasure permanently and
      // causing an infinite error loop on every subsequent animation frame.
      if (!screenLine || !this.lineComponentsByScreenLineId.get(screenLine.id)) {
        if (atom.inDevMode()) {
          console.warn("measureHorizontalPositions: skipped non-rendered row", row);
        }
        return;
      }

      const lineComponent = this.lineComponentsByScreenLineId.get(screenLine.id);

      const lineNode = lineComponent.element;
      const textNodes = lineComponent.textNodes;
      let positionsForLine = this.horizontalPixelPositionsByScreenLineId.get(screenLine.id);
      if (positionsForLine == null) {
        positionsForLine = new Map();
        this.horizontalPixelPositionsByScreenLineId.set(screenLine.id, positionsForLine);
      }

      this.measureHorizontalPositionsOnLine(
        lineNode,
        textNodes,
        columnsToMeasure,
        positionsForLine,
      );
    });
    this.horizontalPositionsToMeasure.clear();
  }

  measureHorizontalPositionsOnLine(lineNode, textNodes, columnsToMeasure, positions) {
    let lineNodeClientLeft = -1;
    let textNodeStartColumn = 0;
    let textNodesIndex = 0;
    let lastTextNodeRight = null;

    columnLoop: for (let columnsIndex = 0; columnsIndex < columnsToMeasure.length; columnsIndex++) {
      const nextColumnToMeasure = columnsToMeasure[columnsIndex];
      while (textNodesIndex < textNodes.length) {
        if (positions.has(nextColumnToMeasure)) continue columnLoop;
        const textNode = textNodes[textNodesIndex];
        const textNodeEndColumn = textNodeStartColumn + textNode.textContent.length;

        if (nextColumnToMeasure < textNodeEndColumn) {
          // We grab a zero-width `DOMRect` at this position. This ensures we
          // won't span any directional shifts in the text (LTR to RTL or vice
          // versa), meaning we'll get a proper measurement for where this
          // character starts.
          //
          // (If the line starts with RTL text, column 0 may not correspond to
          // an X-axis pixel position of 0.)
          let rect = clientRectForRange(
            textNode,
            nextColumnToMeasure - textNodeStartColumn,
            nextColumnToMeasure - textNodeStartColumn,
          );
          let clientPixelPosition = rect.left;
          if (lineNodeClientLeft === -1) {
            lineNodeClientLeft = lineNode.getBoundingClientRect().left;
          }

          // Snap to the physical (device) pixel grid rather than whole CSS
          // pixels. On scaled displays this keeps cursors and selection edges
          // on the true glyph boundary (up to half a CSS pixel closer on
          // fractional-advance fonts) while staying aligned to hardware pixels
          // so carets render crisp. At a device pixel ratio of 1 this is
          // identical to Math.round, preserving the integer invariants the
          // width specs rely on.
          positions.set(
            nextColumnToMeasure,
            roundToPhysicalPixelBoundary(clientPixelPosition - lineNodeClientLeft),
          );
          continue columnLoop;
        } else {
          textNodesIndex++;
          textNodeStartColumn = textNodeEndColumn;
        }
      }

      if (lastTextNodeRight == null) {
        const lastTextNode = textNodes[textNodes.length - 1];
        lastTextNodeRight = clientRectForRange(
          lastTextNode,
          0,
          lastTextNode.textContent.length,
        ).right;
      }

      if (lineNodeClientLeft === -1) {
        lineNodeClientLeft = lineNode.getBoundingClientRect().left;
      }

      positions.set(
        nextColumnToMeasure,
        roundToPhysicalPixelBoundary(lastTextNodeRight - lineNodeClientLeft),
      );
    }
  }

  rowForPixelPosition(pixelPosition) {
    return Math.max(0, this.lineTopIndex.rowForPixelPosition(pixelPosition));
  }

  heightForBlockDecorationsBeforeRow(row) {
    return this.pixelPositionAfterBlocksForRow(row) - this.pixelPositionBeforeBlocksForRow(row);
  }

  heightForBlockDecorationsAfterRow(row) {
    const currentRowBottom = this.pixelPositionAfterBlocksForRow(row) + this.getLineHeight();
    const nextRowTop = this.pixelPositionBeforeBlocksForRow(row + 1);
    return nextRowTop - currentRowBottom;
  }

  pixelPositionBeforeBlocksForRow(row) {
    return this.lineTopIndex.pixelPositionBeforeBlocksForRow(row);
  }

  pixelPositionAfterBlocksForRow(row) {
    return this.lineTopIndex.pixelPositionAfterBlocksForRow(row);
  }

  pixelLeftForRowAndColumn(row, column) {
    const screenLine = this.renderedScreenLineForRow(row);
    if (screenLine) {
      const horizontalPositionsByColumn = this.horizontalPixelPositionsByScreenLineId.get(
        screenLine.id,
      );
      if (horizontalPositionsByColumn) {
        let result = horizontalPositionsByColumn.get(column);
        return result;
      }
    }
  }

  screenPositionForPixelPosition({ top, left }) {
    const { model } = this.props;
    const row = Math.min(this.rowForPixelPosition(top), model.getApproximateScreenLineCount() - 1);

    let screenLine = this.renderedScreenLineForRow(row);
    if (!screenLine) {
      this.requestLineToMeasure(row, model.screenLineForScreenRow(row));
      this.updateSyncBeforeMeasuringContent();
      this.measureContentDuringUpdateSync();
      screenLine = this.renderedScreenLineForRow(row);
    }
    let rowLength = model.lineLengthForScreenRow(row);

    let { textNodes } = this.lineComponentsByScreenLineId.get(screenLine.id);

    let linesClientRect = this.refs.lineTiles.getBoundingClientRect();
    let targetClientLeft = linesClientRect.left + Math.max(0, left);
    let targetClientTop = linesClientRect.top + Math.max(0, top);

    // STRATEGY 1:
    //
    // If the user actually clicked on a place where we can put a cursor, we
    // can look up the DOM `Range` using Chromium’s nonstandard
    // `caretRangeFromPoint` API.
    //
    // This should work wherever the point in question is rendered and visible
    // within the viewport — e.g., anywhere the user clicks.
    let inherentRange = document.caretRangeFromPoint(targetClientLeft, targetClientTop);

    if (inherentRange && textNodes.includes(inherentRange.startContainer)) {
      // The range identified a text node on this line. Now we can convert the
      // range start offset to a screen column by adding the lengths of all the
      // previous nodes.
      let column = columnForTextNodeAndOffset(
        inherentRange.startContainer,
        inherentRange.startOffset,
        textNodes,
      );

      // As a final sanity check, grab this range's bounding DOMRect and ensure
      // it actually contains the point in question.
      //
      // TODO: `caretRangeFromPoint` is incredibly convenient, but this sanity
      // check is required in order to work around a strange behavior that
      // produced a test suite failure. If any further quirks emerge, it might
      // eventually be worth it to skip `caretRangeFromPoint` and go straight
      // to the fallback approach.
      let { top, bottom } = inherentRange.getBoundingClientRect();
      if (targetClientTop >= top && targetClientTop <= bottom) {
        return Point(row, column);
      }
    }

    // SECOND STRATEGY:
    //
    // We need this if the point on screen isn't visible. This can happen if a
    // package calls `screenPositionForPixelPosition` programmatically for a
    // point that is not currently in view.
    //
    // A multi-stage drill-down:
    //
    // * First we find the single text node that contains the position we want.
    // * Next, if necessary, we divide the line further into fragments so that
    //   each fragment is highly likely to have exactly one `DOMRect`; this
    //   tells us that we can assume a single direction of text across that
    //   fragment.
    // * Do a binary search within that fragment until we drill down to the
    //   exact character.
    //
    // Find the text node that contains the position we want.
    {
      let boundingClientRect = boundingClientRectForTextNodes(textNodes);
      // Weed out cases where the pixel position is outside the left and right
      // bounds of the text nodes’ bounding box. These should be clamped, in
      // effect, to the beginning and end of the line.
      if (targetClientLeft < boundingClientRect.left) {
        return Point(row, 0);
      }
      if (targetClientLeft > boundingClientRect.right) {
        return Point(row, rowLength);
      }

      // If we get this far, we effectively will have guaranteed that one of
      // the remaining individual text nodes will have at least one `DOMRect`
      // that contains the point horizontally…
      let containingTextNode = textNodes.find((node) => {
        let rects = clientRectsForTextNode(node);
        return Array.from(rects).some(
          (r) => targetClientLeft >= r.left && targetClientLeft <= r.right,
        );
      });

      // …but we'll handle the failure case just to be safe.
      if (!containingTextNode) {
        console.error(
          `Error: could not find a valid cursor position for coordinates: (${left}, ${top}) within the editor.`,
        );
        // Declare defeat and fall back to the 0th column.
        return Point(row, 0);
      }

      let containingTextNodeIndex = textNodes.indexOf(containingTextNode);
      let characterIndex;

      // The space we will search will be either a full text node or some
      // subset of it. We will ensure that this range of the text node has
      // exactly one text direction.
      let containingTextNodeBounds;
      let containingText;

      if (clientRectsForTextNode(containingTextNode).length === 1) {
        // The whole text node is a single-directional fragment. Great!
        containingText = containingTextNode.textContent;
        containingTextNodeBounds = [0, containingText.length - 1];
      } else {
        // There are multiple `DOMRect`s used to draw this text range. Since
        // this is a single screen line, it won't be because of text wrapping;
        // hence it's almost certainly because we're drawing text in two
        // different directions.
        //
        // Let's divide this text node up along the likely boundaries of RTL
        // text divisions.
        let { textContent } = containingTextNode;

        // Detect unbroken strings of RTL text. These will help us divide the
        // string into fragments, each of which will be considered
        // individually. We use a pattern designed to detect Arabic, Hebrew,
        // and Persian characters in their standard unicode ranges.

        // This pattern describes any number of RTL characters separated only
        // by strings.
        let textMatches = Array.from(
          textContent.matchAll(
            /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]+(?:\s+[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]+)*/g,
          ),
        );

        // These matches identify the RTL sections. Using them, we'll divide
        // the entire line up into fragments, each of which is unidrectional.
        let fragments = [];
        let lastMatchIndex = textMatches.length - 1;

        for (let [i, match] of Array.from(textMatches).entries()) {
          let { index } = match;
          let matchLength = match[0].length;
          if (fragments.length === 0 && index > 0) {
            // The first match doesn't start the line, so add a fragment to
            // represent everything until the first match.
            fragments.push([0, index]);
          }
          let [_, lastFragmentEnd] = fragments[fragments.length - 1];
          if (lastFragmentEnd < index) {
            // A gap exists between the last fragment we added and this match,
            // so add another fragment to represent the gap.
            fragments.push([lastFragmentEnd, index]);
          }
          // Add a fragment for this match.
          fragments.push([index, index + matchLength]);

          if (i === lastMatchIndex && index + matchLength < textContent.length - 1) {
            // This is the last match, but there's text on the line after this
            // match, so we'll add one final fragment to represent that text.
            fragments.push([index + matchLength, textContent.length - 1]);
          }
        }

        for (let [index, endIndex] of fragments) {
          let fragmentText = textContent.substring(index, endIndex);
          let rects = Array.from(clientRectsForRange(containingTextNode, index, endIndex));
          if (rects.some((r) => targetClientLeft >= r.left && targetClientLeft <= r.right)) {
            containingTextNodeBounds = [index, endIndex];
            containingText = fragmentText;
            break;
          }
        }

        let clientRects = clientRectsForTextNode(
          containingTextNode,
          containingTextNodeBounds[0],
          containingTextNodeBounds[1],
        );
        if (clientRects.length > 1) {
          // We've still got a bidirectional fragment somehow. Split the whole
          // thing into individual words. This is a more aggressive way to
          // ensure unidirectionality within a text.
          let words = containingText.split(/\b/);
          let index = containingTextNodeBounds[0];
          let found = false;
          let targetClientRects;
          for (let word of words) {
            let boundaries = [index, index + word.length];
            let clientRects = clientRectsForTextNode(
              containingTextNode,
              boundaries[0],
              boundaries[1],
            );
            if (
              clientRects.some((r) => targetClientLeft >= r.left && targetClientLeft <= r.right)
            ) {
              found = true;
              targetClientRects = clientRects;
              containingTextNodeBounds = boundaries;
              containingText = containingText.substring(...boundaries);
              break;
            }
          }
          // At this point, if we can't find one — or if we can't isolate it to
          // a single contiguous `DOMRect` — then we should give up.
          if (!found | (targetClientRects.length > 1)) {
            console.error(
              `Error: could not find a valid cursor position for coordinates: (${left}, ${top}) within the editor.`,
            );
            // Declare defeat and fall back to the 0th column.
            return Point(row, 0);
          }
        }
      }

      if (!containingTextNodeBounds) {
        console.error(
          `Error: could not find a valid cursor position for coordinates: (${left}, ${top}) within the editor.`,
        );
        // Declare defeat and fall back to the 0th column.
        return Point(row, 0);
      }

      let mode = hasRtlText(containingText) ? "rtl" : "ltr";

      characterIndex = -1;
      {
        let low = containingTextNodeBounds[0];
        let high = containingTextNodeBounds[1];
        while (low <= high) {
          let charIndex = low + ((high - low) >> 1);
          const nextCharIndex = isPairedCharacter(containingTextNode.textContent, charIndex)
            ? charIndex + 2
            : charIndex + 1;

          const rangeRect = clientRectForRange(containingTextNode, charIndex, nextCharIndex);

          if (
            (mode === "ltr" && targetClientLeft < rangeRect.left) ||
            (mode === "rtl" && targetClientLeft > rangeRect.right)
          ) {
            high = charIndex - 1;
            characterIndex = Math.max(0, charIndex - 1);
          } else if (
            (mode === "ltr" && targetClientLeft > rangeRect.right) ||
            (mode === "rtl" && targetClientLeft < rangeRect.left)
          ) {
            low = nextCharIndex;
            characterIndex = Math.min(containingTextNode.textContent.length, nextCharIndex);
          } else {
            let mid = (rangeRect.left + rangeRect.right) / 2;
            if (
              (mode === "ltr" && targetClientLeft <= mid) ||
              (mode === "rtl" && targetClientLeft >= mid)
            ) {
              characterIndex = charIndex;
            } else {
              characterIndex = nextCharIndex;
            }
            break;
          }
        }
        let textNodeStartColumn = 0;
        for (let i = 0; i < containingTextNodeIndex; i++) {
          textNodeStartColumn += textNodes[i].length;
        }
        const column = textNodeStartColumn + characterIndex;
        return Point(row, column);
      }
    }
  }

  // Called by the model just before the display layer resets its screen-row
  // geometry. Records where the viewport is anchored (in buffer coordinates)
  // while the old geometry is still fully populated and queryable, so the next
  // update can put the same content back under the viewport after re-wrapping.
  willResetDisplayLayer() {
    // A copy's inherited anchor hasn't been applied yet; there is no viewport
    // state worth capturing, and the pending anchor is restored later anyway.
    if (this.pendingScrollAnchor) return;
    // A single reflow can reset the display layer more than once (e.g.
    // updateModelSoftWrapColumn relays the width twice around a scrollbar
    // measurement). Only capture on the first reset of a cycle so the anchor
    // reflects the settled pre-reflow geometry rather than a half-reset,
    // not-yet-restored intermediate state.
    if (this.pendingReflowScrollAnchor) return;
    // While a freshly copied editor's layout is still settling, re-apply its
    // exact source anchor across each reflow instead of re-capturing (which
    // would drift with the transient width and placeholder height).
    this.scrollAnchorBeforeReset = this.settlingScrollAnchor || this.captureScrollAnchor();
  }

  didResetDisplayLayer() {
    this.spliceLineTopIndex(0, Infinity, Infinity);
    // Defer the restore: the reset just cleared the spatial index, so scroll
    // geometry is not yet trustworthy here. flushPendingReflowScrollAnchor
    // re-applies the anchor on the next update, once the visible rows have been
    // repopulated. Restoring synchronously here would read a bogus
    // getMaxScrollTop (the un-indexed layer reports its unwrapped height) and
    // snap a past-end viewport to the wrong place.
    if (this.scrollAnchorBeforeReset) {
      this.pendingReflowScrollAnchor = this.scrollAnchorBeforeReset;
      this.scrollAnchorBeforeReset = null;
    }
    this.scheduleUpdate();
  }

  flushPendingReflowScrollAnchor() {
    if (!this.pendingReflowScrollAnchor || !this.hasInitialMeasurements) return false;
    const anchor = this.pendingReflowScrollAnchor;
    this.pendingReflowScrollAnchor = null;
    return this.restoreScrollAnchor(anchor);
  }

  didChangeDisplayLayer(changes) {
    // An edit means the settling window is over (and the anchor's buffer
    // position may no longer point at the same content); resume normal
    // capture-on-reflow behavior.
    if (changes.length > 0) this.settlingScrollAnchor = null;
    // Screen-row changes entirely above the viewport shift every visible row by
    // the same amount. Compensate scrollTop by that delta so the visible
    // content stays put. This keeps unfocused split editors on the same buffer
    // stable while another editor inserts or removes lines above their
    // viewport. The focused editor's own edits are usually at (or below) its
    // cursor, so they don't trigger compensation and native behavior is kept.
    const firstVisibleRow = this.hasInitialMeasurements ? this.getFirstVisibleRow() : null;
    let screenRowDelta = 0;

    for (let i = 0; i < changes.length; i++) {
      const { oldRange, newRange } = changes[i];
      if (firstVisibleRow !== null && newRange.start.row < firstVisibleRow) {
        const oldRows = oldRange.end.row - oldRange.start.row;
        const newRows = newRange.end.row - newRange.start.row;
        screenRowDelta += newRows - oldRows;
      }
      this.spliceLineTopIndex(
        newRange.start.row,
        oldRange.end.row - oldRange.start.row,
        newRange.end.row - newRange.start.row,
      );
    }

    if (screenRowDelta !== 0) {
      const lineHeight = this.getLineHeight();
      if (lineHeight) this.setScrollTop(this.getScrollTop() + screenRowDelta * lineHeight);
    }

    this.scheduleUpdate();
  }

  // Records a viewport anchor in buffer coordinates that survives a soft-wrap
  // reflow. The last cursor is anchored whenever it is on-screen, regardless
  // of how the viewport last moved; otherwise the row at the vertical midpoint
  // of the viewport is anchored. `offset` is the pixel distance from the
  // viewport top to the top of the anchored row, so the row can be placed back
  // at the same visual position after re-wrapping.
  captureScrollAnchor() {
    if (!this.hasInitialMeasurements) return null;

    const { model } = this.props;
    const scrollTop = this.getScrollTop();

    let screenRow = null;
    let bufferPosition = null;
    const cursorScreenPosition = model.getCursorScreenPosition();
    const cursorRow = cursorScreenPosition.row;
    if (cursorRow >= this.getFirstVisibleRow() && cursorRow <= this.getLastVisibleRow()) {
      screenRow = cursorRow;
      // Anchor the cursor's actual buffer position, not column 0 of its
      // current wrapped screen row. After the width changes, that wrapped
      // segment may start at a different buffer column; anchoring its old
      // start would therefore preserve the wrong visual row.
      bufferPosition = model.getCursorBufferPosition();
    }
    if (screenRow === null) {
      const midpointPixel = scrollTop + this.getScrollContainerClientHeight() / 2;
      const contentBottom = this.getContentHeight();
      if (midpointPixel > contentBottom) {
        // Scrolled more than half a screen past the end (scrollPastEnd): anchor
        // the distance from the maximum scroll so the empty past-end gap below
        // the content keeps its size. This is relative to the scroll extent
        // rather than a buffer position, so it survives a reflow that wraps to a
        // different height (where a content-relative anchor drifts, since the
        // content height is only approximate for the unrendered rows).
        return {
          type: "bottom",
          bottomOffset: Math.max(0, this.getMaxScrollTop() - scrollTop),
        };
      }
      // Otherwise anchor the row at the vertical midpoint of the viewport.
      screenRow = this.rowForPixelPosition(midpointPixel);
    }

    if (bufferPosition === null) {
      bufferPosition = model.bufferPositionForScreenPosition(Point(screenRow, 0));
    }
    const rowTop = this.pixelPositionBeforeBlocksForRow(screenRow);
    return {
      type: "row",
      bufferPosition,
      offset: rowTop - scrollTop,
    };
  }

  // Returns whether the scroll position changed.
  restoreScrollAnchor(anchor) {
    if (!anchor || !this.hasInitialMeasurements) return false;

    let changed;
    if (anchor.type === "bottom") {
      // Populate the spatial index through the end of the buffer so
      // getMaxScrollTop reflects the real wrapped height rather than the
      // approximation derived from the rows indexed so far. A bottom anchor
      // means the viewport is at the very end, so this work is needed to
      // render there anyway.
      const { model } = this.props;
      model.screenPositionForBufferPosition(model.getBuffer().getEndPosition());
      this.derivedDimensionsCache = {};
      const target = this.getMaxScrollTop() - anchor.bottomOffset;
      changed = this.setScrollTop(target);
      return changed;
    }

    const screenPosition = this.props.model.screenPositionForBufferPosition(anchor.bufferPosition);
    const rowTop = this.pixelPositionBeforeBlocksForRow(screenPosition.row);
    const target = rowTop - anchor.offset;
    changed = this.setScrollTop(target);
    return changed;
  }

  didChangeSelectionRange() {
    const { model } = this.props;

    if (this.getPlatform() === "linux") {
      if (this.selectionClipboardImmediateId) {
        clearImmediate(this.selectionClipboardImmediateId);
      }

      this.selectionClipboardImmediateId = setImmediate(() => {
        this.selectionClipboardImmediateId = null;

        if (model.isDestroyed()) return;

        const selectedText = model.getSelectedText();
        if (selectedText) {
          // This uses ipcRenderer.send instead of clipboard.writeText because
          // clipboard.writeText is a sync ipcRenderer call on Linux and that
          // will slow down selections.
          electron.ipcRenderer.send("write-text-to-selection-clipboard", selectedText);
        }
      });
    }
  }

  observeBlockDecorations() {
    const { model } = this.props;
    const decorations = model.getDecorations({ type: "block" });
    for (let i = 0; i < decorations.length; i++) {
      this.addBlockDecoration(decorations[i]);
    }
  }

  addBlockDecoration(decoration, subscribeToChanges = true) {
    const marker = decoration.getMarker();
    const { item, position } = decoration.getProperties();
    const element = TextEditor.viewForItem(item);

    if (marker.isValid()) {
      const row = marker.getHeadScreenPosition().row;
      this.lineTopIndex.insertBlock(decoration, row, 0, position === "after");
      this.blockDecorationsToMeasure.add(decoration);
      this.blockDecorationsByElement.set(element, decoration);
      this.blockDecorationResizeObserver.observe(element);

      this.scheduleUpdate();
    }

    if (subscribeToChanges) {
      let wasValid = marker.isValid();

      const didUpdateDisposable = marker.bufferMarker.onDidChange(({ textChanged }) => {
        const isValid = marker.isValid();
        if (wasValid && !isValid) {
          wasValid = false;
          this.blockDecorationsToMeasure.delete(decoration);
          this.heightsByBlockDecoration.delete(decoration);
          this.blockDecorationsByElement.delete(element);
          this.blockDecorationResizeObserver.unobserve(element);
          this.lineTopIndex.removeBlock(decoration);
          this.scheduleUpdate();
        } else if (!wasValid && isValid) {
          wasValid = true;
          this.addBlockDecoration(decoration, false);
        } else if (isValid && !textChanged) {
          this.lineTopIndex.moveBlock(decoration, marker.getHeadScreenPosition().row);
          this.scheduleUpdate();
        }
      });

      const didDestroyDisposable = decoration.onDidDestroy(() => {
        didUpdateDisposable.dispose();
        didDestroyDisposable.dispose();

        if (wasValid) {
          wasValid = false;
          this.blockDecorationsToMeasure.delete(decoration);
          this.heightsByBlockDecoration.delete(decoration);
          this.blockDecorationsByElement.delete(element);
          this.blockDecorationResizeObserver.unobserve(element);
          // Removing a block above the viewport shrinks the space above it, so
          // anchor the viewport to keep the visible content from jumping (e.g.
          // clearing inline results from a package like Hydrogen). Skip while
          // the editor is being torn down, where adjusting scroll would fire
          // spurious scroll events.
          if (this.props.model.isDestroyed()) {
            this.lineTopIndex.removeBlock(decoration);
          } else {
            const anchor = this.captureScrollAnchor();
            this.lineTopIndex.removeBlock(decoration);
            this.restoreScrollAnchor(anchor);
          }
          this.scheduleUpdate();
        }
      });
    }
  }

  didResizeBlockDecorations(entries) {
    if (!this.visible) return;

    for (let i = 0; i < entries.length; i++) {
      const { target, contentRect } = entries[i];
      const decoration = this.blockDecorationsByElement.get(target);
      const previousHeight = this.heightsByBlockDecoration.get(decoration);
      if (this.element.contains(target) && contentRect.height !== previousHeight) {
        this.invalidateBlockDecorationDimensions(decoration);
      }
    }
  }

  invalidateBlockDecorationDimensions(decoration) {
    this.blockDecorationsToMeasure.add(decoration);
    this.scheduleUpdate();
  }

  spliceLineTopIndex(startRow, oldExtent, newExtent) {
    const invalidatedBlockDecorations = this.lineTopIndex.splice(startRow, oldExtent, newExtent);
    invalidatedBlockDecorations.forEach((decoration) => {
      const newPosition = decoration.getMarker().getHeadScreenPosition();
      this.lineTopIndex.moveBlock(decoration, newPosition.row);
    });
  }

  isVisible() {
    return this.element.offsetWidth > 0 || this.element.offsetHeight > 0;
  }

  getWindowInnerHeight() {
    return window.innerHeight;
  }

  getWindowInnerWidth() {
    return window.innerWidth;
  }

  getLineHeight() {
    return this.measurements.lineHeight;
  }

  getBaseCharacterWidth() {
    return this.measurements.baseCharacterWidth;
  }

  getLongestLineWidth() {
    return this.measurements.longestLineWidth;
  }

  getClientContainerHeight() {
    return this.measurements.clientContainerHeight;
  }

  getClientContainerWidth() {
    return this.measurements.clientContainerWidth;
  }

  getScrollContainerWidth() {
    if (this.props.model.getAutoWidth()) {
      return this.getScrollWidth();
    } else {
      return this.getClientContainerWidth() - this.getGutterContainerWidth();
    }
  }

  getScrollContainerHeight() {
    if (this.props.model.getAutoHeight()) {
      return this.getScrollHeight() + this.getHorizontalScrollbarHeight();
    } else {
      return this.getClientContainerHeight();
    }
  }

  getScrollContainerClientWidth() {
    return this.getScrollContainerWidth() - this.getVerticalScrollbarWidth();
  }

  getScrollContainerClientHeight() {
    return this.getScrollContainerHeight() - this.getHorizontalScrollbarHeight();
  }

  canScrollVertically() {
    const { model } = this.props;
    if (model.isMini()) return false;
    if (model.getAutoHeight()) return false;
    // Compare against getScrollHeight(), not getContentHeight(), so the
    // scroll-past-end padding counts as scrollable area. Otherwise a file
    // shorter than the viewport with scrollPastEnd enabled is scrollable
    // (getMaxScrollTop > 0) yet the scrollbar thumb stays hidden.
    return this.getScrollHeight() > this.getScrollContainerClientHeight();
  }

  canScrollHorizontally() {
    const { model } = this.props;
    if (model.isMini()) return false;
    if (model.getAutoWidth()) return false;
    if (model.isSoftWrapped()) return false;
    return this.getContentWidth() > this.getScrollContainerClientWidth();
  }

  getScrollHeight() {
    if (this.props.model.getScrollPastEnd()) {
      return (
        this.getContentHeight() +
        Math.max(
          3 * this.getLineHeight(),
          this.getScrollContainerClientHeight() - 3 * this.getLineHeight(),
        )
      );
    } else if (this.props.model.getAutoHeight()) {
      return this.getContentHeight();
    } else {
      return Math.max(this.getContentHeight(), this.getScrollContainerClientHeight());
    }
  }

  getScrollWidth() {
    const { model } = this.props;

    if (model.isSoftWrapped()) {
      return this.getScrollContainerClientWidth();
    } else if (model.getAutoWidth()) {
      return this.getContentWidth();
    } else {
      return Math.max(this.getContentWidth(), this.getScrollContainerClientWidth());
    }
  }

  getContentHeight() {
    return this.pixelPositionAfterBlocksForRow(this.props.model.getApproximateScreenLineCount());
  }

  getContentWidth() {
    return Math.ceil(this.getLongestLineWidth() + this.getBaseCharacterWidth());
  }

  getScrollContainerClientWidthInBaseCharacters() {
    return Math.floor(this.getScrollContainerClientWidth() / this.getBaseCharacterWidth());
  }

  getGutterContainerWidth() {
    return this.measurements.gutterContainerWidth;
  }

  getLineNumberGutterWidth() {
    return this.measurements.lineNumberGutterWidth;
  }

  getVerticalScrollbarWidth() {
    return this.measurements.verticalScrollbarWidth;
  }

  getHorizontalScrollbarHeight() {
    return this.measurements.horizontalScrollbarHeight;
  }

  getRowsPerTile() {
    return this.props.rowsPerTile || DEFAULT_ROWS_PER_TILE;
  }

  tileStartRowForRow(row) {
    return row - (row % this.getRowsPerTile());
  }

  getRenderedStartRow() {
    if (this.derivedDimensionsCache.renderedStartRow == null) {
      this.derivedDimensionsCache.renderedStartRow = this.tileStartRowForRow(
        this.getFirstVisibleRow(),
      );
    }

    return this.derivedDimensionsCache.renderedStartRow;
  }

  getRenderedEndRow() {
    if (this.derivedDimensionsCache.renderedEndRow == null) {
      this.derivedDimensionsCache.renderedEndRow = Math.min(
        this.props.model.getApproximateScreenLineCount(),
        this.getRenderedStartRow() + this.getVisibleTileCount() * this.getRowsPerTile(),
      );
    }

    return this.derivedDimensionsCache.renderedEndRow;
  }

  getRenderedRowCount() {
    if (this.derivedDimensionsCache.renderedRowCount == null) {
      this.derivedDimensionsCache.renderedRowCount = Math.max(
        0,
        this.getRenderedEndRow() - this.getRenderedStartRow(),
      );
    }

    return this.derivedDimensionsCache.renderedRowCount;
  }

  getRenderedTileCount() {
    if (this.derivedDimensionsCache.renderedTileCount == null) {
      this.derivedDimensionsCache.renderedTileCount = Math.ceil(
        this.getRenderedRowCount() / this.getRowsPerTile(),
      );
    }

    return this.derivedDimensionsCache.renderedTileCount;
  }

  getFirstVisibleRow() {
    if (this.derivedDimensionsCache.firstVisibleRow == null) {
      this.derivedDimensionsCache.firstVisibleRow = this.rowForPixelPosition(this.getScrollTop());
    }

    return this.derivedDimensionsCache.firstVisibleRow;
  }

  getLastVisibleRow() {
    if (this.derivedDimensionsCache.lastVisibleRow == null) {
      this.derivedDimensionsCache.lastVisibleRow = Math.min(
        this.props.model.getApproximateScreenLineCount() - 1,
        this.rowForPixelPosition(this.getScrollBottom()),
      );
    }

    return this.derivedDimensionsCache.lastVisibleRow;
  }

  // We may render more tiles than needed if some contain block decorations,
  // but keeping this calculation simple ensures the number of tiles remains
  // fixed for a given editor height, which eliminates situations where a
  // tile is repeatedly added and removed during scrolling in certain
  // combinations of editor height and line height.
  getVisibleTileCount() {
    if (this.derivedDimensionsCache.visibleTileCount == null) {
      const editorHeightInTiles =
        this.getScrollContainerHeight() / this.getLineHeight() / this.getRowsPerTile();
      this.derivedDimensionsCache.visibleTileCount = Math.ceil(editorHeightInTiles) + 1;
    }
    return this.derivedDimensionsCache.visibleTileCount;
  }

  getFirstVisibleColumn() {
    return Math.floor(this.getScrollLeft() / this.getBaseCharacterWidth());
  }

  getScrollTop() {
    this.scrollTop = Math.min(this.getMaxScrollTop(), this.scrollTop);
    return this.scrollTop;
  }

  setScrollTop(scrollTop) {
    if (Number.isNaN(scrollTop) || scrollTop == null) return false;

    scrollTop = ceilToPhysicalPixelBoundary(
      Math.max(0, Math.min(this.getMaxScrollTop(), scrollTop)),
    );
    if (scrollTop !== this.scrollTop) {
      // A scroll that doesn't originate from the animator's own frame means
      // something else took over the viewport; stop the glide where it is.
      // Value-changing sets only: the dummy scrollbar echoes the current
      // position back through here after every frame.
      if (
        this.scrollAnimator &&
        this.scrollAnimator.isAnimating() &&
        !this.scrollAnimator.applyingFrame
      ) {
        this.scrollAnimator.cancel();
      }
      this.derivedDimensionsCache = {};
      this.scrollTopPending = true;
      this.scrollTop = scrollTop;
      this.element.emitter.emit("did-change-scroll-top", scrollTop);
      return true;
    } else {
      return false;
    }
  }

  getMaxScrollTop() {
    return Math.round(Math.max(0, this.getScrollHeight() - this.getScrollContainerClientHeight()));
  }

  getScrollBottom() {
    return this.getScrollTop() + this.getScrollContainerClientHeight();
  }

  setScrollBottom(scrollBottom) {
    return this.setScrollTop(scrollBottom - this.getScrollContainerClientHeight());
  }

  getScrollLeft() {
    return this.scrollLeft;
  }

  setScrollLeft(scrollLeft) {
    if (Number.isNaN(scrollLeft) || scrollLeft == null) return false;

    scrollLeft = roundToPhysicalPixelBoundary(
      Math.max(0, Math.min(this.getMaxScrollLeft(), scrollLeft)),
    );
    if (scrollLeft !== this.scrollLeft) {
      // A scroll that doesn't originate from the animator's own frame means
      // something else took over the viewport; stop the glide where it is.
      // Value-changing sets only: the dummy scrollbar echoes the current
      // position back through here after every frame.
      if (
        this.scrollAnimator &&
        this.scrollAnimator.isAnimating() &&
        !this.scrollAnimator.applyingFrame
      ) {
        this.scrollAnimator.cancel();
      }
      this.scrollLeftPending = true;
      this.scrollLeft = scrollLeft;
      this.element.emitter.emit("did-change-scroll-left", scrollLeft);
      return true;
    } else {
      return false;
    }
  }

  getMaxScrollLeft() {
    return Math.round(Math.max(0, this.getScrollWidth() - this.getScrollContainerClientWidth()));
  }

  getScrollRight() {
    return this.getScrollLeft() + this.getScrollContainerClientWidth();
  }

  setScrollRight(scrollRight) {
    return this.setScrollLeft(scrollRight - this.getScrollContainerClientWidth());
  }

  setScrollTopRow(scrollTopRow, scheduleUpdate = true) {
    if (this.hasInitialMeasurements) {
      const didScroll = this.setScrollTop(this.pixelPositionBeforeBlocksForRow(scrollTopRow));
      if (didScroll && scheduleUpdate) {
        this.scheduleUpdate();
      }
      return didScroll;
    } else {
      this.pendingScrollTopRow = scrollTopRow;
      return false;
    }
  }

  getScrollTopRow() {
    if (this.hasInitialMeasurements) {
      return this.rowForPixelPosition(this.getScrollTop());
    } else {
      return this.pendingScrollTopRow || 0;
    }
  }

  setScrollLeftColumn(scrollLeftColumn, scheduleUpdate = true) {
    if (this.hasInitialMeasurements && this.getLongestLineWidth() != null) {
      const didScroll = this.setScrollLeft(scrollLeftColumn * this.getBaseCharacterWidth());
      if (didScroll && scheduleUpdate) {
        this.scheduleUpdate();
      }
      return didScroll;
    } else {
      this.pendingScrollLeftColumn = scrollLeftColumn;
      return false;
    }
  }

  getScrollLeftColumn() {
    if (this.hasInitialMeasurements && this.getLongestLineWidth() != null) {
      return Math.round(this.getScrollLeft() / this.getBaseCharacterWidth());
    } else {
      return this.pendingScrollLeftColumn || 0;
    }
  }

  // Ensure the spatial index is populated with rows that are currently visible
  populateVisibleRowRange(renderedStartRow) {
    const { model } = this.props;
    const previousScreenLineCount = model.getApproximateScreenLineCount();

    const renderedEndRow = renderedStartRow + this.getVisibleTileCount() * this.getRowsPerTile();
    this.props.model.displayLayer.populateSpatialIndexIfNeeded(Infinity, renderedEndRow);

    // If the approximate screen line count changes, previously-cached derived
    // dimensions could now be out of date.
    if (model.getApproximateScreenLineCount() !== previousScreenLineCount) {
      this.derivedDimensionsCache = {};
    }
  }

  populateVisibleTiles() {
    const startRow = this.getRenderedStartRow();
    const endRow = this.getRenderedEndRow();
    const freeTileIds = [];
    for (let i = 0; i < this.renderedTileStartRows.length; i++) {
      const tileStartRow = this.renderedTileStartRows[i];
      if (tileStartRow < startRow || tileStartRow >= endRow) {
        const tileId = this.idsByTileStartRow.get(tileStartRow);
        freeTileIds.push(tileId);
        this.idsByTileStartRow.delete(tileStartRow);
      }
    }

    const rowsPerTile = this.getRowsPerTile();
    this.renderedTileStartRows.length = this.getRenderedTileCount();
    for (
      let tileStartRow = startRow, i = 0;
      tileStartRow < endRow;
      tileStartRow = tileStartRow + rowsPerTile, i++
    ) {
      this.renderedTileStartRows[i] = tileStartRow;
      if (!this.idsByTileStartRow.has(tileStartRow)) {
        if (freeTileIds.length > 0) {
          this.idsByTileStartRow.set(tileStartRow, freeTileIds.shift());
        } else {
          this.idsByTileStartRow.set(tileStartRow, this.nextTileId++);
        }
      }
    }

    this.renderedTileStartRows.sort(
      (a, b) => this.idsByTileStartRow.get(a) - this.idsByTileStartRow.get(b),
    );
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

  setInputEnabled(inputEnabled) {
    this.props.model.update({ keyboardInputEnabled: inputEnabled });
  }

  isInputEnabled() {
    return !this.props.model.isReadOnly() && this.props.model.isKeyboardInputEnabled();
  }

  getHiddenInput() {
    return this.refs.cursorsAndInput.refs.hiddenInput;
  }

  getPlatform() {
    return this.props.platform || process.platform;
  }

  getChromeVersion() {
    return this.props.chromeVersion || parseInt(process.versions.chrome);
  }
};

let rangeForMeasurement;
function clientRectForRange(textNode, startIndex, endIndex) {
  rangeForMeasurement ??= document.createRange();
  rangeForMeasurement.setStart(textNode, startIndex);
  rangeForMeasurement.setEnd(textNode, endIndex);
  return rangeForMeasurement.getBoundingClientRect();
}

function clientRectsForRange(textNode, startIndex, endIndex) {
  rangeForMeasurement ??= document.createRange();
  rangeForMeasurement.setStart(textNode, startIndex);
  rangeForMeasurement.setEnd(textNode, endIndex);
  return rangeForMeasurement.getClientRects();
}

function clientRectsForTextNode(textNode, startIndex = null, endIndex = null) {
  rangeForMeasurement ??= document.createRange();
  if (startIndex === null) {
    rangeForMeasurement.setStartBefore(textNode);
  } else {
    rangeForMeasurement.setStart(textNode, startIndex);
  }
  if (endIndex === null) {
    rangeForMeasurement.setEndAfter(textNode);
  } else {
    rangeForMeasurement.setEnd(textNode, endIndex);
  }
  return rangeForMeasurement.getClientRects();
}

function boundingClientRectForTextNodes(textNodes) {
  rangeForMeasurement ??= document.createRange();
  rangeForMeasurement.setStartBefore(textNodes[0]);
  rangeForMeasurement.setEndAfter(textNodes[textNodes.length - 1]);
  return rangeForMeasurement.getBoundingClientRect();
}

// Given the `TextNodes` that make up a screen line and a starting and ending
// column on that screen line, returns the `DOMRect`s that make up that
// range.
function clientRectsForTextNodes(textNodes, startColumn, endColumn) {
  rangeForMeasurement ??= document.createRange();
  let [startTextNode, startOffset] = textNodeAndOffsetForColumn(textNodes, startColumn);
  let [endTextNode, endOffset] = textNodeAndOffsetForColumn(textNodes, endColumn);

  if (
    startTextNode === undefined ||
    endTextNode === undefined ||
    startOffset === undefined ||
    endOffset === undefined
  ) {
    return [];
  }

  rangeForMeasurement.setStart(startTextNode, startOffset);
  rangeForMeasurement.setEnd(endTextNode, endOffset);
  return consolidateClientRects(rangeForMeasurement.getClientRects());
}

// Returns whether two `DOMRect`s overlap. `epsilon` widens the comparison so
// rects separated by a sub-pixel seam still count; fonts with fractional
// glyph advances (common on Windows) produce adjacent inline boxes whose
// edges don't line up exactly.
function rectsOverlap(rectA, rectB, epsilon = 0) {
  if (rectA.right + epsilon < rectB.left) return false;
  if (rectA.left > rectB.right + epsilon) return false;
  if (rectA.top > rectB.bottom) return false;
  if (rectA.bottom < rectB.top) return false;
  return true;
}

function mergeOverlappingRects(rectA, rectB) {
  let x = Math.min(rectA.x, rectB.x);
  let y = Math.min(rectA.top, rectB.top);
  let left = Math.min(rectA.left, rectB.left);
  let right = Math.max(rectA.right, rectB.right);
  let width = right - left;
  let top = Math.min(rectA.top, rectB.top);
  let bottom = Math.max(rectA.bottom, rectB.bottom);
  let height = bottom - top;

  return { x, y, left, right, width, top, bottom, height };
}

// Given any number of `DOMRect`s that might overlap, consolidate them into
// a discrete number of `DOMRect`s that do not overlap. Rects within a pixel
// of one another are treated as contiguous so sub-pixel seams between inline
// boxes don't split a highlight; genuinely separate runs (e.g. RTL segments)
// sit much further apart.
function consolidateClientRects(clientRects) {
  let results = [];
  for (let i = 0; i < clientRects.length; i++) {
    let rect = clientRects[i];
    let previousRect = results[results.length - 1];
    if (previousRect && rectsOverlap(previousRect, rect, 1)) {
      results[results.length - 1] = mergeOverlappingRects(previousRect, rect);
    } else {
      results.push(rect);
    }
  }
  return results;
}

// Given the `TextNode`s that make up a line and a column offset, returns the
// correct `TextNode` and its internal offset suitable for bringing into
// `Range::setStart` or `Range::setEnd`.
function textNodeAndOffsetForColumn(textNodes, column) {
  let prev = 0;
  if (column === 0) return [textNodes[0], 0];

  for (let node of textNodes) {
    if (prev + node.length >= column) {
      return [node, column - prev];
    }
    // Not in this text node.
    prev += node.length;
  }
  return [undefined, undefined];
}

// Reverses the logic above; given a text node and an offset (and a collection
// of text nodes for a given line), figures out the correct column.
function columnForTextNodeAndOffset(activeTextNode, offset, allTextNodes) {
  if (allTextNodes.length === 1 && activeTextNode === allTextNodes[0]) return offset;

  let delta = 0;
  for (let i = 0; i < allTextNodes.length; i++) {
    if (allTextNodes[i] === activeTextNode) {
      return delta + offset;
    }
    delta += allTextNodes[i].length;
  }
  return -1;
}

// Given two `DOMRect`s, returns a `DOMRect`ish object that adjusts the
// coordinates of the first to be relative to the second.
function rectRelativeToOrigin(rect, origin) {
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
    bottom: rect.bottom - origin.top,
    right: rect.right - origin.left,
  };
}

function constrainRangeToRows(range, startRow, endRow) {
  if (range.start.row < startRow || range.end.row >= endRow) {
    range = range.copy();
    if (range.start.row < startRow) {
      range.start.row = startRow;
      range.start.column = 0;
    }
    if (range.end.row >= endRow) {
      range.end.row = endRow;
      range.end.column = 0;
    }
  }
  return range;
}

function debounce(fn, wait) {
  let timestamp, timeout;

  function later() {
    const last = Date.now() - timestamp;
    if (last < wait && last >= 0) {
      timeout = setTimeout(later, wait - last);
    } else {
      timeout = null;
      fn();
    }
  }

  return function () {
    timestamp = Date.now();
    if (!timeout) timeout = setTimeout(later, wait);
  };
}
