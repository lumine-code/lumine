const Path = require("path");
const fs = require("@lumine-code/fs-plus");
const Config = require("./config");
const { CompositeDisposable, Point } = require("atom");

const el = require("./element-builder");
const { badge, isIterable, timeout } = require("./util");

// Properties that we allow a provider to set on a `SelectListView` via a
// `ListController` instance.
const ALLOWED_PROPS_IN_LIST_CONTROLLER = new Set([
  "errorMessage",
  "emptyMessage",
  "loadingMessage",
  "loadingBadge",
]);

function validateListControllerProps(props) {
  return Object.keys(props).every((k) => ALLOWED_PROPS_IN_LIST_CONTROLLER.has(k));
}

/**
 * A class for setting various UI properties on a symbol list palette. This is a
 * privilege given to the “main” (or _exclusive_) provider for a given task.
 *
 * This is how we allow a provider to communicate its state to the UI without
 * giving it full control over the `SelectListView` used to show results.
 */
class ListController {
  constructor(view) {
    this.view = view;
  }

  set(props) {
    if (!validateListControllerProps(props)) {
      console.warn("Provider gave invalid properties to symbol list UI:", props);
    }
    return this.view.update(props);
  }

  clear(...propNames) {
    let props = {};
    for (let propName of propNames) {
      if (!ALLOWED_PROPS_IN_LIST_CONTROLLER.has(propName)) continue;
      props[propName] = null;
    }
    return this.view.update(props);
  }
}

class SymbolsView {
  constructor(stack, broker, options = {}) {
    this.stack = stack;
    this.broker = broker;

    options = {
      emptyMessage: "No symbols found",
      ...options,
    };

    this.selectListView = atom.workspace.buildSelectList({
      ...options,
      className: "symbols-view",
      crumb: "Symbols",
      panelItem: this,
      items: [],
      filterKeyForItem: (item) => item.name,
      elementForItem: this.elementForItem.bind(this),
      didChangeQuery: this.didChangeQuery.bind(this),
      didChangeSelection: this.didChangeSelection.bind(this),
      didConfirmSelection: this.didConfirmSelection.bind(this),
      didConfirmEmptySelection: this.didConfirmEmptySelection.bind(this),
      didCancelSelection: this.didCancelSelection.bind(this),
    });

    this.selectListViewOptions = options;

    this.listController = new ListController(this.selectListView);

    this.element = this.selectListView.element;

    // Create the (hidden) modal panel eagerly: callers introspect
    // `atom.workspace.getModalPanels()` right after the view is constructed.
    this.selectListView.getPanel();

    this.configDisposable = new CompositeDisposable();

    this.configDisposable.add(
      atom.config.observe(`symbols-view`, (value) => {
        this.shouldShowProviderName = value.showProviderNamesInSymbolsView;
        this.useBadgeColors = value.useBadgeColors;
      }),
      Config.observe("providerTimeout", (ms) => (this.timeoutMs = ms)),
      Config.observe("showIconsInSymbolsView", (show) => (this.showIconsInSymbolsView = show)),
    );
  }

  async destroy() {
    await this.cancel();
    this.configDisposable.dispose();
    return this.selectListView.destroy();
  }

  getFilterKey() {
    return "name";
  }

  elementForItem({ position, name, file, icon, tag, context, directory, providerName }, options) {
    name = name.replace(/\n/g, " ");

    if (atom.project.getPaths().length > 1) {
      // More than one project root — we need to disambiguate the file paths.
      file = Path.join(Path.basename(directory), file);
    }

    let badges = [];

    if (providerName && this.shouldShowProviderName) {
      badges.push(providerName);
    }
    if (tag) badges.push(tag);

    let primaryLineClasses = ["primary-line"];
    // A provider naming its own icon still wins; everything else is the
    // registry's kind vocabulary, which badges a kind it has no glyph for
    // rather than showing nothing.
    if (this.showIconsInSymbolsView && icon) primaryLineClasses.push("icon", icon);

    let primary = el(
      `div.${primaryLineClasses.join(".")}`,
      el("div.name", options.highlight(name)),
      badges &&
        el("div.badge-container", ...badges.map((b) => badge(b, { variant: this.useBadgeColors }))),
    );

    if (this.showIconsInSymbolsView) {
      if (!icon) {
        atom.icons.applyTo(primary, { kind: tag, context: "symbols-view" }, { setData: false });
      }
      if (!primary.classList.contains("icon")) primary.classList.add("no-icon");
    }

    let secondaryLineClasses = ["secondary-line"];
    if (this.showIconsInSymbolsView) {
      secondaryLineClasses.push("no-icon");
    }
    let secondary = el(
      `div.${secondaryLineClasses.join(".")}`,
      el("span.location", position ? `${file}:${position.row + 1}` : file),
      context ? el("span.context", context) : null,
    );

    return el("li.two-lines", primary, secondary);
  }

  async cancel() {
    if (!this.isCanceling) {
      this.isCanceling = true;
      await this.updateView({ items: [] });
      this.selectListView.hide();
      this.isCanceling = false;
    }
  }

  async updateView(options) {
    this.selectListView.update(options);
  }

  didChangeQuery() {
    // no-op
  }

  didCancelSelection() {
    this.cancel();
  }

  didConfirmEmptySelection() {
    this.cancel();
  }

  async didConfirmSelection(tag) {
    if (tag.file && !fs.isFileSync(Path.join(tag.directory, tag.file))) {
      await this.updateView({
        errorMessage: `Selected file does not exist`,
      });
      setTimeout(() => {
        this.updateView({ errorMessage: null });
      }, 2000);
    } else {
      await this.cancel();
      this.openTag(tag, { pending: this.shouldBePending() });
    }
  }

  // Whether a pane opened by a view should be treated as a pending pane.
  shouldBePending() {
    return false;
  }

  didChangeSelection() {
    // no-op
  }

  openTag(tag, { pending } = {}) {
    pending ??= this.shouldBePending();
    let editor = atom.workspace.getActiveTextEditor();
    let previous;
    if (editor) {
      previous = {
        editorId: editor.id,
        position: editor.getCursorBufferPosition(),
        file: editor.getURI(),
      };
    }

    let { position, range } = tag;
    if (!position) position = this.getTagLine(tag);

    let result = false;
    if (tag.file) {
      // Open a different file, then jump to a position.
      atom.workspace
        .open(Path.join(tag.directory, tag.file), { pending, activatePane: false })
        .then(() => {
          if (position) {
            return this.moveToPosition(position, { range });
          }
          return undefined;
        });
      result = true;
    } else if (position && previous && !previous.position.isEqual(position)) {
      // Jump to a position in the same file.
      this.moveToPosition(position, { range });
      result = true;
    }
    if (result) this.stack.push(previous);
    return result;
  }

  moveToPosition(position, { beginningOfLine = true } = {}) {
    let editor = atom.workspace.getActiveTextEditor();
    if (editor) {
      editor.setCursorBufferPosition(position, { autoscroll: false });
      if (beginningOfLine) {
        editor.moveToFirstCharacterOfLine();
      }
      editor.scrollToCursorPosition({ center: true });
    }
  }

  attach() {
    this.selectListView.reset();
    this.selectListView.show();
  }

  isVisible() {
    return this.selectListView.isVisible();
  }

  isValidSymbol(symbol) {
    if (typeof symbol.name !== "string") return false;
    if (!symbol.position && !symbol.range) return false;
    if (symbol.position && !(symbol.position instanceof Point)) {
      return false;
    }
    return true;
  }

  normalizeSymbol(symbol, provider) {
    // We enforce these so that (a) we can show a human-readable name of the
    // provider for each symbol (if the user opts into it), and (b) we can
    // selectively clear cached results for certain providers without
    // affecting others.
    symbol.providerName ??= provider.name;
    symbol.providerId ??= provider.packageName;
    if (symbol.path) {
      let parts = Path.parse(symbol.path);
      symbol.directory = `${parts.dir}${Path.sep}`;
      symbol.file = parts.base;
    }
    symbol.name = symbol.name.replace(/[\n\r\t]/, " ");
  }

  addSymbols(allSymbols, newSymbols, provider) {
    for (let symbol of newSymbols) {
      if (!this.isValidSymbol(symbol)) {
        console.warn("Invalid symbol:", symbol);
        continue;
      }

      this.normalizeSymbol(symbol, provider);
      allSymbols.push(symbol);
    }
  }

  // TODO: What on earth is this? Can we possibly still need it?
  getTagLine(tag) {
    if (!tag) return undefined;

    if (tag.lineNumber) {
      return new Point(tag.lineNumber - 1, 0);
    }

    if (!tag.pattern) return undefined;
    let pattern = tag.pattern.replace(/(^\/\^)|(\$\/$)/g, "").trim();
    if (!pattern) return undefined;

    const file = Path.join(tag.directory, tag.file);
    if (!fs.isFileSync(file)) return undefined;

    let iterable = fs.readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < iterable.length; index++) {
      let line = iterable[index];
      if (pattern === line.trim()) {
        return new Point(index, 0);
      }
    }

    return undefined;
  }

  /**
   * Ask a single provider for symbols.
   *
   * @param   {Object} provider The provider to ask.
   * @param   {AbortSignal} signal The signal for the task as a whole, aborted
   *   when the user cancels it.
   * @param   {Object} meta The task descriptor to hand to the provider.
   * @returns {Object} An object whose `symbols` property is whatever the
   *   provider returned — a list, or a promise of one — and whose `signal`
   *   property is the signal governing that particular provider. Callers need
   *   the latter to tell a provider that failed them from one they gave up on:
   *   returning nothing once that signal aborts is the documented contract
   *   being honored, not a provider misbehaving.
   */
  getSymbolsFromProvider(provider, signal, meta) {
    let controller = new AbortController();

    // If the user cancels the task, propagate that cancellation to this
    // provider's AbortController.
    signal.addEventListener("abort", () => controller.abort(), { once: true });

    // Cancel this job automatically if it times out.
    let timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // The exclusive provider is the only one that gets an instance of
    // `ListController` so that it can set UI messages.
    let args = [{ signal: controller.signal, ...meta }];
    if (provider.isExclusive) args.push(this.listController);

    // Stop the clock the moment the provider answers. Left running, it would
    // tell a provider its work was cancelled long after it had delivered.
    let stopClock = () => clearTimeout(timer);

    let symbols;
    try {
      symbols = provider.getSymbols(...args);
    } catch (error) {
      stopClock();
      throw error;
    }

    if (symbols?.then) {
      symbols = symbols.then(
        (value) => {
          stopClock();
          return value;
        },
        (error) => {
          stopClock();
          throw error;
        },
      );
    } else {
      stopClock();
    }

    return { symbols, signal: controller.signal };
  }

  /**
   * Ask each of the given providers for symbols and gather what comes back.
   *
   * Settles when every provider has answered or when they collectively run
   * past `providerTimeout`, whichever happens first.
   *
   * @param   {Array} providers The providers to ask.
   * @param   {AbortSignal} signal The signal for the task as a whole, aborted
   *   when the user cancels it.
   * @param   {Object} meta The task descriptor to hand to each provider.
   * @param   {Object} options Options.
   * @param   {Array} options.symbols The list to gather symbols into.
   *   Optional; defaults to a new empty list. Pass one to seed the results
   *   with symbols that are already known.
   * @param   {Function} options.onSymbols Called with the gathered symbols
   *   each time a provider adds to them, for a list that fills in as it loads.
   *   Optional.
   * @returns {Promise<Array>} The gathered symbols.
   */
  async gatherSymbols(providers, signal, meta, { symbols = [], onSymbols = null } = {}) {
    // Once we stop waiting we stop listening. Every provider holds a signal
    // that aborts on this same budget, so anything still arriving afterwards
    // comes from a provider that ignored it — and taking that would mean the
    // provider honoring the contract gets nothing shown while the one flouting
    // it gets a late render. The write has nowhere good to go regardless: by
    // then the caller has sorted these symbols, rendered them, and cached the
    // list, so a straggler appears out of order or not until the next toggle.
    let closed = false;

    let error = (err, provider, providerSignal) => {
      // A provider we cancelled — because it ran past `providerTimeout`, or
      // because the user dismissed the list — owes us nothing. Abandoning its
      // work is precisely what we asked it to do, so blaming it for the empty
      // hands it comes back with would be reporting our own decision as its
      // fault. Only a provider that failed us on its own terms is worth a word.
      if (providerSignal?.aborted || signal.aborted) return;
      let message = typeof err === "string" ? err : err.message;
      console.error(`Error in retrieving symbols from provider ${provider.name}: ${message}`);
    };

    let done = (newSymbols, provider, providerSignal) => {
      if (closed || signal.aborted) return;
      if (!isIterable(newSymbols)) {
        error(`Provider did not return a list of symbols`, provider, providerSignal);
        return;
      }
      this.addSymbols(symbols, newSymbols, provider);
      onSymbols?.(symbols);
    };

    let tasks = [];
    for (let provider of providers) {
      let providerSignal;
      try {
        let result = this.getSymbolsFromProvider(provider, signal, meta);
        providerSignal = result.signal;
        if (result.symbols?.then) {
          // The provider went async, so we have something to wait for.
          tasks.push(
            result.symbols
              .then((value) => done(value, provider, providerSignal))
              .catch((err) => error(err, provider, providerSignal)),
          );
        } else {
          done(result.symbols, provider, providerSignal);
        }
      } catch (err) {
        error(err, provider, providerSignal);
      }
    }

    if (tasks.length > 0) {
      await Promise.race([Promise.allSettled(tasks), timeout(this.timeoutMs)]);
    }
    closed = true;

    return symbols;
  }
}

module.exports = SymbolsView;
