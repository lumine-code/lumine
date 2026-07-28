"use strict";

const { normalizeSource, SourceRun } = require("./modal-source");
const { normalizeMatcher } = require("./modal-matcher");
const { normalizeActions } = require("./modal-actions");
const { normalizeEntry, defaultEntry } = require("./modal-row");

// One mounted view: capability normalization plus the item pipeline
//   run → deliver → entries → match → visible rows
// with a generation on every async hop so a late result can never paint into a
// frame that has moved on.

let nextFrameId = 0;

class ModalFrame {
  constructor(spec, { session, params }) {
    this.id = ++nextFrameId;
    this.spec = spec;
    this.session = session;
    this.params = params ?? {};

    this.source = spec.source == null ? null : normalizeSource(spec.source);
    this.matcher = normalizeMatcher(spec.source == null ? "none" : spec.matcher);
    this.renderer = spec.renderer ?? null;
    this.actions = normalizeActions(spec);

    this.items = [];
    this.entries = [];
    this.visible = [];
    this.focusedIndex = -1;
    this.checked = new Set();
    this.generation = 0;
    this.run = null;
    this.status = { busy: false, message: null, badge: null, severity: null };
    this.validation = null;
    this.emptyMessageOverride = null;
    this.scrollTop = 0;
    this.settled = false;
    this.rowCache = new Map();
  }

  get template() {
    return this.spec.template ?? (this.source ? "list" : "input");
  }

  get isList() {
    return this.template === "list";
  }

  actionNamed(name) {
    return this.actions.find((action) => action.name === name) ?? null;
  }

  // ── source ────────────────────────────────────────────────────────────────

  startRun(query, { reset = false } = {}) {
    this.abortRun();
    if (!this.source) {
      this.settled = true;
      return null;
    }
    if (reset) {
      this.items = [];
      this.entries = [];
    }
    const generation = ++this.generation;
    this.settled = false;
    this.setStatus({ busy: true });

    const run = new SourceRun({
      source: this.source,
      session: this.session,
      query,
      params: this.params,
      generation,
      onDeliver: (items, mode) => {
        if (generation !== this.generation) return;
        this.setItems(mode === "append" ? this.items.concat(items) : items);
        this.session.didUpdateFrame(this);
      },
      onProgress: (status) => {
        if (generation !== this.generation) return;
        if (status && "emptyMessage" in status) this.emptyMessageOverride = status.emptyMessage;
        this.setStatus(status);
        this.session.didUpdateFrame(this);
      },
      onFail: (error) => {
        if (generation !== this.generation) return;
        this.setStatus({
          busy: false,
          message: error && error.message ? error.message : String(error),
          severity: "error",
        });
        this.session.didUpdateFrame(this);
      },
      onDone: () => {
        if (generation !== this.generation) return;
        this.settled = true;
        this.setStatus({ busy: false });
        this.session.didUpdateFrame(this);
      },
    });

    this.run = run;
    run.start();
    return run;
  }

  abortRun() {
    if (this.run) {
      this.run.abort();
      this.run = null;
    }
  }

  setItems(items) {
    this.items = items ?? [];
    this.entries = this.items.map((item, index) => {
      let entry;
      if (this.renderer && typeof this.renderer.entry === "function") {
        try {
          entry = normalizeEntry(this.renderer.entry(item, index), item, index);
        } catch (error) {
          console.error("modals: renderer.entry threw", error);
          entry = defaultEntry(item, index);
        }
      } else {
        entry = defaultEntry(item, index);
      }
      entry.item = item;
      return entry;
    });
    this.rowCache.clear();
    this.matcher.setItems(this.entries, { session: this.session });
  }

  // ── filtering ─────────────────────────────────────────────────────────────

  filter(query, { selectionStrategy } = {}) {
    const previousId = this.focusedEntry() ? this.focusedEntry().id : null;

    let results;
    try {
      results = this.matcher.match(query, { session: this.session }) ?? [];
    } catch (error) {
      console.error("modals: matcher threw", error);
      results = [];
    }

    // Rows flagged `alwaysShow` bypass filtering entirely (pinned/sentinel rows).
    if (query.text) {
      const matched = new Set(results.map((r) => r.index));
      for (let index = 0; index < this.entries.length; index++) {
        if (this.entries[index].alwaysShow && !matched.has(index)) {
          results.push({ entry: this.entries[index], index, score: 0, pinned: true });
        }
      }
    }

    this.visible = results;
    this.rowCache.clear();
    this.applySelection(previousId, selectionStrategy ?? this.spec.selectionStrategy ?? "follow");
  }

  applySelection(previousId, strategy) {
    if (this.visible.length === 0) {
      this.focusedIndex = -1;
      return;
    }
    // A view that opted out of activation stays unfocused through every
    // re-filter; otherwise "follow" would quietly focus row 0 on the first
    // delivery and Enter would confirm a row the user never selected.
    if (this.spec.initialActivation === "none" && this.focusedIndex < 0) return;
    if (strategy === "none") {
      if (this.focusedIndex >= this.visible.length) this.focusedIndex = -1;
      return;
    }
    if (strategy === "reset") {
      this.focusedIndex = this.firstSelectableIndex(0);
      return;
    }
    if (strategy === "index") {
      this.focusedIndex = this.clampIndex(this.focusedIndex);
      return;
    }
    if (previousId != null) {
      const found = this.visible.findIndex((result) => result.entry.id === previousId);
      if (found >= 0) {
        this.focusedIndex = found;
        return;
      }
    }
    this.focusedIndex = this.clampIndex(this.focusedIndex);
  }

  clampIndex(index) {
    if (this.visible.length === 0) return -1;
    if (index < 0) return this.firstSelectableIndex(0);
    if (index >= this.visible.length) return this.firstSelectableIndex(this.visible.length - 1, -1);
    return this.firstSelectableIndex(index);
  }

  firstSelectableIndex(start, direction = 1) {
    for (let i = start; i >= 0 && i < this.visible.length; i += direction) {
      if (this.isSelectable(i)) return i;
    }
    for (let i = start - direction; i >= 0 && i < this.visible.length; i -= direction) {
      if (this.isSelectable(i)) return i;
    }
    return -1;
  }

  isSelectable(index) {
    const result = this.visible[index];
    if (!result) return false;
    if (result.entry.selectable === false) return false;
    const row = this.rowFor(index);
    return row.kind !== "separator" && row.selectable !== false;
  }

  applyInitialActivation() {
    const initial = this.spec.initialActivation ?? "first";
    if (this.visible.length === 0) {
      this.focusedIndex = -1;
      return;
    }
    if (initial === "none") this.focusedIndex = -1;
    else if (initial === "last")
      this.focusedIndex = this.firstSelectableIndex(this.visible.length - 1, -1);
    else if (initial === "second") this.focusedIndex = this.firstSelectableIndex(1);
    else if (initial && typeof initial === "object" && initial.id != null) {
      const found = this.visible.findIndex((r) => r.entry.id === initial.id);
      this.focusedIndex = found >= 0 ? found : this.firstSelectableIndex(0);
    } else this.focusedIndex = this.firstSelectableIndex(0);
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  // Rows are built lazily and cached per visible index: the matcher and the
  // selection engine read Entry, never Row, so nothing forces a render of the
  // whole result set.
  rowFor(index) {
    if (this.rowCache.has(index)) return this.rowCache.get(index).row;
    const built = this.buildRow(index);
    this.rowCache.set(index, built);
    return built.row;
  }

  visibleAt(index) {
    if (this.rowCache.has(index)) return this.rowCache.get(index);
    const built = this.buildRow(index);
    this.rowCache.set(index, built);
    return built;
  }

  buildRow(index) {
    const result = this.visible[index];
    const item = result.entry.item;
    const query = this.session.getQuery();

    let highlights = result.highlights;
    if (!highlights) {
      try {
        highlights = result.pinned ? {} : this.matcher.highlightsFor(result, query);
      } catch (error) {
        console.error("modals: highlight computation threw", error);
        highlights = {};
      }
    }

    const ctx = {
      session: this.session,
      query,
      index,
      focused: index === this.focusedIndex,
      checked: this.checked.has(item),
      highlights,
    };

    let row;
    try {
      if (this.renderer && typeof this.renderer.element === "function") {
        row = { element: this.renderer.element(item, ctx) };
      } else if (this.renderer && typeof this.renderer.row === "function") {
        row = this.renderer.row(item, ctx);
      } else if (typeof this.renderer === "function") {
        row = this.renderer(item, ctx);
      } else {
        row = item;
      }
      if (row instanceof HTMLElement) row = { element: row };
      if (row == null || typeof row !== "object") row = { label: String(row ?? "") };
    } catch (error) {
      console.error("modals: renderer threw", error);
      row = { label: result.entry.text, className: "modals-row-error" };
    }

    if (this.renderer && typeof this.renderer.decorate === "function") {
      row = { ...row, _decorate: (li) => this.renderer.decorate(li, item, ctx) };
    }

    return { item, entry: result.entry, row, ctx, index };
  }

  visibleForTemplate() {
    const out = [];
    for (let index = 0; index < this.visible.length; index++) out.push(this.visibleAt(index));
    return out;
  }

  focusedEntry() {
    const result = this.visible[this.focusedIndex];
    return result ? result.entry : null;
  }

  focusedItem() {
    const entry = this.focusedEntry();
    return entry ? entry.item : null;
  }

  // ── status ────────────────────────────────────────────────────────────────

  setStatus(patch) {
    if (!patch) return;
    for (const key of ["busy", "message", "badge", "severity"]) {
      if (key in patch) this.status[key] = patch[key];
    }
  }

  clearStatus() {
    this.status = { busy: false, message: null, badge: null, severity: null };
  }

  // ── teardown ──────────────────────────────────────────────────────────────

  destroy() {
    this.abortRun();
    if (this.matcher && typeof this.matcher.dispose === "function") this.matcher.dispose();
    this.rowCache.clear();
    this.items = [];
    this.entries = [];
    this.visible = [];
    this.checked.clear();
  }
}

module.exports = { ModalFrame };
