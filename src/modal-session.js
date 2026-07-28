"use strict";

const { Emitter, CompositeDisposable, Disposable } = require("event-kit");
const { ModalFrame } = require("./modal-frame");
const { isAvailable } = require("./modal-actions");

// One modal conversation: a stack of frames on the shared host, the state
// machine that fences every async hop, and action resolution.
//
// Stage 1 ships the whole state machine but only depth 1; `push`/`pop` land in
// Stage 4. Everything else here — confirm-defer, validation flushing, the
// terminal-callback guarantee — is live from Stage 1 because the migrations
// depend on it.

const VALIDATE_DEBOUNCE = 150;
const CONFIRM_DEFER_MS = 250;
const MAX_DEPTH_DEFAULT = 12;

let nextSessionId = 0;

class ModalSession {
  constructor(manager, spec, { params = {}, mounted = false, target = null } = {}) {
    this.manager = manager;
    this.id = `s${++nextSessionId}`;
    this.mounted = mounted;
    this.params = params;
    this.target = target;

    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.frames = [];
    this.state = "idle";
    this.closed = false;
    this.closing = false;
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });

    this.pendingConfirm = null;
    this.validateTimer = null;
    this.validateGeneration = 0;
    this.actionDepth = 0;
    this.rootSpec = spec;

    this.pushFrame(spec, { params });
  }

  // ── frames & stack ────────────────────────────────────────────────────────

  get frame() {
    return this.frames[this.frames.length - 1];
  }

  // The top view. Falls back to the root spec once the stack has been drained
  // by a close, so anything reading it during teardown still gets an answer.
  get view() {
    return this.frames.length > 0 ? this.frame.spec : this.rootSpec;
  }

  get depth() {
    return this.frames.length;
  }

  pushFrame(spec, { params } = {}) {
    const frame = new ModalFrame(spec, { session: this, params: params ?? this.params });
    this.frames.push(frame);
    return frame;
  }

  getStack() {
    return this.frames.map((frame, index) => ({
      id: frame.spec.id,
      title: frame.spec.title,
      depth: index + 1,
    }));
  }

  canPop() {
    return this.frames.length > 1;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(host) {
    this.host = host;
    const frame = this.frame;

    if (typeof frame.spec.willOpen === "function") {
      let proceed;
      try {
        proceed = await frame.spec.willOpen(this);
      } catch (error) {
        console.error("modals: willOpen threw", error);
      }
      if (proceed === false) {
        this.finish({ status: "cancelled", reason: "api" });
        return false;
      }
      if (this.closed) return false;
    }

    this.mountFrame(frame, { initial: true });
    return true;
  }

  mountFrame(frame, { initial = false, query = "" } = {}) {
    this.host.applyView(this, frame);
    this.host.setQuery(query || frame.spec.value || "", {
      select: frame.spec.valueSelection ?? (frame.spec.value ? "all" : "none"),
      silent: true,
    });

    if (frame.source) {
      frame.startRun(this.getQuery(), { reset: true });
      frame.filter(this.getQuery());
      frame.applyInitialActivation();
    }
    if (initial) this.emitter.emit("did-open", this);
    this.render();
  }

  // ── query ─────────────────────────────────────────────────────────────────

  getQuery() {
    const raw = this.host ? this.host.getQueryText() : "";
    const spec = this.frame.spec;
    let extras = null;
    if (typeof spec.parseQuery === "function") {
      try {
        extras = spec.parseQuery(raw);
      } catch (error) {
        console.error("modals: parseQuery threw", error);
      }
    }
    if (extras && typeof extras === "object") {
      return { raw, ...extras, text: extras.text ?? raw };
    }
    return { raw, text: raw };
  }

  setQuery(text, opts = {}) {
    this.host.setQuery(text, opts);
    if (!opts.silent) this.didChangeQuery();
  }

  didChangeQuery() {
    const query = this.getQuery();
    const frame = this.frame;

    if (frame.source && frame.source.dynamic) {
      frame.startRun(query);
    } else if (frame.source) {
      frame.filter(query);
    }

    this.scheduleValidate(query);

    if (typeof frame.spec.didChangeQuery === "function") {
      try {
        frame.spec.didChangeQuery(query, this);
      } catch (error) {
        console.error("modals: didChangeQuery threw", error);
      }
    }
    this.emitter.emit("did-change-query", query);
    this.render();
  }

  // ── validation ────────────────────────────────────────────────────────────

  scheduleValidate(query) {
    const frame = this.frame;
    if (typeof frame.spec.validate !== "function") {
      frame.validation = null;
      return;
    }
    if (this.validateTimer != null) clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => {
      this.validateTimer = null;
      this.runValidate(query);
    }, VALIDATE_DEBOUNCE);
  }

  async runValidate(query) {
    const frame = this.frame;
    const generation = ++this.validateGeneration;
    let outcome;
    try {
      outcome = await frame.spec.validate(query, this);
    } catch (error) {
      console.error("modals: validate threw", error);
      outcome = null;
    }
    // A validator that resolves after the view moved on must never paint into
    // the frame that replaced it.
    if (generation !== this.validateGeneration || this.closed || this.frame !== frame) return;
    frame.validation = normalizeValidation(outcome);
    this.render();
  }

  // Confirm must not outrun a debounced validator: flush it, await it, then
  // decide. Capped so a slow async validator cannot block Enter forever.
  async flushValidation() {
    const frame = this.frame;
    if (typeof frame.spec.validate !== "function") return frame.validation;
    if (this.validateTimer != null) {
      clearTimeout(this.validateTimer);
      this.validateTimer = null;
      const pending = this.runValidate(this.getQuery());
      await Promise.race([pending, wait(CONFIRM_DEFER_MS)]);
    }
    return frame.validation;
  }

  // ── selection ─────────────────────────────────────────────────────────────

  getItems() {
    return this.frame.items;
  }

  getVisibleItems() {
    return this.frame.visible.map((result) => result.entry.item);
  }

  getFocusedItem() {
    return this.frame.focusedItem();
  }

  getFocusedIndex() {
    return this.frame.focusedIndex;
  }

  focusItem(idOrIndex) {
    const frame = this.frame;
    let index = idOrIndex;
    if (typeof idOrIndex !== "number") {
      index = frame.visible.findIndex((result) => result.entry.id === idOrIndex);
    }
    this.focusIndex(index);
  }

  focusIndex(index) {
    const frame = this.frame;
    if (index < 0 || index >= frame.visible.length) return;
    if (!frame.isSelectable(index)) return;
    if (frame.focusedIndex === index) return;
    frame.focusedIndex = index;
    frame.rowCache.clear();
    this.didChangeFocusedItem();
    this.render();
  }

  moveFocus(delta) {
    const frame = this.frame;
    if (frame.visible.length === 0) return;
    let index = frame.focusedIndex;
    for (let step = 0; step < frame.visible.length; step++) {
      index += delta;
      if (index < 0) index = frame.visible.length - 1;
      if (index >= frame.visible.length) index = 0;
      if (frame.isSelectable(index)) break;
    }
    this.focusIndex(index);
  }

  focusEdge(which) {
    const frame = this.frame;
    if (frame.visible.length === 0) return;
    const index =
      which === "first"
        ? frame.firstSelectableIndex(0)
        : frame.firstSelectableIndex(frame.visible.length - 1, -1);
    this.focusIndex(index);
  }

  didChangeFocusedItem() {
    const item = this.getFocusedItem();
    const spec = this.frame.spec;
    if (typeof spec.didChangeFocusedItem === "function") {
      try {
        spec.didChangeFocusedItem(item, this);
      } catch (error) {
        console.error("modals: didChangeFocusedItem threw", error);
      }
    }
    this.emitter.emit("did-change-focused-item", item);
    if (this.host) this.host.didChangeFocusedItem(this);
  }

  // ── checked set (multi-select data model; UI lands in Stage 4) ─────────────

  getCheckedItems() {
    return Array.from(this.frame.checked);
  }

  setChecked(item, checked) {
    if (checked) this.frame.checked.add(item);
    else this.frame.checked.delete(item);
    this.frame.rowCache.clear();
    this.emitter.emit("did-change-checked", this.getCheckedItems());
    this.render();
  }

  toggleChecked(item) {
    const target = item ?? this.getFocusedItem();
    if (target == null) return;
    this.setChecked(target, !this.frame.checked.has(target));
  }

  clearChecked() {
    this.frame.checked.clear();
    this.frame.rowCache.clear();
    this.render();
  }

  // ── source control ────────────────────────────────────────────────────────

  async refresh({ reset = false } = {}) {
    const run = this.frame.startRun(this.getQuery(), { reset });
    if (!run) return;
    await run.whenSettled();
    if (this.closed) return;
    this.frame.filter(this.getQuery());
    this.render();
  }

  async setSource(source, { reset = true } = {}) {
    this.frame.spec = { ...this.frame.spec, source };
    this.frame.source = source == null ? null : require("./modal-source").normalizeSource(source);
    await this.refresh({ reset });
  }

  isBusy() {
    return this.frame.status.busy || this.state === "busy";
  }

  didUpdateFrame(frame) {
    if (frame !== this.frame) return;
    if (frame.source && !frame.source.dynamic) {
      frame.filter(this.getQuery());
    } else if (frame.source && frame.source.dynamic && !frame.source.rematch) {
      frame.visible = frame.entries.map((entry, index) => ({ entry, index, score: 1 }));
      frame.rowCache.clear();
      frame.applySelection(null, frame.spec.selectionStrategy ?? "follow");
    } else if (frame.source) {
      frame.filter(this.getQuery());
    }
    if (frame.focusedIndex < 0 && frame.visible.length > 0) frame.applyInitialActivation();
    this.render();
    if (this.pendingConfirm && frame.settled) this.resolveDeferredConfirm();
  }

  // ── status ────────────────────────────────────────────────────────────────

  setStatus(patch) {
    this.frame.setStatus(patch);
    this.render();
  }

  clearStatus() {
    this.frame.clearStatus();
    this.render();
  }

  // Seeds the query from the selection in the editor that was focused before
  // the modal opened. No-op when there is no editor, or the selection spans
  // more than one line.
  setQueryFromSelection() {
    const editor = this.target && this.target.editor;
    if (!editor) return false;
    const text = editor.getSelectedText();
    if (!text || /\n/.test(text)) return false;
    this.setQuery(text, { select: "all" });
    return true;
  }

  setHelp(markdown) {
    this.frame.spec = { ...this.frame.spec, help: markdown };
    if (this.host) this.host.didChangeHelp(this);
  }

  // ── actions ───────────────────────────────────────────────────────────────

  actionContext({ secondary = false, event = null, item } = {}) {
    const focused = item !== undefined ? item : this.getFocusedItem();
    const checked = this.getCheckedItems();
    return {
      session: this,
      item: focused,
      items: checked.length ? checked : focused != null ? [focused] : [],
      query: this.getQuery(),
      secondary,
      event,
      signal: this.abortController ? this.abortController.signal : undefined,
      target: this.target,
    };
  }

  // Fixed resolution order: checked multi action → focused row → an
  // `when: "empty"` action → the raw query text.
  async confirmDefault({ secondary = false, event = null } = {}) {
    if (this.closing || this.closed) return;

    // A dynamic source still running for the CURRENT query means the focused
    // row is provisional; defer briefly rather than confirming the old list.
    const frame = this.frame;
    if (frame.source && !frame.settled) {
      if (this.pendingConfirm) return; // slot, not a queue — no double-fire
      this.pendingConfirm = { secondary, event };
      this.state = "settling";
      setTimeout(() => {
        if (this.pendingConfirm) this.resolveDeferredConfirm();
      }, CONFIRM_DEFER_MS);
      return;
    }

    await this.resolveConfirm({ secondary, event });
  }

  resolveDeferredConfirm() {
    const pending = this.pendingConfirm;
    this.pendingConfirm = null;
    if (this.state === "settling") this.state = "idle";
    if (!pending || this.closed) return;
    this.resolveConfirm(pending);
  }

  async resolveConfirm({ secondary = false, event = null }) {
    const frame = this.frame;
    const validation = await this.flushValidation();
    if (this.closed) return;

    const ctx = this.actionContext({ secondary, event });
    const name = secondary ? "confirm-secondary" : "confirm";

    if (ctx.item != null) {
      const row = frame.rowFor(frame.focusedIndex);
      if (row && row.disabled) return;
      // A row can declare its own sublist; confirming it pushes rather than
      // resolving. (`push` is honoured from Stage 4.)
      if (row && row.push) {
        await this.runActionResult({
          push: typeof row.push === "function" ? row.push(ctx) : row.push,
        });
        return;
      }
      const rowAction = row && row.actions ? row.actions.find((a) => a.name === name) : null;
      const action = rowAction ?? frame.actionNamed(name) ?? frame.actionNamed("confirm");
      if (action && typeof action.run === "function") {
        await this.invokeAction(action, ctx);
        return;
      }
      this.finish({ status: "confirmed", value: ctx.item, action: name, secondary });
      return;
    }

    // Severity "error" blocks confirming the typed text, but never blocks
    // confirming a focused row — hence the ordering above.
    if (validation && validation.severity === "error") return;

    // A dedicated `confirmEmpty` wins, but a plain `confirm` declared
    // `when: "always"` also handles the no-row case — that is how a hybrid view
    // (a history list whose Enter executes the typed text) is written as one
    // action branching on `ctx.item`.
    const candidates = [frame.actionNamed("confirm-empty"), frame.actionNamed("confirm")];
    for (const action of candidates) {
      if (!action || typeof action.run !== "function") continue;
      if (!isAvailable(action, ctx)) continue;
      await this.invokeAction(action, ctx);
      return;
    }

    this.finish({
      status: "confirmed",
      value: ctx.query.text,
      action: "confirm-empty",
      secondary,
    });
  }

  async invokeAction(action, ctx) {
    if (this.closed) return;
    if (!isAvailable(action, ctx)) return;

    const blocking = action.busy === "block";
    if (blocking) this.state = "busy";
    this.actionDepth++;
    const depthBefore = this.depth;
    this.abortController = this.abortController ?? new AbortController();
    if (blocking) this.render();

    let result;
    try {
      result = await action.run({ ...ctx, signal: this.abortController.signal });
    } catch (error) {
      console.error(`modals: action "${action.name}" threw`, error);
      if (!this.closed) {
        this.setStatus({
          busy: false,
          message: error && error.message ? error.message : String(error),
          severity: "error",
        });
      }
      this.actionDepth--;
      if (blocking && this.state === "busy") this.state = "idle";
      return;
    }

    this.actionDepth--;
    if (blocking && this.state === "busy") this.state = "idle";
    if (this.closed) return;

    if (action.keepOpen && (!result || result.keepOpen === undefined)) {
      result = { ...(result ?? {}), keepOpen: true };
    }
    // An action that entered a sublist — by calling push(), or by opening what
    // it thought was a separate modal — cannot also be closing the session. A
    // bare `return` there means "I already did the thing", not "confirm".
    if (!result && this.depth > depthBefore) return;
    await this.runActionResult(result, { action, ctx });
  }

  async runActionResult(result, { action, ctx } = {}) {
    if (this.closed) return;
    if (!result) {
      this.finish({
        status: "confirmed",
        value: ctx ? (ctx.item ?? ctx.query.text) : undefined,
        action: action ? action.name : "api",
        secondary: ctx ? ctx.secondary : false,
      });
      return;
    }

    if (result.status) this.setStatus(result.status);

    if (result.query !== undefined) {
      this.host.setQuery(result.query, { select: "none", silent: true });
    }

    if (result.push) {
      await this.push(result.push);
      return;
    }

    if (result.pop) {
      this.pop(result.pop === true ? 1 : result.pop, result.value);
      return;
    }

    const stayOpen = result.keepOpen && !result.close;

    if (result.refresh) {
      await this.refresh();
      if (this.closed) return;
    } else if (result.query !== undefined) {
      this.didChangeQuery();
    }

    if (result.select) this.applySelectDirective(result.select);

    if (!stayOpen) {
      this.finish({
        status: "confirmed",
        value: result.value !== undefined ? result.value : ctx ? ctx.item : undefined,
        action: action ? action.name : "api",
        secondary: ctx ? ctx.secondary : false,
      });
      return;
    }
    this.render();
  }

  applySelectDirective(select) {
    const frame = this.frame;
    if (select === "none") {
      frame.focusedIndex = -1;
      frame.rowCache.clear();
    } else if (select === "reset") {
      frame.applyInitialActivation();
    } else if (select === "next") {
      this.moveFocus(1);
    } else if (select === "previous") {
      this.moveFocus(-1);
    } else if (select && typeof select === "object" && select.id != null) {
      this.focusItem(select.id);
    }
  }

  dispatchAction(name, { secondary = false, event = null } = {}) {
    const frame = this.frame;
    const focusedRow = frame.focusedIndex >= 0 ? frame.rowFor(frame.focusedIndex) : null;
    const rowAction =
      focusedRow && focusedRow.actions ? focusedRow.actions.find((a) => a.name === name) : null;
    const action = rowAction ?? frame.actionNamed(name);
    if (!action || typeof action.run !== "function") return false;
    const ctx = this.actionContext({ secondary, event });
    if (!isAvailable(action, ctx)) return false;
    this.invokeAction(action, ctx);
    return true;
  }

  // ── stack (Stage 4 wires the chrome; the primitives live here) ─────────────

  push(spec, { params, carryQuery = false } = {}) {
    if (this.mounted) throw new Error("modals: push() is not available on a mounted session");
    const maxDepth = this.frame.spec.navigation?.maxDepth ?? MAX_DEPTH_DEFAULT;
    if (this.frames.length >= maxDepth) {
      atom.notifications.addWarning("Modal stack is too deep", {
        description: `Refusing to push past ${maxDepth} levels.`,
      });
      return Promise.resolve(undefined);
    }

    const outgoing = this.frame;
    outgoing.snapshot = {
      query: this.host.getQueryText(),
      selection: this.host.getQuerySelection(),
      scrollTop: this.host.getScrollTop(),
      focusedId: outgoing.focusedEntry() ? outgoing.focusedEntry().id : null,
    };
    outgoing.abortRun();

    const carried = carryQuery ? outgoing.snapshot.query : "";
    const frame = this.pushFrame(spec, { params });
    const promise = new Promise((resolve) => {
      frame.resolvePush = resolve;
    });
    this.mountFrame(frame, { query: carried });
    return promise;
  }

  pop(n = 1, value) {
    if (this.frames.length <= 1) {
      this.cancel("escape");
      return;
    }
    for (let i = 0; i < n && this.frames.length > 1; i++) {
      const frame = this.frames.pop();
      this.closeFrame(frame, { status: "cancelled", reason: "popped" });
      if (frame.resolvePush) frame.resolvePush(value);
    }
    this.restoreFrame(this.frame);
  }

  replace(spec, { carryQuery = true } = {}) {
    const outgoing = this.frames.pop();
    const query = carryQuery ? this.host.getQueryText() : "";
    this.closeFrame(outgoing, { status: "cancelled", reason: "replaced" });
    const frame = this.pushFrame(spec);
    frame.resolvePush = outgoing.resolvePush;
    this.mountFrame(frame, { query });
  }

  restoreFrame(frame) {
    const snapshot = frame.snapshot ?? {};
    this.host.applyView(this, frame);
    this.host.setQuery(snapshot.query ?? "", {
      select: snapshot.selection ?? "none",
      silent: true,
    });
    frame.clearStatus();

    const revalidate = frame.spec.navigation?.revalidate ?? "stale";
    frame.filter(this.getQuery());
    if (snapshot.focusedId != null) {
      const found = frame.visible.findIndex((r) => r.entry.id === snapshot.focusedId);
      if (found >= 0) frame.focusedIndex = found;
    }
    this.render();
    if (snapshot.scrollTop != null) this.host.setScrollTop(snapshot.scrollTop);

    if (revalidate !== "never" && frame.source) {
      frame.startRun(this.getQuery());
    }

    const spec = frame.spec;
    if (typeof spec.didResume === "function") {
      try {
        spec.didResume(undefined, this);
      } catch (error) {
        console.error("modals: didResume threw", error);
      }
    }
  }

  // ── termination ───────────────────────────────────────────────────────────

  confirm(value) {
    this.finish({ status: "confirmed", value, action: "api", secondary: false });
  }

  cancel(reason = "api") {
    this.finish({ status: "cancelled", reason });
  }

  finish(result) {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.manager.closeSession(this, result);
  }

  // Runs every frame's terminal callback exactly once, top-down. The kernel
  // guarantees this for every reason — including "replaced" and "destroyed" —
  // which is precisely what the old force-hide path could not do.
  runTerminalCallbacks(result) {
    while (this.frames.length > 0) {
      const frame = this.frames.pop();
      this.closeFrame(frame, result);
      if (frame.resolvePush) frame.resolvePush(undefined);
    }
  }

  closeFrame(frame, result) {
    frame.abortRun();
    const spec = frame.spec;
    if (typeof spec.didClose === "function") {
      try {
        spec.didClose(result, this);
      } catch (error) {
        console.error("modals: didClose threw", error);
      }
    }
    frame.destroy();
  }

  settle(result) {
    if (this.closed) return;
    this.closed = true;
    if (this.validateTimer != null) {
      clearTimeout(this.validateTimer);
      this.validateTimer = null;
    }
    if (this.abortController) this.abortController.abort();
    this.pendingConfirm = null;
    this.subscriptions.dispose();
    this.resolveResult(result);
    this.emitter.emit("did-close", result);
    this.emitter.dispose();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render() {
    if (this.closed || !this.host) return;
    this.host.render(this);
  }

  templateState() {
    const frame = this.frame;
    return {
      session: this,
      query: this.getQuery(),
      visibleItems: frame.isList ? frame.visibleForTemplate() : [],
      focusedIndex: frame.focusedIndex,
      checked: frame.checked,
      status: frame.status,
      validation: frame.validation,
      emptyMessage: frame.emptyMessageOverride,
    };
  }

  // ── events & escape hatches ───────────────────────────────────────────────

  onDidChangeQuery(cb) {
    return this.emitter.on("did-change-query", cb);
  }
  onDidChangeFocusedItem(cb) {
    return this.emitter.on("did-change-focused-item", cb);
  }
  onDidChangeChecked(cb) {
    return this.emitter.on("did-change-checked", cb);
  }
  onDidClose(cb) {
    return this.emitter.on("did-close", cb);
  }

  get element() {
    return this.host ?? null;
  }
  get queryEditor() {
    return this.host ? this.host.queryEditor.editor : null;
  }
  get listElement() {
    return this.host && this.host.template ? (this.host.template.list ?? null) : null;
  }
}

function normalizeValidation(outcome) {
  if (outcome == null || outcome === "") return null;
  if (typeof outcome === "string") return { message: outcome, severity: "error" };
  if (typeof outcome === "object" && outcome.message != null) {
    return { message: outcome.message, severity: outcome.severity ?? "error" };
  }
  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ModalSession, Disposable };
