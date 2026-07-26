const { CompositeDisposable } = require("atom");
const C = require("./converters");
const {
  STANDARD_TOKEN_TYPES,
  STANDARD_TOKEN_MODIFIERS,
  createScopeMap,
} = require("./semantic-scope-map");

const SEMANTIC_TOKENS_CAPABILITIES = {
  textDocument: {
    semanticTokens: {
      dynamicRegistration: true,
      requests: { full: { delta: true }, range: true },
      tokenTypes: STANDARD_TOKEN_TYPES,
      tokenModifiers: STANDARD_TOKEN_MODIFIERS,
      formats: ["relative"],
      augmentsSyntaxTokens: true,
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
    },
  },
  workspace: { semanticTokens: { refreshSupport: true } },
};

// Budgets: past these, whole-document decoration is not worth the marker
// count. Fall back to viewport-only range requests, or skip the feature when
// the server cannot serve ranges either.
const MAX_BUFFER_LINES = 5000;
const MAX_TOKEN_COUNT = 20000;
// Markers created per batch before yielding, to avoid long main-thread tasks.
const MARKER_CHUNK = 2000;

// Overlays textDocument/semanticTokens results as text decorations carrying
// conventional syntax--* classes, so themes color them like grammar scopes.
// Disabled by default; gated by the scoped config
// ide-client.semanticTokens.enabled.
module.exports = class SemanticTokens {
  static capabilities = SEMANTIC_TOKENS_CAPABILITIES;
  constructor(manager, tracker) {
    this.manager = manager;
    this.tracker = tracker;
    manager.addCapabilityFragment(SEMANTIC_TOKENS_CAPABILITIES);
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      atom.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
      manager.onDidRequestRefresh(({ session, kind }) => {
        if (kind === "semanticTokens") this.refreshSession(session);
      }),
      manager.onDidChangeSession(({ session, state }) => {
        if (state === "running") this.refreshSession(session);
      }),
      tracker.onDidBecomeStale(({ editor, range }) => this.viewportChanged(editor, range)),
      atom.config.onDidChange("ide-client.semanticTokens.enabled", () => this.fetchAll()),
    );
  }
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      session: null,
      layer: null,
      layerDecoration: null,
      markers: [],
      scopeMap: null,
      legend: null,
      data: null,
      resultId: null,
      rangeMode: false,
      generation: 0,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      editor.onDidStopChanging(() => this.fetch(state)),
      editor.onDidDestroy(() => this.detachEditor(editor)),
    );
    this.fetch(state);
  }
  detachEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    state.generation++;
    state.subscriptions.dispose();
    this.clear(state);
    state.layerDecoration?.destroy();
    if (!editor.isDestroyed()) state.layer?.destroy();
    this.states.delete(editor);
  }
  enabledFor(editor) {
    return !!atom.config.get("ide-client.semanticTokens.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
  }
  fetchAll() {
    for (const state of this.states.values()) this.fetch(state);
  }
  refreshSession(session) {
    for (const state of this.states.values()) {
      if (state.session && state.session !== session) continue;
      // The server declared previous results void; a delta over them would lie.
      state.data = null;
      state.resultId = null;
      this.fetch(state);
    }
  }
  viewportChanged(editor, range) {
    const state = this.states.get(editor);
    if (!state?.rangeMode || !state.session) return;
    this.fetchRange(state, range, ++state.generation);
  }
  async fetch(state) {
    const { editor } = state;
    const generation = ++state.generation;
    if (!this.enabledFor(editor)) return this.clear(state);
    // Only one server may classify a buffer: two token sets over the same
    // ranges would fight for the same decorations.
    const session = await this.manager.activeSessionForFeature(
      editor,
      "textDocument/semanticTokens",
    );
    if (state.generation !== generation || editor.isDestroyed()) return;
    if (!session) return this.clear(state);
    const provider = session.capabilities.semanticTokensProvider;
    if (!provider?.legend) return this.clear(state);
    state.session = session;
    if (state.legend !== provider.legend) {
      state.legend = provider.legend;
      state.scopeMap = createScopeMap(provider.legend);
    }
    // Viewport-only mode is sticky for the editor once a budget trips; the
    // next full fetch would only trip it again.
    if (state.rangeMode || editor.getLineCount() > MAX_BUFFER_LINES || !provider.full) {
      if (!provider.range) return this.clear(state);
      state.rangeMode = true;
      return this.fetchRange(state, this.tracker.rangeForEditor(editor), generation);
    }
    const textDocument = { uri: C.pathToUri(editor.getPath()) };
    let result;
    try {
      if (state.resultId && state.data && provider.full?.delta) {
        result = await session.request("textDocument/semanticTokens/full/delta", {
          textDocument,
          previousResultId: state.resultId,
        });
      } else {
        result = await session.request("textDocument/semanticTokens/full", { textDocument });
      }
    } catch {
      return;
    }
    if (state.generation !== generation || editor.isDestroyed()) return;
    const data = result?.edits ? this.applyEdits(state.data, result.edits) : result?.data || [];
    state.data = data;
    state.resultId = result?.resultId || null;
    const tokens = this.decode(data);
    if (tokens.length > MAX_TOKEN_COUNT) {
      state.data = null;
      state.resultId = null;
      if (!provider.range) return this.clear(state);
      state.rangeMode = true;
      return this.fetchRange(state, this.tracker.rangeForEditor(editor), generation);
    }
    await this.buildMarkers(state, tokens, generation);
  }
  async fetchRange(state, [startRow, endRow], generation) {
    const { editor, session } = state;
    let result;
    try {
      result = await session.request("textDocument/semanticTokens/range", {
        textDocument: { uri: C.pathToUri(editor.getPath()) },
        range: { start: { line: startRow, character: 0 }, end: { line: endRow + 1, character: 0 } },
      });
    } catch {
      return;
    }
    if (state.generation !== generation || editor.isDestroyed()) return;
    await this.buildMarkers(state, this.decode(result?.data || []), generation);
  }
  // Decodes the packed relative uint array
  // (deltaLine/deltaStart/length/type/modifiers) into absolute positions.
  decode(data) {
    const tokens = [];
    let row = 0;
    let column = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      if (data[i] > 0) {
        row += data[i];
        column = data[i + 1];
      } else {
        column += data[i + 1];
      }
      tokens.push({ row, column, length: data[i + 2], type: data[i + 3], modifiers: data[i + 4] });
    }
    return tokens;
  }
  // Applies SemanticTokensEdits to the stored uint array. Markers are then
  // rebuilt from scratch: reconstructing only the edited span invites
  // off-by-one drift for no measured win — correctness first.
  applyEdits(data, edits) {
    let next = Array.from(data || []);
    for (const edit of [...edits].sort((a, b) => b.start - a.start))
      next = next
        .slice(0, edit.start)
        .concat(edit.data || [], next.slice(edit.start + edit.deleteCount));
    return next;
  }
  ensureLayer(state) {
    if (state.layer) return;
    state.layer = state.editor.addMarkerLayer({ maintainHistory: false });
    state.layerDecoration = state.editor.decorateMarkerLayer(state.layer, {
      type: "text",
      class: "ide-client-semantic-token",
    });
  }
  async buildMarkers(state, tokens, generation) {
    this.clearMarkers(state);
    this.ensureLayer(state);
    const { layer, layerDecoration, scopeMap } = state;
    for (let offset = 0; offset < tokens.length; offset += MARKER_CHUNK) {
      if (state.generation !== generation || state.editor.isDestroyed()) return;
      const end = Math.min(offset + MARKER_CHUNK, tokens.length);
      for (let i = offset; i < end; i++) {
        const token = tokens[i];
        if (!token.length) continue;
        const marker = layer.markBufferRange(
          [
            [token.row, token.column],
            [token.row, token.column + token.length],
          ],
          { invalidate: "touch" },
        );
        layerDecoration.setPropertiesForMarker(
          marker,
          scopeMap.propertiesFor(token.type, token.modifiers),
        );
        state.markers.push(marker);
      }
      if (end < tokens.length) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  clearMarkers(state) {
    if (!state.editor.isDestroyed()) {
      for (const marker of state.markers) {
        // Drop the override first so the LayerDecoration's per-marker map
        // does not accumulate destroyed markers across refetches.
        state.layerDecoration?.setPropertiesForMarker(marker, null);
        marker.destroy();
      }
    }
    state.markers.length = 0;
  }
  clear(state) {
    this.clearMarkers(state);
    state.data = null;
    state.resultId = null;
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
  }
};
