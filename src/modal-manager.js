"use strict";

const { Emitter, CompositeDisposable, Disposable } = require("event-kit");
const { ModalSession } = require("./modal-session");
const { createModalHostElement } = require("./modal-host-element");
const { sources } = require("./modal-source");
const { matchers } = require("./modal-matcher");
const { highlight, highlightSegments } = require("./modal-row");
const { registerActionKeystrokes } = require("./modal-keymap");
const { previewers } = require("./modal-preview");
const { paneItem } = require("./modal-workspace-preview");

// `atom.modals` — the single owner of modal UI in a window.
//
// Packages describe what they want as data (a ViewSpec) and the kernel owns the
// host element, the panel, the focus policy, the command scope and the stack.
// Two modals coexisting is therefore not a representable state, which is what
// retires the whole class of defects the per-package `addModalPanel` approach
// produced.

// Registered below the user keymap (100) and above package keymaps (0):
// priority outranks specificity in the resolver, so this is what makes a
// modal's own verbs beat a foreign `atom-text-editor` binding while still
// letting the user override anything.
const ACTION_KEYMAP_PRIORITY = 50;

class ModalManager {
  constructor({
    workspace,
    commands,
    keymaps,
    config,
    views,
    packages,
    textEditors,
    notifications,
  }) {
    this.workspace = workspace;
    this.commands = commands;
    this.keymaps = keymaps;
    this.config = config;
    this.views = views;
    this.packages = packages;
    this.textEditors = textEditors;
    this.notifications = notifications;

    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.session = null;
    this.host = null;
    this.panel = null;
    this.hidingSelf = false;
    this.isClosing = false;
    this.pendingOpen = null;
    this.destroyed = false;
    this.actionKeymaps = new Map();
    // Last query per view id, for views that opt into `preserveQuery`. Replace
    // closes the session outright, so without this a user who bounces to
    // another modal and back loses what they had typed.
    this.preservedQueries = new Map();

    this.sources = sources;
    this.matchers = matchers;
    this.renderers = {
      rows: () => ({ row: (item) => item }),
      custom: (fn) => ({ row: fn }),
    };
    this.previewers = { ...previewers, paneItem };
    this.actions = {
      set: (actions, override) => ({ actions, override }),
      confirm: (run, opts = {}) => ({
        name: "confirm",
        label: "Confirm",
        when: "always",
        ...opts,
        run,
      }),
      copy: (get, opts = {}) => ({
        name: "copy",
        label: "Copy",
        keystroke: "cmdorctrl-c",
        ...opts,
        run: (ctx) => {
          atom.clipboard.write(String(get(ctx) ?? ""));
          return { keepOpen: true };
        },
      }),
      open: (get, opts = {}) => ({
        name: opts.name ?? "open",
        label: opts.label ?? "Open",
        ...opts,
        run: async (ctx) => {
          const value = get(ctx);
          if (!value) return;
          const target = typeof value === "string" ? { uri: value } : value;
          await atom.workspace.open(target.uri, {
            initialLine: target.line,
            initialColumn: target.column,
            pending: opts.pending,
            split: opts.split,
          });
        },
      }),
      back: (opts = {}) => ({
        name: "back",
        label: "Back",
        when: "always",
        ...opts,
        run: () => ({ pop: true }),
      }),
    };

    this.ui = { highlight, highlightSegments };
  }

  // ── host & panel ──────────────────────────────────────────────────────────

  // Lazy: a window that never opens a modal pays nothing. Rebuilt on demand
  // after `clear()`, because `AtomEnvironment.reset()` destroys every panel
  // container underneath us.
  ensureHost() {
    if (this.host && this.panel && !this.panel.destroyed) return;

    this.host = createModalHostElement(this);
    this.panel = this.workspace.addModalPanel({
      item: this.host,
      visible: false,
      restoreFocus: false,
      className: "modals",
      priority: 100,
    });

    this.panelSubscriptions = new CompositeDisposable(
      this.panel.onDidChangeVisible((visible) => {
        if (visible || this.hidingSelf || !this.session) return;
        // Somebody else's `addModalPanel` force-hid us. Rather than leaving an
        // orphaned session behind a hidden panel, close it properly.
        this.session.finish({ status: "cancelled", reason: "foreign" });
      }),
      this.panel.onDidDestroy(() => {
        this.panelSubscriptions.dispose();
        this.panel = null;
        this.host = null;
        if (this.session) this.session.finish({ status: "cancelled", reason: "destroyed" });
      }),
    );
  }

  // ── opening ───────────────────────────────────────────────────────────────

  open(spec, opts = {}) {
    if (this.destroyed) return null;
    validateSpec(spec);

    // An open() issued from inside the active session's own action is a
    // sublist, not a replacement: replacing would destroy the caller mid-run
    // and discard the answer it is waiting for.
    if (this.session && this.session.actionDepth > 0) {
      this.session.push(spec, { params: opts.params });
      return this.session;
    }

    const ifOpen = opts.ifOpen ?? "replace";
    if (this.session) {
      if (ifOpen === "reject") return null;
      if (ifOpen === "toggle" && this.session.rootSpec.id === spec.id) {
        this.session.cancel("toggled");
        return null;
      }
      if (ifOpen === "push") {
        this.session.push(spec, { params: opts.params });
        return this.session;
      }
      this.session.finish({ status: "cancelled", reason: "replaced" });
    }

    this.ensureHost();
    this.emitter.emit("will-open", { spec, opts });

    const session = new ModalSession(this, spec, {
      params: opts.params ?? {},
      target: this.captureTarget(),
    });
    this.session = session;

    this.registerActionKeymap(session);

    session.start(this.host).then((started) => {
      if (!started || session !== this.session) return;
      const preserved = spec.preserveQuery ? this.preservedQueries.get(spec.id) : null;
      const query = opts.query ?? preserved;
      if (query != null) {
        this.host.setQuery(query, { select: "all", silent: true });
        session.didChangeQuery();
      }
      this.hidingSelf = false;
      this.panel.show();
      document.body.classList.add("modals-open");
      this.host.focusQuery();
      this.emitter.emit("did-open", session);
    });

    return session;
  }

  toggle(spec, opts = {}) {
    if (this.session && this.session.rootSpec.id === spec.id) {
      this.session.cancel("toggled");
      return null;
    }
    return this.open(spec, opts);
  }

  mount(container, spec, opts = {}) {
    validateSpec(spec);
    const host = createModalHostElement(this);
    host.classList.add("modals-mounted");
    container.appendChild(host);
    const session = new ModalSession(this, spec, {
      params: opts.params ?? {},
      mounted: true,
      target: this.captureTarget(),
    });
    session.mountedHost = host;
    session.start(host);
    return session;
  }

  // ── sugar ─────────────────────────────────────────────────────────────────

  async pick(spec, opts = {}) {
    const session = this.open(spec, opts);
    if (!session) return opts.detailed ? { status: "cancelled", reason: "rejected" } : undefined;
    const result = await session.result;
    if (opts.detailed) return result;
    return result.status === "confirmed" ? result.value : undefined;
  }

  async input(spec, opts = {}) {
    const session = this.open({ template: "input", ...spec }, opts);
    if (!session) return opts.detailed ? { status: "cancelled", reason: "rejected" } : undefined;
    const result = await session.result;
    if (opts.detailed) return result;
    return result.status === "confirmed" ? String(result.value ?? "") : undefined;
  }

  async confirmChoice(spec, opts = {}) {
    const choices = spec.choices ?? [];
    return this.pick(
      {
        id: spec.id,
        title: spec.title,
        placeholder: spec.detail ?? spec.title,
        matcher: "none",
        source: choices,
        initialActivation:
          spec.defaultIndex != null ? { id: choices[spec.defaultIndex]?.label } : "first",
        renderer: {
          entry: (choice) => ({ id: choice.label, text: choice.label }),
          row: (choice) => ({
            label: choice.label,
            icon: choice.icon,
            className: choice.danger ? "danger" : null,
          }),
        },
        confirm: (ctx) => ({ value: ctx.item ? ctx.item.value : undefined }),
      },
      opts,
    );
  }

  // ── closing ───────────────────────────────────────────────────────────────

  // The one close path. Ordering is normative: terminal callbacks first, then
  // hide, then restore focus — restoring before the hide would let the browser
  // strand focus on <body> when the panel goes display:none.
  closeSession(session, result) {
    if (session.closed) return;
    this.isClosing = true;
    try {
      if (session.rootSpec.preserveQuery && this.host && session === this.session) {
        this.preservedQueries.set(session.rootSpec.id, this.host.getQueryText());
      }
      // A previewer that moved the real workspace puts it back — unless the
      // user confirmed, where landing where they chose is the whole point, or
      // the window is going away, where touching state is pure risk.
      if (this.host && session === this.session) {
        this.host.settlePreview(result);
      }
      session.runTerminalCallbacks(result);

      const isPanelSession = session === this.session;
      if (isPanelSession) {
        this.session = null;
        this.unregisterActionKeymap(session);
        if (this.host) this.host.releaseSession();
        if (this.panel && !this.panel.destroyed) {
          this.hidingSelf = true;
          this.panel.hide();
          this.hidingSelf = false;
        }
        document.body.classList.remove("modals-open");
        this.restoreFocus(session, result);
      } else if (session.mountedHost) {
        session.mountedHost.destroy();
      }

      session.settle(result);
      this.emitter.emit("did-close", { session, result });
    } finally {
      this.isClosing = false;
    }

    if (this.pendingOpen) {
      const pending = this.pendingOpen;
      this.pendingOpen = null;
      this.open(pending.spec, pending.opts);
    }
  }

  restoreFocus(session, result) {
    // Never touch focus while the window is going away.
    if (result.reason === "destroyed") return;
    // Read from the root spec: the frame stack has already been drained by the
    // terminal callbacks that ran before us.
    const policy = session.rootSpec.restoreFocus ?? "auto";
    if (policy === "never") return;
    if (typeof policy === "function") {
      const element = policy(result);
      if (element && element.isConnected) element.focus();
      return;
    }
    // "auto": if the confirm handler already moved focus (it opened a file,
    // activated a pane), leave it alone.
    if (policy === "auto") {
      const active = document.activeElement;
      const host = this.host;
      const insideHost = host && host.contains(active);
      if (active && active !== document.body && !insideHost) return;
    }
    session.target.focus();
  }

  cancel(reason = "api") {
    if (this.session) this.session.cancel(reason);
  }

  // A template or renderer that throws would leave the shared host in an
  // unknown state, so rebuild it outright rather than carrying corruption into
  // the next modal.
  recoverFromError(session, error) {
    if (this.notifications) {
      this.notifications.addError("The modal failed to render", {
        detail: String(error && error.stack ? error.stack : error),
        dismissable: true,
      });
    }
    const host = this.host;
    session.finish({ status: "cancelled", reason: "error" });
    if (host === this.host && this.host) {
      this.host.destroy();
      this.host = null;
      if (this.panel && !this.panel.destroyed) this.panel.destroy();
      this.panel = null;
    }
  }

  // ── target capture ────────────────────────────────────────────────────────

  // Captured BEFORE the panel shows, so a consumer never has to cache "the
  // editor I was on when the command fired".
  captureTarget() {
    const editor = this.workspace.getActiveTextEditor() ?? null;
    // Resolved from focus rather than from the centre pane, so a command
    // invoked in a panel or dock mini editor writes back into THAT editor.
    // `editor` is the centre's active item and would silently target the wrong
    // buffer for those; consumers that insert text want this one.
    const focusedEditor = this.textEditors ? this.textEditors.getActiveTextEditor() : null;
    const element = document.activeElement;
    const pane = this.workspace.getActivePane() ?? null;
    const paneItem = pane && !pane.isDestroyed() ? pane.getActiveItem() : null;

    const alive = (object) =>
      object && (typeof object.isDestroyed !== "function" || !object.isDestroyed());

    return {
      editor,
      focusedEditor: focusedEditor ?? editor,
      element,
      pane,
      paneItem,
      dispatch: (commandName, detail) => {
        const node = element && element.isConnected ? element : this.workspace.getElement();
        return this.commands.dispatch(node, commandName, detail);
      },
      restore: () => {
        if (!alive(pane)) {
          const active = this.workspace.getCenter().getActivePane();
          if (active && !active.isDestroyed()) active.activate();
          return;
        }
        pane.activate();
        if (alive(paneItem)) pane.activateItem(paneItem);
      },
      focus: () => {
        if (element && element.isConnected) {
          element.focus();
          return;
        }
        if (alive(pane)) {
          pane.activate();
          return;
        }
        const active = this.workspace.getCenter().getActivePane();
        if (active && !active.isDestroyed()) active.activate();
      },
    };
  }

  // ── action keystrokes ─────────────────────────────────────────────────────

  registerActionKeymap(session) {
    const disposable = registerActionKeystrokes(
      this.keymaps,
      session.view.id,
      session.frame.actions,
      ACTION_KEYMAP_PRIORITY,
    );
    if (disposable) this.actionKeymaps.set(session.id, disposable);
  }

  unregisterActionKeymap(session) {
    const disposable = this.actionKeymaps.get(session.id);
    if (disposable) {
      disposable.dispose();
      this.actionKeymaps.delete(session.id);
    }
  }

  keystrokeFor(viewId, action) {
    if (!action.keystroke) {
      const found = this.keymaps.findKeyBindings({
        command: `modals:${action.name}`,
        target: this.host,
      });
      return found.length ? found[0].keystrokes : null;
    }
    if (typeof action.keystroke === "string") return action.keystroke;
    return action.keystroke[process.platform] ?? null;
  }

  // ── state & observation ───────────────────────────────────────────────────

  getActiveSession() {
    return this.session;
  }

  isOpen() {
    return this.session != null;
  }

  onWillOpen(cb) {
    return this.emitter.on("will-open", ({ spec, opts }) => cb(spec, opts));
  }
  onDidOpen(cb) {
    return this.emitter.on("did-open", cb);
  }
  onDidClose(cb) {
    return this.emitter.on("did-close", ({ session, result }) => cb(session, result));
  }

  // ── registries (Stage 6) ──────────────────────────────────────────────────

  registerSource() {
    throw new Error("modals: registerSource lands in Stage 6");
  }
  registerTemplate() {
    throw new Error("modals: registerTemplate lands in Stage 6");
  }
  getSources() {
    return [];
  }
  openSource() {
    throw new Error("modals: openSource lands in Stage 6");
  }
  openOmni() {
    throw new Error("modals: openOmni lands in Stage 6");
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  // Full teardown: `AtomEnvironment.reset()` destroys the panel containers, so
  // holding on to the panel across a reset would leave a live-looking manager
  // whose `show()` silently does nothing.
  clear() {
    if (this.session) {
      this.session.finish({ status: "cancelled", reason: "destroyed" });
    }
    for (const disposable of this.actionKeymaps.values()) disposable.dispose();
    this.actionKeymaps.clear();
    if (this.panelSubscriptions) {
      this.panelSubscriptions.dispose();
      this.panelSubscriptions = null;
    }
    if (this.host) {
      this.host.destroy();
      this.host = null;
    }
    if (this.panel && !this.panel.destroyed) this.panel.destroy();
    this.panel = null;
    this.pendingOpen = null;
    document.body.classList.remove("modals-open");
  }

  destroy() {
    this.clear();
    this.destroyed = true;
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("modals: a ViewSpec object is required");
  }
  if (typeof spec.id !== "string" || spec.id.length === 0) {
    throw new TypeError("modals: ViewSpec.id is required (kebab-case, package-namespaced)");
  }
}

module.exports = ModalManager;
module.exports.Disposable = Disposable;
