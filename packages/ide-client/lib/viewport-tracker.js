const { Emitter, CompositeDisposable, Disposable } = require("atom");

// Emit only after scrolling settles so a flick through a long file does not
// fire a request per frame.
const SCROLL_SETTLE_MS = 150;
// Rows fetched beyond the visible range, so small scrolls are already covered.
const MARGIN_ROWS = 50;

// Shared per-editor visible-row-range watcher for the viewport-driven LSP
// features (code lens resolution, inlay hints, semantic-token range mode).
// Emits "stale" with the visible screen-row range converted to buffer rows,
// padded by MARGIN_ROWS and clamped to the buffer.
module.exports = class ViewportTracker {
  constructor() {
    this.emitter = new Emitter();
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      atom.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
    );
  }
  // fn({editor, range: [startBufferRow, endBufferRow]})
  onDidBecomeStale(fn) {
    return this.emitter.on("stale", fn);
  }
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const element = editor.getElement();
    const state = { editor, timer: null, visible: null, subscriptions: new CompositeDisposable() };
    this.states.set(editor, state);
    state.subscriptions.add(
      element.onDidChangeScrollTop(() => this.scheduleEmit(state)),
      // The buffer already debounces this event (~300 ms after typing stops),
      // so no extra timer is layered on top.
      editor.onDidStopChanging(() => this.emitStale(state)),
      editor.onDidDestroy(() => this.unwatchEditor(editor)),
    );
    // A background pane reports a meaningless viewport; emit when the editor
    // is revealed so features catch up on rows scrolled to while hidden. The
    // observer fires after the component's reveal update (didShow renders
    // synchronously), so the measurements read here are current.
    const observer = new IntersectionObserver((entries) => {
      const { intersectionRect } = entries[entries.length - 1];
      const visible = intersectionRect.width > 0 || intersectionRect.height > 0;
      if (visible && state.visible === false) this.emitStale(state);
      state.visible = visible;
    });
    observer.observe(element);
    state.subscriptions.add(new Disposable(() => observer.disconnect()));
  }
  unwatchEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.subscriptions.dispose();
    this.states.delete(editor);
  }
  scheduleEmit(state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.emitStale(state);
    }, SCROLL_SETTLE_MS);
  }
  emitStale(state) {
    if (state.editor.isDestroyed()) return;
    this.emitter.emit("stale", { editor: state.editor, range: this.rangeForEditor(state.editor) });
  }
  rangeForEditor(editor) {
    const lastBufferRow = editor.getBuffer().getLastRow();
    const first = editor.bufferRowForScreenRow(editor.getFirstVisibleScreenRow());
    const last = editor.bufferRowForScreenRow(editor.getLastVisibleScreenRow());
    return [Math.max(0, first - MARGIN_ROWS), Math.min(lastBufferRow, last + MARGIN_ROWS)];
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.unwatchEditor(editor);
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
