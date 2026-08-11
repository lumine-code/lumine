const { Disposable } = require("@lumine-code/event-kit");

/**
 * @public
 * @status experimental
 *
 * Lets a package claim a paste before the editor turns the
 * clipboard into text.
 *
 * An instance of this class is always available as the `lumine.pasteProviders`
 * global.
 *
 * This is a dispatch table, not a second clipboard. {@link Clipboard} owns what the
 * clipboard holds; this owns who gets first refusal on putting it somewhere.
 * The two are deliberately separate, because a provider is chosen by the
 * paste's *target* — a text editor, a tree-view directory — and that is
 * workspace vocabulary the clipboard has no business knowing.
 *
 * Providers are offered the paste highest `priority` first, and equal
 * priorities keep registration order. The first one to return `true` claims it
 * and no later provider is consulted; when none does, the caller falls back to
 * its own behavior — inserting text, in the editor's case. A paste that sets
 * `skipPasteProviders` in its options skips the registry outright, which is how
 * `editor:paste-without-reformatting` guarantees it pastes raw text.
 *
 * A provider must decide synchronously. The editor may be inside a native
 * `paste` ClipboardEvent, whose `clipboardData` is readable only for the
 * duration of that event, so claim the paste first and then do the slow part.
 *
 * ## Examples
 *
 * Take over pasting an image, and leave every other paste alone:
 *
 * ```js
 * lumine.pasteProviders.add({
 *   handlePaste({ target, clipboardData }) {
 *     if (target.type !== 'text-editor') return false
 *     const image = imageFrom(clipboardData)
 *     if (!image) return false
 *     saveAndInsert(image, target.editor) // may finish asynchronously
 *     return true
 *   }
 * }, { priority: 100 })
 * ```
 */
module.exports = class PasteProviderRegistry {
  constructor() {
    this.clear();
  }

  clear() {
    this.providers = [];
    this.nextRegistrationOrder = 0;
  }

  /**
   * @public
   * @status experimental
   *
   * Register a paste provider. Returns a `Disposable` that
   * unregisters it.
   *
   * Throws a `TypeError` when the provider has no `handlePaste` method, or when
   * `priority` is not a finite number.
   *
   * @param provider - An `Object` with a `handlePaste(context)` method. It receives exactly what {@link #handlePaste} was given, and returns `true` to claim the paste or `false` to pass it on.
   * @param {Object} [options] - Registration options.
   * @param {Number} [options.priority=0] - The order in which providers are
   *   consulted, highest first. Ties preserve registration order.
   * @returns {Disposable} A disposable that unregisters the provider.
   */
  add(provider, { priority = 0 } = {}) {
    if (!provider || typeof provider.handlePaste !== "function") {
      throw new TypeError("Paste providers must implement handlePaste(context)");
    }
    if (!Number.isFinite(priority)) {
      throw new TypeError("Paste provider priority must be a finite number");
    }

    const registration = {
      provider,
      priority,
      order: this.nextRegistrationOrder++,
    };
    this.providers.push(registration);
    this.providers.sort(
      (left, right) => right.priority - left.priority || left.order - right.order,
    );

    return new Disposable(() => {
      const index = this.providers.indexOf(registration);
      if (index !== -1) this.providers.splice(index, 1);
    });
  }

  /**
   * @public
   * @status experimental
   *
   * Offer a paste to each registered provider in turn.
   *
   * The text editor calls this for you. Call it directly when your own package
   * is somewhere a paste can land: the tree-view does, so that pasting onto a
   * directory row reaches the same providers an editor paste would.
   *
   * @param context - An `Object` describing the paste, with the following keys:
   * @param context.target - An `Object` naming where the paste lands. Today that is `{type: 'text-editor', editor}`, `{type: 'directory', path}`, or `{type: 'terminal', model, path}` — where `path` is the directory the terminal was launched in. Always branch on `type` and return `false` for one you do not recognize — the set grows as more of the workspace offers its pastes here.
   * @param [context.clipboard] - The {@link Clipboard} to read the paste from. Inside a native paste event this is a DataTransfer-backed clipboard, so `readWithMetadata()` sees the metadata of the window that did the copy; outside one it is `lumine.clipboard`. Absent when the caller is not a text editor.
   * @param [context.clipboardData] - The event's `DataTransfer`, or `null` when the paste did not arrive as a native paste event. Custom formats and non-text items such as files and images are readable only from here.
   * @param [context.options] - An `Object` of the paste options the editor would otherwise have used, such as `autoIndent` and `normalizeLineEndings`.
   * @returns {Boolean} : `true` when a provider claimed the paste and the caller must not handle it itself, `false` when none did.
   */
  handlePaste(context) {
    for (const { provider } of this.providers) {
      if (provider.handlePaste(context) === true) return true;
    }
    return false;
  }
};
