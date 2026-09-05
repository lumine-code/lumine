const { Emitter, Disposable } = require("@lumine-code/event-kit");
const TextEditor = require("./text-editor");

// Registration describes how an editor participates in the window rather than
// how it was constructed:
//
// - "document": a standalone document editor, normally a workspace pane item.
// - "fragment": an editable part of a larger document, such as a notebook cell.
// - "input": a form control, search field, prompt, or other editor-backed input.
// - "viewer": a rendered or read-only editor surface that is not a document source.
const ROLES = new Set(["document", "fragment", "input", "viewer"]);

/**
 * @public
 * @status public
 *
 * The global registry of text editors that participate in the window, available
 * as `lumine.textEditors`.
 *
 * {@link Workspace} owns pane items. This registry additionally reaches editor
 * surfaces embedded in package interfaces, such as search fields, notebook
 * cells, prompts, and previews. Registration is explicit because constructing a
 * detached editor does not by itself make that editor part of the window.
 *
 * Registering the same editor more than once with the same role creates another
 * lease on one logical registration. Observers see the editor only when the
 * first lease is acquired and see it removed only after the last lease is
 * disposed. Registering one editor under conflicting roles is an error.
 *
 * ## Roles
 *
 * * `"document"` — a standalone document, normally a workspace pane item.
 * * `"fragment"` — an editable part of a composite document, such as a
 *   notebook cell.
 * * `"input"` — an editor-backed form control, search field, or prompt.
 * * `"viewer"` — a rendered or read-only surface that must not become a
 *   document-content source.
 *
 * ```js
 * const editor = lumine.workspace.buildTextEditor({ mini: true })
 * const registration = lumine.textEditors.add(editor, { role: 'input' })
 * // Release the lease when the surface goes away. Destroying the editor also
 * // releases every outstanding lease.
 * registration.dispose()
 * ```
 */
module.exports = class TextEditorRegistry {
  constructor() {
    this.destroyed = false;
    this.editors = new Map(); // editor -> { editor, role, leases, destroySubscription }
    this.emitter = new Emitter();
  }

  /**
   * @public
   * @status essential
   *
   * Register a {@link TextEditor} as part of the window.
   *
   * Repeated registration with the same role acquires an independent lease and
   * emits no duplicate add event. A conflicting role throws a `TypeError`.
   * Destroying the editor releases the registration automatically.
   *
   * @param editor - The {@link TextEditor} to register.
   * @param {Object} options - Registration options.
   * @param {"document"|"fragment"|"input"|"viewer"} options.role - How the editor participates in the window.
   * @returns {Disposable} A lease to dispose when this owner stops exposing the editor.
   */
  add(editor, { role } = {}) {
    if (this.destroyed) {
      throw new Error("Cannot register a text editor after the registry is destroyed");
    }
    if (!(editor instanceof TextEditor)) {
      throw new TypeError("Text editor registrations require a TextEditor");
    }
    if (editor.isDestroyed()) {
      throw new TypeError("Cannot register a destroyed TextEditor");
    }
    if (!ROLES.has(role)) {
      throw new TypeError(`Unknown text editor role: ${role}`);
    }

    let entry = this.editors.get(editor);
    if (entry) {
      if (entry.role !== role) {
        throw new TypeError(`TextEditor is already registered as ${entry.role}, not ${role}`);
      }
      return this.acquireLease(entry);
    }

    entry = {
      editor,
      role,
      leases: new Set(),
      destroySubscription: null,
    };
    this.editors.set(editor, entry);

    // Install this before notifying observers. An observer is allowed to
    // destroy the editor synchronously from the did-add callback.
    entry.destroySubscription = editor.onDidDestroy(() => this.removeEntry(entry));
    const lease = this.acquireLease(entry);
    this.emitter.emit("did-add-editor", editor);
    return lease;
  }

  acquireLease(entry) {
    const token = {};
    entry.leases.add(token);
    return new Disposable(() => {
      // Entry identity makes handles from before clear() harmless after a
      // later registration of the same model.
      if (this.editors.get(entry.editor) !== entry) return;
      entry.leases.delete(token);
      if (entry.leases.size === 0) this.removeEntry(entry);
    });
  }

  removeEntry(entry, { emit = true } = {}) {
    if (this.editors.get(entry.editor) !== entry) return false;
    this.editors.delete(entry.editor);
    entry.leases.clear();
    const destroySubscription = entry.destroySubscription;
    entry.destroySubscription = null;
    destroySubscription?.dispose();
    if (emit) this.emitter.emit("did-remove-editor", entry.editor);
    return true;
  }

  /**
   * @public
   * @status public
   *
   * Get the role under which a {@link TextEditor} is registered.
   *
   * @param editor - The {@link TextEditor} to look up.
   * @returns {String} Its role, or `null` when it is not registered.
   */
  roleFor(editor) {
    return this.editors.get(editor)?.role ?? null;
  }

  /**
   * @public
   * @status public
   *
   * Get a snapshot of every registered editor in registration order.
   *
   * @returns {Array} of {@link TextEditor TextEditors}.
   */
  getEditors() {
    return Array.from(this.editors.keys());
  }

  /**
   * @public
   * @status essential
   *
   * Invoke the callback with every editor registered now and in the future.
   * Repeated leases for one editor do not invoke the callback again.
   *
   * @param {Function} callback - Called with each {@link TextEditor}.
   * @returns {Disposable} A subscription disposable.
   */
  observe(callback) {
    for (const editor of this.editors.keys()) callback(editor);
    return this.emitter.on("did-add-editor", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the callback after the last lease for an editor is released.
   *
   * @param {Function} callback - Called with the removed {@link TextEditor}.
   * @returns {Disposable} A subscription disposable.
   */
  onDidRemoveEditor(callback) {
    return this.emitter.on("did-remove-editor", callback);
  }

  clear() {
    if (this.destroyed) return;
    for (const entry of [...this.editors.values()]) {
      this.removeEntry(entry, { emit: false });
    }
    this.emitter.dispose();
    this.editors = new Map();
    this.emitter = new Emitter();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entry of [...this.editors.values()]) {
      this.removeEntry(entry, { emit: false });
    }
    this.emitter.dispose();
  }
};
