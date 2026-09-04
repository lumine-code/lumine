const _ = require("@lumine-code/underscore-plus");
const path = require("path");
const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable, Disposable, Emitter } = require("@lumine-code/event-kit");
const TextBuffer = require("./text-buffer");
const { Point, Range } = TextBuffer;
const DecorationManager = require("./decoration-manager");
const Cursor = require("./cursor");
const Selection = require("./selection");
const NullGrammar = require("./null-grammar");
const ScopeDescriptor = require("./scope-descriptor");
const FileState = require("./file-state");
const { selectorMatchesAnyScope } = require("./selectors");

const GutterContainer = require("./gutter-container");
let TextEditorComponent = null;
let TextEditorElement = null;
const {
  isDoubleWidthCharacter,
  isHalfWidthCharacter,
  isKoreanCharacter,
  isWrapBoundary,
} = require("./text-utils");

const SERIALIZATION_VERSION = 1;

function isPromise(value) {
  return value != null && typeof value.then === "function";
}
const NON_WHITESPACE_REGEXP = /\S/;
const ZERO_WIDTH_NBSP = "\ufeff";
let nextId = 0;

const DEFAULT_NON_WORD_CHARACTERS = "/\\()\"':,.;<>~!@#$%^&*|+=[]{}`?-…";

function runCancellableGrammarOperation(editor, languageMode, signal, cancelledValue, operation) {
  if (editor.isDestroyed() || signal?.aborted || editor.buffer.getLanguageMode() !== languageMode) {
    return Promise.resolve(cancelledValue);
  }

  return new Promise((resolve, reject) => {
    let completed = false;
    const subscriptions = new CompositeDisposable();
    const cleanup = () => {
      subscriptions.dispose();
      signal?.removeEventListener?.("abort", cancel);
    };
    const finish = (callback) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };
    const complete = (value) => finish(() => resolve(value));
    const fail = (error) => finish(() => reject(error));
    const cancel = () => complete(cancelledValue);
    const isCurrent = () =>
      !editor.isDestroyed() && !signal?.aborted && editor.buffer.getLanguageMode() === languageMode;

    subscriptions.add(editor.onDidDestroy(cancel));
    subscriptions.add(
      editor.buffer.onDidChangeLanguageMode((newLanguageMode) => {
        if (newLanguageMode !== languageMode) cancel();
      }),
    );
    signal?.addEventListener?.("abort", cancel, { once: true });
    if (!isCurrent()) {
      cancel();
      return;
    }

    let result;
    try {
      result = operation();
    } catch (error) {
      if (isCurrent()) fail(error);
      else cancel();
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        if (isCurrent()) complete(value);
        else cancel();
      },
      (error) => {
        if (isCurrent()) fail(error);
        else cancel();
      },
    );
  });
}

/**
 * @public
 * @status essential
 *
 * This class represents all essential editing state for a single
 * {@link TextBuffer}, including cursor and selection positions, folds, and soft wraps.
 * If you're manipulating the state of an editor, use this class.
 *
 * A single {@link TextBuffer} can belong to multiple editors. For example, if the
 * same file is open in two different panes, Lumine creates a separate editor for
 * each pane. If the buffer is manipulated the changes are reflected in both
 * editors, but each maintains its own cursor position, folded lines, etc.
 *
 * ## Accessing TextEditor Instances
 *
 * The easiest way to get hold of `TextEditor` objects is by registering a callback
 * with `::observeTextEditors` on the `lumine.workspace` global. Your callback will
 * then be called with all current editor instances and also when any editor is
 * created in the future.
 *
 * ```js
 * lumine.workspace.observeTextEditors(editor => {
 *   editor.insertText('Hello World')
 * })
 * ```
 *
 * ## Buffer vs. Screen Coordinates
 *
 * Because editors support folds and soft-wrapping, the lines on screen don't
 * always match the lines in the buffer. For example, a long line that soft wraps
 * twice renders as three lines on screen, but only represents one line in the
 * buffer. Similarly, if rows 5-10 are folded, then row 6 on screen corresponds
 * to row 11 in the buffer.
 *
 * Your choice of coordinates systems will depend on what you're trying to
 * achieve. For example, if you're writing a command that jumps the cursor up or
 * down by 10 lines, you'll want to use screen coordinates because the user
 * probably wants to skip lines *on screen*. However, if you're writing a package
 * that jumps between method definitions, you'll want to work in buffer
 * coordinates.
 *
 * **When in doubt, just default to buffer coordinates**, then experiment with
 * soft wraps and folds to ensure your code interacts with them correctly.
 */
module.exports = class TextEditor {
  static setClipboard(clipboard) {
    this.clipboard = clipboard;
  }

  static setPasteProviderRegistry(pasteProviderRegistry) {
    this.pasteProviderRegistry = pasteProviderRegistry;
  }

  static setScheduler(scheduler) {
    if (TextEditorComponent == null) {
      TextEditorComponent = require("./text-editor-component");
    }
    return TextEditorComponent.setScheduler(scheduler);
  }

  static didUpdateStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require("./text-editor-component");
    }
    return TextEditorComponent.didUpdateStyles();
  }

  static didUpdateScrollbarStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require("./text-editor-component");
    }
    return TextEditorComponent.didUpdateScrollbarStyles();
  }

  static viewForItem(item) {
    return item.element || item;
  }

  static deserialize(state, lumineEnvironment) {
    if (state.version !== SERIALIZATION_VERSION) return null;
    if (state.bufferId == null) return null;

    const bufferId = state.bufferId;

    try {
      state.buffer = lumineEnvironment.project.bufferForIdSync(bufferId);
      if (!state.buffer) return null;
    } catch (error) {
      if (error.syscall === "read") {
        return; // Error reading the file, don't deserialize an editor for it
      } else {
        throw error;
      }
    }

    state.assert = lumineEnvironment.assert.bind(lumineEnvironment);

    // Semantics of the readOnly flag have changed since its introduction.
    // Only respect readOnly2, which has been set with the current readOnly semantics.
    delete state.readOnly;
    state.readOnly = state.readOnly2;
    delete state.readOnly2;

    // Indent guides moved from the editor core to the indent-guide package.
    delete state.showIndentGuide;

    const editor = new TextEditor(state);
    if (state.registered) {
      // `registered` serializes the registry role; older states stored `true`.
      const role = state.registered === true ? "document" : state.registered;
      const disposable = lumineEnvironment.textEditors.add(editor, { role });
      editor.onDidDestroy(() => disposable.dispose());
    }
    return editor;
  }

  constructor(params = {}) {
    if (this.constructor.clipboard == null) {
      throw new Error(
        "Must call TextEditor.setClipboard at least once before creating TextEditor instances",
      );
    }

    this.id = params.id != null ? params.id : nextId++;
    if (this.id >= nextId) {
      // Ensure that new editors get unique ids:
      nextId = this.id + 1;
    }
    this.initialScrollTopRow = params.initialScrollTopRow;
    this.initialScrollLeftColumn = params.initialScrollLeftColumn;
    this.initialScrollAnchor = params.initialScrollAnchor;
    this.decorationManager = params.decorationManager;
    this.selectionsMarkerLayer = params.selectionsMarkerLayer;
    this.mini = params.mini != null ? params.mini : false;
    this.keyboardInputEnabled =
      params.keyboardInputEnabled != null ? params.keyboardInputEnabled : true;
    this.readOnly = params.readOnly != null ? params.readOnly : false;
    this.placeholderText = params.placeholderText;
    this.showLineNumbers = params.showLineNumbers;
    this.assert = params.assert || ((condition) => condition);
    this.showInvisibles = params.showInvisibles != null ? params.showInvisibles : true;
    this.autoHeight = params.autoHeight;
    this.autoWidth = params.autoWidth;
    this.scrollPastEnd = params.scrollPastEnd != null ? params.scrollPastEnd : false;
    this.scrollSensitivity = params.scrollSensitivity != null ? params.scrollSensitivity : 40;
    // Raw default is false so directly-constructed editors (specs, embedders)
    // scroll instantly; the config default of true reaches workspace editors
    // via the TextEditorRegistry.
    // null means "not managed": editors that no TextEditorRegistry configures
    // (for example editors embedded in package views) follow the global
    // smooth-scrolling settings instead of silently disabling the feature.
    this.smoothScrolling = params.smoothScrolling != null ? params.smoothScrolling : null;
    this.wheelSmoothness = params.wheelSmoothness != null ? params.wheelSmoothness : null;
    this.commandSmoothness = params.commandSmoothness != null ? params.commandSmoothness : null;
    this.altWheelMultiplier = params.altWheelMultiplier != null ? params.altWheelMultiplier : 7.5;
    this.scrollCommandDistance =
      params.scrollCommandDistance != null ? params.scrollCommandDistance : 1;
    this.softWrapDebounceInterval =
      params.softWrapDebounceInterval != null ? params.softWrapDebounceInterval : 0;
    this.editorWidthInChars = params.editorWidthInChars;
    this.invisibles = params.invisibles;
    this.softWrapped = params.softWrapped;
    this.softWrapAtPreferredLineLength = params.softWrapAtPreferredLineLength;
    this.preferredLineLength = params.preferredLineLength;
    this.maxScreenLineLength = params.maxScreenLineLength;
    this.softTabs = params.softTabs != null ? params.softTabs : true;
    this.autoIndent = params.autoIndent != null ? params.autoIndent : true;
    this.autoIndentOnPaste = params.autoIndentOnPaste != null ? params.autoIndentOnPaste : true;
    this.undoGroupingInterval =
      params.undoGroupingInterval != null ? params.undoGroupingInterval : 300;
    this.softWrapped = params.softWrapped != null ? params.softWrapped : false;
    this.softWrapAtPreferredLineLength =
      params.softWrapAtPreferredLineLength != null ? params.softWrapAtPreferredLineLength : false;
    this.preferredLineLength = params.preferredLineLength != null ? params.preferredLineLength : 80;
    this.maxScreenLineLength =
      params.maxScreenLineLength != null ? params.maxScreenLineLength : 500;
    this.showLineNumbers = params.showLineNumbers != null ? params.showLineNumbers : true;
    this.overtypeMode = params.overtypeMode != null ? params.overtypeMode : false;
    const { tabLength = 2 } = params;

    this.alive = true;
    this.doBackgroundWork = this.doBackgroundWork.bind(this);
    this.serializationVersion = 1;
    this.suppressSelectionMerging = false;
    this.selectionFlashDuration = 500;
    this.gutterContainer = null;
    this.verticalScrollMargin = 2;
    this.horizontalScrollMargin = 6;
    this.lineHeightInPixels = null;
    this.defaultCharWidth = null;
    this.height = null;
    this.width = null;
    this.registered = false;
    this.atomicSoftTabs = true;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.cursors = [];
    this.cursorsByMarkerId = new Map();
    this.selections = [];
    this.batchedSelectionRemovals = null;
    this.hasTerminatedPendingState = false;

    if (params.buffer) {
      this.buffer = params.buffer;
    } else {
      this.buffer = new TextBuffer();
    }

    const languageMode = this.buffer.getLanguageMode();
    this.languageModeSubscription =
      languageMode.onDidTokenize &&
      languageMode.onDidTokenize(() => {
        this.emitter.emit("did-tokenize");
      });
    if (this.languageModeSubscription) this.disposables.add(this.languageModeSubscription);

    if (params.displayLayer) {
      this.displayLayer = params.displayLayer;
    } else {
      const displayLayerParams = {
        invisibles: this.getInvisibles(),
        softWrapColumn: this.getSoftWrapColumn(),
        atomicSoftTabs: params.atomicSoftTabs != null ? params.atomicSoftTabs : true,
        tabLength,
        ratioForCharacter: this.ratioForCharacter.bind(this),
        isWrapBoundary,
        foldCharacter: ZERO_WIDTH_NBSP,
        softWrapHangingIndent:
          params.softWrapHangingIndentLength != null ? params.softWrapHangingIndentLength : 0,
      };

      this.displayLayer = this.buffer.getDisplayLayer(params.displayLayerId);
      if (this.displayLayer) {
        this.displayLayer.reset(displayLayerParams);
        this.selectionsMarkerLayer = this.displayLayer.getMarkerLayer(
          params.selectionsMarkerLayerId,
        );
      } else {
        this.displayLayer = this.buffer.addDisplayLayer(displayLayerParams);
      }
    }

    this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    this.disposables.add(
      new Disposable(() => {
        if (this.backgroundWorkHandle != null) return cancelIdleCallback(this.backgroundWorkHandle);
      }),
    );

    this.defaultMarkerLayer = this.displayLayer.addMarkerLayer();
    if (!this.selectionsMarkerLayer) {
      this.selectionsMarkerLayer = this.addMarkerLayer({
        maintainHistory: true,
        persistent: true,
        role: "selections",
      });
    }

    this.decorationManager = new DecorationManager(this);
    this.decorateMarkerLayer(this.selectionsMarkerLayer, { type: "cursor" });
    if (!this.isMini()) this.decorateCursorLine();

    this.decorateMarkerLayer(this.displayLayer.foldsMarkerLayer, {
      type: "line-number",
      class: "folded",
    });

    for (let marker of this.selectionsMarkerLayer.getMarkers()) {
      this.addSelection(marker);
    }

    this.subscribeToBuffer();
    this.subscribeToDisplayLayer();

    if (this.cursors.length === 0 && !params.suppressCursorCreation) {
      const initialLine = Math.max(parseInt(params.initialLine) || 0, 0);
      const initialColumn = Math.max(parseInt(params.initialColumn) || 0, 0);
      this.addCursorAtBufferPosition([initialLine, initialColumn]);
    }

    this.gutterContainer = new GutterContainer(this);
    this.lineNumberGutter = this.gutterContainer.addGutter({
      name: "line-number",
      type: "line-number",
      priority: 0,
      visible: params.lineNumberGutterVisible,
    });
  }

  get element() {
    return this.getElement();
  }

  get languageMode() {
    return this.buffer.getLanguageMode();
  }

  get rowsPerPage() {
    return this.getRowsPerPage();
  }

  // The gutter is deliberately not colored by the cursor or the selection. Both
  // are already on screen in the text itself, and every way of marking them on
  // the line number competed with the theme's own gutter colors instead of
  // adding to them.
  decorateCursorLine() {
    this.cursorLineDecorations = [
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: "line",
        class: "cursor-line",
        onlyEmpty: true,
      }),
    ];
  }

  doBackgroundWork(deadline) {
    const previousLongestRow = this.getApproximateLongestScreenRow();
    if (this.displayLayer.doBackgroundWork(deadline)) {
      this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    } else {
      this.backgroundWorkHandle = null;
    }

    if (this.component && this.getApproximateLongestScreenRow() !== previousLongestRow) {
      this.component.scheduleUpdate();
    }
  }

  update(params) {
    const displayLayerParams = {};

    for (let param of Object.keys(params)) {
      const value = params[param];

      switch (param) {
        case "autoIndent":
          this.updateAutoIndent(value, false);
          break;

        case "autoIndentOnPaste":
          this.updateAutoIndentOnPaste(value, false);
          break;

        case "undoGroupingInterval":
          this.updateUndoGroupingInterval(value, false);
          break;

        case "scrollSensitivity":
          this.updateScrollSensitivity(value, false);
          break;

        case "smoothScrolling":
          this.updateSmoothScrolling(value, false);
          break;

        case "wheelSmoothness":
          this.updateWheelSmoothness(value, false);
          break;

        case "commandSmoothness":
          this.updateCommandSmoothness(value, false);
          break;

        case "altWheelMultiplier":
          this.updateAltWheelMultiplier(value, false);
          break;

        case "scrollCommandDistance":
          this.updateScrollCommandDistance(value, false);
          break;

        case "softWrapDebounceInterval":
          this.updateSoftWrapDebounceInterval(value, false);
          break;

        case "encoding":
          this.updateEncoding(value, false);
          break;

        case "softTabs":
          this.updateSoftTabs(value, false);
          break;

        case "atomicSoftTabs":
          this.updateAtomicSoftTabs(value, false, displayLayerParams);
          break;

        case "tabLength":
          this.updateTabLength(value, false, displayLayerParams);
          break;

        case "softWrapped":
          this.updateSoftWrapped(value, false, displayLayerParams);
          break;

        case "softWrapHangingIndentLength":
          this.updateSoftWrapHangingIndentLength(value, false, displayLayerParams);
          break;

        case "softWrapAtPreferredLineLength":
          this.updateSoftWrapAtPreferredLineLength(value, false, displayLayerParams);
          break;

        case "preferredLineLength":
          this.updatePreferredLineLength(value, false, displayLayerParams);
          break;

        case "maxScreenLineLength":
          this.updateMaxScreenLineLength(value, false, displayLayerParams);
          break;

        case "mini":
          this.updateMini(value, false, displayLayerParams);
          break;

        case "readOnly":
          this.updateReadOnly(value, false);
          break;

        case "keyboardInputEnabled":
          this.updateKeyboardInputEnabled(value, false);
          break;

        case "placeholderText":
          this.updatePlaceholderText(value, false);
          break;

        case "lineNumberGutterVisible":
          this.updateLineNumberGutterVisible(value, false);
          break;

        case "showLineNumbers":
          this.updateShowLineNumbers(value, false);
          break;

        case "showInvisibles":
          this.updateShowInvisibles(value, false, displayLayerParams);
          break;

        case "invisibles":
          this.updateInvisibles(value, false, displayLayerParams);
          break;

        case "editorWidthInChars":
          this.updateEditorWidthInChars(value, false, displayLayerParams);
          break;

        case "width":
          this.updateWidth(value, false, displayLayerParams);
          break;

        case "scrollPastEnd":
          this.updateScrollPastEnd(value, false);
          break;

        case "autoHeight":
          this.updateAutoHight(value, false);
          break;

        case "autoWidth":
          this.updateAutoWidth(value, false);
          break;

        default:
          if (param !== "ref" && param !== "key") {
            throw new TypeError(`Invalid TextEditor parameter: '${param}'`);
          }
      }
    }

    return this.finishUpdate(displayLayerParams);
  }

  finishUpdate(displayLayerParams = {}) {
    // Capture a visual scroll anchor before the display layer resets its
    // screen-row geometry (e.g. soft-wrap toggle, tab width, or a width-driven
    // rewrap during resize). The component restores it in didResetDisplayLayer
    // once the new geometry is in place, so the viewport stays visually stable.
    if (this.component) this.component.willResetDisplayLayer();
    this.displayLayer.reset(displayLayerParams);

    if (this.component) {
      return this.component.getNextUpdatePromise();
    } else {
      return Promise.resolve();
    }
  }

  updateAutoIndent(value, finish) {
    this.autoIndent = value;
    if (finish) this.finishUpdate();
  }

  updateAutoIndentOnPaste(value, finish) {
    this.autoIndentOnPaste = value;
    if (finish) this.finishUpdate();
  }

  updateUndoGroupingInterval(value, finish) {
    this.undoGroupingInterval = value;
    if (finish) this.finishUpdate();
  }

  updateScrollSensitivity(value, finish) {
    this.scrollSensitivity = value;
    if (finish) this.finishUpdate();
  }

  updateSmoothScrolling(value, finish) {
    this.smoothScrolling = value;
    if (finish) this.finishUpdate();
  }

  updateWheelSmoothness(value, finish) {
    this.wheelSmoothness = value;
    if (finish) this.finishUpdate();
  }

  updateCommandSmoothness(value, finish) {
    this.commandSmoothness = value;
    if (finish) this.finishUpdate();
  }

  updateAltWheelMultiplier(value, finish) {
    this.altWheelMultiplier = value;
    if (finish) this.finishUpdate();
  }

  updateScrollCommandDistance(value, finish) {
    this.scrollCommandDistance = value;
    if (finish) this.finishUpdate();
  }

  updateSoftWrapDebounceInterval(value, finish) {
    this.softWrapDebounceInterval = value;
    if (finish) this.finishUpdate();
  }

  updateEncoding(value, finish) {
    this.buffer.setEncoding(value);
    if (finish) this.finishUpdate();
  }

  updateSoftTabs(value, finish) {
    if (value !== this.softTabs) {
      this.softTabs = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAtomicSoftTabs(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.atomicSoftTabs) {
      displayLayerParams.atomicSoftTabs = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateTabLength(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.displayLayer.tabLength) {
      displayLayerParams.tabLength = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapped(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapped) {
      this.softWrapped = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      this.emitter.emit("did-change-soft-wrapped", this.isSoftWrapped());
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapHangingIndentLength(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.softWrapHangingIndent) {
      displayLayerParams.softWrapHangingIndent = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapAtPreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapAtPreferredLineLength) {
      this.softWrapAtPreferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updatePreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.preferredLineLength) {
      this.preferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMaxScreenLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.maxScreenLineLength) {
      this.maxScreenLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMini(value, finish, displayLayerParams = {}) {
    if (value !== this.mini) {
      this.mini = value;
      this.emitter.emit("did-change-mini", value);
      displayLayerParams.invisibles = this.getInvisibles();
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      if (this.mini) {
        for (let decoration of this.cursorLineDecorations) {
          decoration.destroy();
        }
        this.cursorLineDecorations = null;
      } else {
        this.decorateCursorLine();
      }
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateReadOnly(value, finish) {
    if (value !== this.readOnly) {
      this.readOnly = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateKeyboardInputEnabled(value, finish) {
    if (value !== this.keyboardInputEnabled) {
      this.keyboardInputEnabled = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updatePlaceholderText(value, finish) {
    if (value !== this.placeholderText) {
      this.placeholderText = value;
      this.emitter.emit("did-change-placeholder-text", value);
    }
    if (finish) this.finishUpdate();
  }

  updateLineNumberGutterVisible(value, finish) {
    if (value !== this.lineNumberGutterVisible) {
      if (value) {
        this.lineNumberGutter.show();
      } else {
        this.lineNumberGutter.hide();
      }
      this.emitter.emit("did-change-line-number-gutter-visible", this.lineNumberGutter.isVisible());
    }
    if (finish) this.finishUpdate();
  }

  updateShowLineNumbers(value, finish) {
    if (value !== this.showLineNumbers) {
      this.showLineNumbers = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateShowInvisibles(value, finish, displayLayerParams = {}) {
    if (value !== this.showInvisibles) {
      this.showInvisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateInvisibles(value, finish, displayLayerParams = {}) {
    if (!_.isEqual(value, this.invisibles)) {
      this.invisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateEditorWidthInChars(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.editorWidthInChars) {
      this.editorWidthInChars = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateWidth(value, finish, displayLayerParams = {}) {
    if (value !== this.width) {
      this.width = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateScrollPastEnd(value, finish) {
    if (value !== this.scrollPastEnd) {
      this.scrollPastEnd = value;
      if (this.component) this.component.scheduleUpdate();
    }
    if (finish) this.finishUpdate();
  }

  updateAutoHight(value, finish) {
    if (value !== this.autoHeight) {
      this.autoHeight = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAutoWidth(value, finish) {
    if (value !== this.autoWidth) {
      this.autoWidth = value;
    }
    if (finish) this.finishUpdate();
  }

  scheduleComponentUpdate() {
    if (this.component) this.component.scheduleUpdate();
  }

  serialize() {
    return {
      deserializer: "TextEditor",
      version: SERIALIZATION_VERSION,

      displayLayerId: this.displayLayer.id,
      selectionsMarkerLayerId: this.selectionsMarkerLayer.id,

      initialScrollTopRow: this.getScrollTopRow(),
      initialScrollLeftColumn: this.getScrollLeftColumn(),

      tabLength: this.displayLayer.tabLength,
      atomicSoftTabs: this.displayLayer.atomicSoftTabs,
      softWrapHangingIndentLength: this.displayLayer.softWrapHangingIndent,

      id: this.id,
      bufferId: this.buffer.id,
      softTabs: this.softTabs,
      softWrapped: this.softWrapped,
      softWrapAtPreferredLineLength: this.softWrapAtPreferredLineLength,
      preferredLineLength: this.preferredLineLength,
      mini: this.mini,
      readOnly2: this.readOnly, // readOnly encompassed both readOnly and keyboardInputEnabled
      keyboardInputEnabled: this.keyboardInputEnabled,
      editorWidthInChars: this.editorWidthInChars,
      width: this.width,
      maxScreenLineLength: this.maxScreenLineLength,
      registered: this.registered,
      invisibles: this.invisibles,
      showInvisibles: this.showInvisibles,
      autoHeight: this.autoHeight,
      autoWidth: this.autoWidth,
    };
  }

  subscribeToBuffer() {
    this.buffer.retain();
    this.disposables.add(
      this.buffer.onDidChangeLanguageMode(this.handleLanguageModeChange.bind(this)),
    );
    this.disposables.add(
      this.buffer.onDidChangePath(() => {
        this.emitter.emit("did-change-title", this.getTitle());
        this.emitter.emit("did-change-path", this.getPath());
      }),
    );
    this.disposables.add(
      this.buffer.onDidChangeEncoding(() => {
        this.emitter.emit("did-change-encoding", this.getEncoding());
      }),
    );
    this.disposables.add(this.buffer.onDidDestroy(() => this.destroy()));
    this.disposables.add(
      this.buffer.onDidChangeFileState((fileState) => {
        if (!this.hasTerminatedPendingState && fileState !== FileState.UNMODIFIED)
          this.terminatePendingState();
      }),
    );
  }

  terminatePendingState() {
    if (!this.hasTerminatedPendingState) this.emitter.emit("did-terminate-pending-state");
    this.hasTerminatedPendingState = true;
  }

  onDidTerminatePendingState(callback) {
    return this.emitter.on("did-terminate-pending-state", callback);
  }

  subscribeToDisplayLayer() {
    this.disposables.add(
      this.displayLayer.onDidChange((changes) => {
        this.mergeIntersectingSelections();
        if (this.component) this.component.didChangeDisplayLayer(changes);
        this.emitter.emit(
          "did-change",
          changes.map((change) => new ChangeEvent(change)),
        );
      }),
    );
    this.disposables.add(
      this.displayLayer.onDidReset(() => {
        this.mergeIntersectingSelections();
        if (this.component) this.component.didResetDisplayLayer();
        this.emitter.emit("did-change", {});
      }),
    );
    this.disposables.add(
      this.selectionsMarkerLayer.onDidCreateMarker(this.addSelection.bind(this)),
    );
    return this.disposables.add(
      this.selectionsMarkerLayer.onDidUpdate(() =>
        this.component != null ? this.component.didUpdateSelections() : undefined,
      ),
    );
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.disposables.dispose();
    this.displayLayer.destroy();
    for (let selection of this.selections.slice()) {
      selection.destroy();
    }
    this.buffer.release();
    this.gutterContainer.destroy();
    this.emitter.emit("did-destroy");
    this.emitter.clear();
    if (this.component) this.component.element.component = null;
    this.component = null;
    this.lineNumberGutter.element = null;
  }

  isAlive() {
    return this.alive;
  }

  isDestroyed() {
    return !this.alive;
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status essential
   *
   * Calls your `callback` when the buffer's title has changed.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Calls your `callback` when the buffer's path, and therefore title, has changed.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangePath(callback) {
    return this.emitter.on("did-change-path", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback synchronously when the content of the
   * buffer changes.
   *
   * Because observers are invoked synchronously, it's important not to perform
   * any expensive operations via this method. Consider {@link #onDidStopChanging} to
   * delay expensive operations until after changes stop occurring.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke `callback` when the buffer's contents change. It is
   * emit asynchronously 300ms after the last buffer change. This is a good place
   * to handle changes to the buffer without compromising typing performance.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidStopChanging(callback) {
    return this.getBuffer().onDidStopChanging(callback);
  }

  /**
   * @public
   * @status essential
   *
   * Calls your `callback` when a {@link Cursor} is moved. If there are
   * multiple cursors, your callback will be called for each cursor.
   *
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {Point} callback.event.oldBufferPosition
   * @param {Point} callback.event.oldScreenPosition
   * @param {Point} callback.event.newBufferPosition
   * @param {Point} callback.event.newScreenPosition
   * @param {Boolean} callback.event.textChanged
   * @param {Cursor} callback.event.cursor - that triggered the event
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeCursorPosition(callback) {
    return this.emitter.on("did-change-cursor-position", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Calls your `callback` when a selection's screen range changes.
   *
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {Range} callback.event.oldBufferRange
   * @param {Range} callback.event.oldScreenRange
   * @param {Range} callback.event.newBufferRange
   * @param {Range} callback.event.newScreenRange
   * @param {Selection} callback.event.selection - that triggered the event
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeSelectionRange(callback) {
    return this.emitter.on("did-change-selection-range", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when soft wrap was enabled or disabled.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeSoftWrapped(callback) {
    return this.emitter.on("did-change-soft-wrapped", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when overtype (overwrite) mode is enabled or
   * disabled for this editor.
   *
   * @param {Function} callback
   * @param {Boolean} callback.overtypeMode - indicating the new state.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeOvertypeMode(callback) {
    return this.emitter.on("did-change-overtype-mode", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when the buffer's encoding has changed.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeEncoding(callback) {
    return this.emitter.on("did-change-encoding", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when the grammar that interprets and
   * colorizes the text has been changed. Immediately calls your callback with
   * the current grammar.
   *
   * @param {Function} callback
   * @param {TreeSitterGrammar|Object} callback.grammar - A Tree-sitter grammar or the null grammar sentinel.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeGrammar(callback) {
    callback(this.getGrammar());
    return this.onDidChangeGrammar(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when the grammar that interprets and
   * colorizes the text has been changed.
   *
   * @param {Function} callback
   * @param {TreeSitterGrammar|Object} callback.grammar - A Tree-sitter grammar or the null grammar sentinel.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeGrammar(callback) {
    return this.buffer.onDidChangeLanguageMode(() => {
      callback(this.buffer.getLanguageMode().grammar);
    });
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when the value of {@link #getFileState} changes.
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeFileState(callback) {
    return this.getBuffer().onDidChangeFileState(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` before text has been inserted.
   *
   * @param {Function} callback
   * @param callback.event - event `Object`
   * @param {String} callback.event.text - text to be inserted
   * @param {Function} callback.event.cancel - Call to prevent the text from being inserted
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onWillInsertText(callback) {
    return this.emitter.on("will-insert-text", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` after text has been inserted.
   *
   * @param {Function} callback
   * @param callback.event - event `Object`
   * @param {String} callback.event.text - text to be inserted
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidInsertText(callback) {
    return this.emitter.on("did-insert-text", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback after the buffer is saved to disk.
   *
   * @param {Function} callback - to be called after the buffer is saved.
   * @param {Object} callback.event - with the following keys:
   * @param callback.event.path - The path to which the buffer was saved.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidSave(callback) {
    return this.getBuffer().onDidSave(callback);
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the given callback when the editor is destroyed.
   *
   * @param {Function} callback - to be called when the editor is destroyed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Cursor} is added to the editor.
   * Immediately calls your callback for each existing cursor.
   *
   * @param {Function} callback
   * @param {Cursor} callback.cursor - that was added
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeCursors(callback) {
    this.getCursors().forEach(callback);
    return this.onDidAddCursor(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Cursor} is added to the editor.
   *
   * @param {Function} callback
   * @param {Cursor} callback.cursor - that was added
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddCursor(callback) {
    return this.emitter.on("did-add-cursor", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Cursor} is removed from the editor.
   *
   * @param {Function} callback
   * @param {Cursor} callback.cursor - that was removed
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidRemoveCursor(callback) {
    return this.emitter.on("did-remove-cursor", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Selection} is added to the editor.
   * Immediately calls your callback for each existing selection.
   *
   * @param {Function} callback
   * @param {Selection} callback.selection - that was added
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeSelections(callback) {
    this.getSelections().forEach(callback);
    return this.onDidAddSelection(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Selection} is added to the editor.
   *
   * @param {Function} callback
   * @param {Selection} callback.selection - that was added
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddSelection(callback) {
    return this.emitter.on("did-add-selection", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Selection} is removed from the editor.
   *
   * @param {Function} callback
   * @param {Selection} callback.selection - that was removed
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidRemoveSelection(callback) {
    return this.emitter.on("did-remove-selection", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` with each {@link Decoration} added to the editor.
   * Calls your `callback` immediately for any existing decorations.
   *
   * @param {Function} callback
   * @param {Decoration} callback.decoration
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeDecorations(callback) {
    return this.decorationManager.observeDecorations(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Decoration} is added to the editor.
   *
   * @param {Function} callback
   * @param {Decoration} callback.decoration - that was added
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddDecoration(callback) {
    return this.decorationManager.onDidAddDecoration(callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when a {@link Decoration} is removed from the editor.
   *
   * @param {Function} callback
   * @param {Decoration} callback.decoration - that was removed
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidRemoveDecoration(callback) {
    return this.decorationManager.onDidRemoveDecoration(callback);
  }

  // Called by DecorationManager when a decoration is added.
  didAddDecoration(decoration) {
    if (this.component && decoration.isType("block")) {
      this.component.addBlockDecoration(decoration);
    }
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when the placeholder text is changed.
   *
   * @param {Function} callback
   * @param {String} callback.placeholderText - new text
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangePlaceholderText(callback) {
    return this.emitter.on("did-change-placeholder-text", callback);
  }

  onDidRequestAutoscroll(callback) {
    return this.emitter.on("did-request-autoscroll", callback);
  }

  onDidChangeIcon(callback) {
    return this.emitter.on("did-change-icon", callback);
  }

  onDidUpdateDecorations(callback) {
    return this.decorationManager.onDidUpdateDecorations(callback);
  }

  // Retrieves the current buffer's URI.
  getURI() {
    return this.buffer.getUri();
  }

  // Create an {@link TextEditor} with its initial state based on this object
  copy() {
    const displayLayer = this.displayLayer.copy();
    const selectionsMarkerLayer = displayLayer.getMarkerLayer(
      this.buffer.getMarkerLayer(this.selectionsMarkerLayer.id).copy().id,
    );
    const softTabs = this.getSoftTabs();
    const initialScrollTopRow = this.getScrollTopRow();
    // Capture a buffer-based anchor so the copy shows the same visual position
    // even when it lands in a pane with a different width (and thus soft wrap).
    const initialScrollAnchor = this.component ? this.component.captureScrollAnchor() : null;
    return new TextEditor({
      buffer: this.buffer,
      selectionsMarkerLayer,
      softTabs,
      suppressCursorCreation: true,
      tabLength: this.getTabLength(),
      initialScrollTopRow,
      initialScrollLeftColumn: this.getScrollLeftColumn(),
      initialScrollAnchor,
      assert: this.assert,
      displayLayer,
      grammar: this.getGrammar(),
      autoWidth: this.autoWidth,
      autoHeight: this.autoHeight,
      // Inherit scrollPastEnd so a copy scrolled into the past-end zone has the
      // room to restore the same visual position instead of clamping.
      scrollPastEnd: this.scrollPastEnd,
      // Inherit the soft-wrap state so the copy keeps the same screen geometry;
      // otherwise it would unwrap on first render and land at a wrong scroll
      // position even though the copied display layer was wrapped.
      softWrapped: this.softWrapped,
      softWrapAtPreferredLineLength: this.softWrapAtPreferredLineLength,
    });
  }

  // Controls visibility based on the given `Boolean`.
  setVisible(visible) {
    if (visible) {
      const languageMode = this.buffer.getLanguageMode();
      if (languageMode.startTokenizing) languageMode.startTokenizing();
    }
  }

  setMini(mini) {
    this.updateMini(mini, true);
  }

  isMini() {
    return this.mini;
  }

  setReadOnly(readOnly) {
    this.updateReadOnly(readOnly, true);
  }

  isReadOnly() {
    return this.readOnly;
  }

  enableKeyboardInput(enabled) {
    this.updateKeyboardInputEnabled(enabled, true);
  }

  isKeyboardInputEnabled() {
    return this.keyboardInputEnabled;
  }

  onDidChangeMini(callback) {
    return this.emitter.on("did-change-mini", callback);
  }

  setLineNumberGutterVisible(lineNumberGutterVisible) {
    this.updateLineNumberGutterVisible(lineNumberGutterVisible, true);
  }

  isLineNumberGutterVisible() {
    return this.lineNumberGutter.isVisible();
  }

  anyLineNumberGutterVisible() {
    return this.getGutters().some((gutter) => gutter.type === "line-number" && gutter.visible);
  }

  onDidChangeLineNumberGutterVisible(callback) {
    return this.emitter.on("did-change-line-number-gutter-visible", callback);
  }

  /**
   * @public
   * @status essential
   *
   * Calls your `callback` when a {@link Gutter} is added to the editor.
   * Immediately calls your callback for each existing gutter.
   *
   * @param {Function} callback
   * @param {Gutter} callback.gutter - that currently exists/was added.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  observeGutters(callback) {
    return this.gutterContainer.observeGutters(callback);
  }

  /**
   * @public
   * @status essential
   *
   * Calls your `callback` when a {@link Gutter} is added to the editor.
   *
   * @param {Function} callback
   * @param {Gutter} callback.gutter - that was added.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidAddGutter(callback) {
    return this.gutterContainer.onDidAddGutter(callback);
  }

  /**
   * @public
   * @status essential
   *
   * Calls your `callback` when a {@link Gutter} is removed from the editor.
   *
   * @param {Function} callback
   * @param callback.name - The name of the {@link Gutter} that was removed.
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidRemoveGutter(callback) {
    return this.gutterContainer.onDidRemoveGutter(callback);
  }

  // Set the number of characters that can be displayed horizontally in the
  // editor.
  //
  // * `editorWidthInChars` A `Number` representing the width of the
  // {@link TextEditorElement} in characters.
  setEditorWidthInChars(editorWidthInChars) {
    this.updateEditorWidthInChars(editorWidthInChars, true);
  }

  // Returns the editor width in characters.
  getEditorWidthInChars() {
    if (this.width != null && this.defaultCharWidth > 0) {
      return Math.max(0, Math.floor(this.width / this.defaultCharWidth));
    } else {
      return this.editorWidthInChars;
    }
  }

  /**
   * @category Buffer
   */

  /**
   * @public
   * @status essential
   *
   * Retrieves the current {@link TextBuffer}.
   */
  getBuffer() {
    return this.buffer;
  }

  /**
   * @category File Details
   */

  /**
   * @public
   * @status essential
   *
   * Get the editor's title for display in other parts of the
   * UI such as the tabs.
   *
   * If the editor's buffer is saved, its title is the file name. If it is
   * unsaved, its title is "untitled".
   *
   * @returns {String}
   */
  getTitle() {
    return this.getFileName() || "untitled";
  }

  /**
   * @public
   * @status essential
   *
   * Get unique title for display in other parts of the UI, such as
   * the window title.
   *
   * If the editor's buffer is unsaved, its title is "untitled"
   * If the editor's buffer is saved, its unique title is formatted as one
   * of the following,
   * * `filename` when it is the only editing buffer with this file name.
   * * `filename — unique-dir-prefix` when other buffers have this file name.
   *
   * @returns {String}
   */
  getLongTitle() {
    if (!this.getPath()) return "untitled";
    // A long title is a property of the whole set of open editors \u2014 it says
    // what distinguishes this one from the others sharing its file name \u2014 so
    // the workspace computes them all together and hands them out. An editor
    // the workspace does not hold has nothing to be distinguished from.
    const longTitle = lumine.workspace?.getLongTitles?.().get(this);
    return longTitle ?? this.getFileName();
  }

  // Long titles for every editor given, as a Map. Editors are grouped by file
  // name, and within a group each one is labelled by the shortest tail of its
  // directory that no other member of the group shares.
  //
  // The number of leading segments to drop is derived from two per-position
  // facts about the group \u2014 how many members carry each value, and whether any
  // member's path ends there \u2014 rather than by comparing each member against
  // every other. Comparing pairwise is quadratic in the size of the group, and
  // the group can be every editor open: a project's worth of `LICENSE` files
  // is one group.
  static computeLongTitles(editors) {
    const groups = new Map();
    for (const editor of editors) {
      if (!editor.getPath()) continue;
      const fileName = editor.getFileName();
      let group = groups.get(fileName);
      if (group === undefined) groups.set(fileName, (group = []));
      group.push(editor);
    }

    const longTitles = new Map();
    for (const [fileName, group] of groups) {
      if (group.length === 1) {
        longTitles.set(group[0], fileName);
        continue;
      }

      const segmentsByEditor = group.map((editor) => editor.getTildifiedDirectorySegments());
      let deepest = 0;
      for (const segments of segmentsByEditor) deepest = Math.max(deepest, segments.length);

      // Per position: how many members carry each value, and whether any
      // member's path ends immediately after it.
      const countsByPosition = [];
      const endsAtPosition = new Array(deepest).fill(false);
      for (let position = 0; position < deepest; position++) countsByPosition.push(new Map());
      for (const segments of segmentsByEditor) {
        for (let position = 0; position < deepest; position++) {
          const counts = countsByPosition[position];
          const segment = segments[position];
          counts.set(segment, (counts.get(segment) ?? 0) + 1);
        }
        if (segments.length > 0) endsAtPosition[segments.length - 1] = true;
      }

      for (let index = 0; index < group.length; index++) {
        const mySegments = segmentsByEditor[index];
        let commonPathSegmentCount;
        for (let position = 0, { length } = mySegments; position < length; position++) {
          const sharedHere = countsByPosition[position].get(mySegments[position]) ?? 0;
          // Someone's path ends here, or someone differs from mine here.
          if (endsAtPosition[position] || sharedHere < group.length) {
            commonPathSegmentCount = position;
            break;
          }
        }
        longTitles.set(
          group[index],
          `${fileName} \u2014 ${path.join(...mySegments.slice(commonPathSegmentCount))}`,
        );
      }
    }

    return longTitles;
  }

  // This editor's directory as `~`-abbreviated path segments, remembered until
  // its path changes. Every editor sharing a file name recomputes these for
  // every other one each time a long title is asked for, so with many
  // same-named files open — a project's worth of `LICENSE`, say — the
  // conversion runs orders of magnitude more often than the paths change.
  getTildifiedDirectorySegments() {
    const directoryPath = this.getDirectoryPath();
    if (this.tildifiedSegmentsForPath !== directoryPath) {
      this.tildifiedSegmentsForPath = directoryPath;
      this.tildifiedSegments = fs.tildify(directoryPath).split(path.sep);
    }
    return this.tildifiedSegments;
  }

  /**
   * @public
   * @status essential
   *
   * @returns {String} path of this editor's text buffer.
   */
  getPath() {
    return this.buffer.getPath();
  }

  getFileName() {
    const fullPath = this.getPath();
    if (fullPath) return path.basename(fullPath);
  }

  getDirectoryPath() {
    const fullPath = this.getPath();
    if (fullPath) return path.dirname(fullPath);
  }

  /**
   * @public
   * @status extended
   *
   * @returns {String} character set encoding of this editor's text buffer.
   */
  getEncoding() {
    return this.buffer.getEncoding();
  }

  /**
   * @public
   * @status extended
   *
   * Set the character set encoding to use in this editor's text
   * buffer.
   *
   * @param encoding - The `String` character set encoding name such as 'utf8'
   */
  setEncoding(encoding) {
    this.buffer.setEncoding(encoding);
  }

  /**
   * @public
   * @status essential
   *
   * @returns {String} one of the values in `FileState`.
   */
  getFileState() {
    return this.buffer.getFileState();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Boolean} `true` if this editor has no content.
   */
  isEmpty() {
    return this.buffer.isEmpty();
  }

  /**
   * @category File Operations
   */

  /**
   * @public
   * @status essential
   *
   * Saves the editor's text buffer.
   *
   * See {@link TextBuffer#save} for more details.
   */
  save() {
    return this.buffer.save();
  }

  /**
   * @public
   * @status essential
   *
   * Saves the editor's text buffer as the given path.
   *
   * See {@link TextBuffer#saveAs} for more details.
   *
   * @param filePath - A `String` path.
   */
  saveAs(filePath) {
    return this.buffer.saveAs(filePath);
  }

  // Determine whether the user should be prompted to save before closing
  // this editor.
  shouldPromptToSave({ windowCloseRequested, projectHasPaths } = {}) {
    if (!lumine.config.get("core.promptOnCloseDirtyBuffer")) {
      return false;
    }

    if (windowCloseRequested && projectHasPaths && lumine.stateStore.isConnected()) {
      return (
        this.getFileState() === FileState.CONFLICTED || this.getFileState() === FileState.REMOVED
      );
    } else {
      return this.getFileState() !== FileState.UNMODIFIED && !this.buffer.hasMultipleEditors();
    }
  }

  // Returns an `Object` to configure dialog shown when this editor is saved
  // via {@link Pane#saveItemAs}.
  getSaveDialogOptions() {
    return {};
  }

  /**
   * @category Reading Text
   */

  /**
   * @public
   * @status essential
   *
   * @returns {String} representing the entire contents of the editor.
   */
  getText() {
    return this.buffer.getText();
  }

  /**
   * @public
   * @status essential
   *
   * Get the text in the given {@link Range} in buffer coordinates.
   *
   * @param range - A {@link Range} or range-compatible `Array`.
   * @returns {String}
   */
  getTextInBufferRange(range) {
    return this.buffer.getTextInRange(range);
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Number} representing the number of lines in the buffer.
   */
  getLineCount() {
    return this.buffer.getLineCount();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Number} representing the number of screen lines in the editor. This accounts for folds.
   */
  getScreenLineCount() {
    return this.displayLayer.getScreenLineCount();
  }

  getApproximateScreenLineCount() {
    return this.displayLayer.getApproximateScreenLineCount();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Number} representing the last zero-indexed buffer row number of the editor.
   */
  getLastBufferRow() {
    return this.buffer.getLastRow();
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Number} representing the last zero-indexed screen row number of the editor.
   */
  getLastScreenRow() {
    return this.getScreenLineCount() - 1;
  }

  /**
   * @public
   * @status essential
   *
   * @param bufferRow - A `Number` representing a zero-indexed buffer row.
   * @returns {String} representing the contents of the line at the given buffer row.
   */
  lineTextForBufferRow(bufferRow) {
    return this.buffer.lineForRow(bufferRow);
  }

  /**
   * @public
   * @status essential
   *
   * @param screenRow - A `Number` representing a zero-indexed screen row.
   * @returns {String} representing the contents of the line at the given screen row.
   */
  lineTextForScreenRow(screenRow) {
    const screenLine = this.screenLineForScreenRow(screenRow);
    if (screenLine) return screenLine.lineText;
  }

  logScreenLines(start = 0, end = this.getLastScreenRow()) {
    for (let row = start; row <= end; row++) {
      const line = this.lineTextForScreenRow(row);
      console.log(row, this.bufferRowForScreenRow(row), line, line.length);
    }
  }

  tokensForScreenRow(screenRow) {
    const tokens = [];
    let lineTextIndex = 0;
    const currentTokenScopes = [];
    const { lineText, tags } = this.screenLineForScreenRow(screenRow);
    for (const tag of tags) {
      if (this.displayLayer.isOpenTag(tag)) {
        currentTokenScopes.push(this.displayLayer.classNameForTag(tag));
      } else if (this.displayLayer.isCloseTag(tag)) {
        currentTokenScopes.pop();
      } else if (tag === 0) {
        // `tag` is not a tag, but rather a description of the number of
        // characters until the next boundary. In unusual circumstances, `0`
        // may be emitted here, but that's just an indication that we can
        // safely ignore this “tag,” because the next boundary will be at the
        // same position.
        continue;
      } else {
        tokens.push({
          text: lineText.substr(lineTextIndex, tag),
          scopes: currentTokenScopes.slice(),
        });
        lineTextIndex += tag;
      }
    }
    return tokens;
  }

  screenLineForScreenRow(screenRow) {
    return this.displayLayer.getScreenLine(screenRow);
  }

  bufferRowForScreenRow(screenRow) {
    return this.displayLayer.translateScreenPosition(Point(screenRow, 0)).row;
  }

  bufferRowsForScreenRows(startScreenRow, endScreenRow) {
    return this.displayLayer.bufferRowsForScreenRows(startScreenRow, endScreenRow + 1);
  }

  screenRowForBufferRow(row) {
    return this.displayLayer.translateBufferPosition(Point(row, 0)).row;
  }

  getRightmostScreenPosition() {
    return this.displayLayer.getRightmostScreenPosition();
  }

  getApproximateRightmostScreenPosition() {
    return this.displayLayer.getApproximateRightmostScreenPosition();
  }

  getMaxScreenLineLength() {
    return this.getRightmostScreenPosition().column;
  }

  getLongestScreenRow() {
    return this.getRightmostScreenPosition().row;
  }

  getApproximateLongestScreenRow() {
    return this.getApproximateRightmostScreenPosition().row;
  }

  lineLengthForScreenRow(screenRow) {
    return this.displayLayer.lineLengthForScreenRow(screenRow);
  }

  // Returns the range for the given buffer row.
  //
  // * `row` A row `Number`.
  // * `options` (optional) An options object with an `includeNewline` key.
  //
  // Returns a {@link Range}.
  bufferRangeForBufferRow(row, options) {
    return this.buffer.rangeForRow(row, options && options.includeNewline);
  }

  // Get the text in the given {@link Range}.
  //
  // Returns a `String`.
  getTextInRange(range) {
    return this.buffer.getTextInRange(range);
  }

  // {Delegates to: TextBuffer.isRowBlank}
  isBufferRowBlank(bufferRow) {
    return this.buffer.isRowBlank(bufferRow);
  }

  // {Delegates to: TextBuffer.nextNonBlankRow}
  nextNonBlankBufferRow(bufferRow) {
    return this.buffer.nextNonBlankRow(bufferRow);
  }

  // {Delegates to: TextBuffer.getEndPosition}
  getEofBufferPosition() {
    return this.buffer.getEndPosition();
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Range} of the paragraph surrounding the most recently added
   * cursor.
   *
   * @returns {Range}
   */
  getCurrentParagraphBufferRange() {
    return this.getLastCursor().getCurrentParagraphBufferRange();
  }

  /**
   * @category Mutating Text
   */

  /**
   * @public
   * @status essential
   *
   * Replaces the entire contents of the buffer with the given `String`.
   *
   * @param {String} text - Text to replace the buffer contents with.
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor.
   */
  setText(text, options = {}) {
    if (!this.ensureWritable("setText", options)) return;
    return this.buffer.setText(text);
  }

  /**
   * @public
   * @status essential
   *
   * Set the text in the given {@link Range} in buffer coordinates.
   *
   * @param range - A {@link Range} or range-compatible `Array`.
   * @param text - A `String`
   * @param {Object} [options]
   * @param {Boolean} [options.normalizeLineEndings] - (default: true)
   * @param [options.undo] - *Deprecated* `String` 'skip' will skip the undo system. This property is deprecated. Call groupLastChanges() on the {@link TextBuffer} afterward instead.
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   * @returns {Range} of the newly-inserted text.
   */
  setTextInBufferRange(range, text, options = {}) {
    if (!this.ensureWritable("setTextInBufferRange", options)) return;
    return this.getBuffer().setTextInRange(range, text, options);
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, replace the selected text with the given text.
   *
   * @param text - A `String` representing the text to insert.
   * @param [options] - See {@link Selection#insertText}.
   * @returns {Range} when the text has been inserted. Returns a `Boolean` `false` when the text has not been inserted.
   */
  insertText(text, options = {}) {
    if (!this.ensureWritable("insertText", options)) return;
    if (!this.emitWillInsertTextEvent(text)) return false;

    let groupLastChanges = false;
    if (options.undo === "skip") {
      options = Object.assign({}, options);
      delete options.undo;
      groupLastChanges = true;
    }

    const groupingInterval = options.groupUndo ? this.undoGroupingInterval : 0;
    if (options.autoIndentNewline == null) options.autoIndentNewline = this.shouldAutoIndent();
    if (options.autoDecreaseIndent == null) options.autoDecreaseIndent = this.shouldAutoIndent();
    const result = this.mutateSelectedText((selection) => {
      const range = selection.insertText(text, options);
      const didInsertEvent = { text, range };
      this.emitter.emit("did-insert-text", didInsertEvent);
      return range;
    }, groupingInterval);
    if (groupLastChanges) this.buffer.groupLastChanges();

    if (options.autoIndent || options.autoIndentNewline || options.autoDecreaseIndent) {
      this.scheduleIndentAdjustment();
    }
    return result;
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, replace the selected text with a newline.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  insertNewline(options = {}) {
    return this.insertText("\n", options);
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, if the selection is empty, delete the character
   * following the cursor. Otherwise delete the selected text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  delete(options = {}) {
    if (!this.ensureWritable("delete", options)) return;
    return this.mutateSelectedText((selection) => selection.delete(options));
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, if the selection is empty, delete the character
   * preceding the cursor. Otherwise delete the selected text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  backspace(options = {}) {
    if (!this.ensureWritable("backspace", options)) return;
    return this.mutateSelectedText((selection) => selection.backspace(options));
  }

  /**
   * @public
   * @status extended
   *
   * Mutate the text of all the selections in a single transaction.
   *
   * All the changes made inside the given `Function` can be reverted with a
   * single call to {@link #undo}.
   *
   * @param fn - A `Function` that will be called once for each {@link Selection}. The first argument will be a {@link Selection} and the second argument will be the `Number` index of that selection.
   */
  mutateSelectedText(fn, groupingInterval = 0) {
    return this.mergeIntersectingSelections(() => {
      return this.transact(groupingInterval, () => {
        return this.getSelectionsOrderedByBufferPosition().map((selection, index) =>
          fn(selection, index),
        );
      });
    });
  }

  // Move lines intersecting the most recent selection or multiple selections
  // up by one row in screen coordinates.
  //
  // * `options` (optional) `Object`
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify a read-only editor. (default: false)
  moveLineUp(options = {}) {
    if (!this.ensureWritable("moveLineUp", options)) return;

    const selections = this.getSelectedBufferRanges().sort((a, b) => a.compare(b));

    if (selections[0].start.row === 0) return;
    if (
      selections[selections.length - 1].start.row === this.getLastBufferRow() &&
      this.buffer.getLastLine() === ""
    )
      return;

    this.transact(() => {
      const newSelectionRanges = [];

      while (selections.length > 0) {
        // Find selections spanning a contiguous set of lines
        const selection = selections.shift();
        const selectionsToMove = [selection];

        while (
          selection.end.row === (selections[0] != null ? selections[0].start.row : undefined)
        ) {
          selectionsToMove.push(selections[0]);
          selection.end.row = selections[0].end.row;
          selections.shift();
        }

        // Compute the buffer range spanned by all these selections, expanding it
        // so that it includes any folded region that intersects them.
        let startRow = selection.start.row;
        let endRow = selection.end.row;
        if (selection.end.row > selection.start.row && selection.end.column === 0) {
          // Don't move the last line of a multi-line selection if the selection ends at column 0
          endRow--;
        }

        startRow = this.displayLayer.findBoundaryPrecedingBufferRow(startRow);
        endRow = this.displayLayer.findBoundaryFollowingBufferRow(endRow + 1);
        const linesRange = new Range(Point(startRow, 0), Point(endRow, 0));

        // If selected line range is preceded by a fold, one line above on screen
        // could be multiple lines in the buffer.
        const precedingRow = this.displayLayer.findBoundaryPrecedingBufferRow(startRow - 1);
        const insertDelta = linesRange.start.row - precedingRow;

        // Any folds in the text that is moved will need to be re-created.
        // It includes the folds that were intersecting with the selection.
        const rangesToRefold = this.displayLayer
          .destroyFoldsIntersectingBufferRange(linesRange)
          .map((range) => range.translate([-insertDelta, 0]));

        // Delete lines spanned by selection and insert them on the preceding buffer row
        let lines = this.buffer.getTextInRange(linesRange);
        if (lines[lines.length - 1] !== "\n") {
          lines += this.buffer.lineEndingForRow(linesRange.end.row - 2);
        }
        this.buffer.delete(linesRange);
        this.buffer.insert([precedingRow, 0], lines);

        // Restore folds that existed before the lines were moved
        for (let rangeToRefold of rangesToRefold) {
          this.displayLayer.foldBufferRange(rangeToRefold);
        }

        for (const selectionToMove of selectionsToMove) {
          newSelectionRanges.push(selectionToMove.translate([-insertDelta, 0]));
        }
      }

      this.setSelectedBufferRanges(newSelectionRanges, {
        autoscroll: false,
        preserveFolds: true,
      });
      if (this.shouldAutoIndent()) this.autoIndentSelectedRows();
      this.scrollToBufferPosition([newSelectionRanges[0].start.row, 0]);
    });
  }

  // Move lines intersecting the most recent selection or multiple selections
  // down by one row in screen coordinates.
  //
  // * `options` (optional) `Object`
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify a read-only editor. (default: false)
  moveLineDown(options = {}) {
    if (!this.ensureWritable("moveLineDown", options)) return;

    const selections = this.getSelectedBufferRanges();
    selections.sort((a, b) => b.compare(a));

    this.transact(() => {
      this.consolidateSelections();
      const newSelectionRanges = [];

      while (selections.length > 0) {
        // Find selections spanning a contiguous set of lines
        const selection = selections.shift();
        const selectionsToMove = [selection];

        // if the current selection start row matches the next selections' end row - make them one selection
        while (
          selection.start.row === (selections[0] != null ? selections[0].end.row : undefined)
        ) {
          selectionsToMove.push(selections[0]);
          selection.start.row = selections[0].start.row;
          selections.shift();
        }

        // Compute the buffer range spanned by all these selections, expanding it
        // so that it includes any folded region that intersects them.
        let startRow = selection.start.row;
        let endRow = selection.end.row;
        if (selection.end.row > selection.start.row && selection.end.column === 0) {
          // Don't move the last line of a multi-line selection if the selection ends at column 0
          endRow--;
        }

        startRow = this.displayLayer.findBoundaryPrecedingBufferRow(startRow);
        endRow = this.displayLayer.findBoundaryFollowingBufferRow(endRow + 1);
        const linesRange = new Range(Point(startRow, 0), Point(endRow, 0));

        // If selected line range is followed by a fold, one line below on screen
        // could be multiple lines in the buffer. But at the same time, if the
        // next buffer row is wrapped, one line in the buffer can represent many
        // screen rows.
        const followingRow = Math.min(
          this.buffer.getLineCount(),
          this.displayLayer.findBoundaryFollowingBufferRow(endRow + 1),
        );
        const insertDelta = followingRow - linesRange.end.row;

        // Any folds in the text that is moved will need to be re-created.
        // It includes the folds that were intersecting with the selection.
        const rangesToRefold = this.displayLayer
          .destroyFoldsIntersectingBufferRange(linesRange)
          .map((range) => range.translate([insertDelta, 0]));

        // Delete lines spanned by selection and insert them on the following correct buffer row
        let lines = this.buffer.getTextInRange(linesRange);
        if (followingRow - 1 === this.buffer.getLastRow()) {
          lines = `\n${lines}`;
        }

        this.buffer.insert([followingRow, 0], lines);
        this.buffer.delete(linesRange);

        // Restore folds that existed before the lines were moved
        for (let rangeToRefold of rangesToRefold) {
          this.displayLayer.foldBufferRange(rangeToRefold);
        }

        for (const selectionToMove of selectionsToMove) {
          newSelectionRanges.push(selectionToMove.translate([insertDelta, 0]));
        }
      }

      this.setSelectedBufferRanges(newSelectionRanges, {
        autoscroll: false,
        preserveFolds: true,
      });
      if (this.shouldAutoIndent()) this.autoIndentSelectedRows();
      this.scrollToBufferPosition([newSelectionRanges[0].start.row - 1, 0]);
    });
  }

  // Move any active selections one column to the left.
  //
  // * `options` (optional) `Object`
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify a read-only editor. (default: false)
  moveSelectionLeft(options = {}) {
    if (!this.ensureWritable("moveSelectionLeft", options)) return;
    const selections = this.getSelectedBufferRanges();
    const noSelectionAtStartOfLine = selections.every((selection) => selection.start.column !== 0);

    const translationDelta = [0, -1];
    const translatedRanges = [];

    if (noSelectionAtStartOfLine) {
      this.transact(() => {
        for (let selection of selections) {
          const charToLeftOfSelection = new Range(
            selection.start.translate(translationDelta),
            selection.start,
          );
          const charTextToLeftOfSelection = this.buffer.getTextInRange(charToLeftOfSelection);

          this.buffer.insert(selection.end, charTextToLeftOfSelection);
          this.buffer.delete(charToLeftOfSelection);
          translatedRanges.push(selection.translate(translationDelta));
        }

        this.setSelectedBufferRanges(translatedRanges);
      });
    }
  }

  // Move any active selections one column to the right.
  //
  // * `options` (optional) `Object`
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify a read-only editor. (default: false)
  moveSelectionRight(options = {}) {
    if (!this.ensureWritable("moveSelectionRight", options)) return;
    const selections = this.getSelectedBufferRanges();
    const noSelectionAtEndOfLine = selections.every((selection) => {
      return selection.end.column !== this.buffer.lineLengthForRow(selection.end.row);
    });

    const translationDelta = [0, 1];
    const translatedRanges = [];

    if (noSelectionAtEndOfLine) {
      this.transact(() => {
        for (let selection of selections) {
          const charToRightOfSelection = new Range(
            selection.end,
            selection.end.translate(translationDelta),
          );
          const charTextToRightOfSelection = this.buffer.getTextInRange(charToRightOfSelection);

          this.buffer.delete(charToRightOfSelection);
          this.buffer.insert(selection.start, charTextToRightOfSelection);
          translatedRanges.push(selection.translate(translationDelta));
        }

        this.setSelectedBufferRanges(translatedRanges);
      });
    }
  }

  // Duplicate all lines containing active selections.
  //
  // * `options` (optional) `Object`
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify a read-only editor. (default: false)
  duplicateLines(options = {}) {
    if (!this.ensureWritable("duplicateLines", options)) return;
    this.transact(() => {
      const selections = this.getSelectionsOrderedByBufferPosition();
      const previousSelectionRanges = [];

      let i = selections.length - 1;
      while (i >= 0) {
        const j = i;
        previousSelectionRanges[i] = selections[i].getBufferRange();
        if (selections[i].isEmpty()) {
          const { start } = selections[i].getScreenRange();
          selections[i].setScreenRange(
            [
              [start.row, 0],
              [start.row + 1, 0],
            ],
            {
              preserveFolds: true,
            },
          );
        }
        let [startRow, endRow] = selections[i].getBufferRowRange();
        endRow++;
        while (i > 0) {
          const [previousSelectionStartRow, previousSelectionEndRow] =
            selections[i - 1].getBufferRowRange();
          if (previousSelectionEndRow === startRow) {
            startRow = previousSelectionStartRow;
            previousSelectionRanges[i - 1] = selections[i - 1].getBufferRange();
            i--;
          } else {
            break;
          }
        }

        const intersectingFolds = this.displayLayer.foldsIntersectingBufferRange([
          [startRow, 0],
          [endRow, 0],
        ]);
        let textToDuplicate = this.getTextInBufferRange([
          [startRow, 0],
          [endRow, 0],
        ]);
        if (endRow > this.getLastBufferRow()) textToDuplicate = `\n${textToDuplicate}`;
        this.buffer.insert([endRow, 0], textToDuplicate);

        const insertedRowCount = endRow - startRow;

        for (let k = i; k <= j; k++) {
          selections[k].setBufferRange(previousSelectionRanges[k].translate([insertedRowCount, 0]));
        }

        for (const fold of intersectingFolds) {
          const foldRange = this.displayLayer.bufferRangeForFold(fold);
          this.displayLayer.foldBufferRange(foldRange.translate([insertedRowCount, 0]));
        }

        i--;
      }
    });
  }

  replaceSelectedText(options, fn) {
    this.mutateSelectedText((selection) => {
      selection.getBufferRange();
      if (options && options.selectWordIfEmpty && selection.isEmpty()) {
        selection.selectWord();
      }
      const text = selection.getText();
      selection.deleteSelectedText();
      const range = selection.insertText(fn(text));
      selection.setBufferRange(range);
    });
  }

  // Split multi-line selections into one selection per line.
  //
  // Operates on all selections. This method breaks apart all multi-line
  // selections to create multiple single-line selections that cumulatively cover
  // the same original area.
  splitSelectionsIntoLines() {
    this.mergeIntersectingSelections(() => {
      for (const selection of this.getSelections()) {
        const range = selection.getBufferRange();
        if (range.isSingleLine()) continue;

        const { start, end } = range;
        this.addSelectionForBufferRange([start, [start.row, Infinity]]);
        let { row } = start;
        while (++row < end.row) {
          this.addSelectionForBufferRange([
            [row, 0],
            [row, Infinity],
          ]);
        }
        if (end.column !== 0)
          this.addSelectionForBufferRange([
            [end.row, 0],
            [end.row, end.column],
          ]);
        selection.destroy();
      }
    });
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, transpose the selected text.
   *
   * If the selection is empty, the characters preceding and following the cursor
   * are swapped. Otherwise, the selected characters are reversed.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  transpose(options = {}) {
    if (!this.ensureWritable("transpose", options)) return;
    this.mutateSelectedText((selection) => {
      if (selection.isEmpty()) {
        selection.selectRight();
        const text = selection.getText();
        selection.delete();
        selection.cursor.moveLeft();
        selection.insertText(text);
      } else {
        selection.insertText(selection.getText().split("").reverse().join(""));
      }
    });
  }

  /**
   * @public
   * @status extended
   *
   * Convert the selected text to upper case.
   *
   * For each selection, if the selection is empty, converts the containing word
   * to upper case. Otherwise convert the selected text to upper case.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  upperCase(options = {}) {
    if (!this.ensureWritable("upperCase", options)) return;
    this.replaceSelectedText({ selectWordIfEmpty: true }, (text) => text.toUpperCase(options));
  }

  /**
   * @public
   * @status extended
   *
   * Convert the selected text to lower case.
   *
   * For each selection, if the selection is empty, converts the containing word
   * to upper case. Otherwise convert the selected text to upper case.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  lowerCase(options = {}) {
    if (!this.ensureWritable("lowerCase", options)) return;
    this.replaceSelectedText({ selectWordIfEmpty: true }, (text) => text.toLowerCase(options));
  }

  /**
   * @public
   * @status extended
   *
   * Toggle line comments for rows intersecting selections.
   *
   * If the current grammar doesn't support comments, does nothing.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  toggleLineCommentsInSelection(options = {}) {
    if (!this.ensureWritable("toggleLineCommentsInSelection", options)) return;
    this.mutateSelectedText((selection) => selection.toggleLineComments(options));
  }

  // Convert multiple lines to a single line.
  //
  // Operates on all selections. If the selection is empty, joins the current
  // line with the next line. Otherwise it joins all lines that intersect the
  // selection.
  //
  // Joining a line means that multiple lines are converted to a single line with
  // the contents of each of the original non-empty lines separated by a space.
  //
  // * `options` (optional) `Object`
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify a read-only editor. (default: false)
  joinLines(options = {}) {
    if (!this.ensureWritable("joinLines", options)) return;
    this.mutateSelectedText((selection) => selection.joinLines());
  }

  /**
   * @public
   * @status extended
   *
   * Reduce every run of blank lines in the buffer to a single blank line.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  collapseBlankLines(options = {}) {
    if (!this.ensureWritable("collapseBlankLines", options)) return;
    this.transact(() => {
      this.backwardsScanInBufferRange(
        /(?:\r\n|\n|\r(?!\n)){3,}/g,
        this.buffer.getRange(),
        ({ replace }) => replace("\n\n"),
      );
    });
  }

  /**
   * @public
   * @status extended
   *
   * Collapse runs of spaces in line content without changing indentation.
   *
   * The complete leading whitespace prefix is preserved, including mixed tabs and
   * spaces. Runs of spaces after that prefix are reduced to one space.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  collapseContentSpaces(options = {}) {
    if (!this.ensureWritable("collapseContentSpaces", options)) return;
    this.transact(() => {
      this.backwardsScanInBufferRange(/ {2,}/g, this.buffer.getRange(), ({ range, replace }) => {
        const indentationLength = this.lineTextForBufferRow(range.start.row).match(/^[ \t]*/)[0]
          .length;
        if (range.start.column >= indentationLength) replace(" ");
      });
    });
  }

  /**
   * @public
   * @status extended
   *
   * For each cursor, insert a newline at beginning the following line.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  insertNewlineBelow(options = {}) {
    if (!this.ensureWritable("insertNewlineBelow", options)) return;
    this.transact(() => {
      this.moveToEndOfLine();
      this.insertNewline(options);
    });
  }

  /**
   * @public
   * @status extended
   *
   * For each cursor, insert a newline at the end of the preceding line.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  insertNewlineAbove(options = {}) {
    if (!this.ensureWritable("insertNewlineAbove", options)) return;
    this.transact(() => {
      const bufferRow = this.getCursorBufferPosition().row;
      const indentLevel = this.indentationForBufferRow(bufferRow);
      const onFirstLine = bufferRow === 0;

      this.moveToBeginningOfLine();
      this.moveLeft();
      this.insertNewline(options);

      if (this.shouldAutoIndent() && this.indentationForBufferRow(bufferRow) < indentLevel) {
        this.setIndentationForBufferRow(bufferRow, indentLevel);
      }

      if (onFirstLine) {
        this.moveUp();
        this.moveToEndOfLine();
      }
    });
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, if the selection is empty, delete all characters
   * of the containing word that precede the cursor. Otherwise delete the
   * selected text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToBeginningOfWord(options = {}) {
    if (!this.ensureWritable("deleteToBeginningOfWord", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToBeginningOfWord(options));
  }

  /**
   * @public
   * @status extended
   *
   * Similar to {@link #deleteToBeginningOfWord}, but deletes only back to the
   * previous word boundary.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToPreviousWordBoundary(options = {}) {
    if (!this.ensureWritable("deleteToPreviousWordBoundary", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToPreviousWordBoundary(options));
  }

  /**
   * @public
   * @status extended
   *
   * Similar to {@link #deleteToEndOfWord}, but deletes only up to the
   * next word boundary.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToNextWordBoundary(options = {}) {
    if (!this.ensureWritable("deleteToNextWordBoundary", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToNextWordBoundary(options));
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, if the selection is empty, delete all characters
   * of the containing subword following the cursor. Otherwise delete the selected
   * text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToBeginningOfSubword(options = {}) {
    if (!this.ensureWritable("deleteToBeginningOfSubword", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToBeginningOfSubword(options));
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, if the selection is empty, delete all characters
   * of the containing subword following the cursor. Otherwise delete the selected
   * text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToEndOfSubword(options = {}) {
    if (!this.ensureWritable("deleteToEndOfSubword", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToEndOfSubword(options));
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, if the selection is empty, delete all characters
   * of the containing line that precede the cursor. Otherwise delete the
   * selected text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToBeginningOfLine(options = {}) {
    if (!this.ensureWritable("deleteToBeginningOfLine", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToBeginningOfLine(options));
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, if the selection is not empty, deletes the
   * selection; otherwise, deletes all characters of the containing line
   * following the cursor. If the cursor is already at the end of the line,
   * deletes the following newline.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToEndOfLine(options = {}) {
    if (!this.ensureWritable("deleteToEndOfLine", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToEndOfLine(options));
  }

  /**
   * @public
   * @status extended
   *
   * Delete through the indentation of the line following each selection.
   *
   * Empty selections start at their cursor. Non-empty selections also consume the
   * rest of their final selected line. Selection direction does not affect the
   * result.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToNextLineContent(options = {}) {
    if (!this.ensureWritable("deleteToNextLineContent", options)) return;

    const lastBufferRow = this.getLastBufferRow();
    const rangesToDelete = [];
    for (const selectionRange of this.getSelectedBufferRanges()) {
      let finalSelectedRow = selectionRange.end.row;
      if (!selectionRange.isEmpty() && selectionRange.end.column === 0) {
        finalSelectedRow--;
      }

      const nextRow = finalSelectedRow + 1;
      if (nextRow > lastBufferRow) {
        if (!selectionRange.isEmpty()) {
          rangesToDelete.push(new Range(selectionRange.start, this.buffer.getEndPosition()));
        }
        continue;
      }

      const nextLine = this.lineTextForBufferRow(nextRow);
      const firstContentColumn = nextLine.search(NON_WHITESPACE_REGEXP);
      rangesToDelete.push(
        new Range(
          selectionRange.start,
          new Point(nextRow, firstContentColumn === -1 ? nextLine.length : firstContentColumn),
        ),
      );
    }

    rangesToDelete.sort((left, right) => left.start.compare(right.start));
    const mergedRanges = [];
    for (const range of rangesToDelete) {
      const previous = mergedRanges[mergedRanges.length - 1];
      if (previous && range.start.compare(previous.end) <= 0) {
        if (range.end.compare(previous.end) > 0) {
          mergedRanges[mergedRanges.length - 1] = new Range(previous.start, range.end);
        }
      } else {
        mergedRanges.push(new Range(range.start, range.end));
      }
    }

    this.transact(() => {
      for (let index = mergedRanges.length - 1; index >= 0; index--) {
        this.buffer.delete(mergedRanges[index]);
      }
    });
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, if the selection is empty, delete all characters
   * of the containing word following the cursor. Otherwise delete the selected
   * text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteToEndOfWord(options = {}) {
    if (!this.ensureWritable("deleteToEndOfWord", options)) return;
    this.mutateSelectedText((selection) => selection.deleteToEndOfWord(options));
  }

  /**
   * @public
   * @status extended
   *
   * Delete all lines intersecting selections.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  deleteLine(options = {}) {
    if (!this.ensureWritable("deleteLine", options)) return;
    this.mergeSelectionsOnSameRows();
    this.mutateSelectedText((selection) => selection.deleteLine(options));
  }

  /**
   * Ensure that this editor is not marked read-only before allowing a buffer modification to occur. If
   * the editor is read-only, require an explicit opt-in option to proceed (`bypassReadOnly`) or throw an Error.
   *
   * @private
   */
  ensureWritable(methodName, opts) {
    if (!opts.bypassReadOnly && this.isReadOnly()) {
      if (lumine.window.isDevMode() || lumine.window.isSpecMode()) {
        const e = new Error("Attempt to mutate a read-only TextEditor");
        e.detail =
          `Your package is attempting to call ${methodName} on an editor that has been marked read-only. ` +
          "Pass {bypassReadOnly: true} to modify it anyway, or test editors with .isReadOnly() before attempting " +
          "modifications.";
        throw e;
      }

      return false;
    }

    return true;
  }

  /**
   * @category History
   */

  /**
   * @public
   * @status essential
   *
   * Undo the last change.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  undo(options = {}) {
    if (!this.ensureWritable("undo", options)) return;
    this.avoidMergingSelections(() =>
      this.buffer.undo({ selectionsMarkerLayer: this.selectionsMarkerLayer }),
    );
    this.getLastSelection().autoscroll();
  }

  /**
   * @public
   * @status essential
   *
   * Redo the last change.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  redo(options = {}) {
    if (!this.ensureWritable("redo", options)) return;
    this.avoidMergingSelections(() =>
      this.buffer.redo({ selectionsMarkerLayer: this.selectionsMarkerLayer }),
    );
    this.getLastSelection().autoscroll();
  }

  /**
   * @public
   * @status extended
   *
   * Batch multiple operations as a single undo/redo step.
   *
   * Any group of operations that are logically grouped from the perspective of
   * undoing and redoing should be performed in a transaction. If you want to
   * abort the transaction, call {@link #abortTransaction} to terminate the function's
   * execution and revert any changes performed up to the abortion.
   *
   * @param [groupingInterval] - The `Number` of milliseconds for which this transaction should be considered 'groupable' after it begins. If a transaction with a positive `groupingInterval` is committed while the previous transaction is still 'groupable', the two transactions are merged with respect to undo and redo.
   * @param fn - A `Function` to call inside the transaction.
   */
  transact(groupingInterval, fn) {
    const options = { selectionsMarkerLayer: this.selectionsMarkerLayer };
    if (typeof groupingInterval === "function") {
      fn = groupingInterval;
    } else {
      options.groupingInterval = groupingInterval;
    }
    return this.buffer.transact(options, fn);
  }

  /**
   * @public
   * @status extended
   *
   * Abort an open transaction, undoing any operations performed so far
   * within the transaction.
   */
  abortTransaction() {
    return this.buffer.abortTransaction();
  }

  /**
   * @public
   * @status extended
   *
   * Create a pointer to the current state of the buffer for use
   * with {@link #revertToCheckpoint} and {@link #groupChangesSinceCheckpoint}.
   *
   * @returns {Number} checkpoint value.
   */
  createCheckpoint() {
    return this.buffer.createCheckpoint({
      selectionsMarkerLayer: this.selectionsMarkerLayer,
    });
  }

  /**
   * @public
   * @status extended
   *
   * Revert the buffer to the state it was in when the given
   * checkpoint was created.
   *
   * The redo stack will be empty following this operation, so changes since the
   * checkpoint will be lost. If the given checkpoint is no longer present in the
   * undo history, no changes will be made to the buffer and this method will
   *
   * @param checkpoint - The checkpoint to revert to.
   * @returns {Boolean} Whether the operation succeeded.
   */
  revertToCheckpoint(checkpoint) {
    return this.buffer.revertToCheckpoint(checkpoint);
  }

  /**
   * @public
   * @status extended
   *
   * Group all changes since the given checkpoint into a single
   * transaction for purposes of undo/redo.
   *
   * If the given checkpoint is no longer present in the undo history, no
   * grouping will be performed and this method will return `false`.
   *
   * @param checkpoint - The checkpoint from which to group changes.
   * @returns {Boolean} indicating whether the operation succeeded.
   */
  groupChangesSinceCheckpoint(checkpoint) {
    return this.buffer.groupChangesSinceCheckpoint(checkpoint, {
      selectionsMarkerLayer: this.selectionsMarkerLayer,
    });
  }

  /**
   * @category TextEditor Coordinates
   */

  /**
   * @public
   * @status essential
   *
   * Convert a position in buffer-coordinates to screen-coordinates.
   *
   * The position is clipped via {@link #clipBufferPosition} prior to the conversion.
   * The position is also clipped via {@link #clipScreenPosition} following the
   * conversion, which only makes a difference when `options` are supplied.
   *
   * @param bufferPosition - A {@link Point} or `Array` of [row, column].
   * @param [options] - An options object for {@link #clipScreenPosition}.
   * @returns {Point}
   */
  screenPositionForBufferPosition(bufferPosition, options) {
    return this.displayLayer.translateBufferPosition(bufferPosition, options);
  }

  /**
   * @public
   * @status essential
   *
   * Convert a position in screen-coordinates to buffer-coordinates.
   *
   * The position is clipped via {@link #clipScreenPosition} prior to the conversion.
   *
   * @param {Point|Array<Number>} screenPosition - The screen position to convert.
   * @param {Object} [options] - Options for {@link #clipScreenPosition}.
   * @returns {Point}
   */
  bufferPositionForScreenPosition(screenPosition, options) {
    return this.displayLayer.translateScreenPosition(screenPosition, options);
  }

  /**
   * @public
   * @status essential
   *
   * Convert a range in buffer-coordinates to screen-coordinates.
   *
   * @param {Range} bufferRange - in buffer coordinates to translate into screen coordinates.
   * @returns {Range}
   */
  screenRangeForBufferRange(bufferRange, options) {
    bufferRange = Range.fromObject(bufferRange);
    const start = this.screenPositionForBufferPosition(bufferRange.start, options);
    const end = this.screenPositionForBufferPosition(bufferRange.end, options);
    return new Range(start, end);
  }

  /**
   * @public
   * @status essential
   *
   * Convert a range in screen-coordinates to buffer-coordinates.
   *
   * @param {Range} screenRange - in screen coordinates to translate into buffer coordinates.
   * @returns {Range}
   */
  bufferRangeForScreenRange(screenRange) {
    screenRange = Range.fromObject(screenRange);
    const start = this.bufferPositionForScreenPosition(screenRange.start);
    const end = this.bufferPositionForScreenPosition(screenRange.end);
    return new Range(start, end);
  }

  /**
   * @public
   * @status extended
   *
   * Convert a rectangular block of screen positions -- the same two columns
   * across a span of screen rows -- to buffer coordinates in bulk.
   *
   * For each screen row from `startRow` through `endRow`, the returned entry
   * carries the buffer range delimited by `[row, startColumn]` and
   * `[row, endColumn]`, translated exactly as
   * {@link #bufferRangeForScreenRange} translates them, with default clipping.
   * Columns beyond the end of a row's screen line clip to the end of that
   * line.
   *
   * When both columns clip to the same buffer position the entry's range is
   * empty, and `screenColumn` reports the screen column that position
   * occupies -- what {@link #screenPositionForBufferPosition} would return
   * for it. That is the datum which tells a row whose text ends before the
   * block apart from a row the block genuinely intersects. For non-empty
   * ranges `screenColumn` is `null`.
   *
   * This is equivalent to calling {@link #bufferRangeForScreenRange} once per
   * row, but the display layer walks its spatial index over the whole span a
   * single time, which is substantially faster for large blocks.
   *
   * @param {Number} startRow - The first screen row of the block.
   * @param {Number} endRow - The last screen row of the block, inclusive. Must be at least `startRow`.
   * @param {Number} startColumn - The screen column of the block's first edge.
   * @param {Number} endColumn - The screen column of the block's second edge. May be less than `startColumn`; the two are translated in the order given.
   * @returns {Array} of `{bufferRange, screenColumn}` objects, one per screen row, where `bufferRange` is a {@link Range} and `screenColumn` is a `Number` or `null`.
   */
  bufferRangesForScreenColumnBlock(startRow, endRow, startColumn, endColumn) {
    return this.displayLayer.translateScreenColumnBlock(startRow, endRow, startColumn, endColumn);
  }

  /**
   * @public
   * @status extended
   *
   * Clip the given {@link Point} to a valid position in the buffer.
   *
   * If the given {@link Point} describes a position that is actually reachable by the
   * cursor based on the current contents of the buffer, it is returned
   * unchanged. If the {@link Point} does not describe a valid position, the closest
   * valid position is returned instead.
   *
   * ## Examples
   *
   * ```js
   * editor.clipBufferPosition([-1, -1]) // -> `[0, 0]`
   *
   * // When the line at buffer row 2 is 10 characters long
   * editor.clipBufferPosition([2, Infinity]) // -> `[2, 10]`
   * ```
   *
   * @param bufferPosition - The {@link Point} representing the position to clip.
   * @returns {Point}
   */
  clipBufferPosition(bufferPosition) {
    return this.buffer.clipPosition(bufferPosition);
  }

  /**
   * @public
   * @status extended
   *
   * Clip the start and end of the given range to valid positions in the
   * buffer. See {@link #clipBufferPosition} for more information.
   *
   * @param range - The {@link Range} to clip.
   * @returns {Range}
   */
  clipBufferRange(range) {
    return this.buffer.clipRange(range);
  }

  /**
   * @public
   * @status extended
   *
   * Clip the given {@link Point} to a valid position on screen.
   *
   * If the given {@link Point} describes a position that is actually reachable by the
   * cursor based on the current contents of the screen, it is returned
   * unchanged. If the {@link Point} does not describe a valid position, the closest
   * valid position is returned instead.
   *
   * ## Examples
   *
   * ```js
   * editor.clipScreenPosition([-1, -1]) // -> `[0, 0]`
   *
   * // When the line at screen row 2 is 10 characters long
   * editor.clipScreenPosition([2, Infinity]) // -> `[2, 10]`
   * ```
   *
   * @param screenPosition - The {@link Point} representing the position to clip.
   * @param {Object} [options]
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {Point} The clipped screen position.
   */
  clipScreenPosition(screenPosition, options) {
    return this.displayLayer.clipScreenPosition(screenPosition, options);
  }

  /**
   * @public
   * @status extended
   *
   * Clip the start and end of the given range to valid positions on screen.
   * See {@link #clipScreenPosition} for more information.
   *
   * @param screenRange - The {@link Range} to clip.
   * @param [options] - See {@link #clipScreenPosition} `options`.
   * @returns {Range}
   */
  clipScreenRange(screenRange, options) {
    screenRange = Range.fromObject(screenRange);
    const start = this.displayLayer.clipScreenPosition(screenRange.start, options);
    const end = this.displayLayer.clipScreenPosition(screenRange.end, options);
    return Range(start, end);
  }

  /**
   * @category Decorations
   */

  /**
   * @public
   * @status essential
   *
   * Add a decoration that tracks a {@link DisplayMarker}. When the
   * marker moves, is invalidated, or is destroyed, the decoration will be
   * updated to reflect the marker's state.
   *
   * The following are the supported decorations types:
   *
   * * __line__: Adds the given CSS `class` to the lines overlapping the rows
   *     spanned by the marker.
   * * __line-number__: Adds the given CSS `class` to the line numbers overlapping
   *     the rows spanned by the marker
   * * __text__: Injects spans into all text overlapping the marked range, then adds
   *     the given `class` or `style` to these spans. Use this to manipulate the foreground
   *     color or styling of text in a range.
   * * __highlight__: Creates an absolutely-positioned `.highlight` div to the editor
   *     containing nested divs that cover the marked region. For example, when the user
   *     selects text, the selection is implemented with a highlight decoration. The structure
   *     of this highlight will be:
   *     ```html
   *     <div class="highlight <your-class>">
   *       <!-- Will be one region for each row in the range. Spans 2 lines? There will be 2 regions. -->
   *       <div class="region"></div>
   *     </div>
   *     ```
   * * __overlay__: Positions the view associated with the given item at the head
   *     or tail of the given `DisplayMarker`, depending on the `position` property.
   * * __gutter__: Tracks a {@link DisplayMarker} in a {@link Gutter}. Gutter decorations are created
   *     by calling {@link Gutter#decorateMarker} on the desired `Gutter` instance.
   * * __block__: Positions the view associated with the given item before or
   *     after the row of the given {@link DisplayMarker}, depending on the `position` property.
   *     Block decorations at the same screen row are ordered by their `order` property.
   *     A block item takes the editor's selection background whenever its visual position
   *     before or after that row lies within a non-empty selection.
   * * __cursor__: Render a cursor at the head of the {@link DisplayMarker}. If multiple cursor decorations
   *     are created for the same marker, their class strings and style objects are combined
   *     into a single cursor. This decoration type may be used to style existing cursors
   *     by passing in their markers or to render artificial cursors that don't actually
   *     exist in the model by passing a marker that isn't associated with a real cursor.
   *
   * ## Arguments
   *
   *
   *      An overlay that can have neither side — the one it asked for is taken,
   *      the other will not fit — is pushed clear of whatever is in its way
   *      rather than drawn over it, and the wrapper is marked
   *      `data-overlay-displaced` to say it is no longer touching its line.
   *
   * @param marker - A {@link DisplayMarker} you want this decoration to follow.
   * @param decorationParams - An `Object` representing the decoration e.g. `{type: 'line-number', class: 'linter-error'}`
   * @param decorationParams.type - Determines the behavior and appearance of this {@link Decoration}. Supported decoration types and their uses are listed above.
   * @param decorationParams.class - This CSS class will be applied to the decorated line number, line, text spans, highlight regions, cursors, or overlay.
   * @param decorationParams.style - An `Object` containing CSS style properties to apply to the relevant DOM node. Currently this only works with a `type` of `cursor` or `text`.
   * @param [decorationParams.item] - An `HTMLElement` or a model `Object` with a corresponding view registered. Only applicable to the `gutter`, `overlay` and `block` decoration types.
   * @param [decorationParams.onlyHead] - If `true`, the decoration will only be applied to the head of the `DisplayMarker`. Only applicable to the `line` and `line-number` decoration types.
   * @param [decorationParams.onlyEmpty] - If `true`, the decoration will only be applied if the associated `DisplayMarker` is empty. Only applicable to the `gutter`, `line`, and `line-number` decoration types.
   * @param [decorationParams.onlyNonEmpty] - If `true`, the decoration will only be applied if the associated `DisplayMarker` is non-empty. Only applicable to the `gutter`, `line`, and `line-number` decoration types.
   * @param [decorationParams.omitEmptyLastRow] - If `false`, the decoration will be applied to the last row of a non-empty range, even if it ends at column 0. Defaults to `true`. Only applicable to the `gutter`, `line`, and `line-number` decoration types.
   * @param [decorationParams.position] - Only applicable to decorations of type `overlay` and `block`. Controls where the view is positioned relative to the `TextEditorMarker`. Values can be `'head'` (the default) or `'tail'` for overlay decorations, and `'before'` (the default) or `'after'` for block decorations.
   * @param [decorationParams.order] - Only applicable to decorations of type `block`. Controls where the view is positioned relative to other block decorations at the same screen row. If unspecified, block decorations render oldest to newest.
   * @param [decorationParams.avoidOverflow] - Only applicable to decorations of type `overlay`. Determines whether the decoration adjusts its horizontal or vertical position to remain fully visible when it would otherwise overflow the editor. Defaults to `true`. An overlay that opts out is neither moved by nor an obstacle to the placement described below.
   * @param [decorationParams.side] - Only applicable to decorations of type `overlay`. The side of the line the overlay asks for, `'above'` or `'below'` (the default). It is a request, not a guarantee: an overlay takes the other side when the one it asked for will not fit the window or is already taken, and the side it ended up on is reported back on the wrapper as `data-overlay-position`.
   * @param [decorationParams.priority] - Only applicable to decorations of type `overlay`. When several overlays want the same side of the same line, the higher priority chooses first and the others work around it; it also decides which one paints on top. Defaults to `0`. The convention across the bundled packages is `autocomplete` 2, `intentions` 1, `hover` 0.
   * @returns {Decoration} created {@link Decoration} object.
   */
  decorateMarker(marker, decorationParams) {
    return this.decorationManager.decorateMarker(marker, decorationParams);
  }

  /**
   * @public
   * @status essential
   *
   * Add a decoration to every marker in the given marker layer. Can
   * be used to decorate a large number of markers without having to create and
   * manage many individual decorations.
   *
   * @param markerLayer - A {@link DisplayMarkerLayer} or {@link MarkerLayer} to decorate.
   * @param decorationParams - The same parameters that are passed to {@link TextEditor#decorateMarker}, except the `type` cannot be `overlay` or `gutter`.
   * @returns {LayerDecoration}
   */
  decorateMarkerLayer(markerLayer, decorationParams) {
    return this.decorationManager.decorateMarkerLayer(markerLayer, decorationParams);
  }

  // Deprecated: Get all the decorations within a screen row range on the default
  // layer.
  //
  // * `startScreenRow` the `Number` beginning screen row
  // * `endScreenRow` the `Number` end screen row (inclusive)
  //
  // Returns an `Object` of decorations in the form
  //  `{1: [{id: 10, type: 'line-number', class: 'someclass'}], 2: ...}`
  //   where the keys are {@link DisplayMarker} IDs, and the values are an array of decoration
  //   params objects attached to the marker.
  // Returns an empty object when no decorations are found
  decorationsForScreenRowRange(startScreenRow, endScreenRow) {
    return this.decorationManager.decorationsForScreenRowRange(startScreenRow, endScreenRow);
  }

  decorationsStateForScreenRowRange(startScreenRow, endScreenRow) {
    return this.decorationManager.decorationsStateForScreenRowRange(startScreenRow, endScreenRow);
  }

  /**
   * @public
   * @status extended
   *
   * Get all decorations.
   *
   * @param [propertyFilter] - An `Object` containing key value pairs that the returned decorations' properties must match.
   * @returns {Array} of {@link Decoration Decorations}.
   */
  getDecorations(propertyFilter) {
    return this.decorationManager.getDecorations(propertyFilter);
  }

  /**
   * @public
   * @status extended
   *
   * Get all decorations of type 'line'.
   *
   * @param [propertyFilter] - An `Object` containing key value pairs that the returned decorations' properties must match.
   * @returns {Array} of {@link Decoration Decorations}.
   */
  getLineDecorations(propertyFilter) {
    return this.decorationManager.getLineDecorations(propertyFilter);
  }

  /**
   * @public
   * @status extended
   *
   * Get all decorations of type 'line-number'.
   *
   * @param [propertyFilter] - An `Object` containing key value pairs that the returned decorations' properties must match.
   * @returns {Array} of {@link Decoration Decorations}.
   */
  getLineNumberDecorations(propertyFilter) {
    return this.decorationManager.getLineNumberDecorations(propertyFilter);
  }

  /**
   * @public
   * @status extended
   *
   * Get all decorations of type 'highlight'.
   *
   * @param [propertyFilter] - An `Object` containing key value pairs that the returned decorations' properties must match.
   * @returns {Array} of {@link Decoration Decorations}.
   */
  getHighlightDecorations(propertyFilter) {
    return this.decorationManager.getHighlightDecorations(propertyFilter);
  }

  /**
   * @public
   * @status extended
   *
   * Get all decorations of type 'overlay'.
   *
   * @param [propertyFilter] - An `Object` containing key value pairs that the returned decorations' properties must match.
   * @returns {Array} of {@link Decoration Decorations}.
   */
  getOverlayDecorations(propertyFilter) {
    return this.decorationManager.getOverlayDecorations(propertyFilter);
  }

  /**
   * @category Markers
   */

  /**
   * @public
   * @status essential
   *
   * Create a marker on the default marker layer with the given range
   * in buffer coordinates. This marker will maintain its logical location as the
   * buffer is changed, so if you mark a particular word, the marker will remain
   * over that word even if the word's location in the buffer changes.
   *
   * @param bufferRange - A {@link Range} or range-compatible `Array`
   * @param options - A hash of key-value pairs to associate with the marker. There are also reserved property names that have marker-specific meaning.
   * @param {Boolean} [options.maintainHistory] - Whether to store this marker's range before and after each change in the undo history. This allows the marker's position to be restored more accurately for certain undo/redo operations, but uses more time and memory. (default: false)
   * @param {Boolean} [options.reversed] - Creates the marker in a reversed orientation. (default: false)
   * @param {String} [options.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @returns {DisplayMarker}
   */
  markBufferRange(bufferRange, options) {
    return this.defaultMarkerLayer.markBufferRange(bufferRange, options);
  }

  /**
   * @public
   * @status essential
   *
   * Create a marker on the default marker layer with the given range
   * in screen coordinates. This marker will maintain its logical location as the
   * buffer is changed, so if you mark a particular word, the marker will remain
   * over that word even if the word's location in the buffer changes.
   *
   * @param screenRange - A {@link Range} or range-compatible `Array`
   * @param options - A hash of key-value pairs to associate with the marker. There are also reserved property names that have marker-specific meaning.
   * @param {Boolean} [options.maintainHistory] - Whether to store this marker's range before and after each change in the undo history. This allows the marker's position to be restored more accurately for certain undo/redo operations, but uses more time and memory. (default: false)
   * @param {Boolean} [options.reversed] - Creates the marker in a reversed orientation. (default: false)
   * @param {String} [options.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @returns {DisplayMarker}
   */
  markScreenRange(screenRange, options) {
    return this.defaultMarkerLayer.markScreenRange(screenRange, options);
  }

  /**
   * @public
   * @status essential
   *
   * Create a marker on the default marker layer with the given buffer
   * position and no tail. To group multiple markers together in their own
   * private layer, see {@link #addMarkerLayer}.
   *
   * @param bufferPosition - A {@link Point} or point-compatible `Array`
   * @param [options] - An `Object` with the following keys:
   * @param {String} [options.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @returns {DisplayMarker}
   */
  markBufferPosition(bufferPosition, options) {
    return this.defaultMarkerLayer.markBufferPosition(bufferPosition, options);
  }

  /**
   * @public
   * @status essential
   *
   * Create a marker on the default marker layer with the given screen
   * position and no tail. To group multiple markers together in their own
   * private layer, see {@link #addMarkerLayer}.
   *
   * @param screenPosition - A {@link Point} or point-compatible `Array`
   * @param [options] - An `Object` with the following keys:
   * @param {String} [options.invalidate] - Determines the rules by which changes to the buffer *invalidate* the marker. (default: 'overlap') It can be any of the following strategies, in order of fragility: * __never__: The marker is never marked as invalid. This is a good choice for markers representing selections in an editor. * __surround__: The marker is invalidated by changes that completely surround it. * __overlap__: The marker is invalidated by changes that surround the start or end of the marker. This is the default. * __inside__: The marker is invalidated by changes that extend into the inside of the marker. Changes that end at the marker's start or start at the marker's end do not invalidate the marker. * __touch__: The marker is invalidated by a change that touches the marked region in any way, including changes that end at the marker's start or start at the marker's end. This is the most fragile strategy.
   * @param {String} options.clipDirection - If `'backward'`, clips before an invalid position; if `'forward'`, clips after it; if `'closest'`, uses the nearest valid position. Defaults to `'closest'`.
   * @returns {DisplayMarker} The new marker.
   */
  markScreenPosition(screenPosition, options) {
    return this.defaultMarkerLayer.markScreenPosition(screenPosition, options);
  }

  /**
   * @public
   * @status essential
   *
   * Find all {@link DisplayMarker DisplayMarkers} on the default marker layer that
   * match the given properties.
   *
   * This method finds markers based on the given properties. Markers can be
   * associated with custom properties that will be compared with basic equality.
   * In addition, there are several special properties that will be compared
   * with the range of the markers rather than their properties.
   *
   * @param params - An `Object` containing properties that each returned marker must satisfy. Markers can be associated with custom properties, which are compared with basic equality. In addition, several reserved properties can be used to filter markers based on their current range:
   * @param params.startBufferRow - Only include markers starting at this row in buffer coordinates.
   * @param params.endBufferRow - Only include markers ending at this row in buffer coordinates.
   * @param params.containsBufferRange - Only include markers containing this {@link Range} or in range-compatible `Array` in buffer coordinates.
   * @param params.containsBufferPosition - Only include markers containing this {@link Point} or `Array` of `[row, column]` in buffer coordinates.
   * @returns {Array} of {@link DisplayMarker DisplayMarkers}
   */
  findMarkers(params) {
    return this.defaultMarkerLayer.findMarkers(params);
  }

  /**
   * @public
   * @status extended
   *
   * Get the {@link DisplayMarker} on the default layer for the given
   * marker id.
   *
   * @param {Number} id - id of the marker
   */
  getMarker(id) {
    return this.defaultMarkerLayer.getMarker(id);
  }

  /**
   * @public
   * @status extended
   *
   * Get all {@link DisplayMarker DisplayMarkers} on the default marker layer. Consider
   * using {@link #findMarkers}
   */
  getMarkers() {
    return this.defaultMarkerLayer.getMarkers();
  }

  /**
   * @public
   * @status extended
   *
   * Get the number of markers in the default marker layer.
   *
   * @returns {Number}
   */
  getMarkerCount() {
    return this.defaultMarkerLayer.getMarkerCount();
  }

  destroyMarker(id) {
    const marker = this.getMarker(id);
    if (marker) marker.destroy();
  }

  /**
   * @public
   * @status essential
   *
   * Create a marker layer to group related markers.
   *
   * @param options - An `Object` containing the following keys:
   * @param options.maintainHistory - A `Boolean` indicating whether marker state should be restored on undo/redo. Defaults to `false`.
   * @param options.persistent - A `Boolean` indicating whether or not this marker layer should be serialized and deserialized along with the rest of the buffer. Defaults to `false`. If `true`, the marker layer's id will be maintained across the serialization boundary, allowing you to retrieve it via {@link #getMarkerLayer}.
   * @returns {DisplayMarkerLayer}
   */
  addMarkerLayer(options) {
    return this.displayLayer.addMarkerLayer(options);
  }

  /**
   * @public
   * @status essential
   *
   * Get a {@link DisplayMarkerLayer} by id.
   *
   * @param id - The id of the marker layer to retrieve.
   * @returns {DisplayMarkerLayer} or `undefined` if no layer exists with the given id.
   */
  getMarkerLayer(id) {
    return this.displayLayer.getMarkerLayer(id);
  }

  /**
   * @public
   * @status essential
   *
   * Get the default {@link DisplayMarkerLayer}.
   *
   * All marker APIs not tied to an explicit layer interact with this default
   * layer.
   *
   * @returns {DisplayMarkerLayer}
   */
  getDefaultMarkerLayer() {
    return this.defaultMarkerLayer;
  }

  /**
   * @category Cursors
   */

  /**
   * @public
   * @status essential
   *
   * Get the position of the most recently added cursor in buffer
   * coordinates.
   *
   * @returns {Point}
   */
  getCursorBufferPosition() {
    return this.getLastCursor().getBufferPosition();
  }

  /**
   * @public
   * @status essential
   *
   * Get the position of all the cursor positions in buffer coordinates.
   *
   * @returns {Array} of {@link Point Points} in the order they were added
   */
  getCursorBufferPositions() {
    return this.getCursors().map((cursor) => cursor.getBufferPosition());
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor to the given position in buffer coordinates.
   *
   * If there are multiple cursors, they will be consolidated to a single cursor.
   *
   * @param position - A {@link Point} or `Array` of `[row, column]`
   * @param [options] - An `Object` containing the following keys:
   * @param options.autoscroll - Determines whether the editor scrolls to the new cursor's position. Defaults to true.
   */
  setCursorBufferPosition(position, options) {
    return this.moveCursors((cursor) => cursor.setBufferPosition(position, options));
  }

  /**
   * @public
   * @status essential
   *
   * Get a {@link Cursor} at given screen coordinates {@link Point}
   *
   * @param position - A {@link Point} or `Array` of `[row, column]`
   * @returns {Cursor|undefined} first matched {@link Cursor} or undefined
   */
  getCursorAtScreenPosition(position) {
    const selection = this.getSelectionAtScreenPosition(position);
    if (selection && selection.getHeadScreenPosition().isEqual(position)) {
      return selection.cursor;
    }
  }

  /**
   * @public
   * @status essential
   *
   * Get the position of the most recently added cursor in screen
   * coordinates.
   *
   * @returns {Point}
   */
  getCursorScreenPosition() {
    return this.getLastCursor().getScreenPosition();
  }

  /**
   * @public
   * @status essential
   *
   * Get the position of all the cursor positions in screen coordinates.
   *
   * @returns {Array} of {@link Point Points} in the order the cursors were added
   */
  getCursorScreenPositions() {
    return this.getCursors().map((cursor) => cursor.getScreenPosition());
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor to the given position in screen coordinates.
   *
   * If there are multiple cursors, they will be consolidated to a single cursor.
   *
   * @param position - A {@link Point} or `Array` of `[row, column]`
   * @param [options] - An `Object` combining options for {@link #clipScreenPosition} with:
   * @param options.autoscroll - Determines whether the editor scrolls to the new cursor's position. Defaults to true.
   */
  setCursorScreenPosition(position, options) {
    return this.moveCursors((cursor) => cursor.setScreenPosition(position, options));
  }

  /**
   * @public
   * @status essential
   *
   * Add a cursor at the given position in buffer coordinates.
   *
   * @param bufferPosition - A {@link Point} or `Array` of `[row, column]`
   * @returns {Cursor}
   */
  addCursorAtBufferPosition(bufferPosition, options) {
    this.selectionsMarkerLayer.markBufferPosition(bufferPosition, {
      invalidate: "never",
    });
    if (!options || options.autoscroll !== false) this.getLastSelection().cursor.autoscroll();
    return this.getLastSelection().cursor;
  }

  /**
   * @public
   * @status essential
   *
   * Add a cursor at the position in screen coordinates.
   *
   * @param screenPosition - A {@link Point} or `Array` of `[row, column]`
   * @returns {Cursor}
   */
  addCursorAtScreenPosition(screenPosition, options) {
    this.selectionsMarkerLayer.markScreenPosition(screenPosition, {
      invalidate: "never",
    });
    if (!options || options.autoscroll !== false) this.getLastSelection().cursor.autoscroll();
    return this.getLastSelection().cursor;
  }

  /**
   * @public
   * @status essential
   *
   * @returns {Boolean} indicating whether or not there are multiple cursors.
   */
  hasMultipleCursors() {
    return this.getCursors().length > 1;
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor up one row in screen coordinates.
   *
   * @param {Number} [lineCount] - number of lines to move
   */
  moveUp(lineCount) {
    return this.moveCursors((cursor) => cursor.moveUp(lineCount, { moveToEndOfSelection: true }));
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor down one row in screen coordinates.
   *
   * @param {Number} [lineCount] - number of lines to move
   */
  moveDown(lineCount) {
    return this.moveCursors((cursor) => cursor.moveDown(lineCount, { moveToEndOfSelection: true }));
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor left one column.
   *
   * @param {Number} [columnCount] - number of columns to move (default: 1)
   */
  moveLeft(columnCount) {
    return this.moveCursors((cursor) =>
      cursor.moveLeft(columnCount, { moveToEndOfSelection: true }),
    );
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor right one column.
   *
   * @param {Number} [columnCount] - number of columns to move (default: 1)
   */
  moveRight(columnCount) {
    return this.moveCursors((cursor) =>
      cursor.moveRight(columnCount, { moveToEndOfSelection: true }),
    );
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor to the beginning of its line in buffer coordinates.
   */
  moveToBeginningOfLine() {
    return this.moveCursors((cursor) => cursor.moveToBeginningOfLine());
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor to the beginning of its line in screen coordinates.
   */
  moveToBeginningOfScreenLine() {
    return this.moveCursors((cursor) => cursor.moveToBeginningOfScreenLine());
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor to the first non-whitespace character of its line.
   */
  moveToFirstCharacterOfLine() {
    return this.moveCursors((cursor) => cursor.moveToFirstCharacterOfLine());
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor to the end of its line in buffer coordinates.
   */
  moveToEndOfLine() {
    return this.moveCursors((cursor) => cursor.moveToEndOfLine());
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor to the end of its line in screen coordinates.
   */
  moveToEndOfScreenLine() {
    return this.moveCursors((cursor) => cursor.moveToEndOfScreenLine());
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor to the beginning of its surrounding word.
   */
  moveToBeginningOfWord() {
    return this.moveCursors((cursor) => cursor.moveToBeginningOfWord());
  }

  /**
   * @public
   * @status essential
   *
   * Move every cursor to the end of its surrounding word.
   */
  moveToEndOfWord() {
    return this.moveCursors((cursor) => cursor.moveToEndOfWord());
  }

  // Cursor Extended

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the top of the buffer.
   *
   * If there are multiple cursors, they will be merged into a single cursor.
   */
  moveToTop() {
    return this.moveCursors((cursor) => cursor.moveToTop());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the bottom of the buffer.
   *
   * If there are multiple cursors, they will be merged into a single cursor.
   */
  moveToBottom() {
    return this.moveCursors((cursor) => cursor.moveToBottom());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the beginning of the next word.
   */
  moveToBeginningOfNextWord() {
    return this.moveCursors((cursor) => cursor.moveToBeginningOfNextWord());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the previous word boundary.
   */
  moveToPreviousWordBoundary() {
    return this.moveCursors((cursor) => cursor.moveToPreviousWordBoundary());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the next word boundary.
   */
  moveToNextWordBoundary() {
    return this.moveCursors((cursor) => cursor.moveToNextWordBoundary());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the previous subword boundary.
   */
  moveToPreviousSubwordBoundary() {
    return this.moveCursors((cursor) => cursor.moveToPreviousSubwordBoundary());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the next subword boundary.
   */
  moveToNextSubwordBoundary() {
    return this.moveCursors((cursor) => cursor.moveToNextSubwordBoundary());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the beginning of the next paragraph.
   */
  moveToBeginningOfNextParagraph() {
    return this.moveCursors((cursor) => cursor.moveToBeginningOfNextParagraph());
  }

  /**
   * @public
   * @status extended
   *
   * Move every cursor to the beginning of the previous paragraph.
   */
  moveToBeginningOfPreviousParagraph() {
    return this.moveCursors((cursor) => cursor.moveToBeginningOfPreviousParagraph());
  }

  /**
   * @public
   * @status extended
   *
   * @returns {Cursor} most recently added {@link Cursor}
   */
  getLastCursor() {
    this.createLastSelectionIfNeeded();
    return _.last(this.cursors);
  }

  /**
   * @public
   * @status extended
   *
   * @param [options] - See {@link Cursor#getBeginningOfCurrentWordBufferPosition}.
   * @returns {String} word surrounding the most recently added cursor.
   */
  getWordUnderCursor(options) {
    return this.getTextInBufferRange(this.getLastCursor().getCurrentWordBufferRange(options));
  }

  /**
   * @public
   * @status extended
   *
   * Get an Array of all {@link Cursor Cursors}.
   */
  getCursors() {
    this.createLastSelectionIfNeeded();
    return this.cursors.slice();
  }

  /**
   * @public
   * @status extended
   *
   * Get all {@link Cursor Cursors}, ordered by their position in the buffer
   * instead of the order in which they were added.
   *
   * @returns {Array} of {@link Selection Selections}.
   */
  getCursorsOrderedByBufferPosition() {
    return this.getCursors().sort((a, b) => a.compare(b));
  }

  cursorsForScreenRowRange(startScreenRow, endScreenRow) {
    const cursors = [];
    for (let marker of this.selectionsMarkerLayer.findMarkers({
      intersectsScreenRowRange: [startScreenRow, endScreenRow],
    })) {
      const cursor = this.cursorsByMarkerId.get(marker.id);
      if (cursor) cursors.push(cursor);
    }
    return cursors;
  }

  // Add a cursor based on the given {@link DisplayMarker}.
  addCursor(marker) {
    const cursor = new Cursor({
      editor: this,
      marker,
    });
    this.cursors.push(cursor);
    this.cursorsByMarkerId.set(marker.id, cursor);
    return cursor;
  }

  moveCursors(fn) {
    return this.transact(() => {
      this.getCursors().forEach(fn);
      return this.mergeCursors();
    });
  }

  cursorMoved(event) {
    return this.emitter.emit("did-change-cursor-position", event);
  }

  // Merge cursors that have the same screen position
  mergeCursors() {
    const positions = {};
    const doomed = [];
    for (let cursor of this.getCursors()) {
      const position = cursor.getBufferPosition().toString();
      if (Object.hasOwn(positions, position)) {
        // A cursor and its selection share one marker, so destroying either
        // destroys both; the selection is the handle the batch takes.
        doomed.push(cursor.selection);
      } else {
        positions[position] = true;
      }
    }
    this.destroySelections(doomed);
  }

  /**
   * @category Selections
   */

  /**
   * @public
   * @status essential
   *
   * Get the selected text of the most recently added selection.
   *
   * @returns {String}
   */
  getSelectedText() {
    return this.getLastSelection().getText();
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Range} of the most recently added selection in buffer
   * coordinates.
   *
   * @returns {Range}
   */
  getSelectedBufferRange() {
    return this.getLastSelection().getBufferRange();
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Range Ranges} of all selections in buffer coordinates.
   *
   * The ranges are sorted by when the selections were added. Most recent at the end.
   *
   * @returns {Array} of {@link Range Ranges}.
   */
  getSelectedBufferRanges() {
    return this.getSelections().map((selection) => selection.getBufferRange());
  }

  /**
   * @public
   * @status essential
   *
   * Set the selected range in buffer coordinates. If there are multiple
   * selections, they are reduced to a single selection with the given range.
   *
   * @param bufferRange - A {@link Range} or range-compatible `Array`.
   * @param [options] - An `Object` of options:
   * @param options.reversed - A `Boolean` indicating whether to create the selection in a reversed orientation.
   * @param options.preserveFolds - A `Boolean`, which if `true` preserves the fold settings after the selection is set.
   */
  setSelectedBufferRange(bufferRange, options) {
    return this.setSelectedBufferRanges([bufferRange], options);
  }

  /**
   * @public
   * @status essential
   *
   * Set the selected ranges in buffer coordinates. If there are multiple
   * selections, they are replaced by new selections with the given ranges.
   *
   * @param bufferRanges - An `Array` of {@link Range Ranges} or range-compatible `Arrays`.
   * @param [options] - An `Object` of options:
   * @param options.reversed - A `Boolean` indicating whether to create the selection in a reversed orientation.
   * @param options.preserveFolds - A `Boolean`, which if `true` preserves the fold settings after the selection is set.
   */
  setSelectedBufferRanges(bufferRanges, options = {}) {
    if (!bufferRanges.length) throw new Error("Passed an empty array to setSelectedBufferRanges");

    const selections = this.getSelections();
    this.destroySelections(selections.slice(bufferRanges.length));

    this.mergeIntersectingSelections(options, () => {
      for (let i = 0; i < bufferRanges.length; i++) {
        let bufferRange = bufferRanges[i];
        bufferRange = Range.fromObject(bufferRange);
        if (selections[i]) {
          selections[i].setBufferRange(bufferRange, options);
        } else {
          this.addSelectionForBufferRange(bufferRange, options);
        }
      }
    });
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Range} of the most recently added selection in screen
   * coordinates.
   *
   * @returns {Range}
   */
  getSelectedScreenRange() {
    return this.getLastSelection().getScreenRange();
  }

  /**
   * @public
   * @status essential
   *
   * Get the {@link Range Ranges} of all selections in screen coordinates.
   *
   * The ranges are sorted by when the selections were added. Most recent at the end.
   *
   * @returns {Array} of {@link Range Ranges}.
   */
  getSelectedScreenRanges() {
    return this.getSelections().map((selection) => selection.getScreenRange());
  }

  /**
   * @public
   * @status essential
   *
   * Set the selected range in screen coordinates. If there are multiple
   * selections, they are reduced to a single selection with the given range.
   *
   * @param screenRange - A {@link Range} or range-compatible `Array`.
   * @param [options] - An `Object` of options:
   * @param options.reversed - A `Boolean` indicating whether to create the selection in a reversed orientation.
   */
  setSelectedScreenRange(screenRange, options) {
    return this.setSelectedBufferRange(
      this.bufferRangeForScreenRange(screenRange, options),
      options,
    );
  }

  /**
   * @public
   * @status essential
   *
   * Set the selected ranges in screen coordinates. If there are multiple
   * selections, they are replaced by new selections with the given ranges.
   *
   * @param screenRanges - An `Array` of {@link Range Ranges} or range-compatible `Arrays`.
   * @param [options] - An `Object` of options:
   * @param options.reversed - A `Boolean` indicating whether to create the selection in a reversed orientation.
   */
  setSelectedScreenRanges(screenRanges, options = {}) {
    if (!screenRanges.length) throw new Error("Passed an empty array to setSelectedScreenRanges");

    const selections = this.getSelections();
    this.destroySelections(selections.slice(screenRanges.length));

    this.mergeIntersectingSelections(options, () => {
      for (let i = 0; i < screenRanges.length; i++) {
        let screenRange = screenRanges[i];
        screenRange = Range.fromObject(screenRange);
        if (selections[i]) {
          selections[i].setScreenRange(screenRange, options);
        } else {
          this.addSelectionForScreenRange(screenRange, options);
        }
      }
    });
  }

  /**
   * @public
   * @status essential
   *
   * Add a selection for the given range in buffer coordinates.
   *
   * @param bufferRange - A {@link Range}
   * @param [options] - An `Object` of options:
   * @param options.reversed - A `Boolean` indicating whether to create the selection in a reversed orientation.
   * @param options.preserveFolds - A `Boolean`, which if `true` preserves the fold settings after the selection is set.
   * @returns {Selection} added {@link Selection}.
   */
  addSelectionForBufferRange(bufferRange, options = {}) {
    bufferRange = Range.fromObject(bufferRange);
    if (!options.preserveFolds) {
      this.displayLayer.destroyFoldsContainingBufferPositions(
        [bufferRange.start, bufferRange.end],
        true,
      );
    }
    this.selectionsMarkerLayer.markBufferRange(bufferRange, {
      invalidate: "never",
      reversed: options.reversed != null ? options.reversed : false,
    });
    if (options.autoscroll !== false) this.getLastSelection().autoscroll();
    return this.getLastSelection();
  }

  /**
   * @public
   * @status essential
   *
   * Add a selection for the given range in screen coordinates.
   *
   * @param screenRange - A {@link Range}
   * @param [options] - An `Object` of options:
   * @param options.reversed - A `Boolean` indicating whether to create the selection in a reversed orientation.
   * @param options.preserveFolds - A `Boolean`, which if `true` preserves the fold settings after the selection is set.
   * @returns {Selection} added {@link Selection}.
   */
  addSelectionForScreenRange(screenRange, options = {}) {
    return this.addSelectionForBufferRange(this.bufferRangeForScreenRange(screenRange), options);
  }

  /**
   * @public
   * @status essential
   *
   * Select from the current cursor position to the given position in
   * buffer coordinates.
   *
   * This method may merge selections that end up intersecting.
   *
   * @param position - An instance of {@link Point}, with a given `row` and `column`.
   */
  selectToBufferPosition(position) {
    const lastSelection = this.getLastSelection();
    lastSelection.selectToBufferPosition(position);
    return this.mergeIntersectingSelections({
      reversed: lastSelection.isReversed(),
    });
  }

  /**
   * @public
   * @status essential
   *
   * Select from the current cursor position to the given position in
   * screen coordinates.
   *
   * This method may merge selections that end up intersecting.
   *
   * @param position - An instance of {@link Point}, with a given `row` and `column`.
   */
  selectToScreenPosition(position, options) {
    const lastSelection = this.getLastSelection();
    lastSelection.selectToScreenPosition(position, options);
    if (!options || !options.suppressSelectionMerge) {
      return this.mergeIntersectingSelections({
        reversed: lastSelection.isReversed(),
      });
    }
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor of each selection one character upward while
   * preserving the selection's tail position.
   *
   *
   * This method may merge selections that end up intersecting.
   *
   * @param {Number} [rowCount] - number of rows to select (default: 1)
   */
  selectUp(rowCount) {
    return this.expandSelectionsBackward((selection) => selection.selectUp(rowCount));
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor of each selection one character downward while
   * preserving the selection's tail position.
   *
   *
   * This method may merge selections that end up intersecting.
   *
   * @param {Number} [rowCount] - number of rows to select (default: 1)
   */
  selectDown(rowCount) {
    return this.expandSelectionsForward((selection) => selection.selectDown(rowCount));
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor of each selection one character leftward while
   * preserving the selection's tail position.
   *
   *
   * This method may merge selections that end up intersecting.
   *
   * @param {Number} [columnCount] - number of columns to select (default: 1)
   */
  selectLeft(columnCount) {
    return this.expandSelectionsBackward((selection) => selection.selectLeft(columnCount));
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor of each selection one character rightward while
   * preserving the selection's tail position.
   *
   *
   * This method may merge selections that end up intersecting.
   *
   * @param {Number} [columnCount] - number of columns to select (default: 1)
   */
  selectRight(columnCount) {
    return this.expandSelectionsForward((selection) => selection.selectRight(columnCount));
  }

  /**
   * @public
   * @status essential
   *
   * Select from the top of the buffer to the end of the last selection
   * in the buffer.
   *
   * This method merges multiple selections into a single selection.
   */
  selectToTop() {
    return this.expandSelectionsBackward((selection) => selection.selectToTop());
  }

  /**
   * @public
   * @status essential
   *
   * Selects from the top of the first selection in the buffer to the end
   * of the buffer.
   *
   * This method merges multiple selections into a single selection.
   */
  selectToBottom() {
    return this.expandSelectionsForward((selection) => selection.selectToBottom());
  }

  /**
   * @public
   * @status essential
   *
   * Select all text in the buffer.
   *
   * This method merges multiple selections into a single selection.
   */
  selectAll() {
    return this.expandSelectionsForward((selection) => selection.selectAll());
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor of each selection to the beginning of its line
   * while preserving the selection's tail position.
   *
   * This method may merge selections that end up intersecting.
   */
  selectToBeginningOfLine() {
    return this.expandSelectionsBackward((selection) => selection.selectToBeginningOfLine());
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor of each selection to the first non-whitespace
   * character of its line while preserving the selection's tail position. If the
   * cursor is already on the first character of the line, move it to the
   * beginning of the line.
   *
   * This method may merge selections that end up intersecting.
   */
  selectToFirstCharacterOfLine() {
    return this.expandSelectionsBackward((selection) => selection.selectToFirstCharacterOfLine());
  }

  /**
   * @public
   * @status essential
   *
   * Move the cursor of each selection to the end of its line while
   * preserving the selection's tail position.
   *
   * This method may merge selections that end up intersecting.
   */
  selectToEndOfLine() {
    return this.expandSelectionsForward((selection) => selection.selectToEndOfLine());
  }

  /**
   * @public
   * @status essential
   *
   * Expand selections to the beginning of their containing word.
   *
   * Operates on all selections. Moves the cursor to the beginning of the
   * containing word while preserving the selection's tail position.
   */
  selectToBeginningOfWord() {
    return this.expandSelectionsBackward((selection) => selection.selectToBeginningOfWord());
  }

  /**
   * @public
   * @status essential
   *
   * Expand selections to the end of their containing word.
   *
   * Operates on all selections. Moves the cursor to the end of the containing
   * word while preserving the selection's tail position.
   */
  selectToEndOfWord() {
    return this.expandSelectionsForward((selection) => selection.selectToEndOfWord());
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, move its cursor to the preceding subword
   * boundary while maintaining the selection's tail position.
   *
   * This method may merge selections that end up intersecting.
   */
  selectToPreviousSubwordBoundary() {
    return this.expandSelectionsBackward((selection) =>
      selection.selectToPreviousSubwordBoundary(),
    );
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, move its cursor to the next subword boundary
   * while maintaining the selection's tail position.
   *
   * This method may merge selections that end up intersecting.
   */
  selectToNextSubwordBoundary() {
    return this.expandSelectionsForward((selection) => selection.selectToNextSubwordBoundary());
  }

  /**
   * @public
   * @status essential
   *
   * For each cursor, select the containing line.
   *
   * This method merges selections on successive lines.
   */
  selectLinesContainingCursors() {
    return this.expandSelectionsForward((selection) => selection.selectLine());
  }

  /**
   * @public
   * @status essential
   *
   * Select the word surrounding each cursor.
   */
  selectWordsContainingCursors() {
    return this.expandSelectionsForward((selection) => selection.selectWord());
  }

  /**
   * @public
   * @status extended
   *
   * Select the subword surrounding each cursor.
   */
  selectSubwordsContainingCursors() {
    return this.expandSelectionsForward((selection) => selection.selectSubword());
  }

  // Selection Extended

  /**
   * @public
   * @status extended
   *
   * For each selection, move its cursor to the preceding word boundary
   * while maintaining the selection's tail position.
   *
   * This method may merge selections that end up intersecting.
   */
  selectToPreviousWordBoundary() {
    return this.expandSelectionsBackward((selection) => selection.selectToPreviousWordBoundary());
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, move its cursor to the next word boundary while
   * maintaining the selection's tail position.
   *
   * This method may merge selections that end up intersecting.
   */
  selectToNextWordBoundary() {
    return this.expandSelectionsForward((selection) => selection.selectToNextWordBoundary());
  }

  /**
   * @public
   * @status extended
   *
   * Expand selections to the beginning of the next word.
   *
   * Operates on all selections. Moves the cursor to the beginning of the next
   * word while preserving the selection's tail position.
   */
  selectToBeginningOfNextWord() {
    return this.expandSelectionsForward((selection) => selection.selectToBeginningOfNextWord());
  }

  /**
   * @public
   * @status extended
   *
   * Expand selections to the beginning of the next paragraph.
   *
   * Operates on all selections. Moves the cursor to the beginning of the next
   * paragraph while preserving the selection's tail position.
   */
  selectToBeginningOfNextParagraph() {
    return this.expandSelectionsForward((selection) =>
      selection.selectToBeginningOfNextParagraph(),
    );
  }

  /**
   * @public
   * @status extended
   *
   * Expand selections to the beginning of the next paragraph.
   *
   * Operates on all selections. Moves the cursor to the beginning of the next
   * paragraph while preserving the selection's tail position.
   */
  selectToBeginningOfPreviousParagraph() {
    return this.expandSelectionsBackward((selection) =>
      selection.selectToBeginningOfPreviousParagraph(),
    );
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, select the syntax node that contains
   * that selection.
   */
  selectLargerSyntaxNode() {
    const languageMode = this.buffer.getLanguageMode();
    if (!languageMode.getRangeForSyntaxNodeContainingRange) return;

    this.expandSelectionsForward((selection) => {
      const currentRange = selection.getBufferRange();
      const newRange = languageMode.getRangeForSyntaxNodeContainingRange(currentRange);
      if (newRange) {
        if (!selection._rangeStack) selection._rangeStack = [];
        selection._rangeStack.push(currentRange);
        selection.setBufferRange(newRange);
      }
    });
  }

  /**
   * @public
   * @status extended
   *
   * Undo the effect of a preceding call to {@link #selectLargerSyntaxNode}.
   */
  selectSmallerSyntaxNode() {
    this.expandSelectionsForward((selection) => {
      if (selection._rangeStack) {
        const lastRange = selection._rangeStack[selection._rangeStack.length - 1];
        if (lastRange && selection.getBufferRange().containsRange(lastRange)) {
          selection._rangeStack.length--;
          selection.setBufferRange(lastRange);
        }
      }
    });
  }

  /**
   * @public
   * @status extended
   *
   * Select the range of the given marker if it is valid.
   *
   * @param marker - A {@link DisplayMarker}
   * @returns {Range|undefined} selected {@link Range} or `undefined` if the marker is invalid.
   */
  selectMarker(marker) {
    if (marker.isValid()) {
      const range = marker.getBufferRange();
      this.setSelectedBufferRange(range);
      return range;
    }
  }

  /**
   * @public
   * @status extended
   *
   * Get the most recently added {@link Selection}.
   *
   * @returns {Selection}
   */
  getLastSelection() {
    this.createLastSelectionIfNeeded();
    return _.last(this.selections);
  }

  getSelectionAtScreenPosition(position) {
    const markers = this.selectionsMarkerLayer.findMarkers({
      containsScreenPosition: position,
    });
    if (markers.length > 0) return this.cursorsByMarkerId.get(markers[0].id).selection;
  }

  /**
   * @public
   * @status extended
   *
   * Get current {@link Selection Selections}.
   *
   * @returns {Array<Selection>} The current selections.
   */
  getSelections() {
    this.createLastSelectionIfNeeded();
    return this.selections.slice();
  }

  /**
   * @public
   * @status extended
   *
   * Get all {@link Selection Selections}, ordered by their position in the buffer
   * instead of the order in which they were added.
   *
   * @returns {Array} of {@link Selection Selections}.
   */
  getSelectionsOrderedByBufferPosition() {
    return this.getSelections().sort((a, b) => a.compare(b));
  }

  /**
   * @public
   * @status extended
   *
   * Determine if a given range in buffer coordinates intersects a
   * selection.
   *
   * @param bufferRange - A {@link Range} or range-compatible `Array`.
   * @returns {Boolean}
   */
  selectionIntersectsBufferRange(bufferRange) {
    return this.getSelections().some((selection) => selection.intersectsBufferRange(bufferRange));
  }

  /**
   * @public
   * @status extended
   *
   * Destroy the given {@link Selection Selections} as one batch.
   *
   * Emits `did-remove-cursor` and `did-remove-selection` once per selection, in
   * the order given, exactly as destroying each one in turn would. What changes
   * is the bookkeeping: the selection and cursor lists are compacted once for
   * the whole batch rather than rescanned and spliced once per selection, which
   * is what makes discarding thousands of selections linear rather than
   * quadratic.
   *
   * Selections that are already destroyed are ignored.
   *
   * @param selections - An `Array` of {@link Selection Selections}.
   */
  destroySelections(selections) {
    // One selection is the overwhelmingly common case and the prologue would be
    // pure overhead. A destroyed editor never reaches `removeSelection` at all,
    // so its lists must not be compacted behind its back, and a nested call is
    // already covered by the batch that is running.
    if (selections.length < 2 || this.isDestroyed() || this.batchedSelectionRemovals) {
      for (const selection of selections) selection.destroy();
      return;
    }

    const doomed = [];
    const doomedSelections = new Set();
    const doomedCursors = new Set();
    for (const selection of selections) {
      if (selection.destroyed || doomedSelections.has(selection)) continue;
      doomed.push(selection);
      doomedSelections.add(selection);
      doomedCursors.add(selection.cursor);
      this.cursorsByMarkerId.delete(selection.cursor.marker.id);
    }
    if (doomed.length === 0) return;

    // Compacted before the first marker is destroyed, so that every callback
    // the destruction fires sees the lists it would have seen after the last
    // individual removal: survivors only, and every one of them still alive.
    // Packages do read these lists from inside a removal handler and go on to
    // decorate what they find there, and a destroyed marker cannot be
    // decorated. `doomed` is a separate array because compacting empties the
    // caller's when it passed the live list itself.
    compactInPlace(this.cursors, doomedCursors);
    compactInPlace(this.selections, doomedSelections);

    this.batchedSelectionRemovals = doomedSelections;
    try {
      for (const selection of doomed) selection.destroy();
    } finally {
      this.batchedSelectionRemovals = null;
    }
  }

  // Selections Private

  // Add a similarly-shaped selection to the next eligible line below
  // each selection.
  //
  // Operates on all selections. If the selection is empty, adds an empty
  // selection to the next following non-empty line as close to the current
  // selection's column as possible. If the selection is non-empty, adds a
  // selection to the next line that is long enough for a non-empty selection
  // starting at the same column as the current selection to be added to it.
  addSelectionBelow() {
    return this.expandSelectionsForward((selection) => selection.addSelectionBelow());
  }

  // Add a similarly-shaped selection to the next eligible line above
  // each selection.
  //
  // Operates on all selections. If the selection is empty, adds an empty
  // selection to the next preceding non-empty line as close to the current
  // selection's column as possible. If the selection is non-empty, adds a
  // selection to the next line that is long enough for a non-empty selection
  // starting at the same column as the current selection to be added to it.
  addSelectionAbove() {
    return this.expandSelectionsBackward((selection) => selection.addSelectionAbove());
  }

  // Calls the given function with each selection, then merges selections
  expandSelectionsForward(fn) {
    this.mergeIntersectingSelections(() => this.getSelections().forEach(fn));
  }

  // Calls the given function with each selection, then merges selections in the
  // reversed orientation
  expandSelectionsBackward(fn) {
    this.mergeIntersectingSelections({ reversed: true }, () => this.getSelections().forEach(fn));
  }

  finalizeSelections() {
    for (let selection of this.getSelections()) {
      selection.finalize();
    }
  }

  selectionsForScreenRows(startRow, endRow) {
    return this.getSelections().filter((selection) =>
      selection.intersectsScreenRowRange(startRow, endRow),
    );
  }

  // Merges intersecting selections. If passed a function, it executes
  // the function with merging suppressed, then merges intersecting selections
  // afterward.
  mergeIntersectingSelections(...args) {
    return this.mergeSelections(...args, (previousSelection, currentSelection) => {
      const exclusive = !currentSelection.isEmpty() && !previousSelection.isEmpty();
      return previousSelection.intersectsWith(currentSelection, exclusive);
    });
  }

  mergeSelectionsOnSameRows(...args) {
    return this.mergeSelections(...args, (previousSelection, currentSelection) => {
      const screenRange = currentSelection.getScreenRange();
      return previousSelection.intersectsScreenRowRange(screenRange.start.row, screenRange.end.row);
    });
  }

  // Runs the function with selection merging suppressed, and merges nothing
  // afterwards. This used to delegate to mergeSelections with a predicate that
  // always answered false -- which still sorted every selection by buffer
  // position on the way out, only to feed each neighbouring pair to a
  // predicate that cannot say yes. For a caller holding thousands of
  // selections, undo and redo among them, that sort was the whole cost of the
  // call.
  //
  // Two behaviors of the old sweep are deliberately kept. Reading the
  // selection list resurrected one when the function had destroyed them all,
  // so an editor never comes back from this with no selection; and a throwing
  // function skipped the sweep, so it skips the resurrection too.
  avoidMergingSelections(...args) {
    let fn = args.pop();
    if (typeof fn !== "function") fn = () => {};

    if (this.suppressSelectionMerging) return fn();

    this.suppressSelectionMerging = true;
    let result;
    try {
      result = fn();
    } finally {
      this.suppressSelectionMerging = false;
    }
    this.createLastSelectionIfNeeded();
    return result;
  }

  mergeSelections(...args) {
    return this.buffer.batchMarkerLayerUpdates(() => {
      const mergePredicate = args.pop();
      let fn = args.pop();
      let options = args.pop();
      if (typeof fn !== "function") {
        options = fn;
        fn = () => {};
      }

      if (this.suppressSelectionMerging) return fn();

      // Restored on the way out however the callback leaves: a throw used to
      // strand the flag set, which silently disables merging for the rest of this
      // editor's life rather than failing where the fault is.
      this.suppressSelectionMerging = true;
      let result;
      try {
        result = fn();
      } finally {
        this.suppressSelectionMerging = false;
      }

      const selections = this.getSelectionsOrderedByBufferPosition();
      let lastSelection = selections.shift();
      for (const selection of selections) {
        if (mergePredicate(lastSelection, selection)) {
          lastSelection.merge(selection, options);
        } else {
          lastSelection = selection;
        }
      }

      return result;
    });
  }

  // Add a {@link Selection} based on the given {@link DisplayMarker}.
  //
  // * `marker` The {@link DisplayMarker} to highlight
  // * `options` (optional) An `Object` that pertains to the {@link Selection} constructor.
  //
  // Returns the new {@link Selection}.
  addSelection(marker, options = {}) {
    const cursor = this.addCursor(marker);
    let selection = new Selection(Object.assign({ editor: this, marker, cursor }, options));
    this.selections.push(selection);
    const selectionBufferRange = selection.getBufferRange();
    this.mergeIntersectingSelections({ preserveFolds: options.preserveFolds });

    if (selection.destroyed) {
      for (selection of this.getSelections()) {
        if (selection.intersectsBufferRange(selectionBufferRange)) return selection;
      }
    } else {
      this.emitter.emit("did-add-cursor", cursor);
      this.emitter.emit("did-add-selection", selection);
      return selection;
    }
  }

  // Remove the given selection.
  removeSelection(selection) {
    // Inside a `destroySelections` batch this selection and its cursor were
    // taken out of both lists up front along with the rest of the batch, and
    // only the events are still owed. The membership test rather than a bare
    // flag is what lets a selection destroyed re-entrantly from one of those
    // events still remove itself the ordinary way.
    if (!this.batchedSelectionRemovals || !this.batchedSelectionRemovals.delete(selection)) {
      _.remove(this.cursors, selection.cursor);
      _.remove(this.selections, selection);
      this.cursorsByMarkerId.delete(selection.cursor.marker.id);
    }
    this.emitter.emit("did-remove-cursor", selection.cursor);
    return this.emitter.emit("did-remove-selection", selection);
  }

  // Reduce one or more selections to a single empty selection based on the most
  // recently added cursor.
  clearSelections(options) {
    this.consolidateSelections();
    this.getLastSelection().clear(options);
  }

  // Reduce multiple selections to the most recently added selection.
  consolidateSelections() {
    const selections = this.getSelections();
    if (selections.length > 1) {
      const lastSelection = selections.pop();
      this.destroySelections(selections);
      lastSelection.autoscroll({ center: false });
      return true;
    } else {
      return false;
    }
  }

  // Called by the selection
  selectionRangeChanged(event) {
    if (this.component) this.component.didChangeSelectionRange();
    this.emitter.emit("did-change-selection-range", event);
  }

  createLastSelectionIfNeeded() {
    if (this.selections.length === 0) {
      this.addSelectionForBufferRange(
        [
          [0, 0],
          [0, 0],
        ],
        {
          autoscroll: false,
          preserveFolds: true,
        },
      );
    }
  }

  /**
   * @category Searching and Replacing
   */

  /**
   * @public
   * @status essential
   *
   * Scan regular expression matches in the entire buffer, calling the
   * given iterator function on each match.
   *
   * `::scan` functions as the replace method as well via the `replace`
   *
   * If you're programmatically modifying the results, you may want to try
   * {@link #backwardsScanInBufferRange} to avoid tripping over your own changes.
   *
   * @param regex - A `RegExp` to search for.
   * @param {Object} [options]
   * @param {Number} options.leadingContextLineCount - default `0`; The number of lines before the matched line to include in the results object.
   * @param {Number} options.trailingContextLineCount - default `0`; The number of lines after the matched line to include in the results object.
   * @param iterator - A `Function` that's called on each match
   * @param {Object} iterator.object
   * @param iterator.object.match - The current regular expression match.
   * @param iterator.object.matchText - A `String` with the text of the match.
   * @param iterator.object.range - The {@link Range} of the match.
   * @param iterator.object.stop - Call this `Function` to terminate the scan.
   * @param iterator.object.replace - Call this `Function` with a `String` to replace the match.
   */
  scan(regex, options = {}, iterator) {
    if (_.isFunction(options)) {
      iterator = options;
      options = {};
    }

    return this.buffer.scan(regex, options, iterator);
  }

  /**
   * @public
   * @status essential
   *
   * Scan regular expression matches in a given range, calling the given
   * iterator function on each match.
   *
   * @param regex - A `RegExp` to search for.
   * @param range - A {@link Range} in which to search.
   * @param iterator - A `Function` that's called on each match with an `Object` containing the following keys:
   * @param iterator.match - The current regular expression match.
   * @param iterator.matchText - A `String` with the text of the match.
   * @param iterator.range - The {@link Range} of the match.
   * @param iterator.stop - Call this `Function` to terminate the scan.
   * @param iterator.replace - Call this `Function` with a `String` to replace the match.
   */
  scanInBufferRange(regex, range, iterator) {
    return this.buffer.scanInRange(regex, range, iterator);
  }

  /**
   * @public
   * @status essential
   *
   * Scan regular expression matches in a given range in reverse order,
   * calling the given iterator function on each match.
   *
   * @param regex - A `RegExp` to search for.
   * @param range - A {@link Range} in which to search.
   * @param iterator - A `Function` that's called on each match with an `Object` containing the following keys:
   * @param iterator.match - The current regular expression match.
   * @param iterator.matchText - A `String` with the text of the match.
   * @param iterator.range - The {@link Range} of the match.
   * @param iterator.stop - Call this `Function` to terminate the scan.
   * @param iterator.replace - Call this `Function` with a `String` to replace the match.
   */
  backwardsScanInBufferRange(regex, range, iterator) {
    return this.buffer.backwardsScanInRange(regex, range, iterator);
  }

  /**
   * @category Tab Behavior
   */

  /**
   * @public
   * @status essential
   *
   * @returns {Boolean} indicating whether softTabs are enabled for this editor.
   */
  getSoftTabs() {
    return this.softTabs;
  }

  /**
   * @public
   * @status essential
   *
   * Enable or disable soft tabs for this editor.
   *
   * @param softTabs - A `Boolean`
   */
  setSoftTabs(softTabs) {
    this.softTabs = softTabs;
    this.updateSoftTabs(this.softTabs, true);
  }

  // Returns a `Boolean` indicating whether atomic soft tabs are enabled for this editor.
  hasAtomicSoftTabs() {
    return this.displayLayer.atomicSoftTabs;
  }

  /**
   * @public
   * @status essential
   *
   * Toggle soft tabs for this editor
   */
  toggleSoftTabs() {
    this.setSoftTabs(!this.getSoftTabs());
  }

  /**
   * @public
   * @status essential
   *
   * Get the on-screen length of tab characters.
   *
   * @returns {Number}
   */
  getTabLength() {
    return this.displayLayer.tabLength;
  }

  /**
   * @public
   * @status essential
   *
   * Set the on-screen length of tab characters. Setting this to a
   * `Number` This will override the `editor.tabLength` setting.
   *
   * @param {Number} tabLength - length of a single tab. Setting to `null` will fallback to using the `editor.tabLength` config setting
   */
  setTabLength(tabLength) {
    this.updateTabLength(tabLength, true);
  }

  // Returns an `Object` representing the current invisible character
  // substitutions for this editor, whose keys are names of invisible characters
  // and whose values are 1-character `Stringss` that are displayed in place of
  // those invisible characters
  getInvisibles() {
    if (!this.mini && this.showInvisibles && this.invisibles != null) {
      return this.invisibles;
    } else {
      return {};
    }
  }

  getSoftWrapHangingIndentLength() {
    return this.displayLayer.softWrapHangingIndent;
  }

  /**
   * @public
   * @status extended
   *
   * Determine if the buffer uses hard or soft tabs.
   *
   * @returns {Boolean|undefined} `true` for leading spaces, `false` for a leading hard tab (`\t`), or `undefined` when no non-comment line has leading whitespace.
   */
  usesSoftTabs() {
    const languageMode = this.buffer.getLanguageMode();
    const hasIsRowCommented = languageMode.isRowCommented;
    for (
      let bufferRow = 0, end = Math.min(1000, this.buffer.getLastRow());
      bufferRow <= end;
      bufferRow++
    ) {
      if (hasIsRowCommented && languageMode.isRowCommented(bufferRow)) continue;
      const line = this.buffer.lineForRow(bufferRow);
      if (line[0] === " ") return true;
      if (line[0] === "\t") return false;
    }
  }

  /**
   * @public
   * @status extended
   *
   * Get the text representing a single level of indent.
   *
   * If soft tabs are enabled, the text is composed of N spaces, where N is the
   * tab length. Otherwise the text is a tab character (`\t`).
   *
   * @returns {String}
   */
  getTabText() {
    return this.buildIndentString(1);
  }

  // If soft tabs are enabled, convert all hard tabs to soft tabs in the given
  // {@link Range}.
  normalizeTabsInBufferRange(bufferRange) {
    if (!this.getSoftTabs()) {
      return;
    }
    return this.scanInBufferRange(/\t/g, bufferRange, ({ replace }) => replace(this.getTabText()));
  }

  /**
   * @category Soft Wrap Behavior
   */

  /**
   * @public
   * @status essential
   *
   * Determine whether lines in this editor are soft-wrapped.
   *
   * @returns {Boolean}
   */
  isSoftWrapped() {
    return this.softWrapped;
  }

  /**
   * @public
   * @status essential
   *
   * Enable or disable soft wrapping for this editor.
   *
   * @param softWrapped - A `Boolean`
   * @returns {Boolean}
   */
  setSoftWrapped(softWrapped) {
    this.updateSoftWrapped(softWrapped, true);
    return this.isSoftWrapped();
  }

  getPreferredLineLength() {
    return this.preferredLineLength;
  }

  /**
   * @public
   * @status essential
   *
   * Toggle soft wrapping for this editor
   *
   * @returns {Boolean}
   */
  toggleSoftWrapped() {
    return this.setSoftWrapped(!this.isSoftWrapped());
  }

  /**
   * @public
   * @status essential
   *
   * Determine whether overtype (overwrite) mode is enabled for this
   * editor. In overtype mode, typing replaces the character following the cursor
   * instead of inserting before it.
   *
   * @returns {Boolean}
   */
  isOvertypeMode() {
    return this.overtypeMode;
  }

  /**
   * @public
   * @status essential
   *
   * Enable or disable overtype (overwrite) mode for this editor.
   *
   * @param overtypeMode - A `Boolean`.
   * @returns {Boolean}
   */
  setOvertypeMode(overtypeMode) {
    overtypeMode = !!overtypeMode;
    if (overtypeMode !== this.overtypeMode) {
      this.overtypeMode = overtypeMode;
      this.emitter.emit("did-change-overtype-mode", overtypeMode);
    }
    return this.overtypeMode;
  }

  /**
   * @public
   * @status essential
   *
   * Toggle overtype (overwrite) mode for this editor.
   *
   * @returns {Boolean}
   */
  toggleOvertypeMode() {
    return this.setOvertypeMode(!this.overtypeMode);
  }

  /**
   * @public
   * @status extended
   *
   * When overtype mode is active, expand each empty selection one
   * character to the right (except at the end of a line) so that the text about
   * to be inserted overwrites the following character rather than being inserted
   * before it. Non-empty selections are left untouched and replaced as usual.
   *
   * Called by the editor component immediately before inserting genuinely typed
   * text; it has no effect unless {@link #isOvertypeMode} is `true`.
   */
  applyOvertype() {
    if (!this.overtypeMode) return;
    for (const selection of this.getSelections()) {
      if (selection.isEmpty() && !selection.cursor.isAtEndOfLine()) {
        selection.selectRight();
      }
    }
  }

  /**
   * @public
   * @status essential
   *
   * Gets the column at which column will soft wrap
   */
  getSoftWrapColumn() {
    if (this.isSoftWrapped() && !this.mini) {
      if (this.softWrapAtPreferredLineLength) {
        return Math.min(this.getEditorWidthInChars(), this.preferredLineLength);
      } else {
        return this.getEditorWidthInChars();
      }
    } else {
      return this.maxScreenLineLength;
    }
  }

  /**
   * @category Indentation
   */

  /**
   * @public
   * @status essential
   *
   * Get the indentation level of the given buffer row.
   *
   * Determines how deeply the given row is indented based on the soft tabs and
   * tab length settings of this editor. Note that if soft tabs are enabled and
   * the tab length is 2, a row with 4 leading spaces would have an indentation
   * level of 2.
   *
   * @param bufferRow - A `Number` indicating the buffer row.
   * @returns {Number}
   */
  indentationForBufferRow(bufferRow) {
    return this.indentLevelForLine(this.lineTextForBufferRow(bufferRow));
  }

  /**
   * @public
   * @status essential
   *
   * Set the indentation level for the given buffer row.
   *
   * Inserts or removes hard tabs or spaces based on the soft tabs and tab length
   * settings of this editor in order to bring it to the given indentation level.
   * Note that if soft tabs are enabled and the tab length is 2, a row with 4
   * leading spaces would have an indentation level of 2.
   *
   * @param bufferRow - A `Number` indicating the buffer row.
   * @param newLevel - A `Number` indicating the new indentation level.
   * @param {Object} [options] - Indentation options.
   * @param {Boolean} [options.preserveLeadingWhitespace=false] - Preserve
   *   whitespace already at the beginning of the line.
   */
  setIndentationForBufferRow(bufferRow, newLevel, { preserveLeadingWhitespace } = {}) {
    let endColumn;
    if (preserveLeadingWhitespace) {
      endColumn = 0;
    } else {
      endColumn = this.lineTextForBufferRow(bufferRow).match(/^\s*/)[0].length;
    }
    const newIndentString = this.buildIndentString(newLevel);
    return this.buffer.setTextInRange(
      [
        [bufferRow, 0],
        [bufferRow, endColumn],
      ],
      newIndentString,
    );
  }

  /**
   * @public
   * @status extended
   *
   * Indent rows intersecting selections by one level.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor.
   */
  indentSelectedRows(options = {}) {
    if (!this.ensureWritable("indentSelectedRows", options)) return;
    return this.mutateSelectedText((selection) => selection.indentSelectedRows(options));
  }

  /**
   * @public
   * @status extended
   *
   * Outdent rows intersecting selections by one level.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor.
   */
  outdentSelectedRows(options = {}) {
    if (!this.ensureWritable("outdentSelectedRows", options)) return;
    return this.mutateSelectedText((selection) => selection.outdentSelectedRows(options));
  }

  /**
   * @public
   * @status extended
   *
   * Get the indentation level of the given line of text.
   *
   * Determines how deeply the given line is indented based on the soft tabs and
   * tab length settings of this editor. Note that if soft tabs are enabled and
   * the tab length is 2, a row with 4 leading spaces would have an indentation
   * level of 2.
   *
   * @param line - A `String` representing a line of text.
   * @returns {Number}
   */
  indentLevelForLine(line) {
    const tabLength = this.getTabLength();
    let indentLength = 0;
    for (let i = 0, { length } = line; i < length; i++) {
      const char = line[i];
      if (char === "\t") {
        indentLength += tabLength - (indentLength % tabLength);
      } else if (char === " ") {
        indentLength++;
      } else {
        break;
      }
    }
    return indentLength / tabLength;
  }

  /**
   * @public
   * @status extended
   *
   * Indent rows intersecting selections based on the grammar's suggested
   * indent level.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor.
   */
  autoIndentSelectedRows(options = {}) {
    if (!this.ensureWritable("autoIndentSelectedRows", options)) return;
    return this.mutateSelectedText((selection) => selection.autoIndentSelectedRows(options));
  }

  // Indent all lines intersecting selections. See {@link Selection#indent} for more
  // information.
  //
  // * `options` (optional) `Object`
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify a read-only editor.
  indent(options = {}) {
    if (!this.ensureWritable("indent", options)) return;
    if (options.autoIndent == null) options.autoIndent = this.shouldAutoIndent();
    this.mutateSelectedText((selection) => selection.indent(options));
  }

  // Constructs the string used for indents.
  buildIndentString(level, column = 0) {
    if (this.getSoftTabs()) {
      const tabStopViolation = column % this.getTabLength();
      return _.multiplyString(" ", Math.floor(level * this.getTabLength()) - tabStopViolation);
    } else {
      const excessWhitespace = _.multiplyString(
        " ",
        Math.round((level - Math.floor(level)) * this.getTabLength()),
      );
      return _.multiplyString("\t", Math.floor(level)) + excessWhitespace;
    }
  }

  /**
   * @category Grammars
   */

  /**
   * @public
   * @status essential
   *
   * Get the current {@link TreeSitterGrammar}, or the null grammar sentinel.
   */
  getGrammar() {
    const languageMode = this.buffer.getLanguageMode();
    return (languageMode.getGrammar && languageMode.getGrammar()) || NullGrammar;
  }

  // Deprecated: Set the current Tree-sitter grammar of this editor.
  //
  // Assigning a grammar will cause the editor to re-tokenize based on the new
  // grammar.
  //
  // * `grammar` {@link TreeSitterGrammar}
  setGrammar(grammar) {
    const buffer = this.getBuffer();
    buffer.setLanguageMode(lumine.grammars.languageModeForGrammarAndBuffer(grammar, buffer));
  }

  /**
   * @public
   * @status experimental
   *
   * Get a notification when async tokenization is completed.
   */
  onDidTokenize(callback) {
    return this.emitter.on("did-tokenize", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Wait for the current grammar to finish its initial parse and any pending
   * transaction, including injected language layers.
   *
   * Returns `false` when the editor is destroyed, the grammar changes, the
   * optional signal is aborted, or parsing the current transaction fails. A
   * parser-loading or grammar-settlement failure rejects the returned promise.
   *
   * @param {Object} [options]
   * @param {AbortSignal} [options.signal] - Cancels this wait when aborted.
   * @returns {Promise} A promise that resolves to whether the current grammar settled successfully.
   */
  whenGrammarSettled({ signal } = {}) {
    if (this.isDestroyed() || signal?.aborted) return Promise.resolve(false);

    const languageMode = this.buffer.getLanguageMode();
    const atGrammarSettlement = languageMode.atGrammarSettlement;
    const ready = languageMode.ready;
    const atTransactionEnd = languageMode.atTransactionEnd;
    if (
      typeof atGrammarSettlement !== "function" &&
      typeof ready?.then !== "function" &&
      typeof atTransactionEnd !== "function"
    ) {
      return Promise.resolve(true);
    }

    return new Promise((resolve, reject) => {
      let completed = false;
      const subscriptions = new CompositeDisposable();

      const cleanup = () => {
        subscriptions.dispose();
        signal?.removeEventListener?.("abort", cancel);
      };
      const finish = (callback) => {
        if (completed) return;
        completed = true;
        cleanup();
        callback();
      };
      const complete = (value) => finish(() => resolve(value));
      const fail = (error) => finish(() => reject(error));
      const cancel = () => complete(false);
      const isCurrent = () =>
        !this.isDestroyed() && !signal?.aborted && this.buffer.getLanguageMode() === languageMode;

      subscriptions.add(this.onDidDestroy(cancel));
      subscriptions.add(
        this.buffer.onDidChangeLanguageMode((newLanguageMode) => {
          if (newLanguageMode !== languageMode) cancel();
        }),
      );
      signal?.addEventListener?.("abort", cancel, { once: true });
      if (!isCurrent()) {
        cancel();
        return;
      }

      (async () => {
        try {
          if (typeof atGrammarSettlement === "function") {
            const transaction = await atGrammarSettlement.call(languageMode);
            if (!isCurrent()) return cancel();
            complete(!transaction?.parseError);
            return;
          }

          if (typeof ready?.then === "function") await ready;
          if (!isCurrent()) return cancel();

          const transaction =
            typeof atTransactionEnd === "function"
              ? await atTransactionEnd.call(languageMode)
              : null;
          if (!isCurrent()) return cancel();
          complete(!transaction?.parseError);
        } catch (error) {
          if (!isCurrent()) cancel();
          else fail(error);
        }
      })();
    });
  }

  /**
   * @category Managing Syntax Scopes
   */

  /**
   * @public
   * @status essential
   *
   * @returns {ScopeDescriptor} that includes this editor's language. e.g. `['.source.ruby']`, or `['.source.coffee']`. You can use this with {@link Config#get} to get language specific config values.
   */
  getRootScopeDescriptor() {
    return this.buffer.getLanguageMode().rootScopeDescriptor;
  }

  /**
   * @public
   * @status essential
   *
   * Get the syntactic {@link ScopeDescriptor} for the given position in buffer
   * coordinates. Useful with {@link Config#get}.
   *
   * For example, if called with a position inside the parameter list of an
   * anonymous CoffeeScript function, this method returns a {@link ScopeDescriptor} with
   * the following scopes array:
   * `["source.coffee", "meta.function.inline.coffee", "meta.parameters.coffee", "variable.parameter.function.coffee"]`
   *
   * @param bufferPosition - A {@link Point} or `Array` of `[row, column]`.
   * @returns {ScopeDescriptor}
   */
  scopeDescriptorForBufferPosition(bufferPosition) {
    const languageMode = this.buffer.getLanguageMode();
    return languageMode.scopeDescriptorForPosition
      ? languageMode.scopeDescriptorForPosition(bufferPosition)
      : new ScopeDescriptor({ scopes: ["text"] });
  }

  /**
   * @public
   * @status essential
   *
   * Get the syntactic tree {@link ScopeDescriptor} for the given position in buffer
   * coordinates.
   *
   * For example, if called with a position inside the parameter list of a
   * JavaScript class function, this method returns a {@link ScopeDescriptor} with
   * the following syntax nodes array:
   * `["source.js", "program", "expression_statement", "assignment_expression", "class", "class_body", "method_definition", "formal_parameters", "identifier"]`
   * @param bufferPosition - A {@link Point} or `Array` of `[row, column]`.
   * @returns {ScopeDescriptor}
   */
  syntaxTreeScopeDescriptorForBufferPosition(bufferPosition) {
    const languageMode = this.buffer.getLanguageMode();
    return languageMode.syntaxTreeScopeDescriptorForPosition
      ? languageMode.syntaxTreeScopeDescriptorForPosition(bufferPosition)
      : this.scopeDescriptorForBufferPosition(bufferPosition);
  }

  /**
   * @public
   * @status extended
   *
   * Get the smallest Tree-sitter syntax node at the given position in buffer
   * coordinates across all language layers.
   *
   * Node breadth decides between candidates first; the deeper language layer
   * wins only when candidates have equal breadth. An optional predicate
   * receives each candidate node and its grammar. Returns `null` when no syntax
   * tree is available, including before the grammar's first parse and while
   * using the null grammar.
   *
   * The returned node belongs to the current parse snapshot. Do not retain it
   * after the buffer changes or the grammar reparses; request it again instead.
   *
   * @param bufferPosition - A {@link Point} or `Array` of `[row, column]`.
   * @param {Function} [where] - Optional predicate receiving a syntax node and its {@link TreeSitterGrammar}.
   * @returns {Object|null} A Tree-sitter syntax node, or `null`.
   */
  getSyntaxNodeAtBufferPosition(bufferPosition, where) {
    const languageMode = this.buffer.getLanguageMode();
    return languageMode.getSyntaxNodeAtPosition?.(bufferPosition, where) ?? null;
  }

  /**
   * @public
   * @status extended
   *
   * Get the smallest Tree-sitter syntax node that contains the given range in
   * buffer coordinates across all language layers shared by both endpoints.
   *
   * Node breadth decides between candidates first; the deeper language layer
   * wins only when candidates have equal breadth. An optional predicate
   * receives each candidate node and its grammar. Returns `null` when no syntax
   * tree or shared containing layer is available.
   *
   * The returned node belongs to the current parse snapshot. Do not retain it
   * after the buffer changes or the grammar reparses; request it again instead.
   *
   * @param bufferRange - A {@link Range} or `Array` of two `[row, column]` points.
   * @param {Function} [where] - Optional predicate receiving a syntax node and its {@link TreeSitterGrammar}.
   * @returns {Object|null} A Tree-sitter syntax node, or `null`.
   */
  getSyntaxNodeContainingBufferRange(bufferRange, where) {
    const languageMode = this.buffer.getLanguageMode();
    return (
      languageMode.getSyntaxNodeContainingRange?.(Range.fromObject(bufferRange), where) ?? null
    );
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the current root grammar or an active injected grammar
   * declares a query of the given type.
   *
   * This checks declarations only; it does not load or compile the query.
   *
   * @param {String} queryType - The grammar query property to inspect, such as `tagsQuery`.
   * @returns {Boolean} Whether the query is declared by a current language layer.
   */
  hasGrammarQuery(queryType) {
    const languageMode = this.buffer.getLanguageMode();
    return typeof languageMode.hasQuery === "function" ? languageMode.hasQuery(queryType) : false;
  }

  /**
   * @public
   * @status extended
   *
   * Run a grammar query against the current root syntax tree and all active
   * injected language layers.
   *
   * The returned groups contain each matching grammar and its captures after
   * Tree-sitter predicates and scope adjustments are applied. Returns an empty
   * array when the query is absent, parsing is cancelled or unsuccessful, the
   * grammar changes, or the editor is destroyed.
   *
   * Captures contain syntax nodes from the current parse snapshot. Do not
   * retain them after the buffer changes or the grammar reparses. Parser-loading
   * and query-execution failures reject the returned promise.
   *
   * @param {String} queryType - The grammar query property to run, such as `tagsQuery`.
   * @param {Object} [options]
   * @param {AbortSignal} [options.signal] - Cancels this query when aborted.
   * @returns {Promise} A promise resolving to `{grammar, captures}` groups for current language layers.
   */
  async getGrammarQueryCaptureGroups(queryType, { signal } = {}) {
    const languageMode = this.buffer.getLanguageMode();
    if (!(await this.whenGrammarSettled({ signal }))) return [];
    if (
      this.isDestroyed() ||
      signal?.aborted ||
      this.buffer.getLanguageMode() !== languageMode ||
      typeof languageMode.getQueryCaptureGroups !== "function"
    ) {
      return [];
    }

    const groups = await runCancellableGrammarOperation(this, languageMode, signal, [], () =>
      languageMode.getQueryCaptureGroups(queryType, { signal }),
    );
    return groups ?? [];
  }

  /**
   * @public
   * @status extended
   *
   * Get the range in buffer coordinates of all tokens surrounding the
   * cursor that match the given scope selector.
   *
   * For example, if you wanted to find the string surrounding the cursor, you
   * could call `editor.bufferRangeForScopeAtCursor(".string.quoted")`.
   *
   * @param {String} scopeSelector - selector. e.g. `'.source.ruby'`
   * @returns {Range}
   */
  bufferRangeForScopeAtCursor(scopeSelector) {
    return this.bufferRangeForScopeAtPosition(scopeSelector, this.getCursorBufferPosition());
  }

  /**
   * @public
   * @status extended
   *
   * Get the range in buffer coordinates of all tokens surrounding the
   * given position in buffer coordinates that match the given scope selector.
   *
   * For example, if you wanted to find the string surrounding the cursor, you
   * could call `editor.bufferRangeForScopeAtPosition(".string.quoted", this.getCursorBufferPosition())`.
   *
   * @param {String} scopeSelector - selector. e.g. `'.source.ruby'`
   * @param bufferPosition - A {@link Point} or `Array` of [row, column]
   * @returns {Range}
   */
  bufferRangeForScopeAtPosition(scopeSelector, bufferPosition) {
    return this.buffer
      .getLanguageMode()
      .bufferRangeForScopeAtPosition(scopeSelector, bufferPosition);
  }

  /**
   * @public
   * @status extended
   *
   * Determine if the given row is entirely a comment
   */
  isBufferRowCommented(bufferRow) {
    const match = this.lineTextForBufferRow(bufferRow).match(/\S/);
    if (match) {
      return selectorMatchesAnyScope(
        "comment",
        this.scopeDescriptorForBufferPosition([bufferRow, match.index]).scopes,
      );
    }
  }

  // Get the scope descriptor at the cursor.
  getCursorScope() {
    return this.getLastCursor().getScopeDescriptor();
  }

  // Get the syntax nodes at the cursor.
  getCursorSyntaxTreeScope() {
    return this.getLastCursor().getSyntaxTreeScopeDescriptor();
  }

  tokenForBufferPosition(bufferPosition) {
    return this.buffer.getLanguageMode().tokenForPosition(bufferPosition);
  }

  /**
   * @category Clipboard Operations
   */

  /**
   * @public
   * @status essential
   *
   * For each selection, copy the selected text.
   *
   * @returns {Promise} that resolves after the system clipboard has been updated.
   */
  copySelectedText(clipboard = this.constructor.clipboard) {
    if (clipboard === this.constructor.clipboard) clipboard = clipboard.createMemoryClipboard();
    let maintainClipboard = false;
    for (let selection of this.getSelectionsOrderedByBufferPosition()) {
      if (selection.isEmpty()) {
        const previousRange = selection.getBufferRange();
        selection.selectLine();
        selection.copy(maintainClipboard, true, clipboard);
        selection.setBufferRange(previousRange);
      } else {
        selection.copy(maintainClipboard, false, clipboard);
      }
      maintainClipboard = true;
    }
    return clipboard.flush?.();
  }

  /**
   * For each selection, only copy highlighted text.
   *
   * @private
   */
  copyOnlySelectedText(clipboard = this.constructor.clipboard) {
    if (clipboard === this.constructor.clipboard) clipboard = clipboard.createMemoryClipboard();
    let maintainClipboard = false;
    for (let selection of this.getSelectionsOrderedByBufferPosition()) {
      if (!selection.isEmpty()) {
        selection.copy(maintainClipboard, false, clipboard);
        maintainClipboard = true;
      }
    }
    return clipboard.flush?.();
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, cut the selected text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor.
   * @returns {Promise} that resolves after the system clipboard has been updated.
   */
  cutSelectedText(options = {}) {
    if (!this.ensureWritable("cutSelectedText", options)) return;
    let clipboard = options.clipboard || this.constructor.clipboard;
    if (clipboard === this.constructor.clipboard) clipboard = clipboard.createMemoryClipboard();
    let maintainClipboard = false;
    this.mutateSelectedText((selection) => {
      if (selection.isEmpty()) {
        selection.selectLine();
        selection.cut(maintainClipboard, true, options.bypassReadOnly, clipboard);
      } else {
        selection.cut(maintainClipboard, false, options.bypassReadOnly, clipboard);
      }
      maintainClipboard = true;
    });
    return clipboard.flush?.();
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, replace the selected text with the contents of
   * the clipboard.
   *
   * If the clipboard contains the same number of selections as the current
   * editor, each selection will be replaced with the content of the
   * corresponding clipboard selection text.
   *
   * @param [options] - See {@link Selection#insertText}.
   * @returns {Promise} that resolves after the clipboard text has been inserted.
   */
  pasteText(options = {}) {
    if (!this.ensureWritable("parseText", options)) return;
    const clipboard = options.clipboard || this.constructor.clipboard;
    options = Object.assign({}, options);
    delete options.clipboard;
    const paste = ({ text: clipboardText, metadata }) => {
      if (!this.emitWillInsertTextEvent(clipboardText)) return false;
      let languageMode = this.buffer.getLanguageMode();

      if (!metadata) metadata = {};
      if (options.autoIndent == null) options.autoIndent = this.shouldAutoIndentOnPaste();

      this.mutateSelectedText((selection, index) => {
        let fullLine, indentBasis, text;
        if (metadata.selections && metadata.selections.length === this.getSelections().length) {
          ({ text, indentBasis, fullLine } = metadata.selections[index]);
        } else {
          ({ indentBasis, fullLine } = metadata);
          text = clipboardText;
        }

        if (
          indentBasis != null &&
          (text.includes("\n") || !selection.cursor.hasPrecedingCharactersOnLine())
        ) {
          options.indentBasis = indentBasis;
        } else {
          options.indentBasis = null;
        }

        let range;
        if (fullLine && selection.isEmpty()) {
          const oldPosition = selection.getBufferRange().start;
          selection.setBufferRange([
            [oldPosition.row, 0],
            [oldPosition.row, 0],
          ]);
          range = selection.insertText(text, options);
          const newPosition = oldPosition.translate([1, 0]);
          selection.setBufferRange([newPosition, newPosition]);
        } else {
          range = selection.insertText(text, options);
        }

        if (languageMode.atTransactionEnd && options.autoIndent && text.includes("\n")) {
          // The `autoIndent` option as passed to `Selection#insertText` has no
          // effect in `TreeSitterLanguageMode` because it asks what the
          // right indent level would be for the given text _before_ inserting
          // it, and that question can't be answered because the text isn't part
          // of the buffer yet and can't be parsed.
          //
          // The good news is that we can wait until the transaction's done;
          // we'll know the extent of the buffer involved in the paste, so we can
          // auto-indent those rows once they're in the buffer and reflected in
          // the parse tree. This also lets us defer the `did-insert-text` event
          // until the auto-indent happens, so that the event metadata is more
          // accurate.
          //
          // We can also use this technique to format text as required by the
          // `editor:paste-without-reformatting` command. Instead of
          // getting the suggested indent level for each row of the pasted text,
          // we get the suggested indent level of the first row, then alter each
          // succeeding row's level by the same amount.
          //
          languageMode.atTransactionEnd().then(({ range }) => {
            let marker = this.markBufferRange(range);
            let endRow = range.end.row;
            // A range that ends on column 0 of a given row doesn't actually
            // touch that row.
            if (range.end.column === 0) endRow--;
            let checkpoint = this.buffer.createCheckpoint();
            this.autoIndentBufferRows(range.start.row, endRow, {
              ...options,
              isPastedText: true,
            });
            // Detect whether the buffer actually changed. If it did, fold that
            // change into the previous history entry.
            if (this.buffer.getChangesSinceCheckpoint(checkpoint).length > 0) {
              this.buffer.groupLastChanges();
            }

            range = marker.getBufferRange();
            text = this.buffer.getTextInRange(range);
            this.emitter.emit("did-insert-text", { text, range });
          });
        } else {
          this.emitter.emit("did-insert-text", { text, range });
        }
      });
    };

    const clipboardData = clipboard.readWithMetadata();
    return isPromise(clipboardData) ? clipboardData.then(paste) : paste(clipboardData);
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, if the selection is empty, cut all characters
   * of the containing screen line following the cursor. Otherwise cut the selected
   * text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor.
   */
  cutToEndOfLine(options = {}) {
    if (!this.ensureWritable("cutToEndOfLine", options)) return;
    let clipboard = options.clipboard || this.constructor.clipboard;
    if (clipboard === this.constructor.clipboard) clipboard = clipboard.createMemoryClipboard();
    options = { ...options, clipboard };
    let maintainClipboard = false;
    this.mutateSelectedText((selection) => {
      selection.cutToEndOfLine(maintainClipboard, options);
      maintainClipboard = true;
    });
    return clipboard.flush?.();
  }

  /**
   * @public
   * @status essential
   *
   * For each selection, if the selection is empty, cut all characters
   * of the containing buffer line following the cursor. Otherwise cut the
   * selected text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor.
   */
  cutToEndOfBufferLine(options = {}) {
    if (!this.ensureWritable("cutToEndOfBufferLine", options)) return;
    let clipboard = options.clipboard || this.constructor.clipboard;
    if (clipboard === this.constructor.clipboard) clipboard = clipboard.createMemoryClipboard();
    options = { ...options, clipboard };
    let maintainClipboard = false;
    this.mutateSelectedText((selection) => {
      selection.cutToEndOfBufferLine(maintainClipboard, options);
      maintainClipboard = true;
    });
    return clipboard.flush?.();
  }

  /**
   * @category Folds
   */

  /**
   * @public
   * @status extended
   *
   * Get the foldable range that starts at the given row in buffer coordinates
   * without creating a fold.
   *
   * Unlike {@link #foldBufferRow}, this method does not search preceding rows
   * for a fold that contains the given row.
   *
   * @param bufferRow - A `Number`.
   * @returns {Range|null} The exact foldable range, or `null` when the row does not start one.
   */
  getFoldableRangeAtBufferRow(bufferRow) {
    const languageMode = this.buffer.getLanguageMode();
    return languageMode.getFoldRangeForRow?.(bufferRow, this.getTabLength()) ?? null;
  }

  /**
   * @public
   * @status essential
   *
   * Fold the most recent cursor's row based on its indentation level.
   *
   * The fold will extend from the nearest preceding line with a lower
   * indentation level up to the nearest following row with a lower indentation
   * level.
   */
  foldCurrentRow() {
    const { row } = this.getCursorBufferPosition();
    const languageMode = this.buffer.getLanguageMode();
    const range =
      languageMode.getFoldableRangeContainingPoint &&
      languageMode.getFoldableRangeContainingPoint(Point(row, Infinity), this.getTabLength());
    if (range) return this.displayLayer.foldBufferRange(range);
  }

  /**
   * @public
   * @status essential
   *
   * Unfold the most recent cursor's row by one level.
   */
  unfoldCurrentRow() {
    const { row } = this.getCursorBufferPosition();
    return this.displayLayer.destroyFoldsContainingBufferPositions([Point(row, Infinity)], false);
  }

  /**
   * @public
   * @status essential
   *
   * Fold the given row in buffer coordinates based on its indentation
   * level.
   *
   * If the given row is foldable, the fold will begin there. Otherwise, it will
   * begin at the first foldable row preceding the given row.
   *
   * @param bufferRow - A `Number`.
   */
  foldBufferRow(bufferRow) {
    let position = Point(bufferRow, Infinity);
    const languageMode = this.buffer.getLanguageMode();
    while (true) {
      const foldableRange =
        languageMode.getFoldableRangeContainingPoint &&
        languageMode.getFoldableRangeContainingPoint(position, this.getTabLength());
      if (foldableRange) {
        const existingFolds = this.displayLayer.foldsIntersectingBufferRange(
          Range(foldableRange.start, foldableRange.start),
        );
        if (existingFolds.length === 0) {
          this.displayLayer.foldBufferRange(foldableRange);
        } else {
          const firstExistingFoldRange = this.displayLayer.bufferRangeForFold(existingFolds[0]);
          if (firstExistingFoldRange.start.isLessThan(position)) {
            position = Point(firstExistingFoldRange.start.row, 0);
            continue;
          }
        }
      }
      break;
    }
  }

  /**
   * @public
   * @status essential
   *
   * Unfold all folds containing the given row in buffer coordinates.
   *
   * @param bufferRow - A `Number`
   */
  unfoldBufferRow(bufferRow) {
    const position = Point(bufferRow, Infinity);
    return this.displayLayer.destroyFoldsContainingBufferPositions([position]);
  }

  /**
   * @public
   * @status extended
   *
   * For each selection, fold the rows it intersects.
   */
  foldSelectedLines() {
    for (let selection of this.selections) {
      selection.fold();
    }
  }

  /**
   * @public
   * @status extended
   *
   * Fold all foldable lines.
   */
  foldAll() {
    const languageMode = this.buffer.getLanguageMode();
    const foldableRanges =
      languageMode.getFoldableRanges && languageMode.getFoldableRanges(this.getTabLength());
    this.displayLayer.destroyAllFolds();
    for (let range of foldableRanges || []) {
      this.displayLayer.foldBufferRange(range);
    }
  }

  /**
   * @public
   * @status extended
   *
   * Unfold all existing folds.
   */
  unfoldAll() {
    const result = this.displayLayer.destroyAllFolds();
    if (result.length > 0) this.scrollToCursorPosition();
    return result;
  }

  /**
   * @public
   * @status extended
   *
   * Fold all foldable lines at the given indent level.
   *
   * @param level - A `Number` starting at 0.
   */
  foldAllAtIndentLevel(level) {
    const languageMode = this.buffer.getLanguageMode();
    const foldableRanges =
      languageMode.getFoldableRangesAtIndentLevel &&
      languageMode.getFoldableRangesAtIndentLevel(level, this.getTabLength());
    this.displayLayer.destroyAllFolds();
    for (let range of foldableRanges || []) {
      this.displayLayer.foldBufferRange(range);
    }
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the given row in buffer coordinates is foldable.
   *
   * A *foldable* row is a row that *starts* a row range that can be folded.
   *
   * @param bufferRow - A `Number`
   * @returns {Boolean}
   */
  isFoldableAtBufferRow(bufferRow) {
    const languageMode = this.buffer.getLanguageMode();
    return languageMode.isFoldableAtRow && languageMode.isFoldableAtRow(bufferRow);
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the given row in screen coordinates is foldable.
   *
   * A *foldable* row is a row that *starts* a row range that can be folded.
   *
   * @param screenRow - A `Number`
   * @returns {Boolean}
   */
  isFoldableAtScreenRow(screenRow) {
    return this.isFoldableAtBufferRow(this.bufferRowForScreenRow(screenRow));
  }

  /**
   * @public
   * @status extended
   *
   * Fold the given buffer row if it isn't currently folded, and unfold
   * it otherwise.
   */
  toggleFoldAtBufferRow(bufferRow) {
    if (this.isFoldedAtBufferRow(bufferRow)) {
      return this.unfoldBufferRow(bufferRow);
    } else {
      return this.foldBufferRow(bufferRow);
    }
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the most recently added cursor's row is folded.
   *
   * @returns {Boolean}
   */
  isFoldedAtCursorRow() {
    return this.isFoldedAtBufferRow(this.getCursorBufferPosition().row);
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the given row in buffer coordinates is folded.
   *
   * @param bufferRow - A `Number`
   * @returns {Boolean}
   */
  isFoldedAtBufferRow(bufferRow) {
    const range = Range(
      Point(bufferRow, 0),
      Point(bufferRow, this.buffer.lineLengthForRow(bufferRow)),
    );
    return this.displayLayer.foldsIntersectingBufferRange(range).length > 0;
  }

  /**
   * @public
   * @status extended
   *
   * Determine whether the given row in screen coordinates is folded.
   *
   * @param screenRow - A `Number`
   * @returns {Boolean}
   */
  isFoldedAtScreenRow(screenRow) {
    return this.isFoldedAtBufferRow(this.bufferRowForScreenRow(screenRow));
  }

  // Creates a new fold between two row numbers.
  //
  // startRow - The row `Number` to start folding at
  // endRow - The row `Number` to end the fold
  //
  // Returns the new `Fold`.
  foldBufferRowRange(startRow, endRow) {
    return this.foldBufferRange(Range(Point(startRow, Infinity), Point(endRow, Infinity)));
  }

  foldBufferRange(range) {
    return this.displayLayer.foldBufferRange(range);
  }

  // Remove any `Folds` found that intersect the given buffer range.
  destroyFoldsIntersectingBufferRange(bufferRange) {
    return this.displayLayer.destroyFoldsIntersectingBufferRange(bufferRange);
  }

  // Remove any `Folds` found that contain the given array of buffer positions.
  destroyFoldsContainingBufferPositions(bufferPositions, excludeEndpoints) {
    return this.displayLayer.destroyFoldsContainingBufferPositions(
      bufferPositions,
      excludeEndpoints,
    );
  }

  /**
   * @category Gutters
   */

  /**
   * @public
   * @status essential
   *
   * Add a custom {@link Gutter}.
   *
   * @param options - An `Object` with the following fields:
   * @param options.name - (required) A unique `String` to identify this gutter.
   * @param [options.priority] - A `Number` that determines stacking order between gutters. Lower priority items are forced closer to the edges of the window. (default: -100)
   * @param {Boolean} [options.visible] - specifying whether the gutter is visible initially after being created. (default: true)
   * @param {String} [options.type] - specifying the type of gutter to create. `'decorated'` gutters are useful as a destination for decorations created with {@link Gutter#decorateMarker}. `'line-number'` gutters.
   * @param {String} [options.class] - added to the CSS classnames of the gutter's root DOM element.
   * @param {Function} [options.labelFn] - called by a `'line-number'` gutter to generate the label for each line number element. Should return a `String` that will be used to label the corresponding line.
   * @param options.labelFn.lineData - an `Object` containing information about each line to label.
   * @param {Number} options.labelFn.lineData.bufferRow - indicating the zero-indexed buffer index of this line.
   * @param {Number} options.labelFn.lineData.screenRow - indicating the zero-indexed screen index.
   * @param {Boolean} options.labelFn.lineData.foldable - that is `true` if a fold may be created here.
   * @param {Boolean} options.labelFn.lineData.softWrapped - if this screen row is the soft-wrapped continuation of the same buffer row.
   * @param {Number} options.labelFn.lineData.maxDigits - the maximum number of digits necessary to represent any known screen row.
   * @param {Function} [options.onMouseDown] - to be called when a mousedown event is received by a line-number element within this `type: 'line-number'` {@link Gutter}. If unspecified, the default behavior is to select the clicked buffer row.
   * @param options.onMouseDown.lineData - an `Object` containing information about the line that's being clicked.
   * @param {Number} options.onMouseDown.lineData.bufferRow - of the originating line element
   * @param {Number} options.onMouseDown.lineData.screenRow
   * @param {Function} [options.onMouseMove] - to be called when a mousemove event occurs on a line-number element within within this `type: 'line-number'` {@link Gutter}.
   * @param options.onMouseMove.lineData - an `Object` containing information about the line that's being clicked.
   * @param {Number} options.onMouseMove.lineData.bufferRow - of the originating line element
   * @param {Number} options.onMouseMove.lineData.screenRow
   * @returns {Gutter} newly-created {@link Gutter}.
   */
  addGutter(options) {
    return this.gutterContainer.addGutter(options);
  }

  /**
   * @public
   * @status essential
   *
   * Get this editor's gutters.
   *
   * @returns {Array} of {@link Gutter Gutters}.
   */
  getGutters() {
    return this.gutterContainer.getGutters();
  }

  getLineNumberGutter() {
    return this.lineNumberGutter;
  }

  /**
   * @public
   * @status essential
   *
   * Get the gutter with the given name.
   *
   * @returns {Gutter}, or `null` if no gutter exists for the given name.
   */
  gutterWithName(name) {
    return this.gutterContainer.gutterWithName(name);
  }

  /**
   * @category Scrolling the TextEditor
   */

  /**
   * @public
   * @status essential
   *
   * Scroll the editor to reveal the most recently added cursor if it is
   * off-screen.
   *
   * @param {Object} [options]
   * @param options.center - Center the editor around the cursor if possible. (default: false)
   * @param options.zone - Land the cursor inside a band of the viewport, instead of centering it. See {@link #scrollToScreenRange}.
   */
  scrollToCursorPosition(options) {
    const zone = options && options.zone;
    const autoscrollOptions = {};
    if (zone != null) {
      autoscrollOptions.zone = zone;
      autoscrollOptions.center = false;
    } else if (options && Object.hasOwn(options, "center")) {
      autoscrollOptions.center = options.center === true;
    }
    this.getLastCursor().autoscroll(autoscrollOptions);
  }

  /**
   * @public
   * @status essential
   *
   * Scrolls the editor to the given buffer position.
   *
   * @param bufferPosition - An object that represents a buffer position. It can be either an `Object` (`{row, column}`), `Array` (`[row, column]`), or {@link Point}
   * @param {Object} [options]
   * @param options.center - Center the editor around the position if possible. (default: false)
   * @param options.zone - Land the position inside a band of the viewport. See {@link #scrollToScreenRange}.
   */
  scrollToBufferPosition(bufferPosition, options) {
    return this.scrollToScreenPosition(
      this.screenPositionForBufferPosition(bufferPosition),
      options,
    );
  }

  /**
   * @public
   * @status essential
   *
   * Scrolls the editor to the given screen position.
   *
   * @param screenPosition - An object that represents a screen position. It can be either an `Object` (`{row, column}`), `Array` (`[row, column]`), or {@link Point}
   * @param {Object} [options]
   * @param options.center - Center the editor around the position if possible. (default: false)
   * @param options.zone - Land the position inside a band of the viewport. See {@link #scrollToScreenRange}.
   */
  scrollToScreenPosition(screenPosition, options) {
    this.scrollToScreenRange(new Range(screenPosition, screenPosition), options);
  }

  /**
   * @public
   * @status extended
   *
   * Scrolls the editor to the given screen range.
   *
   * @param screenRange - A {@link Range} or range-compatible `Array`.
   * @param {Object} [options]
   * @param options.center - Center the editor around the range if possible. (default: false)
   * @param options.zone - Where in the viewport the range should come to rest, as a percentage of the travel it has between the vertical scroll margins: `0` rests it against the top margin and `100` against the bottom one. A `Number` pins the range to that one spot. An `Array` of two numbers names where it lands after leaving the band through the top and after leaving it through the bottom, and so describes the band itself — nothing scrolls while the range is already inside. Ordered (`[0, 50]`) that is the edge it just crossed, the smallest scroll that brings it back; inverted (`[50, 0]`) it is the opposite edge, throwing the range across the viewport to leave the most room ahead of it. `[0, 100]` is the default behaviour and `50` is `center`.
   * @param options.reversed - Scroll to the start of the range before its end when both are off-screen. (default: true)
   * @param options.clip - Clip the range to the editor's contents first. (default: true)
   */
  scrollToScreenRange(screenRange, options = {}) {
    if (options.clip !== false) screenRange = this.clipScreenRange(screenRange);
    if (options.zone != null) options = { ...options, zone: normalizeScrollZone(options.zone) };
    const scrollEvent = { screenRange, options };
    if (this.component) this.component.didRequestAutoscroll(scrollEvent);
    this.emitter.emit("did-request-autoscroll", scrollEvent);
  }

  pageUp() {
    this.moveUp(this.getRowsPerPage());
  }

  pageDown() {
    this.moveDown(this.getRowsPerPage());
  }

  selectPageUp() {
    this.selectUp(this.getRowsPerPage());
  }

  selectPageDown() {
    this.selectDown(this.getRowsPerPage());
  }

  // Returns the number of rows per page
  getRowsPerPage() {
    if (this.component) {
      const clientHeight = this.component.getScrollContainerClientHeight();
      const lineHeight = this.component.getLineHeight();
      return Math.max(1, Math.ceil(clientHeight / lineHeight));
    } else {
      return 1;
    }
  }

  /**
   * @category Config
   */

  /**
   * @public
   * @status experimental
   *
   * Is auto-indentation enabled for this editor?
   *
   * @returns {Boolean}
   */
  shouldAutoIndent() {
    return this.autoIndent;
  }

  /**
   * @public
   * @status experimental
   *
   * Is auto-indentation on paste enabled for this editor?
   *
   * @returns {Boolean}
   */
  shouldAutoIndentOnPaste() {
    return this.autoIndentOnPaste;
  }

  /**
   * @public
   * @status experimental
   *
   * Does this editor allow scrolling past the last line?
   *
   * @returns {Boolean}
   */
  getScrollPastEnd() {
    if (this.getAutoHeight()) {
      return false;
    } else {
      return this.scrollPastEnd;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * How fast does the editor scroll in response to mouse wheel
   * movements?
   *
   * @returns {Number} positive `Number`.
   */
  getScrollSensitivity() {
    return this.scrollSensitivity;
  }

  /**
   * @public
   * @status experimental
   *
   * Are mouse wheel and scroll command movements animated?
   *
   * @returns {Boolean}
   */
  getSmoothScrolling() {
    if (this.smoothScrolling != null) return this.smoothScrolling;
    return lumine.config.get("editor.smoothScrolling");
  }

  /**
   * @public
   * @status experimental
   *
   * How gradually does the editor glide toward the target
   * position when scrolling with the mouse wheel?
   *
   * @returns {Number} positive `Number`.
   */
  getWheelSmoothness() {
    if (this.wheelSmoothness != null) return this.wheelSmoothness;
    return lumine.config.get("editor.wheelSmoothness");
  }

  /**
   * @public
   * @status experimental
   *
   * How gradually does the editor glide when scrolling via the
   * scroll commands?
   *
   * @returns {Number} positive `Number`.
   */
  getCommandSmoothness() {
    if (this.commandSmoothness != null) return this.commandSmoothness;
    return lumine.config.get("editor.commandSmoothness");
  }

  /**
   * @public
   * @status experimental
   *
   * Speed multiplier applied to wheel scrolling while holding
   * `alt`.
   *
   * @returns {Number} positive `Number`.
   */
  getAltWheelMultiplier() {
    return this.altWheelMultiplier;
  }

  /**
   * @public
   * @status experimental
   *
   * Distance scrolled by the scroll commands, as a fraction of
   * the editor height. Seeded from config; the increase/decrease scroll
   * distance commands adjust it per editor.
   *
   * @returns {Number} positive `Number`.
   */
  getScrollCommandDistance() {
    return this.scrollCommandDistance;
  }

  /**
   * @public
   * @status experimental
   *
   * How long (in milliseconds) to wait for the editor width to
   * settle before re-wrapping soft-wrapped lines. `0` re-wraps immediately.
   *
   * @returns {Number} non-negative `Number`.
   */
  getSoftWrapDebounceInterval() {
    return this.softWrapDebounceInterval;
  }

  /**
   * @public
   * @status experimental
   *
   * Are line numbers enabled for this editor?
   *
   * @returns {Boolean}
   */
  doesShowLineNumbers() {
    return this.showLineNumbers;
  }

  /**
   * @public
   * @status experimental
   *
   * Get the time interval within which text editing operations
   * are grouped together in the editor's undo history.
   *
   * @returns {Number} time interval `Number` in milliseconds.
   */
  getUndoGroupingInterval() {
    return this.undoGroupingInterval;
  }

  /**
   * @public
   * @status experimental
   *
   * Get the characters that are *not* considered part of words,
   * for the purpose of word-based cursor movements.
   *
   * @returns {String} containing the non-word characters.
   */
  getNonWordCharacters(position) {
    const languageMode = this.buffer.getLanguageMode();
    const queryPosition = position || Point(0, 0);
    const languageValue = languageMode.getNonWordCharacters?.(queryPosition);
    if (languageValue != null) return languageValue;

    const scope = languageMode.scopeDescriptorForPosition?.(queryPosition);
    return (
      globalThis.lumine?.config?.get("editor.nonWordCharacters", { scope }) ??
      DEFAULT_NON_WORD_CHARACTERS
    );
  }

  /**
   * @category Event Handlers
   */

  handleLanguageModeChange() {
    this.unfoldAll();
    if (this.languageModeSubscription) {
      this.languageModeSubscription.dispose();
      this.disposables.remove(this.languageModeSubscription);
    }
    const languageMode = this.buffer.getLanguageMode();

    if (this.component && this.component.visible && languageMode.startTokenizing) {
      languageMode.startTokenizing();
    }
    this.languageModeSubscription =
      languageMode.onDidTokenize &&
      languageMode.onDidTokenize(() => {
        this.emitter.emit("did-tokenize");
      });
    if (this.languageModeSubscription) this.disposables.add(this.languageModeSubscription);
    this.emitter.emit("did-change-grammar", languageMode.grammar);
  }

  /**
   * @category TextEditor Rendering
   */

  // Get the Element for the editor.
  getElement() {
    if (!this.component) {
      if (!TextEditorComponent) TextEditorComponent = require("./text-editor-component");
      if (!TextEditorElement) TextEditorElement = require("./text-editor-element");
      this.component = new TextEditorComponent({
        model: this,
        updatedSynchronously: TextEditorElement.prototype.updatedSynchronously,
        initialScrollTopRow: this.initialScrollTopRow,
        initialScrollLeftColumn: this.initialScrollLeftColumn,
        initialScrollAnchor: this.initialScrollAnchor,
      });
    }
    return this.component.element;
  }

  getAllowedLocations() {
    return ["center"];
  }

  /**
   * @public
   * @status essential
   *
   * Retrieves the greyed out placeholder of a mini editor.
   *
   * @returns {String}
   */
  getPlaceholderText() {
    return this.placeholderText;
  }

  /**
   * @public
   * @status essential
   *
   * Set the greyed out placeholder of a mini editor. Placeholder text
   * will be displayed when the editor has no content.
   *
   * @param {String} placeholderText - text that is displayed when the editor has no content.
   */
  setPlaceholderText(placeholderText) {
    this.updatePlaceholderText(placeholderText, true);
  }

  getVerticalScrollMargin() {
    const maxScrollMargin = Math.floor((this.height / this.getLineHeightInPixels() - 1) / 2);
    return Math.min(this.verticalScrollMargin, maxScrollMargin);
  }

  setVerticalScrollMargin(verticalScrollMargin) {
    this.verticalScrollMargin = verticalScrollMargin;
    return this.verticalScrollMargin;
  }

  getHorizontalScrollMargin() {
    return Math.min(
      this.horizontalScrollMargin,
      Math.floor((this.width / this.getDefaultCharWidth() - 1) / 2),
    );
  }
  setHorizontalScrollMargin(horizontalScrollMargin) {
    this.horizontalScrollMargin = horizontalScrollMargin;
    return this.horizontalScrollMargin;
  }

  getLineHeightInPixels() {
    return this.lineHeightInPixels;
  }
  setLineHeightInPixels(lineHeightInPixels) {
    this.lineHeightInPixels = lineHeightInPixels;
    return this.lineHeightInPixels;
  }

  getKoreanCharWidth() {
    return this.koreanCharWidth;
  }
  getHalfWidthCharWidth() {
    return this.halfWidthCharWidth;
  }
  getDoubleWidthCharWidth() {
    return this.doubleWidthCharWidth;
  }
  getDefaultCharWidth() {
    return this.defaultCharWidth;
  }

  ratioForCharacter(character) {
    if (isKoreanCharacter(character)) {
      return this.getKoreanCharWidth() / this.getDefaultCharWidth();
    } else if (isHalfWidthCharacter(character)) {
      return this.getHalfWidthCharWidth() / this.getDefaultCharWidth();
    } else if (isDoubleWidthCharacter(character)) {
      return this.getDoubleWidthCharWidth() / this.getDefaultCharWidth();
    } else {
      return 1;
    }
  }

  setDefaultCharWidth(defaultCharWidth, doubleWidthCharWidth, halfWidthCharWidth, koreanCharWidth) {
    if (doubleWidthCharWidth == null) {
      doubleWidthCharWidth = defaultCharWidth;
    }
    if (halfWidthCharWidth == null) {
      halfWidthCharWidth = defaultCharWidth;
    }
    if (koreanCharWidth == null) {
      koreanCharWidth = defaultCharWidth;
    }
    if (
      defaultCharWidth !== this.defaultCharWidth ||
      (doubleWidthCharWidth !== this.doubleWidthCharWidth &&
        halfWidthCharWidth !== this.halfWidthCharWidth &&
        koreanCharWidth !== this.koreanCharWidth)
    ) {
      this.defaultCharWidth = defaultCharWidth;
      this.doubleWidthCharWidth = doubleWidthCharWidth;
      this.halfWidthCharWidth = halfWidthCharWidth;
      this.koreanCharWidth = koreanCharWidth;
      if (this.isSoftWrapped()) {
        this.displayLayer.reset({
          softWrapColumn: this.getSoftWrapColumn(),
        });
      }
    }
    return defaultCharWidth;
  }

  getAutoHeight() {
    return this.autoHeight != null ? this.autoHeight : true;
  }

  getAutoWidth() {
    return this.autoWidth != null ? this.autoWidth : false;
  }

  // Use setScrollTopRow instead of this method
  setFirstVisibleScreenRow(screenRow) {
    this.setScrollTopRow(screenRow);
  }

  getFirstVisibleScreenRow() {
    return this.getElement().component.getFirstVisibleRow();
  }

  getLastVisibleScreenRow() {
    return this.getElement().component.getLastVisibleRow();
  }

  getVisibleRowRange() {
    return [this.getFirstVisibleScreenRow(), this.getLastVisibleScreenRow()];
  }

  // Use setScrollLeftColumn instead of this method
  setFirstVisibleScreenColumn(column) {
    return this.setScrollLeftColumn(column);
  }

  getFirstVisibleScreenColumn() {
    return this.getElement().component.getFirstVisibleColumn();
  }

  getScrollTopRow() {
    return this.getElement().component.getScrollTopRow();
  }

  setScrollTopRow(scrollTopRow) {
    this.getElement().component.setScrollTopRow(scrollTopRow);
  }

  getScrollLeftColumn() {
    return this.getElement().component.getScrollLeftColumn();
  }

  setScrollLeftColumn(scrollLeftColumn) {
    this.getElement().component.setScrollLeftColumn(scrollLeftColumn);
  }

  /**
   * @category Utility
   */

  inspect() {
    return `<TextEditor ${this.id}>`;
  }

  emitWillInsertTextEvent(text) {
    let result = true;
    const cancel = () => {
      result = false;
    };
    this.emitter.emit("will-insert-text", { cancel, text });
    return result;
  }

  /**
   * @category Language Mode Delegated Methods
   */

  suggestedIndentForBufferRow(bufferRow, options) {
    const languageMode = this.buffer.getLanguageMode();
    return (
      languageMode.suggestedIndentForBufferRow &&
      languageMode.suggestedIndentForBufferRow(bufferRow, this.getTabLength(), options)
    );
  }

  // Given a buffer row, indent it.
  //
  // * bufferRow - The row `Number`.
  // * options - An `Object` of options to pass through to {@link TextEditor#setIndentationForBufferRow}.
  autoIndentBufferRow(bufferRow, options) {
    const indentLevel = this.suggestedIndentForBufferRow(bufferRow, options);
    if (indentLevel?.then) {
      // The language mode may go async if it can't answer our question
      // immediately. If it fulfills with a number, that's our indent level. If
      // it fulfills with `undefined`, it means it couldn't give us an answer
      // because of further changes in the same transaction, meaning we should
      // schedule an auto-indent for the entire range affected by the
      // transaction.
      indentLevel.then((indentLevel) => {
        if (typeof indentLevel === "number") {
          this.setIndentationForBufferRow(bufferRow, indentLevel, options);
          this.buffer.groupLastChanges();
        } else if (indentLevel === undefined) {
          this.scheduleIndentAdjustment(true);
        }
      });
    } else if (typeof indentLevel === "number") {
      return this.setIndentationForBufferRow(bufferRow, indentLevel, options);
    }
  }

  // Indents all the rows between two buffer row numbers.
  //
  // * startRow - The row `Number` to start at
  // * endRow - The row `Number` to end at
  autoIndentBufferRows(startRow, endRow, options = {}) {
    const languageMode = this.buffer.getLanguageMode();
    let lastRowIndented = startRow - 1;
    if (languageMode.suggestedIndentForBufferRows) {
      // In tree-sitter mode, we are fortunate that this command will only ever
      // be called at the ends of transactions, when the parse tree is clean.
      // But that's also why we should try to auto-indent this whole range
      // atomically. Compared to the naive version below, on a hypothetical
      // ten-line range, this will result in only one tree re-parse (after
      // we're done) rather than ten.
      let indents = languageMode.suggestedIndentForBufferRows(
        startRow,
        endRow,
        this.getTabLength(),
        options,
      );

      // The language mode may not be able to indent the whole block
      // atomically. If not, we'll indent as much as we're able, then fall back
      // to the costlier approach.
      if (indents !== null) {
        this.transact(() => {
          for (let [row, indent] of indents) {
            this.setIndentationForBufferRow(row, indent);
            lastRowIndented = row;
          }
        });
        if (lastRowIndented === endRow) {
          return;
        }
      }

      if (options.isPastedText) {
        // With this option enabled, if we reach this point, it means that
        // `indents` is `null`, or somehow gave us an incomplete set of indent
        // levels. In either case, we don't want to fall back to a row-by-row
        // auto-indent, because we were just using this mode to batch-adjust
        // the rows to preserve relative indentation.
        return;
      }
    }
    let row = lastRowIndented + 1;
    while (row <= endRow) {
      this.autoIndentBufferRow(row);
      row++;
    }
  }

  autoDecreaseIndentForBufferRow(bufferRow) {
    const languageMode = this.buffer.getLanguageMode();
    if (!languageMode.suggestedIndentForEditedBufferRow) {
      return;
    }
    let indentLevel = languageMode.suggestedIndentForEditedBufferRow(
      bufferRow,
      this.getTabLength(),
    );
    if (indentLevel?.then) {
      indentLevel.then((indentLevel) => {
        // We have a stricter contract than `autoIndentBufferRow`: if
        // `suggestedIndentForEditedBufferRow` doesn't return a number, we
        // should ignore it. Otherwise we run the risk of dedenting something
        // that the user doesn't want dedented.
        if (typeof indentLevel === "number") {
          this.setIndentationForBufferRow(bufferRow, indentLevel);
          this.buffer.groupLastChanges();
        }
      });
    } else {
      if (indentLevel != null) this.setIndentationForBufferRow(bufferRow, indentLevel);
    }
  }

  // Called at the end of a multi-change transaction when an auto-indent action
  // was supposed to happen during that transaction. May be called multiple
  // times, but will result in a maximum of one post-transaction adjustment.
  scheduleIndentAdjustment(force = false) {
    // Ensure that we schedule only one indent adjustment per
    // between-transaction interval. It might have already been done, in which
    // case we don't even need to try to schedule it.
    if (this.didAdjustIndent) return;

    // If we're forcing this to run, replace the existing promise, because
    // there's no guarantee that the existing promise won't bail early.
    if (this.autoIndentAtTransactionEndPromise && !force) return;

    let languageMode = this.buffer.getLanguageMode();
    if (!languageMode.atTransactionEnd) return;
    if (!languageMode.useAsyncParsing || !languageMode.useAsyncIndent) return;

    let promise = languageMode.atTransactionEnd().then(({ range, autoIndentRequests }) => {
      if (!range || this.didAdjustIndent) return;
      // When `force` is not `true`, will only try to auto-indent this
      // transaction's range if the language mode reports that one of its
      // suggested-indent methods was called during the transaction.
      if (autoIndentRequests === 0 && !force) return;

      this.transact(() => this.autoIndentBufferRows(range.start.row, range.end.row));
      this.buffer.groupLastChanges();
      this.didAdjustIndent = true;
    });

    this.autoIndentAtTransactionEndPromise = promise.finally(() => {
      this.autoIndentAtTransactionEndPromise = null;
      this.didAdjustIndent = false;
    });
  }

  toggleLineCommentForBufferRow(row) {
    this.toggleLineCommentsForBufferRows(row, row);
  }

  toggleLineCommentsForBufferRows(start, end, options = {}) {
    const languageMode = this.buffer.getLanguageMode();
    let { commentStartString, commentEndString } =
      (languageMode.commentStringsForPosition &&
        languageMode.commentStringsForPosition(new Point(start, 0))) ||
      {};
    if (!commentStartString) return;
    commentStartString = commentStartString.trim();

    if (commentEndString) {
      commentEndString = commentEndString.trim();
      const startDelimiterColumnRange = columnRangeForStartDelimiter(
        this.buffer.lineForRow(start),
        commentStartString,
      );
      if (startDelimiterColumnRange) {
        const endDelimiterColumnRange = columnRangeForEndDelimiter(
          this.buffer.lineForRow(end),
          commentEndString,
        );
        if (endDelimiterColumnRange) {
          this.buffer.transact(() => {
            this.buffer.delete([
              [end, endDelimiterColumnRange[0]],
              [end, endDelimiterColumnRange[1]],
            ]);
            this.buffer.delete([
              [start, startDelimiterColumnRange[0]],
              [start, startDelimiterColumnRange[1]],
            ]);
          });
        }
      } else {
        this.buffer.transact(() => {
          const indentLength = this.buffer.lineForRow(start).match(/^\s*/)[0].length;
          this.buffer.insert([start, indentLength], commentStartString + " ");
          this.buffer.insert([end, this.buffer.lineLengthForRow(end)], " " + commentEndString);

          // Prevent the cursor from selecting / passing the delimiters
          // See https://github.com/atom/atom/pull/17519
          if (options.correctSelection && options.selection) {
            const endLineLength = this.buffer.lineLengthForRow(end);
            const oldRange = options.selection.getBufferRange();
            if (oldRange.isEmpty()) {
              if (oldRange.start.column === endLineLength) {
                const endCol = endLineLength - commentEndString.length - 1;
                options.selection.setBufferRange(
                  [
                    [end, endCol],
                    [end, endCol],
                  ],
                  { autoscroll: false },
                );
              }
            } else {
              const startDelta =
                oldRange.start.column === indentLength
                  ? [0, commentStartString.length + 1]
                  : [0, 0];
              const endDelta =
                oldRange.end.column === endLineLength ? [0, -commentEndString.length - 1] : [0, 0];
              options.selection.setBufferRange(oldRange.translate(startDelta, endDelta), {
                autoscroll: false,
              });
            }
          }
        });
      }
    } else {
      let hasCommentedLines = false;
      let hasUncommentedLines = false;
      for (let row = start; row <= end; row++) {
        const line = this.buffer.lineForRow(row);
        if (NON_WHITESPACE_REGEXP.test(line)) {
          if (columnRangeForStartDelimiter(line, commentStartString)) {
            hasCommentedLines = true;
          } else {
            hasUncommentedLines = true;
          }
        }
      }

      const shouldUncomment = hasCommentedLines && !hasUncommentedLines;

      if (shouldUncomment) {
        for (let row = start; row <= end; row++) {
          const columnRange = columnRangeForStartDelimiter(
            this.buffer.lineForRow(row),
            commentStartString,
          );
          if (columnRange)
            this.buffer.delete([
              [row, columnRange[0]],
              [row, columnRange[1]],
            ]);
        }
      } else {
        let minIndentLevel = Infinity;
        let minBlankIndentLevel = Infinity;
        for (let row = start; row <= end; row++) {
          const line = this.buffer.lineForRow(row);
          const indentLevel = this.indentLevelForLine(line);
          if (NON_WHITESPACE_REGEXP.test(line)) {
            if (indentLevel < minIndentLevel) minIndentLevel = indentLevel;
          } else {
            if (indentLevel < minBlankIndentLevel) minBlankIndentLevel = indentLevel;
          }
        }
        minIndentLevel = Number.isFinite(minIndentLevel)
          ? minIndentLevel
          : Number.isFinite(minBlankIndentLevel)
            ? minBlankIndentLevel
            : 0;

        const indentString = this.buildIndentString(minIndentLevel);
        for (let row = start; row <= end; row++) {
          const line = this.buffer.lineForRow(row);
          if (NON_WHITESPACE_REGEXP.test(line)) {
            const indentColumn = columnForIndentLevel(line, minIndentLevel, this.getTabLength());
            this.buffer.insert(Point(row, indentColumn), commentStartString + " ");
          } else {
            this.buffer.setTextInRange(
              new Range(new Point(row, 0), new Point(row, Infinity)),
              indentString + commentStartString + " ",
            );
          }
        }
      }
    }
  }

  /**
   * @public
   * @status public
   *
   *
   * Lumine allows language bundles to define comment delimiters in several
   * places. For instance, a grammar author can place delimiter metadata in the
   * grammar definition file, or as scope-specific settings in the ordinary
   * config system — or a combination of the two.
   *
   * In some languages, comment delimiters vary based on position in the
   * buffer. (For instance, line comments can't always be used in JavaScript
   * JSX blocks, so block comments are much safer.) This method will look for
   * any such overrides and return what it thinks are the best delimiters to
   * use at a given point.
   *
   * Some languages don't specify all their delimiters in their configuration,
   * but this method will return all the information that it can discern.
   *
   * * point - A {@link Point} or point-compatible `Array`.
   *
   *
   * * `line`: If present, a `String` representing a line comment delimiter.
   *   (If `undefined`, there is no known line comment delimiter for the given
   *   buffer position.)
   * * `block`: If present, a two-item `Array` containing `Strings`
   *   representing the starting and ending block comment delimiters. (If
   *   `undefined`, there are no known block comment delimiters for the given
   *   buffer position.)
   *
   * @returns {Object} Information about the appropriate comment delimiters at the buffer position.
   */
  getCommentDelimitersForBufferPosition(point) {
    point = Point.fromObject(point);
    const languageMode = this.buffer.getLanguageMode();
    let { commentStartString, commentEndString, commentDelimiters } =
      languageMode.commentStringsForPosition(point);
    if (commentDelimiters) {
      return commentDelimiters;
    } else {
      // Build a delimiters object out of the other data we received. The
      // `commentStartString` and `commentEndString` settings aren't meant to
      // be comprehensive — they just tell you which delimiter(s) to use to
      // comment out a given selection — but they're better than nothing.
      if (commentStartString && commentEndString) {
        return { block: [commentStartString.trim(), commentEndString.trim()] };
      } else if (commentStartString && !commentEndString) {
        return { line: commentStartString.trim() };
      } else {
        return null;
      }
    }
  }

  rowRangeForParagraphAtBufferRow(bufferRow) {
    if (!NON_WHITESPACE_REGEXP.test(this.lineTextForBufferRow(bufferRow))) return;

    const languageMode = this.buffer.getLanguageMode();
    const isCommented = languageMode.isRowCommented(bufferRow);

    let startRow = bufferRow;
    while (startRow > 0) {
      if (!NON_WHITESPACE_REGEXP.test(this.lineTextForBufferRow(startRow - 1))) break;
      if (languageMode.isRowCommented(startRow - 1) !== isCommented) break;
      startRow--;
    }

    let endRow = bufferRow;
    const rowCount = this.getLineCount();
    while (endRow + 1 < rowCount) {
      if (!NON_WHITESPACE_REGEXP.test(this.lineTextForBufferRow(endRow + 1))) break;
      if (languageMode.isRowCommented(endRow + 1) !== isCommented) break;
      endRow++;
    }

    return new Range(
      new Point(startRow, 0),
      new Point(endRow, this.buffer.lineLengthForRow(endRow)),
    );
  }
};

// Drops the `doomed` members from `array` in place, keeping the survivors in
// order. In place is the requirement rather than the optimization: packages
// read `selections` and `cursors` directly and keep the array they were handed,
// so these two may be emptied and refilled but never replaced.
function compactInPlace(array, doomed) {
  let write = 0;
  for (let read = 0; read < array.length; read++) {
    const element = array[read];
    if (!doomed.has(element)) array[write++] = element;
  }
  array.length = write;
}

function columnForIndentLevel(line, indentLevel, tabLength) {
  let column = 0;
  let indentLength = 0;
  const goalIndentLength = indentLevel * tabLength;
  while (indentLength < goalIndentLength) {
    const char = line[column];
    if (char === "\t") {
      indentLength += tabLength - (indentLength % tabLength);
    } else if (char === " ") {
      indentLength++;
    } else {
      break;
    }
    column++;
  }
  return column;
}

function columnRangeForStartDelimiter(line, delimiter) {
  const startColumn = line.search(NON_WHITESPACE_REGEXP);
  if (startColumn === -1) return null;
  if (!line.startsWith(delimiter, startColumn)) return null;

  let endColumn = startColumn + delimiter.length;
  if (line[endColumn] === " ") endColumn++;
  return [startColumn, endColumn];
}

// Normalizes the `zone` autoscroll option to a pair of percentages, so the
// component never has to ask what shape it was given. A lone number is a band of
// zero height: the one spot the range is pinned to. The pair is deliberately not
// reordered — which end comes first is what distinguishes the least possible
// scroll from the greatest.
function normalizeScrollZone(zone) {
  const bounds = Array.isArray(zone) ? zone : [zone];
  if (bounds.length < 1 || bounds.length > 2 || !bounds.every(Number.isFinite)) {
    throw new TypeError(
      `Invalid autoscroll zone: ${JSON.stringify(
        zone,
      )} must be a percentage or a pair of percentages`,
    );
  }
  const [afterLeavingTop, afterLeavingBottom = afterLeavingTop] = bounds.map((bound) =>
    Math.min(100, Math.max(0, bound)),
  );
  return [afterLeavingTop, afterLeavingBottom];
}

function columnRangeForEndDelimiter(line, delimiter) {
  let startColumn = line.lastIndexOf(delimiter);
  if (startColumn === -1) return null;

  const endColumn = startColumn + delimiter.length;
  if (NON_WHITESPACE_REGEXP.test(line.slice(endColumn))) return null;
  if (line[startColumn - 1] === " ") startColumn--;
  return [startColumn, endColumn];
}

class ChangeEvent {
  constructor({ oldRange, newRange }) {
    this.oldRange = oldRange;
    this.newRange = newRange;
  }

  get start() {
    return this.newRange.start;
  }

  get oldExtent() {
    return this.oldRange.getExtent();
  }

  get newExtent() {
    return this.newRange.getExtent();
  }
}
