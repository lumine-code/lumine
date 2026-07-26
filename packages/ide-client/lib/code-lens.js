const { CompositeDisposable } = require("atom");
const C = require("./converters");

const CODE_LENS_CAPABILITIES = {
  textDocument: { codeLens: { dynamicRegistration: true } },
  workspace: { codeLens: { refreshSupport: true } },
};

// Extra settle time on top of the buffer's own stopped-changing delay: lens
// positions are anchored markers, so refetching lazily is fine.
const FETCH_DEBOUNCE_MS = 1000;

// Renders textDocument/codeLens results as block decorations above the rows
// they annotate. Unresolved lenses show a placeholder and resolve lazily when
// their row scrolls into view. Disabled by default; the gate is the scoped
// config ide-client.codeLens.enabled, so it can be enabled per language.
module.exports = class CodeLens {
  static capabilities = CODE_LENS_CAPABILITIES;
  constructor(manager, tracker) {
    this.manager = manager;
    this.tracker = tracker;
    manager.addCapabilityFragment(CODE_LENS_CAPABILITIES);
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      atom.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
      manager.onDidRequestRefresh(({ session, kind }) => {
        if (kind === "codeLens") this.refreshSession(session);
      }),
      manager.onDidChangeSession(({ session, state }) => {
        if (state === "running") this.refreshSession(session);
      }),
      tracker.onDidBecomeStale(({ editor, range }) => this.resolveVisible(editor, range)),
      atom.config.onDidChange("ide-client.codeLens.enabled", () => this.fetchAll()),
    );
  }
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      session: null,
      rows: new Map(),
      timer: null,
      generation: 0,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      editor.onDidStopChanging(() => this.scheduleFetch(state)),
      editor.onDidDestroy(() => this.detachEditor(editor)),
    );
    this.fetch(state);
  }
  detachEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.generation++;
    state.subscriptions.dispose();
    this.clear(state);
    this.states.delete(editor);
  }
  enabledFor(editor) {
    return !!atom.config.get("ide-client.codeLens.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
  }
  scheduleFetch(state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.fetch(state);
    }, FETCH_DEBOUNCE_MS);
  }
  fetchAll() {
    for (const state of this.states.values()) this.fetch(state);
  }
  refreshSession(session) {
    for (const state of this.states.values())
      if (!state.session || state.session === session) this.fetch(state);
  }
  async fetch(state) {
    const { editor } = state;
    const generation = ++state.generation;
    if (!this.enabledFor(editor)) return this.clear(state);
    const session = await this.manager.activeSessionForFeature(editor, "textDocument/codeLens");
    if (state.generation !== generation || editor.isDestroyed()) return;
    if (!session) return this.clear(state);
    state.session = session;
    let lenses;
    try {
      lenses = await session.request("textDocument/codeLens", {
        textDocument: { uri: C.pathToUri(editor.getPath()) },
      });
    } catch {
      return;
    }
    if (state.generation !== generation || editor.isDestroyed()) return;
    this.render(state, lenses || []);
  }
  // Refresh in place: block-decoration insertion has no scroll anchoring, so
  // destroying and recreating an item whose row survives would make the
  // viewport jump. Surviving rows keep their marker, decoration, and item;
  // only their anchors are updated.
  render(state, lenses) {
    const byRow = new Map();
    for (const lens of lenses) {
      const row = lens?.range?.start?.line;
      if (row == null || row < 0) continue;
      let group = byRow.get(row);
      if (!group) byRow.set(row, (group = []));
      group.push(lens);
    }
    for (const [row, entry] of state.rows) {
      if (byRow.has(row)) continue;
      entry.marker.destroy();
      state.rows.delete(row);
    }
    for (const [row, group] of byRow) {
      let entry = state.rows.get(row);
      if (!entry) {
        entry = this.createRowEntry(state, row);
        state.rows.set(row, entry);
      } else if (entry.marker.getStartBufferPosition().row !== row) {
        // The marker drifted with edits since the last fetch; the freshly
        // fetched row is authoritative.
        entry.marker.setBufferRange([
          [row, 0],
          [row, 0],
        ]);
      }
      entry.lenses = group;
      entry.resolving.clear();
      this.renderRowItem(entry);
    }
  }
  createRowEntry(state, row) {
    // Block decorations tolerate empty ranges (only text decorations skip
    // them), so the marker sits collapsed at the start of the row.
    const marker = state.editor.markBufferRange(
      [
        [row, 0],
        [row, 0],
      ],
      { invalidate: "touch" },
    );
    const item = document.createElement("div");
    item.className = "ide-client-code-lens";
    const entry = { marker, item, lenses: [], resolving: new Set() };
    item.addEventListener("click", (event) => this.didClick(state, entry, event));
    entry.decoration = state.editor.decorateMarker(marker, {
      type: "block",
      position: "before",
      order: 0,
      item,
    });
    return entry;
  }
  renderRowItem(entry) {
    const { item, lenses } = entry;
    while (item.childNodes.length > lenses.length) item.lastChild.remove();
    lenses.forEach((lens, index) => {
      let anchor = item.childNodes[index];
      if (!anchor) {
        anchor = document.createElement("a");
        item.appendChild(anchor);
      }
      anchor.textContent = lens.command ? lens.command.title : "…";
    });
  }
  didClick(state, entry, event) {
    const anchor = event.target.closest("a");
    if (!anchor || !entry.item.contains(anchor)) return;
    const command =
      entry.lenses[Array.prototype.indexOf.call(entry.item.childNodes, anchor)]?.command;
    if (!command?.command) return;
    event.preventDefault();
    state.session
      ?.request("workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments,
      })
      .catch((error) =>
        atom.notifications.addError("Code lens command failed", {
          detail: error.message,
          dismissable: true,
        }),
      );
  }
  // Lazily resolve placeholder lenses whose rows entered the viewport.
  resolveVisible(editor, [startRow, endRow]) {
    const state = this.states.get(editor);
    const session = state?.session;
    if (!session?.capabilities?.codeLensProvider?.resolveProvider) return;
    for (const entry of state.rows.values()) {
      const row = entry.marker.getStartBufferPosition().row;
      if (row < startRow || row > endRow) continue;
      entry.lenses.forEach((lens, index) => {
        if (lens.command || entry.resolving.has(lens)) return;
        entry.resolving.add(lens);
        session
          .request("codeLens/resolve", lens)
          .then((resolved) => {
            entry.resolving.delete(lens);
            // A refetch may have replaced the row's lenses meanwhile.
            if (!resolved?.command || entry.lenses[index] !== lens) return;
            lens.command = resolved.command;
            const anchor = entry.item.childNodes[index];
            if (anchor) anchor.textContent = lens.command.title;
          })
          .catch(() => entry.resolving.delete(lens));
      });
    }
  }
  clear(state) {
    if (!state.editor.isDestroyed())
      for (const entry of state.rows.values()) entry.marker.destroy();
    state.rows.clear();
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
  }
};
