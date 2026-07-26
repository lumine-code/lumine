const { CompositeDisposable, Disposable } = require("atom");
const C = require("./converters");

const INLAY_HINT_CAPABILITIES = {
  textDocument: {
    inlayHint: {
      dynamicRegistration: true,
      resolveSupport: { properties: ["tooltip", "textEdits", "label.tooltip", "label.command"] },
    },
  },
  workspace: { inlayHint: { refreshSupport: true } },
};

// Renders textDocument/inlayHint labels as text decorations whose ::before
// (or ::after at end of line) content comes from a CSS custom property, so no
// extra DOM nodes or measurement work are needed beyond the renderer's own
// width-changing text-decoration support. Fetches viewport ranges only,
// driven by the shared viewport tracker.
module.exports = class InlayHints {
  static capabilities = INLAY_HINT_CAPABILITIES;
  constructor(manager, tracker) {
    this.manager = manager;
    this.tracker = tracker;
    manager.addCapabilityFragment(INLAY_HINT_CAPABILITIES);
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      atom.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
      manager.onDidRequestRefresh(({ session, kind }) => {
        if (kind === "inlayHint") this.refreshSession(session);
      }),
      manager.onDidChangeSession(({ session, state }) => {
        if (state === "running") this.refreshSession(session);
      }),
      tracker.onDidBecomeStale(({ editor, range }) => {
        const state = this.states.get(editor);
        if (state) this.fetch(state, range);
      }),
      atom.config.onDidChange("ide-client.inlayHints.enabled", () => this.fetchAll()),
      atom.config.onDidChange("ide-client.inlayHints.maxLabelLength", () => this.fetchAll()),
    );
  }
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      session: null,
      layer: null,
      hints: new Map(),
      generation: 0,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(editor.onDidDestroy(() => this.detachEditor(editor)));
    // Capture-phase so the click never reaches the renderer's own mousedown
    // handling: a click landing on the label pseudo-element has no text node
    // under it, and the renderer's fallback would put the cursor at column 0.
    const element = editor.getElement();
    const listener = (event) => this.didMouseDown(state, event);
    element.addEventListener("mousedown", listener, true);
    state.subscriptions.add(
      new Disposable(() => element.removeEventListener("mousedown", listener, true)),
    );
    this.fetch(state, this.tracker.rangeForEditor(editor));
  }
  detachEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    state.generation++;
    state.subscriptions.dispose();
    this.clear(state);
    if (!editor.isDestroyed()) state.layer?.destroy();
    this.states.delete(editor);
  }
  enabledFor(editor) {
    return !!atom.config.get("ide-client.inlayHints.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
  }
  fetchAll() {
    for (const state of this.states.values())
      this.fetch(state, this.tracker.rangeForEditor(state.editor));
  }
  refreshSession(session) {
    for (const state of this.states.values())
      if (!state.session || state.session === session)
        this.fetch(state, this.tracker.rangeForEditor(state.editor));
  }
  async fetch(state, range) {
    const { editor } = state;
    const generation = ++state.generation;
    if (!this.enabledFor(editor)) return this.clear(state);
    // The server that serves hints is picked by capability, not by order: a
    // linter and a type checker can share the editor while only one of them
    // has hints to give.
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/inlayHint");
    if (state.generation !== generation || editor.isDestroyed()) return;
    if (!session) return this.clear(state);
    state.session = session;
    const [startRow, endRow] = range;
    let hints;
    try {
      hints = await session.request("textDocument/inlayHint", {
        textDocument: { uri: C.pathToUri(editor.getPath()) },
        range: { start: { line: startRow, character: 0 }, end: { line: endRow + 1, character: 0 } },
      });
    } catch {
      return;
    }
    if (state.generation !== generation || editor.isDestroyed()) return;
    this.render(state, hints || [], startRow, endRow);
  }
  labelFor(hint) {
    const label = Array.isArray(hint.label)
      ? hint.label.map((part) => part?.value || "").join("")
      : hint.label || "";
    const max = atom.config.get("ide-client.inlayHints.maxLabelLength") ?? 48;
    return label.length > max ? `${label.slice(0, max)}…` : label;
  }
  // Reconcile against the live entries: a hint that reappears identically
  // keeps its marker and decoration untouched, so its cached property object
  // lets textDecorationsEqual short-circuit the line rebuild. Only stale
  // entries inside the fetched range are destroyed — rows outside it were not
  // re-queried and their hints are still the best data available.
  render(state, hints, startRow, endRow) {
    const { editor } = state;
    const buffer = editor.getBuffer();
    const next = new Map();
    for (const hint of hints) {
      if (!hint?.position) continue;
      const label = this.labelFor(hint);
      if (!label) continue;
      const row = hint.position.line;
      if (row < 0 || row > buffer.getLastRow()) continue;
      const lineLength = buffer.lineLengthForRow(row);
      // Text decorations skip empty ranges, and an empty line offers no
      // character to span: skip the hint entirely.
      if (lineLength === 0) continue;
      const column = Math.min(Math.max(hint.position.character, 0), lineLength);
      const atEnd = column >= lineLength;
      const pads = `${hint.paddingLeft ? "L" : ""}${hint.paddingRight ? "R" : ""}`;
      const key = `${row}:${column}:${atEnd ? "a" : "b"}:${pads}:${label}`;
      if (next.has(key)) continue;
      const existing = state.hints.get(key);
      if (existing) {
        state.hints.delete(key);
        next.set(key, existing);
        continue;
      }
      next.set(key, this.createHint(state, { row, column, atEnd, label, hint }));
    }
    for (const [key, entry] of state.hints) {
      const row = entry.marker.getStartBufferPosition().row;
      if (row >= startRow && row <= endRow) entry.marker.destroy();
      else next.set(key, entry);
    }
    state.hints = next;
  }
  createHint(state, { row, column, atEnd, label, hint }) {
    if (!state.layer) state.layer = state.editor.addMarkerLayer({ maintainHistory: false });
    // The decorated span must wrap a real character: [P, P+1] renders the
    // label before the character at P via ::before; at end of line the marker
    // covers the last character and an ::after variant renders behind it.
    // Never [P, P] — the renderer skips empty text-decoration ranges.
    const range = atEnd
      ? [
          [row, column - 1],
          [row, column],
        ]
      : [
          [row, column],
          [row, column + 1],
        ];
    const marker = state.layer.markBufferRange(range, { invalidate: "touch" });
    let className = atEnd ? "ide-client-inlay-hint-after" : "ide-client-inlay-hint";
    if (hint.paddingLeft) className += " ide-client-inlay-hint-pad-left";
    if (hint.paddingRight) className += " ide-client-inlay-hint-pad-right";
    const properties = {
      type: "text",
      class: className,
      style: { "--ide-inlay-text": JSON.stringify(label) },
    };
    state.editor.decorateMarker(marker, properties);
    return { marker, properties, atEnd };
  }
  didMouseDown(state, event) {
    const target = event.target?.closest?.(".ide-client-inlay-hint, .ide-client-inlay-hint-after");
    if (!target) return;
    const lineNode = target.closest(".line");
    const screenRow = Number(lineNode?.dataset.screenRow);
    if (Number.isNaN(screenRow)) return;
    const bufferRow = state.editor.bufferRowForScreenRow(screenRow);
    const value = target.style.getPropertyValue("--ide-inlay-text");
    for (const entry of state.hints.values()) {
      const range = entry.marker.getBufferRange();
      if (range.start.row !== bufferRow) continue;
      if (entry.properties.style["--ide-inlay-text"] !== value) continue;
      event.preventDefault();
      event.stopPropagation();
      // The marker tracked edits since the fetch, so its current position is
      // the hint's live anchor.
      state.editor.setCursorBufferPosition(entry.atEnd ? range.end : range.start);
      return;
    }
  }
  clear(state) {
    if (!state.editor.isDestroyed())
      for (const entry of state.hints.values()) entry.marker.destroy();
    state.hints.clear();
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
  }
};
