"use strict";

const { Disposable } = require("@lumine-code/event-kit");
const etch = require("@lumine-code/etch");
const InputDialog = require("./input-dialog");
const SelectListComponent = require("./select-list-component");
const SelectListModel = require("./select-list-model");
const { PreparedItems } = require("./dialog-actions");
const { highlightMatches, createTwoLineItem } = require("./select-list-helpers");
const fuzzyMatcher = require("./fuzzy-matcher");
const $ = etch.dom;

// Rendering hundreds of rows costs real time and nobody scans them; the list
// caps itself and ends with a "Show more…" row that reveals the next batch.
// The page size is an implementation policy rather than a package-facing
// matcher knob.
const DEFAULT_MAX_RESULTS = SelectListModel.DEFAULT_PAGE_SIZE;

// The component's own last row when matches exceed the cap. Never handed to the
// consumer's callbacks: confirming it grows the list, selecting it reads as
// no selection, and the component renders it itself.
const SHOW_MORE_ITEM = Object.freeze({ showMoreSentinel: true });
const ROW_VIEW = Symbol("select-list-row-view");
const ROW_DISPOSABLE = Symbol("select-list-row-disposable");
let nextSelectListId = 1;

/**
 * @public
 * @status experimental
 *
 * Detached fuzzy-searchable select-list model. Extends InputDialog with items,
 * filtering, selection and list rendering. Call {@link InputDialog#getElement} to lazily
 * create its unmounted surface, or use {@link Workspace#addSelectList} to give
 * it a modal host.
 *
 * Hosted lists support keep-open mode by default. Set `supportsKeepOpen: false`
 * for a surface that must finish after one choice. Individual terminal actions
 * in a repeatable list declare disposition `complete`.
 *
 * A flat `items` source may also supply `overflowSections`, an alternative
 * grouping of exactly the same items. It applies only while the unfiltered
 * list actually overflows its viewport; shorter lists retain their natural
 * order without section separators. Pass `null` to remove this alternative.
 *
 * Set `search.prepareOnIdle: true` for a large built-in fuzzy list with a pure
 * `getFilterText` callback. Core may extract and normalize its text before a
 * query, in short yielding batches. Query sources and custom matchers are
 * unaffected. Source replacement and destruction cancel pending preparation;
 * an immediate query completes any remaining preparation before matching.
 *
 * `search.yieldToInput: true` also yields while ranking large flat lists (at
 * least 2048 items). It requires pure filter-text and score callbacks and the
 * built-in matcher without a custom sort. Pending results are empty, so actions
 * cannot confirm a stale match. Every match is published together when ready;
 * newer input, source changes and destruction cancel the obsolete request.
 * `setQuery()` resolves after that request's results have rendered.
 *
 * A recents adapter's `save(ids, change)` receives the operation's intent:
 * `{type: 'record'|'remove'|'clear'|'limit'|'replace', id?, limit}`. Apply it to
 * the latest stored IDs with {@link updateRecentItemIds} inside a scoped
 * state's `mutate()` callback. Returning the committed IDs synchronizes a
 * successful no-op too; returning nothing remains valid for other adapters.
 * Set `adapter.serializesWrites: true` when the adapter owns write ordering.
 * Core then invokes save immediately, letting scoped state capture the current
 * project before a rebind. Other adapters retain core's serial save queue.
 * Project adapters notify `onDidChange` on a project rebind even when the IDs
 * are equal. Use the scoped state's `observe()` subscription, skipping its
 * initial callback, so a pending save cannot project into a different project.
 *
 * Destroy this model with the inherited {@link InputDialog#destroy}; calling
 * the inherited {@link InputDialog#confirm} delegates to {@link #confirmSelection}.
 */
class SelectList extends InputDialog {
  createComponent() {
    return new SelectListComponent(this);
  }

  initializeState() {
    this.validateKeepOpenSupport(this.props);
    this.keepOpen = false;
    this.listCommandDescriptors = this.props.internalActionPalette
      ? {}
      : {
          "select-list:toggle-keep-open": {
            description: "Keep the list open after actions, or restore normal closing.",
            didDispatch: () => this.setKeepOpen(!this.isKeepOpen()),
          },
        };
    this.listActionDescriptors = this.props.internalActionPalette
      ? []
      : [
          {
            command: "select-list:toggle-keep-open",
            context: "dialog",
            disposition: "stay",
            group: "List",
            when: () => this.host != null && this.supportsKeepOpen(),
          },
        ];
    this.sessionSelectionGeneration = 0;
    this.pendingSourceSelectionGeneration = null;
    this.showMoreSelected = false;
    this.overflowSectionsActive = false;
    this.overflowUpdatePromise = null;
    this.overflowResizeObserver = null;
    this.overflowViewport = null;
    this.pixelSizeSubscription = null;
    this.listBoxId = `select-list-${nextSelectListId++}`;
    this.itemDomIds = new Map();
    this.recentBoundaryIndex = -1;
    this.matchIndicesMap = new Map();
    this.filterMatcher = null;
    this.filterMatcherIds = null;
    this.filterMatcherIgnoresDiacritics = null;
    this.filterMatcherGeneration = null;
    this.matcherPreparation = null;
    this.queryWork = null;
    this.recentRevision = 0;
    this.recentLoadGeneration = 0;
    this.recentSaveQueue = null;
    this.recentActionDescriptors = [];
    this.recentCommandDescriptors = {};
    this.recentConfiguration = this.normalizeRecents(this.props.recents);

    let configuredRecentIds = [];
    if (this.recentConfiguration) {
      const loaded = this.recentConfiguration.adapter.load();
      if (loaded && typeof loaded.then === "function") {
        const revision = this.recentRevision;
        const generation = ++this.recentLoadGeneration;
        this.recentsReady = Promise.resolve(loaded)
          .then((recentIds) => this.applyLoadedRecentItemIds(recentIds, revision, generation))
          .catch((error) => this.didFailRecents(error));
      } else {
        if (loaded != null && !Array.isArray(loaded)) {
          throw new TypeError("recents.adapter.load() must return an array or Promise.");
        }
        configuredRecentIds = Array.from(new Set(loaded ?? [])).slice(
          0,
          this.recentConfiguration.limit,
        );
      }
      if (this.recentConfiguration.adapter.onDidChange) {
        this.disposables.add(
          this.recentConfiguration.adapter.onDidChange((recentIds) => {
            if (recentIds === undefined) {
              const revision = this.recentRevision;
              const generation = ++this.recentLoadGeneration;
              let loadedIds;
              try {
                loadedIds = this.recentConfiguration.adapter.load();
              } catch (error) {
                this.didFailRecents(error);
                return;
              }
              Promise.resolve(loadedIds)
                .then((ids) => this.applyLoadedRecentItemIds(ids, revision, generation))
                .catch((error) => this.didFailRecents(error));
            } else {
              this.recentLoadGeneration++;
              this.setRecentItemIds(recentIds, { persist: false }).catch((error) =>
                this.didFailRecents(error),
              );
            }
          }),
        );
      }
      this.installRecentActions();
    }

    this.modelGetItemId = this.buildModelGetItemId(this.props);
    this.modelSearch = this.buildModelSearch(this.props);
    const selection = this.normalizeSelection(this.props.selection);
    const source = Object.prototype.hasOwnProperty.call(this.props, "sections")
      ? { sections: this.props.sections }
      : { items: this.props.items ?? [] };
    this.model = new SelectListModel({
      ...source,
      getItemId: this.modelGetItemId,
      search: this.modelSearch,
      query: this.modelQuery(this.props.query ?? "", this.props),
      recentIds: this.props.recentItemIds ?? configuredRecentIds,
      allowEmptySelection: selection.allowEmpty,
      pageSize: DEFAULT_MAX_RESULTS,
      ...(selection.initial !== undefined ? { initialSelection: selection.initial } : {}),
    });

    this.props.items = this.model.getItems();
    this.dialogActions.set(this.actionsForCatalog(this.props.actions ?? []));
    this.validateOverflowSections(this.props);
    this.syncModelState();
    this.scheduleMatcherPreparation();
  }

  validateOverflowSections(props) {
    if (props.overflowSections == null) return;
    if (Object.prototype.hasOwnProperty.call(props, "sections")) {
      throw new TypeError("overflowSections requires a flat items source.");
    }
    const natural = new SelectListModel({ items: props.items, getItemId: props.getItemId });
    const alternative = new SelectListModel({
      sections: props.overflowSections,
      getItemId: props.getItemId,
    });
    if (
      natural.getItems().length !== alternative.getItems().length ||
      alternative
        .getItems()
        .some((item) => natural.getItemById(alternative.getItemId(item)) !== item)
    ) {
      throw new Error("overflowSections must contain exactly the same items as items.");
    }
  }

  normalizeRecents(recents) {
    if (recents == null) return null;
    if (!recents || typeof recents !== "object" || Array.isArray(recents)) {
      throw new TypeError("recents must be an object.");
    }
    const adapter = recents.adapter;
    if (!adapter || typeof adapter.load !== "function" || typeof adapter.save !== "function") {
      throw new TypeError("recents.adapter must provide load() and save(ids).");
    }
    if (adapter.onDidChange != null && typeof adapter.onDidChange !== "function") {
      throw new TypeError("recents.adapter.onDidChange must be a function.");
    }
    if (adapter.serializesWrites != null && typeof adapter.serializesWrites !== "boolean") {
      throw new TypeError("recents.adapter.serializesWrites must be a boolean.");
    }
    const limit = recents.limit ?? Infinity;
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("recents.limit must be a non-negative integer.");
    }
    return { adapter, limit };
  }

  normalizeSelection(selection) {
    if (selection == null) return { allowEmpty: false, initial: undefined };
    if (typeof selection !== "object" || Array.isArray(selection)) {
      throw new TypeError("selection must be an object.");
    }
    const initial = selection.initial;
    if (initial === undefined) {
      return { allowEmpty: selection.allowEmpty === true, initial: undefined };
    }
    if (!initial || typeof initial !== "object" || Array.isArray(initial)) {
      throw new TypeError("selection.initial must be {mode: 'first'|'none'} or {id}.");
    }
    return { allowEmpty: selection.allowEmpty === true, initial };
  }

  installRecentActions() {
    this.recentCommandDescriptors = {
      "select-list:remove-recent": {
        description: "Remove the selected item from the recent section.",
        didDispatch: (event) => this.removeRecentItem(event.detail.item),
      },
      "select-list:clear-recents": {
        description: "Clear every item from the recent section.",
        didDispatch: () => this.clearRecentItems(),
      },
    };
    this.recentActionDescriptors = [
      {
        command: "select-list:remove-recent",
        context: "item",
        disposition: "stay",
        group: "Recent",
        when: ({ item }) => item != null && this.isRecentItem(item),
      },
      {
        command: "select-list:clear-recents",
        context: "dialog",
        disposition: "stay",
        group: "Recent",
        when: () => this.getRecentItemIds().length > 0,
      },
    ];
  }

  actionsForCatalog(actions) {
    const provided = [...this.listActionDescriptors, ...this.recentActionDescriptors];
    if (provided.length === 0) return actions;
    let entries;
    if (actions == null) entries = [];
    else if (Array.isArray(actions)) entries = actions.slice();
    else if (typeof actions === "object") {
      entries = Object.prototype.hasOwnProperty.call(actions, "command")
        ? [actions]
        : Object.entries(actions);
    } else {
      entries = [actions];
    }
    const providerCommands = new Set(provided.map(({ command }) => command));
    entries = entries.filter((entry) => {
      const command = Array.isArray(entry) ? entry[0] : entry?.command;
      return !providerCommands.has(command);
    });
    return [...entries, ...provided];
  }

  commandsForRegistration(commands) {
    const provided = { ...this.listCommandDescriptors, ...this.recentCommandDescriptors };
    if (Object.keys(provided).length === 0) return commands;
    if (commands != null && (typeof commands !== "object" || Array.isArray(commands))) {
      return commands;
    }
    for (const command of Object.keys(provided)) {
      if (Object.prototype.hasOwnProperty.call(commands ?? {}, command)) {
        throw new Error(`Dialog command '${command}' is reserved by the select-list.`);
      }
    }
    return { ...(commands ?? {}), ...provided };
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether successful actions keep this list open for another use.
   * Actions declaring complete still close the list.
   * @returns {Boolean}
   * @category Actions
   */
  isKeepOpen() {
    return this.keepOpen;
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether this list supports keep-open mode.
   * @returns {Boolean} False for an explicit supportsKeepOpen opt-out and internal action lists.
   * @category Actions
   */
  supportsKeepOpen() {
    return this.props.supportsKeepOpen !== false && !this.props.internalActionPalette;
  }

  /**
   * @public
   * @status experimental
   *
   * Set this session's keep-open mode. Fresh modal sessions start with it off.
   * @param {Boolean} keepOpen - Whether ordinary close actions leave the list open.
   * @returns {Promise<void>} Resolves after the view updates.
   * @category Actions
   */
  setKeepOpen(keepOpen) {
    if (typeof keepOpen !== "boolean") throw new TypeError("keepOpen must be a boolean.");
    if (keepOpen && !this.supportsKeepOpen()) {
      throw new Error("This list does not support keep-open mode.");
    }
    if (!this.changeKeepOpenState(keepOpen)) return Promise.resolve();
    this.refreshItemActionsIndicator();
    return Promise.resolve();
  }

  /** @private The built-in toggle only changes attributes synchronously. */
  shouldShowActionProgress(command) {
    return command !== "select-list:toggle-keep-open";
  }

  /** @private Update state without scheduling a duplicate render during prop/session resets. */
  changeKeepOpenState(keepOpen) {
    if (this.keepOpen === keepOpen) return false;
    this.keepOpen = keepOpen;
    this.component?.element.toggleAttribute("keep-open", keepOpen);
    this.emitter.emit("did-change-keep-open", { list: this, keepOpen });
    return true;
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the session's keep-open mode changes.
   * @param {Function} callback - Receives an event with list and keepOpen.
   * @returns {Disposable} Dispose to unsubscribe.
   * @category Event Subscription
   */
  onDidChangeKeepOpen(callback) {
    return this.emitter.on("did-change-keep-open", callback);
  }

  /** @private */
  resolveDisposition(disposition, context) {
    return disposition === "close" &&
      this.supportsKeepOpen() &&
      (context?.keepOpen ?? this.keepOpen)
      ? "stay"
      : disposition;
  }

  /** @private */
  validateKeepOpenSupport(props) {
    if ("supportsKeepOpen" in props && typeof props.supportsKeepOpen !== "boolean") {
      throw new TypeError("supportsKeepOpen must be a boolean.");
    }
  }

  /** @private */
  validateUpdateProps(props) {
    super.validateUpdateProps(props);
    this.validateKeepOpenSupport(props);
  }

  applyLoadedRecentItemIds(recentIds, revision, generation) {
    if (
      this.destroyed ||
      revision !== this.recentRevision ||
      generation !== this.recentLoadGeneration
    ) {
      return this;
    }
    return this.setRecentItemIds(recentIds ?? [], { persist: false });
  }

  didFailRecents(error) {
    if (this.destroyed) return this;
    const report = () => {
      if (!this.destroyed) {
        void this.setStatus({ type: "error", message: error?.message ?? String(error) });
      }
      return this;
    };
    return this.component ? report() : Promise.resolve().then(report);
  }

  saveRecentItemIds(recentIds, change) {
    const save = () => {
      try {
        return Promise.resolve(this.recentConfiguration.adapter.save(recentIds, change));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const operation =
      this.recentSaveQueue && !this.recentConfiguration.adapter.serializesWrites
        ? this.recentSaveQueue.catch(() => {}).then(save)
        : save();
    this.recentSaveQueue = operation;
    const clear = () => {
      if (this.recentSaveQueue === operation) this.recentSaveQueue = null;
    };
    operation.then(clear, clear);
    return operation;
  }

  // A select list *is* an input dialog with a list in it, so it carries both
  // classes and the stylesheet hierarchy mirrors the class hierarchy. Dropping
  // `input-dialog` here is what used to leave every base dialog rule — the
  // message line among them — matching nothing inside a list. A rule meant for
  // dialogs and not lists is written `.input-dialog:not(.select-list)`.
  rootClasses() {
    return [...super.rootClasses(), "select-list"];
  }

  didInitializeElement() {
    super.didInitializeElement();
    this.component.element.toggleAttribute("keep-open", this.keepOpen);
    this.queryEditor.getElement().setAttribute("role", "combobox");
    this.queryEditor.getElement().setAttribute("aria-autocomplete", "list");
    this.updateComboboxAttributes();
    this.updateActiveDescendant();
  }

  didAttachElement() {
    super.didAttachElement();
    this.observePixelSize();
    if (this.props.overflowSections != null) void this.updateComponent();
  }

  didDetachElement() {
    super.didDetachElement();
    this.pixelSizeSubscription?.dispose();
    this.pixelSizeSubscription = null;
  }

  /** @private */
  observePixelSize() {
    this.pixelSizeSubscription?.dispose();
    const element = this.component.element;
    const window = element.ownerDocument.defaultView;
    const ratio = window.devicePixelRatio;
    element.style.setProperty("--select-list-pixel-size", `${1 / ratio}px`);
    // Zooming or moving to another display changes the native scroll step.
    // Rearm the query at the new resolution, and release it while detached.
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const didChange = () => this.observePixelSize();
    query.addEventListener("change", didChange);
    this.pixelSizeSubscription = new Disposable(() =>
      query.removeEventListener("change", didChange),
    );
  }

  didChangeHostVisible(visible) {
    super.didChangeHostVisible(visible);
    this.updateComboboxAttributes();
    if (visible && this.props.overflowSections != null) void this.updateComponent();
  }

  updateComponent() {
    const update = super.updateComponent();
    if (this.props.overflowSections == null) {
      this.observeOverflowViewport();
      return update;
    }
    const previous = this.overflowUpdatePromise;
    const overflowUpdate = Promise.all([update, previous]).then(() =>
      this.updateOverflowSections(),
    );
    this.overflowUpdatePromise = overflowUpdate;
    return overflowUpdate.finally(() => {
      if (this.overflowUpdatePromise === overflowUpdate) this.overflowUpdatePromise = null;
    });
  }

  async updateOverflowSections() {
    if (this.destroyed) return;
    this.observeOverflowViewport();
    if (this.props.overflowSections == null) return;
    const scroller = this.component?.refs?.items;
    if (!scroller?.isConnected || scroller.clientHeight === 0) return;

    let overflow = false;
    if (this.props.overflowSections != null && this.getParsedQuery().text === "") {
      // Measure the flat baseline: an added section rule must never be the
      // thing that makes this alternative overflow and keeps itself enabled.
      const separators = Array.from(scroller.querySelectorAll("[data-overflow-section]"));
      const scrollTop = scroller.scrollTop;
      const displays = separators.map((element) => element.style.display);
      separators.forEach((element) => {
        element.style.display = "none";
      });
      overflow = scroller.scrollHeight > scroller.clientHeight;
      separators.forEach((element, index) => {
        element.style.display = displays[index];
      });
      scroller.scrollTop = scrollTop;
    }
    if (overflow === this.overflowSectionsActive) return;

    const previousSelection = this.selectionSnapshot();
    const displayedCount = this.model.getDisplayedCount();
    this.model.update(
      overflow ? { sections: this.props.overflowSections } : { items: this.props.items },
    );
    while (this.model.getDisplayedCount() < displayedCount && this.model.hasMore()) {
      this.model.showMore();
    }
    this.overflowSectionsActive = overflow;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "layout");
    await super.updateComponent();
    if (!this.destroyed) this.observeOverflowViewport();
  }

  observeOverflowViewport() {
    const viewport = this.props.overflowSections != null ? this.component?.refs?.items : null;
    const window = viewport?.ownerDocument.defaultView;
    if (viewport === this.overflowViewport && window === this.overflowWindow) return;
    this.overflowResizeObserver?.disconnect();
    this.overflowResizeObserver = null;
    this.overflowViewport = viewport ?? null;
    this.overflowWindow = window;
    if (!viewport) return;
    const observer = new window.ResizeObserver(() => {
      if (!this.destroyed && this.overflowResizeObserver === observer) void this.updateComponent();
    });
    this.overflowResizeObserver = observer;
    observer.observe(viewport);
  }

  /** @private */
  resetForNewSession(options) {
    this.changeKeepOpenState(false);
    const generation = ++this.sessionSelectionGeneration;
    this.pendingSourceSelectionGeneration = this.getSource() ? generation : null;
    super.resetForNewSession(options);
    const previousSelection = this.selectionSnapshot();
    const initialSelection = this.initialSelectionForSession();
    this.model.resetDisplayLimit();
    this.model.update({ initialSelection });
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "session");
    this.refreshItemActionsIndicator();
    void this.updateComponent();
  }

  initialSelectionForSession() {
    const selection = this.normalizeSelection(this.props.selection);
    return selection.initial ?? { mode: selection.allowEmpty ? "none" : "first" };
  }

  applySourcePublication(publication) {
    const generation = this.pendingSourceSelectionGeneration;
    if (generation == null) return super.applySourcePublication(publication);

    if (Array.isArray(publication)) {
      if (publication.length === 0) return super.applySourcePublication(publication);
      this.pendingSourceSelectionGeneration = null;
      return this.setItems(publication, { selection: this.initialSelectionForSession() });
    }

    const hasItems = Array.isArray(publication?.items);
    const hasSections = Array.isArray(publication?.sections);
    const hasExplicitSelection =
      Object.prototype.hasOwnProperty.call(publication ?? {}, "selection") ||
      publication?.itemUpdateOptions?.selection != null;
    const hasNonEmptyItems =
      (hasItems && publication.items.length > 0) ||
      (hasSections && publication.sections.some((section) => section?.items?.length > 0));
    if ((!hasItems && !hasSections) || (!hasExplicitSelection && !hasNonEmptyItems)) {
      return super.applySourcePublication(publication);
    }

    this.pendingSourceSelectionGeneration = null;
    if (hasExplicitSelection) return super.applySourcePublication(publication);
    return super.applySourcePublication({
      ...publication,
      itemUpdateOptions: {
        ...(publication.itemUpdateOptions ?? {}),
        selection: this.initialSelectionForSession(),
      },
    });
  }

  openSource() {
    const generation = this.pendingSourceSelectionGeneration;
    let operation;
    try {
      operation = super.openSource();
    } catch (error) {
      if (this.pendingSourceSelectionGeneration === generation) {
        this.pendingSourceSelectionGeneration = null;
      }
      throw error;
    }
    const finish = () => {
      if (this.pendingSourceSelectionGeneration === generation) {
        this.pendingSourceSelectionGeneration = null;
      }
    };
    return Promise.resolve(operation).then(
      (value) => {
        finish();
        return value;
      },
      (error) => {
        finish();
        throw error;
      },
    );
  }

  cancelSource(reason) {
    this.pendingSourceSelectionGeneration = null;
    return super.cancelSource(reason);
  }

  /**
   * Release list-specific resources during {@link InputDialog#destroy}.
   * @private
   */
  async destroyNow() {
    this.cancelQueryWork();
    this.cancelMatcherPreparation();
    this.filterMatcher = null;
    this.filterMatcherIds = null;
    this.filterMatcherIgnoresDiacritics = null;
    this.filterMatcherFirst = null;
    this.overflowResizeObserver?.disconnect();
    this.overflowViewport = null;
    try {
      await super.destroyNow();
    } finally {
      this.model = null;
    }
  }

  buildModelGetItemId(props) {
    if (props.getItemId != null && typeof props.getItemId !== "function") {
      throw new TypeError("getItemId must be a function.");
    }
    return props.getItemId ?? null;
  }

  buildModelSearch(props) {
    const search = props.search ?? {};
    if (!search || typeof search !== "object" || Array.isArray(search)) {
      throw new TypeError("search must be an object.");
    }
    const { getFilterText = null, filter = null, sort = null } = search;
    let { matcher = null } = search;

    if (!filter && !matcher) {
      const options = {
        algorithm: search.algorithm,
        ignoreDiacritics: search.ignoreDiacritics,
        scoreModifier: search.scoreModifier,
      };
      matcher = (candidates, query, context) =>
        this.matchCandidates(candidates, query, context, options);
      matcher[SelectListModel.PreparedRecordMatcher] = true;
    }

    return {
      getFilterText: getFilterText ?? null,
      filter: filter ?? null,
      sort: sort ?? null,
      matcher,
    };
  }

  parseQuery(query, props = this.props) {
    const raw = query == null ? "" : String(query);
    const parser = props.search?.parseQuery;
    let parsed;
    if (parser) {
      parsed = parser(raw);
    } else {
      parsed = raw;
    }
    if (typeof parsed === "string") return Object.freeze({ text: parsed, data: null });
    if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") {
      throw new TypeError("search.parseQuery must return a string or {text, data} object.");
    }
    return Object.freeze({ text: parsed.text, data: parsed.data ?? null });
  }

  /**
   * @public
   * @status experimental
   *
   * Return the parsed search text and package metadata.
   * @returns {Object} A frozen {text, data} record; data is the arbitrary metadata returned by search.parseQuery.
   * @category Query
   */
  getParsedQuery() {
    return this.parseQuery(this.getQuery());
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the asynchronous source and keep local filtering aligned with its
   * mode. Query sources own filtering; snapshot sources and a null source use
   * the list's current parsed query.
   * @param {Object|null} source - Source options accepted by InputDialog.setSource; query sources own filtering.
   * @returns {Promise<void>}
   * @category Asynchronous Sources
   */
  setSource(source) {
    const previousSelection = this.model ? this.selectionSnapshot() : null;
    const sourcePromise = super.setSource(source);
    if (!this.model || this.suppressModelQueryUpdate) return sourcePromise;

    const query = this.modelQuery(this.getQuery(), this.props);
    if (query === this.model.getQuery()) return sourcePromise;

    this.model.update({ query });
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "source");
    const updatePromise = this.updateComponent();
    return Promise.all([sourcePromise, updatePromise]).then(() => undefined);
  }

  modelQuery(query, props = this.props) {
    return props.source?.mode === "query" ? "" : this.parseQuery(query, props).text;
  }

  syncModelState() {
    this.processedQuery = this.model.getQuery();
    this.filteredItemsSnapshot = null;
    this.displayedRecords = this.model._getDisplayedRecords();
    this.items = this.displayedRecords.map((record) => record.item);
    if (this.model.hasMore()) this.items.push(SHOW_MORE_ITEM);

    this.showMoreSelected = this.showMoreSelected && this.model.hasMore();
    if (this.showMoreSelected) {
      this.selectionIndex = this.items.length - 1;
    } else {
      const selectedIndex = this.model.getSelectedIndex();
      this.selectionIndex = selectedIndex < 0 ? undefined : selectedIndex;
    }

    let recentCount = 0;
    while (recentCount < this.displayedRecords.length && this.displayedRecords[recentCount].recent)
      recentCount++;
    this.recentBoundaryIndex =
      recentCount > 0 && recentCount < this.displayedRecords.length ? recentCount : -1;
    this.updateComboboxAttributes();
    this.updateActiveDescendant();
  }

  updateComboboxAttributes() {
    const editorElement = this.queryEditor?.component?.element;
    if (!editorElement) return;
    const hasListbox = (this.items?.length ?? 0) > 0;
    if (hasListbox) editorElement.setAttribute("aria-controls", this.listBoxId);
    else editorElement.removeAttribute("aria-controls");
    editorElement.setAttribute("aria-expanded", String(this.hostVisible && hasListbox));
  }

  domIdForIndex(index) {
    if (this.items[index] === SHOW_MORE_ITEM) return `${this.listBoxId}-show-more`;
    const record = this.displayedRecords[index];
    if (!record) return null;
    let domId = this.itemDomIds.get(record.id);
    if (!domId) {
      domId = `${this.listBoxId}-item-${this.itemDomIds.size + 1}`;
      this.itemDomIds.set(record.id, domId);
    }
    return domId;
  }

  prepareItemElement(element, index, selected) {
    element.id = this.domIdForIndex(index);
    element.setAttribute("role", "option");
    element.setAttribute("aria-selected", String(selected));
    return element;
  }

  updateActiveDescendant() {
    const editorElement = this.queryEditor?.component?.element;
    if (!editorElement) return;
    const activeId = this.selectionIndex == null ? null : this.domIdForIndex(this.selectionIndex);
    if (activeId) editorElement.setAttribute("aria-activedescendant", activeId);
    else editorElement.removeAttribute("aria-activedescendant");
  }

  resetRenderedItems() {
    this.listItems = null;
    this.matchIndicesMap = new Map();
  }

  commandsForElement() {
    return {
      ...super.commandsForElement(),
      "core:move-up": (event) => {
        this.selectPrevious();
        event.stopPropagation();
      },
      "core:move-down": (event) => {
        this.selectNext();
        event.stopPropagation();
      },
      "core:move-to-top": (event) => {
        this.selectFirst();
        event.stopPropagation();
      },
      "core:move-to-bottom": (event) => {
        this.selectLast();
        event.stopPropagation();
      },
    };
  }

  confirm() {
    return this.confirmSelection();
  }

  getActionContext(source = "api") {
    const context = super.getActionContext(source);
    const item = this.getSelectedItem();
    const result = {
      ...context,
      keepOpen: this.keepOpen,
      list: this,
      item,
      itemId: this.getSelectedItemId(),
    };
    const records = this.model._records;
    let items;
    let materialized = false;
    const prepared = { records };
    Object.defineProperty(result, PreparedItems, { value: prepared });
    Object.defineProperty(result, "items", {
      enumerable: true,
      configurable: true,
      get() {
        // Once a caller has the mutable public snapshot, capture its contents
        // normally; it may have changed independently of the source records.
        prepared.records = null;
        if (!materialized) {
          items = records.map((record) => record.item);
          materialized = true;
        }
        return items;
      },
      set(value) {
        prepared.records = null;
        items = value;
        materialized = true;
      },
    });
    return result;
  }

  getActionItemId(item) {
    return this.getItemId(item);
  }

  resolveActionItemById(id) {
    return this.model?.getItemById(id) ?? null;
  }

  /** @private A captured action keeps its identity while list data is replaced. */
  currentActionContext(context) {
    if (context.item == null) return context;
    const item = this.model?.getItemById(context.itemId) ?? null;
    return item === context.item ? context : Object.freeze({ ...context, item });
  }

  recordActionRecent({ item }) {
    if (item != null) {
      return this.recordRecentItem(item).catch((error) => this.didFailRecents(error));
    }
  }

  updateProps(props) {
    const previousSelection = this.selectionSnapshot();
    const nextProps = { ...this.props, ...props };
    if ("items" in props && !("sections" in props)) delete nextProps.sections;
    if (
      "items" in props ||
      "sections" in props ||
      "overflowSections" in props ||
      "getItemId" in props
    ) {
      this.validateOverflowSections(nextProps);
    }
    const modelChanges = {};
    const itemsChanged = "items" in props || "sections" in props;
    const recentItemIdsChanged = "recentItemIds" in props;
    const identityChanged = "getItemId" in props;
    const searchChanged = "search" in props;

    if ("items" in props) modelChanges.items = props.items;
    if ("sections" in props) modelChanges.sections = props.sections;
    const resetOverflow =
      "overflowSections" in props ||
      itemsChanged ||
      identityChanged ||
      searchChanged ||
      "query" in props;
    if (
      resetOverflow &&
      (nextProps.overflowSections != null || (this.overflowSectionsActive && !itemsChanged))
    ) {
      modelChanges.items = nextProps.items;
      delete modelChanges.sections;
    }

    let nextGetItemId = this.modelGetItemId;
    if (identityChanged) {
      nextGetItemId = this.buildModelGetItemId(nextProps);
      modelChanges.getItemId = nextGetItemId;
    }

    let nextSearch = this.modelSearch;
    if (searchChanged) {
      nextSearch = this.buildModelSearch(nextProps);
      modelChanges.search = nextSearch;
    }

    if (recentItemIdsChanged) {
      this.recentRevision++;
      modelChanges.recentIds = props.recentItemIds;
    }
    if ("selection" in props) {
      const selection = this.normalizeSelection(props.selection);
      modelChanges.allowEmptySelection = selection.allowEmpty;
      if (selection.initial !== undefined) modelChanges.initialSelection = selection.initial;
    }
    if (!("selection" in props) && props.itemUpdateOptions?.selection != null) {
      modelChanges.initialSelection = props.itemUpdateOptions.selection;
    }
    if ("query" in props || searchChanged || "source" in props) {
      const query = "query" in props ? props.query : this.getQuery();
      modelChanges.query = this.modelQuery(query == null ? "" : String(query), nextProps);
    }

    const changesModel = Object.keys(modelChanges).length > 0;
    const yielding = changesModel && this.shouldYieldSearch(nextProps, modelChanges.query);
    if (changesModel) {
      this.cancelQueryWork();
      if (!yielding) this.cancelMatcherPreparation();
      this.model._applyUpdate(modelChanges, false, yielding ? [] : undefined);
    }
    if (resetOverflow) this.overflowSectionsActive = false;

    const listProps = [
      "items",
      "sections",
      "overflowSections",
      "getItemId",
      "search",
      "renderItem",
      "recentItemIds",
      "selection",
      "emptyMessage",
      "itemsClassList",
      "supportsKeepOpen",
    ];
    for (const key of listProps) {
      if (key in props) this.props[key] = props[key];
    }
    if (!this.supportsKeepOpen()) this.changeKeepOpenState(false);
    if ("items" in props) delete this.props.sections;
    if ("sections" in props) this.props.sections = props.sections;
    if (itemsChanged) this.props.items = this.model.getItems();
    if (recentItemIdsChanged) {
      const recentIds = this.model.getRecentIds();
      this.props.recentItemIds = recentIds;
    }
    this.modelGetItemId = nextGetItemId;
    this.modelSearch = nextSearch;

    this.suppressModelQueryUpdate = true;
    try {
      super.updateProps(props);
    } finally {
      this.suppressModelQueryUpdate = false;
    }
    if (
      itemsChanged ||
      identityChanged ||
      searchChanged ||
      "sections" in props ||
      "source" in props
    )
      this.scheduleMatcherPreparation();

    if (changesModel || "selection" in props || props.itemUpdateOptions) {
      this.showMoreSelected = false;
      this.resetRenderedItems();
      this.syncModelState();
      this.publishSelectionChange(previousSelection, itemsChanged ? "items" : "update");
    }
    if (yielding) this.startQueryWork();

    if (itemsChanged) {
      this.emitter.emit("did-change-items", { list: this, items: this.getItems() });
    }
    if (recentItemIdsChanged) {
      this.emitter.emit("did-change-recent-item-ids", {
        list: this,
        recentItemIds: this.getRecentItemIds(),
      });
    }
  }

  renderBody() {
    if (this.queryWork && !this.model.getMatchCount())
      return $.div({ className: "message-line", role: "status" }, "Searching…");
    return this.renderItems();
  }

  /** @category Items */

  /**
   * @public
   * @status experimental
   *
   * Return a snapshot of all source items.
   * @returns {Array<*>}
   */
  getItems() {
    return this.model.getItems();
  }

  /**
   * @public
   * @status experimental
   *
   * Return all items in current filtered order.
   * @returns {Array<*>}
   * @category Filtering
   */
  getFilteredItems() {
    return this.model.getFilteredItems();
  }

  // Compatibility snapshot, materialized only when a caller actually reads it.
  get filteredItems() {
    return (this.filteredItemsSnapshot ??= this.model.getFilteredItems());
  }

  set filteredItems(items) {
    this.filteredItemsSnapshot = items;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the currently displayed page without UI rows.
   * @returns {Array<*>}
   * @category Pagination
   */
  getDisplayedItems() {
    return this.model.getDisplayedItems();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the number of source items.
   * @returns {Number}
   */
  getItemCount() {
    return this.model.getItemCount();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the number of filtered matches.
   * @returns {Number}
   * @category Filtering
   */
  getMatchCount() {
    return this.model.getMatchCount();
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when source items change.
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {SelectList} callback.event.list
   * @param {Array<*>} callback.event.items
   * @returns {Disposable} Dispose to unsubscribe.
   * @category Event Subscription
   */
  onDidChangeItems(callback) {
    return this.emitter.on("did-change-items", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the logical selection changes.
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {SelectList} callback.event.list
   * @param {*} callback.event.item - The selected source item, or null for a selection-change event.
   * @param {*} callback.event.itemId - Its stable ID, or null.
   * @param {Number|null} callback.event.index
   * @param {*} callback.event.previousItem
   * @param {String} callback.event.reason
   * @returns {Disposable} Dispose to unsubscribe.
   * @category Event Subscription
   */
  onDidChangeSelection(callback) {
    return this.emitter.on("did-change-selection", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Replace a flat item source while preserving selection by default.
   * @param {Array<*>} items - Replacement source.
   * @param {Object} [options] - Selection behavior for this update.
   * @param {Object} [options.selection] - Override selection with {mode: "first"}, {mode: "none"}, or {id}. Otherwise preserve selection by stable ID when possible.
   * @returns {Promise<void>}
   */
  setItems(items, options = {}) {
    return this.update({ items, itemUpdateOptions: options });
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the source with explicitly grouped sections.
   * @param {Array<Object>} sections - Section records with a required non-null primitive id and items array; additional section metadata is retained.
   * @param {Object} [options] - Selection behavior for this update.
   * @param {Object} [options.selection] - Override selection with {mode: "first"}, {mode: "none"}, or {id}. Otherwise preserve selection by stable ID when possible.
   * @returns {Promise<void>}
   */
  setSections(sections, options = {}) {
    return this.update({ sections, itemUpdateOptions: options });
  }

  /**
   * @public
   * @status experimental
   *
   * Re-render the current source after items changed in place.
   * @param {Object} [options] - Selection options accepted by setItems/setSections.
   * @returns {Promise<void>}
   */
  refresh(options = {}) {
    return "sections" in this.props
      ? this.update({ sections: this.props.sections, itemUpdateOptions: options })
      : this.setItems(this.props.items, options);
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the stable identifier used by the model for an item. Object
   * items default to their `id` property; primitive items identify themselves.
   * @param {*} item - A source item.
   * @returns {*} A non-null primitive stable ID from getItemId, object.id, or a primitive item.
   */
  getItemId(item) {
    return this.model.getItemId(item);
  }

  hasSectionSeparatorBefore(index) {
    if (index <= 0 || index >= this.displayedRecords.length) return false;
    const current = this.displayedRecords[index];
    const previous = this.displayedRecords[index - 1];
    if (current.recent || previous.recent) return false;
    return current.sectionId != null && current.sectionId !== previous.sectionId;
  }

  selectionSnapshot() {
    return {
      id: this.model.getSelectedId(),
      item: this.model.getSelectedItem(),
      index: this.model.getSelectedIndex(),
      showMore: this.showMoreSelected,
      uiIndex: this.selectionIndex,
    };
  }

  publishSelectionChange(previous, reason = "programmatic") {
    const item = this.getSelectedItem();
    const itemId = this.getSelectedItemId();
    const changed = !Object.is(previous.id, itemId) || previous.showMore !== this.showMoreSelected;
    if (changed) {
      this.emitter.emit("did-change-selection", {
        list: this,
        item,
        itemId,
        index: this.getSelectedIndex(),
        previousItem: previous.showMore ? null : previous.item,
        reason,
      });
    }
  }

  renderItems() {
    if (this.items && this.items.length > 0) {
      const className = ["list-group"].concat(this.props.itemsClassList || []).join(" ");
      // Result changes reveal the selection; action and status renders preserve
      // the viewport the user may have scrolled away from it.
      const revealSelection = this.listItems == null;

      this.listItems = this.items.map((item, index) => {
        const record = this.displayedRecords[index];
        const selected =
          item === SHOW_MORE_ITEM
            ? this.showMoreSelected
            : Object.is(this.model.getSelectedId(), record.id);
        const filterKey = this.getFilterKey(item);
        const opts = { selected, index, filterKey };
        // Lazy getter - matchIndices only computed when accessed
        Object.defineProperty(opts, "matchIndices", {
          get: () => this.getMatchIndices(item, filterKey),
          enumerable: true,
        });
        opts.highlight = (text, indices = opts.matchIndices) => highlightMatches(text, indices);
        return $(ListItemView, {
          key: this.domIdForIndex(index),
          element: this.prepareItemElement(this.resolveElement(item, opts), index, selected),
          selected: selected,
          revealSelection,
          onclick: (event) => this.didClickItem(index, event),
          onmiddleclick: () => this.selectIndex(index),
          oncontextmenu: () => this.didContextMenuItem(index),
        });
      });

      const children = [];
      for (let index = 0; index < this.items.length; index++) {
        // Recents and declared sections own their boundaries; they disappear
        // automatically while a query flattens the result set.
        const key =
          index === this.recentBoundaryIndex
            ? "separator:recent"
            : this.hasSectionSeparatorBefore(index)
              ? `separator:section:${String(this.displayedRecords[index].sectionId)}:${index}`
              : null;
        if (key !== null) {
          children.push(
            $.li({
              key,
              className: "select-list-separator",
              role: "separator",
              attributes: {
                "aria-hidden": "true",
                "data-overflow-section":
                  this.overflowSectionsActive && index !== this.recentBoundaryIndex
                    ? "true"
                    : undefined,
              },
            }),
          );
        }
        children.push(this.listItems[index]);
      }

      return $.ol({ id: this.listBoxId, className, ref: "items", role: "listbox" }, ...children);
    } else if (!this.hasMessage() && this.props.emptyMessage) {
      return $.div({ ref: "emptyMessage", className: "empty-message" }, this.props.emptyMessage);
    } else {
      return "";
    }
  }

  didChangeQuery() {
    let previousSelection = null;
    if (this.model && !this.suppressModelQueryUpdate) {
      previousSelection = this.selectionSnapshot();
      this.cancelQueryWork();
      const changes = {
        query: this.modelQuery(this.getQuery()),
        ...(this.overflowSectionsActive ? { items: this.props.items } : {}),
      };
      const yielding = this.shouldYieldSearch(this.props, changes.query);
      if (!yielding) this.cancelMatcherPreparation();
      this.model._applyUpdate(changes, false, yielding ? [] : undefined);
      this.overflowSectionsActive = false;
      this.showMoreSelected = false;
      this.resetRenderedItems();
      this.syncModelState();
      if (yielding) this.startQueryWork();
    }
    super.didChangeQuery();
    if (previousSelection) this.publishSelectionChange(previousSelection, "query");
    if (this.model) void this.updateComponent();
  }

  update(props = {}) {
    const rendering = super.update(props);
    const pending = ["query", "items", "sections", "search", "source", "getItemId"].some(
      (key) => key in props,
    )
      ? this.queryWork?.promise
      : null;
    return pending ? Promise.all([rendering, pending]).then(() => undefined) : rendering;
  }

  shouldYieldSearch(props, query = this.model.getQuery()) {
    const search = props.search;
    return !!(
      query &&
      search?.yieldToInput &&
      !search.filter &&
      !search.matcher &&
      !search.sort &&
      !props.sections &&
      props.source?.mode !== "query" &&
      (props.items?.length ?? this.model.getItemCount()) >= 2048
    );
  }

  cancelQueryWork() {
    this.queryWork?.controller.abort();
    this.queryWork = null;
  }

  startQueryWork() {
    const controller = new AbortController();
    const work = { controller, promise: null };
    this.queryWork = work;
    const records = this.model._records;
    const generation = this.model.getGeneration();
    const query = this.model.getQuery();
    const options = this.props.search;
    const check = () => {
      controller.signal.throwIfAborted();
      if (this.destroyed || this.model.getGeneration() !== generation)
        throw new Error("List source changed during matching");
    };
    work.promise = (async () => {
      // Let the editor paint the new query before doing any candidate work.
      await new Promise((resolve) => setImmediate(resolve));
      check();
      if (this.filterMatcherGeneration !== generation || this.filterMatcherFirst !== records[0]) {
        const pending = this.matcherPreparation;
        this.cancelMatcherPreparation();
        const preparation =
          pending?.generation === generation && pending.records === records
            ? pending
            : {
                generation,
                records,
                ignoreDiacritics: !!options.ignoreDiacritics,
                matcher: fuzzyMatcher.setCandidates([], {
                  ignoreDiacritics: !!options.ignoreDiacritics,
                }),
                ids: new Map(),
                next: 0,
              };
        this.matcherPreparation = preparation;
        do {
          check();
          this.prepareMatcherBatch(
            preparation,
            (item) => this.model.getFilterText(item),
            performance.now() + 6,
          );
          if (preparation.next < records.length)
            await new Promise((resolve) => setImmediate(resolve));
        } while (preparation.next < records.length);
        check();
        if (this.matcherPreparation === preparation) this.matcherPreparation = null;
        this.installPreparedMatcher(preparation);
      }
      const ids = await this.filterMatcher.fuzzyMatcher.matchIdsAsync(
        query,
        {
          algorithm: options.algorithm || "fuzzaldrin",
          scoreModifier: options.scoreModifier
            ? (score, id) => options.scoreModifier(score, records[id].item)
            : undefined,
        },
        { signal: controller.signal },
      );
      const results = new Array(ids.length);
      let deadline = performance.now() + 6;
      for (let i = 0; i < ids.length; i++) {
        results[i] = records[ids[i]];
        if ((i & 1023) === 0 && performance.now() >= deadline) {
          await new Promise((resolve) => setImmediate(resolve));
          check();
          deadline = performance.now() + 6;
        }
      }
      check();
      const previousSelection = this.selectionSnapshot();
      this.model._applyUpdate(
        { query, initialSelection: { mode: this.model._allowEmptySelection ? "none" : "first" } },
        false,
        results,
      );
      this.showMoreSelected = false;
      this.resetRenderedItems();
      this.syncModelState();
      if (this.queryWork === work) this.queryWork = null;
      this.publishSelectionChange(previousSelection, "query");
      this.refreshItemActionsIndicator();
      await this.updateComponent();
    })()
      .catch((error) => {
        if (controller.signal.aborted) return;
        void this.setStatus({ type: "error", message: error?.message ?? String(error) });
        throw error;
      })
      .finally(() => {
        if (this.queryWork === work) this.queryWork = null;
      });
    // Keyboard changes have no promise consumer. Explicit setQuery still
    // receives the rejection while the surface reports the error in both cases.
    void work.promise.catch(() => {});
  }

  didClickItem(itemIndex, event) {
    const target = this.queryEditor.getElement();
    event ??= new target.ownerDocument.defaultView.MouseEvent("click");
    if (event.button !== 0) return;

    // Select synchronously before dispatch so every action sees the clicked
    // item. Selection observers can distinguish this from keyboard preview.
    void this.selectIndex(itemIndex, true, "click");
    const keystroke = [
      event.ctrlKey && "ctrl",
      event.altKey && "alt",
      event.shiftKey && "shift",
      event.metaKey && "cmd",
      "enter",
    ]
      .filter(Boolean)
      .join("-");
    this.services.keymapManager.dispatchKeystroke(keystroke, target, event);
  }

  didContextMenuItem(itemIndex) {
    this.selectIndex(itemIndex);
    if (!this.host) return false;
    const available = this.hasAvailableActions(this.getActionContext("context-menu"));
    if (!available) return false;
    this.requestActions();
    return true;
  }

  /**
   * @public
   * @status experimental
   *
   * Reveals the next batch of matches in place of the "Show more…" row. The
   * first newly revealed item takes the selection — it sits exactly where the
   * row was.
   *
   * Pressing the row (a click, or Enter while it is highlighted) keeps the
   * scroller where it is, so the list never jumps under the pointer. Keyboard
   * navigation that lands on the row from afar — Ctrl-End crossing the whole
   * list — passes `followSelection: true` instead, and the viewport moves to
   * the newly selected item like any other selection change.
   * @param {Object} [options] - Paging options.
   * @param {Boolean} [options.followSelection=false] - Scroll to the first newly revealed item instead of preserving the viewport.
   * @returns {Promise<Boolean>}
   * @category Pagination
   */
  async showMore({ followSelection = false } = {}) {
    if (!this.model.hasMore()) return false;
    const previousSelection = this.selectionSnapshot();
    const revealIndex = this.model.getDisplayedCount();
    const scroller = this.component?.refs?.items;
    const scrollTop = scroller ? scroller.scrollTop : 0;

    this.model.showMore();
    this.model.selectIndex(revealIndex);
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "pagination");
    await this.updateComponent();

    // The ol persists across the update, and the selection's own
    // scroll-into-view runs inside it; putting the viewport back last is what
    // makes the pressed-button paths stable.
    if (!followSelection && this.component?.refs?.items) {
      this.component.refs.items.scrollTop = scrollTop;
    }
    return true;
  }

  matchCandidates(candidates, query, context, options) {
    // A rejected model transaction may reuse its proposed numeric generation
    // on the next attempt. Its newly prepared records still have new identities.
    if (
      this.filterMatcherGeneration !== context.generation ||
      this.filterMatcherFirst !== candidates[0]
    ) {
      const pending = this.matcherPreparation;
      if (
        pending &&
        pending.generation === context.generation &&
        pending.records === candidates &&
        pending.ignoreDiacritics === !!options.ignoreDiacritics
      ) {
        this.cancelMatcherPreparation();
        this.prepareMatcherBatch(pending, (item) => context.getFilterText(item), Infinity);
        this.installPreparedMatcher(pending);
      } else {
        this.cancelMatcherPreparation();
        const texts = candidates.map(
          (candidate) => candidate.filterText ?? context.getFilterText(candidate.item),
        );
        const ignoreDiacritics = !!options.ignoreDiacritics;
        if (this.filterMatcher && this.filterMatcherIgnoresDiacritics === ignoreDiacritics)
          this.filterMatcher.setCandidates(texts);
        else this.filterMatcher = fuzzyMatcher.setCandidates(texts, { ignoreDiacritics });
        this.filterMatcherIgnoresDiacritics = ignoreDiacritics;
        this.filterMatcherIds = new Map(
          candidates.map((candidate, index) => [candidate.id, index]),
        );
        this.filterMatcherGeneration = context.generation;
        this.filterMatcherFirst = candidates[0];
      }
    }
    const modifyScore = options.scoreModifier;
    return this.filterMatcher
      .matchIds(query, {
        algorithm: options.algorithm,
        scoreModifier: modifyScore
          ? (score, id) => modifyScore(score, candidates[id].item)
          : undefined,
      })
      .map((id) => candidates[id]);
  }

  /** @private */
  cancelMatcherPreparation() {
    if (this.matcherPreparation) clearTimeout(this.matcherPreparation.timer);
    this.matcherPreparation = null;
  }

  /** @private */
  scheduleMatcherPreparation() {
    this.cancelMatcherPreparation();
    if (
      this.destroyed ||
      !this.model ||
      this.filterMatcher ||
      this.model.getQuery() ||
      this.props.source?.mode === "query" ||
      !this.props.search?.prepareOnIdle ||
      this.props.search.filter ||
      this.props.search.matcher ||
      this.model._records.length < 2048
    )
      return;
    const ignoreDiacritics = !!this.props.search.ignoreDiacritics;
    const work = {
      generation: this.model.getGeneration(),
      records: this.model._records,
      ignoreDiacritics,
      matcher: fuzzyMatcher.setCandidates([], { ignoreDiacritics }),
      ids: new Map(),
      next: 0,
      timer: null,
    };
    this.matcherPreparation = work;
    const current = () =>
      !this.destroyed &&
      this.props.source?.mode !== "query" &&
      this.matcherPreparation === work &&
      this.model?.getGeneration() === work.generation &&
      this.model._records === work.records;
    const run = () => {
      if (!current()) {
        if (this.matcherPreparation === work) this.cancelMatcherPreparation();
        return;
      }
      try {
        this.prepareMatcherBatch(
          work,
          (item) => this.model.getFilterText(item),
          performance.now() + 4,
        );
      } catch {
        // A speculative extraction failure is retried by the normal query path,
        // where the existing transactional/error handling owns the exception.
        this.cancelMatcherPreparation();
        return;
      }
      if (!current()) {
        if (this.matcherPreparation === work) this.cancelMatcherPreparation();
        return;
      }
      if (work.next === work.records.length) {
        this.matcherPreparation = null;
        this.installPreparedMatcher(work);
      } else work.timer = setTimeout(run, 0);
    };
    work.timer = setTimeout(run, 0);
  }

  /** @private */
  prepareMatcherBatch(work, getText, deadline) {
    do {
      const ids = [],
        texts = [];
      const end = Math.min(work.records.length, work.next + 64);
      for (; work.next < end; work.next++) {
        const record = work.records[work.next];
        ids.push(work.next);
        texts.push(getText(record.item));
        work.ids.set(record.id, work.next);
      }
      work.matcher.fuzzyMatcher.addCandidates(ids, texts);
    } while (work.next < work.records.length && performance.now() < deadline);
  }

  /** @private */
  installPreparedMatcher(work) {
    this.filterMatcher = work.matcher;
    this.filterMatcherIds = work.ids;
    this.filterMatcherIgnoresDiacritics = work.ignoreDiacritics;
    this.filterMatcherGeneration = work.generation;
    this.filterMatcherFirst = work.records[0];
  }

  /** @category Filtering */

  /**
   * @public
   * @status experimental
   *
   * Returns the filter key for an item.
   * @param {*} item - A source item.
   * @returns {String|null}
   */
  getFilterKey(item) {
    // The sentinel never matches a query and has no consumer-facing key.
    if (item === SHOW_MORE_ITEM) return null;

    return this.model.getFilterText(item);
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the match indices for an item, computing lazily if needed.
   * Match indices indicate which characters in the filter key matched the query.
   * @param {*} item - A source item.
   * @param {String} [filterKey] - Use this filter text instead of deriving it from the item.
   * @returns {Array<Number>|null}
   */
  getMatchIndices(item, filterKey) {
    const itemId = this.getItemId(item);
    // Use provided filterKey or get from item
    if (!filterKey) {
      filterKey = this.getFilterKey(item);
    }
    const cached = this.matchIndicesMap?.get(itemId);
    if (cached?.text === filterKey) return cached.indexes;

    const matchQuery = this.getParsedQuery().text;
    if (!filterKey || !matchQuery) {
      return null;
    }

    // Match the original display text so expanding folds preserve its offsets.
    const ignoreDiacritics = !!this.props.search?.ignoreDiacritics;
    const options = { algorithm: this.props.search?.algorithm, ignoreDiacritics };
    const id = this.filterMatcherIds?.get(itemId);
    const prepared =
      id !== undefined &&
      this.filterMatcherGeneration === this.model.getGeneration() &&
      filterKey === this.getFilterKey(item);
    const indexes = prepared
      ? this.filterMatcher.getMatchIndexes(id, matchQuery, options)
      : (fuzzyMatcher.match(filterKey, matchQuery, { ...options, recordMatchIndexes: true })
          ?.matchIndexes ?? null);
    this.matchIndicesMap?.set(itemId, { text: filterKey, indexes });
    return indexes;
  }

  /** @category Selection */

  /**
   * @public
   * @status experimental
   *
   * Return the selected package item, or null.
   * @returns {*} The selected source item, or null when no item is selected.
   */
  getSelectedItem() {
    return this.showMoreSelected ? null : this.model.getSelectedItem();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the stable ID of the selected item, or null.
   * @returns {*} The selected non-null primitive stable ID, or null when none is selected.
   */
  getSelectedItemId() {
    return this.showMoreSelected ? null : this.model.getSelectedId();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the selected filtered index, or null.
   * @returns {Number|null}
   */
  getSelectedIndex() {
    if (this.showMoreSelected) return null;
    const index = this.model.getSelectedIndex();
    return index < 0 ? null : index;
  }

  selectedItemRaw() {
    if (this.showMoreSelected) return SHOW_MORE_ITEM;
    return this.model.getSelectedItem();
  }

  /**
   * Resolves the element for an item.
   * If renderItem returns an HTML element, uses it directly.
   * If it returns a descriptor object, builds the row from it and hands the
   * result to the descriptor's `didRender`, so a caller can decorate a row it
   * did not build — apply an icon, set a dataset key — without owning the markup.
   * @param {*} item - The item to get an element for
   * @param {Object} opts - Options passed to renderItem
   * @returns {HTMLElement} The resolved element
   * @private
   */
  resolveElement(item, opts) {
    // The component renders its own last row; the consumer's renderer never
    // sees the sentinel.
    if (item === SHOW_MORE_ITEM) {
      return createTwoLineItem({ primary: "Show more…", className: "show-more-item" });
    }
    const renderItem = this.props.renderItem;
    const result = renderItem
      ? renderItem(item, opts)
      : { primary: opts.highlight(opts.filterKey) };
    if (result?.nodeType === 1 && result.ownerDocument) {
      return result;
    }
    if (result?.element?.nodeType === 1 && result.element.ownerDocument) {
      if (result.destroy != null && typeof result.destroy !== "function") {
        throw new TypeError("A custom row view destroy property must be a function.");
      }
      result.element[ROW_VIEW] = result;
      return result.element;
    }
    const element = createTwoLineItem(result);
    const disposable = result.didRender?.(element);
    if (disposable != null && typeof disposable.dispose !== "function") {
      throw new TypeError("renderItem.didRender must return a Disposable or nothing.");
    }
    if (disposable) element[ROW_DISPOSABLE] = disposable;
    return element;
  }

  renderItemAtIndex(index) {
    if (!this.listItems || index < 0 || index >= this.listItems.length) return;
    const item = this.items[index];
    const record = this.displayedRecords[index];
    const selected =
      item === SHOW_MORE_ITEM
        ? this.showMoreSelected
        : Object.is(this.model.getSelectedId(), record.id);
    const filterKey = this.getFilterKey(item);
    const opts = { selected, index, filterKey };
    // Lazy getter - matchIndices only computed when accessed
    Object.defineProperty(opts, "matchIndices", {
      get: () => this.getMatchIndices(item, filterKey),
      enumerable: true,
    });
    opts.highlight = (text, indices = opts.matchIndices) => highlightMatches(text, indices);
    const component = this.listItems[index].component;
    component.update({
      element: this.prepareItemElement(this.resolveElement(item, opts), index, selected),
      selected: selected,
      revealSelection: true,
      onclick: (event) => this.didClickItem(index, event),
      onmiddleclick: () => this.selectIndex(index),
      oncontextmenu: () => this.didContextMenuItem(index),
    });
  }

  // With an allowed empty selection, that state sits between the two ends
  // of the cycle: stepping off either end returns to it, and stepping again
  // enters the list at the far end. Without it the ends wrap straight into
  // each other, since there is no empty state to pass through. Only these two
  // route through the empty selection — `selectFirst`/`selectLast` are asked
  // for an end by name, and give it.
  /**
   * @public
   * @status experimental
   *
   * Select the previous item, respecting the optional empty state.
   * @returns {Promise<void|Boolean>}
   */
  selectPrevious() {
    if (this.selectionIndex === undefined) return this.selectLast();
    if (this.allowsEmptySelectionAt(0)) return this.selectNone();
    return this.selectIndexOrShowMore(this.selectionIndex - 1);
  }

  /**
   * @public
   * @status experimental
   *
   * Select the next item, revealing another page when needed.
   * @returns {Promise<void|Boolean>}
   */
  selectNext() {
    if (this.showMoreSelected) return this.showMore({ followSelection: true });
    if (this.selectionIndex === undefined) return this.selectFirst();
    if (this.allowsEmptySelectionAt(this.items.length - 1)) return this.selectNone();
    return this.selectIndexOrShowMore(this.selectionIndex + 1);
  }

  /**
   * Whether a move from the current selection should empty it rather than
   * carry on. False while a "Show more…" row is the end being stepped off:
   * revealing the rest of the matches comes before leaving the list.
   * @param {number} edge - The index the move would step off
   * @returns {boolean} Whether to empty the selection instead
   * @private
   */
  allowsEmptySelectionAt(edge) {
    return (
      !this.showMoreSelected &&
      this.props.selection?.allowEmpty === true &&
      this.selectionIndex === edge
    );
  }

  /**
   * @public
   * @status experimental
   *
   * Select the first matching item.
   * @returns {Promise<void|Boolean>} Resolves after selection or after revealing another page.
   */
  selectFirst() {
    return this.selectIndexOrShowMore(0);
  }

  /**
   * @public
   * @status experimental
   *
   * Select the last item in the displayed page.
   * @returns {Promise<void|Boolean>} Resolves after selection or after revealing another page.
   */
  selectLast() {
    return this.selectIndexOrShowMore(this.items.length - 1);
  }

  // Keyboard navigation never has to press the button: the moment the
  // selection would land on the "Show more…" row, the list expands in place
  // instead and the selection continues into the first newly revealed item.
  // Only the navigation methods route through here — a mouse click must keep
  // its select-then-confirm order, where the confirm does the expanding.
  selectIndexOrShowMore(index) {
    let target = index;
    if (target >= this.items.length) {
      target = 0;
    } else if (target < 0) {
      target = this.items.length - 1;
    }
    if (this.items[target] === SHOW_MORE_ITEM) {
      return this.showMore({ followSelection: true });
    }
    return this.selectIndex(index);
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the logical selection.
   * @returns {Promise<void>}
   */
  selectNone() {
    return this.selectIndex(undefined);
  }

  /**
   * @public
   * @status experimental
   *
   * Select an item by its displayed index.
   * @param {Number|undefined} index - Displayed index, or undefined to clear selection; out-of-bounds indices wrap.
   * @param {Boolean} [updateComponent=true] - Schedule rendering when true.
   * @param {String} [reason="programmatic"] - Included in the selection-change event.
   * @returns {Promise<void>}
   */
  selectIndex(index, updateComponent = true, reason = "programmatic") {
    const previous = this.selectionSnapshot();
    if (this.items.length === 0 || index === undefined) {
      this.model.selectNone();
      this.showMoreSelected = false;
    } else {
      let target = index;
      if (target >= this.items.length) target = 0;
      if (target < 0) target = this.items.length - 1;
      if (this.items[target] === SHOW_MORE_ITEM) {
        this.model.selectNone();
        this.showMoreSelected = true;
      } else {
        this.model.selectIndex(target);
        this.showMoreSelected = false;
      }
    }

    this.syncModelState();
    this.publishSelectionChange(previous, reason);
    this.refreshItemActionsIndicator();

    if (updateComponent) {
      if (this.listItems) {
        if (previous.uiIndex >= 0) this.renderItemAtIndex(previous.uiIndex);
        if (this.selectionIndex >= 0) this.renderItemAtIndex(this.selectionIndex);
        return etch.getScheduler().getNextUpdatePromise();
      } else {
        return this.updateComponent();
      }
    } else {
      return Promise.resolve();
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Select an item by value or object identity.
   * @param {*} item - A source item.
   * @returns {Promise<void>}
   */
  selectItem(item) {
    const previous = this.selectionSnapshot();
    const previousDisplayedCount = this.model.getDisplayedCount();
    this.model.selectItem(item);
    this.showMoreSelected = false;
    this.syncModelState();
    this.publishSelectionChange(previous);
    this.refreshItemActionsIndicator();
    if (this.model.getDisplayedCount() !== previousDisplayedCount || !this.listItems) {
      this.resetRenderedItems();
      return this.updateComponent();
    }
    if (previous.uiIndex >= 0) this.renderItemAtIndex(previous.uiIndex);
    if (this.selectionIndex >= 0) this.renderItemAtIndex(this.selectionIndex);
    return etch.getScheduler().getNextUpdatePromise();
  }

  /**
   * @public
   * @status experimental
   *
   * Select an item by stable ID.
   * @param {*} id - A non-null primitive item ID; throws when absent from the source.
   * @returns {Promise<void>}
   */
  selectItemById(id) {
    const item = this.model.getItemById(id);
    if (item == null)
      throw new Error("Cannot select the specified item because its id does not exist.");
    return this.selectItem(item);
  }

  /** @category Scrolling */

  /**
   * @public
   * @status experimental
   *
   * Return the list viewport's vertical scroll offset.
   * @returns {Number}
   */
  getScrollTop() {
    return this.component?.refs?.items?.scrollTop ?? 0;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the list viewport's vertical scroll offset.
   * @param {Number} scrollTop - Vertical offset in pixels; has no effect before materialization.
   * @returns {void}
   */
  setScrollTop(scrollTop) {
    if (this.component?.refs?.items) this.component.refs.items.scrollTop = scrollTop;
  }

  /**
   * @public
   * @status experimental
   *
   * Select and reveal an item or stable ID.
   * @param {*} itemOrId - A source item or its non-null primitive stable ID.
   * @returns {Boolean}
   */
  scrollToItem(itemOrId) {
    try {
      if (this.model.getItems().includes(itemOrId)) this.selectItem(itemOrId);
      else this.selectItemById(itemOrId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Reveal the currently selected row.
   * @returns {Boolean}
   */
  scrollToSelectedItem() {
    if (this.selectionIndex == null || !this.listItems?.[this.selectionIndex]) return false;
    this.listItems[this.selectionIndex].component.scrollIntoViewIfNeeded();
    return true;
  }

  /** @category Pagination */

  /**
   * @public
   * @status experimental
   *
   * Return whether another result page remains.
   * @returns {Boolean}
   */
  hasMoreItems() {
    return this.model.hasMore();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the number of matches beyond the displayed page.
   * @returns {Number}
   */
  getRemainingItemCount() {
    return Math.max(0, this.getMatchCount() - this.getDisplayedItems().length);
  }

  /**
   * @public
   * @status experimental
   *
   * Collapse displayed results to the first page.
   * @returns {Promise<void>}
   */
  resetDisplayedItemLimit() {
    const previousSelection = this.selectionSnapshot();
    this.model.resetDisplayLimit();
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "pagination");
    return this.updateComponent();
  }

  /** @category Recent Items */

  /**
   * @public
   * @status experimental
   *
   * Return recent item IDs in most-recent-first order.
   * @returns {Array<*>}
   */
  getRecentItemIds() {
    return this.model.getRecentIds();
  }

  /**
   * @public
   * @status experimental
   *
   * Replace and optionally persist recent item IDs.
   * @param {Array<*>} recentIds - Non-null primitive item IDs in most-recent-first order.
   * @param {Object} [options] - Persistence options.
   * @param {Boolean} [options.persist=true] - Save through the configured recents adapter.
   * @returns {Promise<SelectList>}
   */
  setRecentItemIds(recentIds, options = {}) {
    return this.setRecentItemIdsWithChange(recentIds, { type: "replace" }, options);
  }

  /** @private */
  async setRecentItemIdsWithChange(recentIds, change, { persist = true } = {}) {
    if (!Array.isArray(recentIds)) throw new TypeError("Recent item IDs must be an array.");
    const limit = this.getRecentLimit();
    const normalized = Array.from(new Set(recentIds)).slice(0, limit);
    const update = this.update({ recentItemIds: normalized });
    const revision = this.recentRevision;
    const metadata = Object.freeze({ ...change, limit });
    const save =
      persist && this.recentConfiguration
        ? this.saveRecentItemIds(normalized, metadata)
        : Promise.resolve();
    const [, committed] = await Promise.all([update, save]);
    if (Array.isArray(committed) && !this.destroyed && revision === this.recentRevision)
      await this.setRecentItemIds(committed, { persist: false });
    return this;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the configured maximum recent item count.
   * @returns {Number}
   */
  getRecentLimit() {
    return this.recentConfiguration?.limit ?? Infinity;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the maximum recent item count and trim persisted state.
   * @param {Number} limit - A non-negative integer or Infinity. Requires a configured recents adapter.
   * @returns {Promise<SelectList>}
   */
  setRecentLimit(limit) {
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("The recent item limit must be a non-negative integer.");
    }
    if (!this.recentConfiguration) {
      throw new Error("Cannot set a recent item limit without a recents adapter.");
    }
    this.recentConfiguration.limit = limit;
    return this.setRecentItemIdsWithChange(this.getRecentItemIds(), { type: "limit" });
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether an item or stable ID is recent.
   * @param {*} itemOrId - A source item or its non-null primitive stable ID.
   * @returns {Boolean}
   */
  isRecentItem(itemOrId) {
    const id = this.model.getItems().includes(itemOrId) ? this.model.getItemId(itemOrId) : itemOrId;
    return this.getRecentItemIds().includes(id);
  }

  /**
   * @public
   * @status experimental
   *
   * Move an item to the front of the recent section.
   * @param {*} item - A source item.
   * @returns {Promise<SelectList>}
   */
  recordRecentItem(item) {
    const id = this.getItemId(item);
    const recentIds = this.getRecentItemIds().filter((candidate) => candidate !== id);
    recentIds.unshift(id);
    return this.setRecentItemIdsWithChange(recentIds, { type: "record", id });
  }

  /**
   * @public
   * @status experimental
   *
   * Remove an item from the recent section.
   * @param {*} itemOrId - A source item or its non-null primitive stable ID.
   * @returns {Promise<SelectList>}
   */
  removeRecentItem(itemOrId) {
    const id = this.model.getItems().includes(itemOrId) ? this.model.getItemId(itemOrId) : itemOrId;
    return this.setRecentItemIdsWithChange(
      this.getRecentItemIds().filter((candidate) => candidate !== id),
      { type: "remove", id },
    );
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the recent section.
   * @returns {Promise<SelectList>}
   */
  clearRecentItems() {
    return this.setRecentItemIdsWithChange([], { type: "clear" });
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when recent item IDs change.
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {SelectList} callback.event.list
   * @param {Array<*>} callback.event.recentItemIds
   * @returns {Disposable} Dispose to unsubscribe.
   * @category Event Subscription
   */
  onDidChangeRecentItemIds(callback) {
    return this.emitter.on("did-change-recent-item-ids", callback);
  }

  /** @category Confirmation */

  /**
   * @public
   * @status experimental
   *
   * Confirms the current selection through the applicable primary action, or
   * emits the corresponding confirmation event when none is declared.
   * @returns {Promise<Object|Boolean>|undefined} Primary action completion, a paging result for the Show more row, or undefined after a confirmation event.
   */
  confirmSelection() {
    if (this.selectedItemRaw() === SHOW_MORE_ITEM) {
      return this.showMore();
    }
    const selectedItem = this.getSelectedItem();
    const primary = this.dialogActions.getPrimary(this.getActionContext("primary"));
    if (primary) return this.runAction(primary.command, { source: "primary" });
    if (selectedItem != null) {
      this.emitter.emit("did-confirm-selection", {
        list: this,
        item: selectedItem,
        itemId: this.getItemId(selectedItem),
      });
    } else {
      this.emitter.emit("did-confirm-empty-selection", { list: this });
    }
  }

  /** @category Event Subscription */

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when confirmation has no primary item action.
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {SelectList} callback.event.list
   * @param {*} callback.event.item - The selected source item, or null for a selection-change event.
   * @param {*} callback.event.itemId - Its stable ID, or null.
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidConfirmSelection(callback) {
    return this.emitter.on("did-confirm-selection", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when an empty selection is confirmed.
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {SelectList} callback.event.list
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidConfirmEmptySelection(callback) {
    return this.emitter.on("did-confirm-empty-selection", callback);
  }
}

/** @private */
class ListItemView {
  constructor(props) {
    this.mouseDown = this.mouseDown.bind(this);
    this.mouseUp = this.mouseUp.bind(this);
    this.didClick = this.didClick.bind(this);
    this.didContextMenu = this.didContextMenu.bind(this);
    this.selected = props.selected;
    this.onclick = props.onclick;
    this.onmiddleclick = props.onmiddleclick;
    this.oncontextmenu = props.oncontextmenu;
    this.element = props.element;
    this.element.addEventListener("mousedown", this.mouseDown);
    this.element.addEventListener("mouseup", this.mouseUp);
    this.element.addEventListener("click", this.didClick);
    this.element.addEventListener("contextmenu", this.didContextMenu);
    if (this.selected) {
      this.element.classList.add("selected");
    }
    this.domEventsDisposable = new Disposable(() => {
      this.element.removeEventListener("mousedown", this.mouseDown);
      this.element.removeEventListener("mouseup", this.mouseUp);
      this.element.removeEventListener("click", this.didClick);
      this.element.removeEventListener("contextmenu", this.didContextMenu);
    });
    etch.getScheduler().updateDocument(this.scrollIntoViewIfNeeded.bind(this));
  }

  mouseDown(event) {
    event.preventDefault();
    if (event.button === 1) {
      this.onmiddleclick();
    }
  }

  mouseUp(event) {
    event.preventDefault();
  }

  didClick(event) {
    event.preventDefault();
    this.onclick(event);
  }

  didContextMenu(event) {
    if (!this.oncontextmenu()) return;
    event.preventDefault();
    event.stopPropagation();
  }

  destroy() {
    this.releaseElement();
    this.element.remove();
    this.domEventsDisposable.dispose();
  }

  update(props) {
    const previousElement = this.element;
    const parent = previousElement.parentNode;
    const nextSibling = previousElement.nextSibling;
    this.element.removeEventListener("mousedown", this.mouseDown);
    this.element.removeEventListener("mouseup", this.mouseUp);
    this.element.removeEventListener("click", this.didClick);
    this.element.removeEventListener("contextmenu", this.didContextMenu);

    this.releaseElement();
    if (parent) {
      if (previousElement.parentNode === parent) {
        parent.replaceChild(props.element, previousElement);
      } else {
        parent.insertBefore(props.element, nextSibling?.parentNode === parent ? nextSibling : null);
      }
    }
    this.element = props.element;
    this.element.addEventListener("mousedown", this.mouseDown);
    this.element.addEventListener("mouseup", this.mouseUp);
    this.element.addEventListener("click", this.didClick);
    this.element.addEventListener("contextmenu", this.didContextMenu);
    if (props.selected) {
      this.element.classList.add("selected");
    } else {
      this.element.classList.remove("selected");
    }

    this.selected = props.selected;
    this.onclick = props.onclick;
    this.onmiddleclick = props.onmiddleclick;
    this.oncontextmenu = props.oncontextmenu;
    if (props.revealSelection) {
      etch.getScheduler().updateDocument(this.scrollIntoViewIfNeeded.bind(this));
    }
  }

  scrollIntoViewIfNeeded() {
    if (this.selected) {
      this.element.scrollIntoViewIfNeeded(false);
    }
  }

  releaseElement() {
    const rowView = this.element[ROW_VIEW];
    const disposable = this.element[ROW_DISPOSABLE];
    delete this.element[ROW_VIEW];
    delete this.element[ROW_DISPOSABLE];
    rowView?.destroy?.();
    disposable?.dispose();
  }
}

module.exports = SelectList;
