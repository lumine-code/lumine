"use strict";

const { Disposable } = require("@lumine-code/event-kit");
const etch = require("@lumine-code/etch");
const InputDialog = require("./input-dialog");
const SelectListComponent = require("./select-list-component");
const SelectListModel = require("./select-list-model");
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
 * Fuzzy-searchable select list. Extends InputDialog — which owns the
 * modal panel, query editor, focus handling, and confirm/cancel commands —
 * with items, filtering, selection, and list rendering.
 */
class SelectList extends InputDialog {
  createComponent() {
    return new SelectListComponent(this);
  }

  initializeState() {
    this.showMoreSelected = false;
    this.listBoxId = `select-list-${nextSelectListId++}`;
    this.itemDomIds = new Map();
    this.recentBoundaryIndex = -1;
    this.matchIndicesMap = new Map();
    this.filterMatcher = null;
    this.filterMatcherGeneration = null;
    this.indexMatcher = null;
    this.indexMatcherIgnoresDiacritics = null;
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
    this.syncModelState();
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
    this.dialogActions.set(this.actionsForCatalog(this.props.actions ?? []));
  }

  actionsForCatalog(actions) {
    if (this.recentActionDescriptors.length === 0) return actions;
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
    const providerCommands = new Set(this.recentActionDescriptors.map(({ command }) => command));
    entries = entries.filter((entry) => {
      const command = Array.isArray(entry) ? entry[0] : entry?.command;
      return !providerCommands.has(command);
    });
    return [...entries, ...this.recentActionDescriptors];
  }

  commandsForRegistration(commands) {
    if (this.recentActionDescriptors.length === 0) return commands;
    if (commands != null && (typeof commands !== "object" || Array.isArray(commands))) {
      return commands;
    }
    for (const command of Object.keys(this.recentCommandDescriptors)) {
      if (Object.prototype.hasOwnProperty.call(commands ?? {}, command)) {
        throw new Error(`Dialog command '${command}' is reserved by the recents provider.`);
      }
    }
    return { ...(commands ?? {}), ...this.recentCommandDescriptors };
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

  saveRecentItemIds(recentIds) {
    const save = () => {
      try {
        return Promise.resolve(this.recentConfiguration.adapter.save(recentIds));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const operation = this.recentSaveQueue
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
    this.component.refs.queryEditor.element.setAttribute("role", "combobox");
    this.component.refs.queryEditor.element.setAttribute("aria-autocomplete", "list");
    this.updateComboboxAttributes();
    this.updateActiveDescendant();
  }

  didShowPanel() {
    super.didShowPanel();
    this.updateComboboxAttributes();
  }

  didHidePanel(options) {
    super.didHidePanel(options);
    this.updateComboboxAttributes();
  }

  didSuspendPanel() {
    this.updateComboboxAttributes();
  }

  /**
   * @public
   * @status experimental
   *
   * Destroys the select list and cleans up resources.
   * @returns {Promise} Resolves when destruction is complete
   */
  async destroy() {
    this.filterMatcher = null;
    this.indexMatcher = null;
    await super.destroy();
    this.model = null;
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
    const updatePromise = this.component.update();
    return Promise.all([sourcePromise, updatePromise]).then(() => undefined);
  }

  modelQuery(query, props = this.props) {
    return props.source?.mode === "query" ? "" : this.parseQuery(query, props).text;
  }

  syncModelState() {
    this.processedQuery = this.model.getQuery();
    this.filteredItems = this.model.getFilteredItems();
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

    const allRecords = this.model._getFilteredRecords();
    let recentCount = 0;
    while (recentCount < allRecords.length && allRecords[recentCount].recent) recentCount++;
    this.recentBoundaryIndex =
      recentCount > 0 && recentCount < this.displayedRecords.length ? recentCount : -1;
    this.updateComboboxAttributes();
    this.updateActiveDescendant();
  }

  updateComboboxAttributes() {
    const editorElement = this.component?.refs?.queryEditor?.element;
    if (!editorElement) return;
    const hasListbox = (this.items?.length ?? 0) > 0;
    if (hasListbox) editorElement.setAttribute("aria-controls", this.listBoxId);
    else editorElement.removeAttribute("aria-controls");
    editorElement.setAttribute("aria-expanded", String(this.isVisible() && hasListbox));
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
    const editorElement = this.component?.refs?.queryEditor?.element;
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

  cancel(reason) {
    return this.cancelSelection(reason);
  }

  getActionContext(source = "api") {
    const context = super.getActionContext(source);
    const item = this.getSelectedItem();
    return {
      ...context,
      list: this,
      item,
      itemId: this.getSelectedItemId(),
      items: this.getItems(),
    };
  }

  getActionItemId(item) {
    return this.getItemId(item);
  }

  resolveActionItemById(id) {
    return this.model?.getItemById(id) ?? null;
  }

  recordActionRecent({ item }) {
    if (item != null) {
      return this.recordRecentItem(item).catch((error) => this.didFailRecents(error));
    }
  }

  updateProps(props) {
    const previousSelection = this.selectionSnapshot();
    const nextProps = { ...this.props, ...props };
    const modelChanges = {};
    const itemsChanged = "items" in props || "sections" in props;
    const recentItemIdsChanged = "recentItemIds" in props;
    const identityChanged = "getItemId" in props;
    const searchChanged = "search" in props;

    if ("items" in props) modelChanges.items = props.items;
    if ("sections" in props) modelChanges.sections = props.sections;

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
    if (changesModel) this.model.update(modelChanges);

    const listProps = [
      "items",
      "sections",
      "getItemId",
      "search",
      "renderItem",
      "recentItemIds",
      "selection",
      "emptyMessage",
      "itemsClassList",
    ];
    for (const key of listProps) {
      if (key in props) this.props[key] = props[key];
    }
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

    if (changesModel || "selection" in props || props.itemUpdateOptions) {
      this.showMoreSelected = false;
      this.resetRenderedItems();
      this.syncModelState();
      this.publishSelectionChange(previousSelection, itemsChanged ? "items" : "update");
    }

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
    return this.renderItems();
  }

  /**
   * @public
   * @status experimental
   *
   * Return a snapshot of all source items.
   */
  getItems() {
    return this.model.getItems();
  }

  /**
   * @public
   * @status experimental
   *
   * Return all items in current filtered order.
   */
  getFilteredItems() {
    return this.model.getFilteredItems();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the currently displayed page without UI rows.
   */
  getDisplayedItems() {
    return this.model.getDisplayedItems();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the number of source items.
   */
  getItemCount() {
    return this.model.getItems().length;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the number of filtered matches.
   */
  getMatchCount() {
    return this.model.getFilteredItems().length;
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when source items change.
   */
  onDidChangeItems(callback) {
    return this.emitter.on("did-change-items", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the logical selection changes.
   */
  onDidChangeSelection(callback) {
    return this.emitter.on("did-change-selection", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Replace a flat item source while preserving selection by default.
   */
  setItems(items, options = {}) {
    return this.update({ items, itemUpdateOptions: options });
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the source with explicitly grouped sections.
   */
  setSections(sections, options = {}) {
    return this.update({ sections, itemUpdateOptions: options });
  }

  /**
   * @public
   * @status experimental
   *
   * Re-render the current source after items changed in place.
   */
  refresh(options = {}) {
    return "sections" in this.props
      ? this.update({ sections: this.props.sections, itemUpdateOptions: options })
      : this.setItems(this.model.getItems(), options);
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the stable identifier used by the model for an item. Object
   * items default to their `id` property; primitive items identify themselves.
   * @param {*} item - The item to identify
   * @returns {*} The item's identifier
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
          onclick: () => this.didClickItem(index),
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
              "aria-hidden": "true",
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
      this.model.update({ query: this.modelQuery(this.getQuery()) });
      this.showMoreSelected = false;
      this.resetRenderedItems();
      this.syncModelState();
    }
    super.didChangeQuery();
    if (previousSelection) this.publishSelectionChange(previousSelection, "query");
    if (this.model) this.component.update();
  }

  didClickItem(itemIndex) {
    this.selectIndex(itemIndex);
    this.consumeUiAction(this.confirmSelection());
  }

  didContextMenuItem(itemIndex) {
    this.selectIndex(itemIndex);
    const available = this.hasAvailableActions(this.getActionContext("context-menu"));
    if (!available) return false;
    this.consumeUiAction(this.showActions());
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
   * @param {Object} [options]
   * @param {boolean} [options.followSelection] - Let the selection's own
   *   scroll-into-view stand instead of restoring the previous position
   * @returns {Promise} Resolves when the expanded list has rendered
   */
  async showMore({ followSelection = false } = {}) {
    if (!this.model.hasMore()) return false;
    const previousSelection = this.selectionSnapshot();
    const revealIndex = this.model.getDisplayedCount();
    const scroller = this.component.refs.items;
    const scrollTop = scroller ? scroller.scrollTop : 0;

    this.model.showMore();
    this.model.selectIndex(revealIndex);
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "pagination");
    await this.component.update();

    // The ol persists across the update, and the selection's own
    // scroll-into-view runs inside it; putting the viewport back last is what
    // makes the pressed-button paths stable.
    if (!followSelection && this.component.refs.items) {
      this.component.refs.items.scrollTop = scrollTop;
    }
    return true;
  }

  matchCandidates(candidates, query, context, options) {
    const filterTexts = candidates.map((candidate) => candidate.filterText);
    if (this.filterMatcherGeneration !== context.generation) {
      this.filterMatcher = fuzzyMatcher.setCandidates(filterTexts, {
        ignoreDiacritics: !!options.ignoreDiacritics,
      });
      this.filterMatcherGeneration = context.generation;
    }
    const matchOptions = {
      recordMatchIndexes: false,
    };
    if (options.algorithm) matchOptions.algorithm = options.algorithm;
    const results = this.filterMatcher.match(query, matchOptions);
    const modifyScore = options.scoreModifier;
    const scoredCandidates = [];
    for (const result of results) {
      const candidate = candidates[result.id];
      let score = result.score;
      if (modifyScore) {
        score = modifyScore(score, candidate.item);
      }
      if (score > 0) {
        scoredCandidates.push({ candidate, score });
      }
    }
    if (modifyScore) {
      scoredCandidates.sort((left, right) => right.score - left.score);
    }
    return scoredCandidates.map(({ candidate }) => candidate);
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the filter key for an item.
   * @param {*} item - The item to get the filter key for
   * @returns {string|null} The filter key string, or null
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
   * @param {*} item - The item to get match indices for
   * @param {string} [filterKey] - Optional filter key override. If not provided,
   *   uses the filter text cached by the list model.
   * @returns {number[]|null} Array of character indices that matched, or null
   */
  getMatchIndices(item, filterKey) {
    const itemId = this.getItemId(item);
    const cached = this.matchIndicesMap?.get(itemId);
    if (cached !== undefined) return cached;

    // Use provided filterKey or get from item
    if (!filterKey) {
      filterKey = this.getFilterKey(item);
    }

    const matchQuery = this.getParsedQuery().text;
    if (!filterKey || !matchQuery) {
      return null;
    }

    // Use reusable matcher for index computation. It folds diacritics the same
    // way as the filter matcher so indexes map back to the original filterKey.
    const ignoreDiacritics = !!this.props.search?.ignoreDiacritics;
    if (!this.indexMatcher || this.indexMatcherIgnoresDiacritics !== ignoreDiacritics) {
      this.indexMatcher = fuzzyMatcher.setCandidates([filterKey], {
        ignoreDiacritics,
      });
      this.indexMatcherIgnoresDiacritics = ignoreDiacritics;
    } else {
      fuzzyMatcher.setCandidates(this.indexMatcher, [filterKey]);
    }

    const indexMatchOptions = {
      maxResults: 1,
      recordMatchIndexes: true,
    };
    if (this.props.search?.algorithm) indexMatchOptions.algorithm = this.props.search.algorithm;

    const results = this.indexMatcher.match(matchQuery, indexMatchOptions);

    const indexes = results.length > 0 ? results[0].matchIndexes : null;
    this.matchIndicesMap?.set(itemId, indexes);
    return indexes;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the selected package item, or null.
   */
  getSelectedItem() {
    return this.showMoreSelected ? null : this.model.getSelectedItem();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the stable ID of the selected item, or null.
   */
  getSelectedItemId() {
    return this.showMoreSelected ? null : this.model.getSelectedId();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the selected filtered index, or null.
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
    if (result instanceof HTMLElement) {
      return result;
    }
    if (result?.element instanceof HTMLElement) {
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
      onclick: () => this.didClickItem(index),
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
   */
  selectFirst() {
    return this.selectIndexOrShowMore(0);
  }

  /**
   * @public
   * @status experimental
   *
   * Select the last item in the displayed page.
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
   */
  selectNone() {
    return this.selectIndex(undefined);
  }

  /**
   * @public
   * @status experimental
   *
   * Select an item by its displayed index.
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
        return this.component.update();
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
      return this.component.update();
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
   */
  selectItemById(id) {
    const item = this.model.getItemById(id);
    if (item == null)
      throw new Error("Cannot select the specified item because its id does not exist.");
    return this.selectItem(item);
  }

  /**
   * @public
   * @status experimental
   *
   * Return the list viewport's vertical scroll offset.
   */
  getScrollTop() {
    return this.component.refs.items?.scrollTop ?? 0;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the list viewport's vertical scroll offset.
   */
  setScrollTop(scrollTop) {
    if (this.component.refs.items) this.component.refs.items.scrollTop = scrollTop;
  }

  /**
   * @public
   * @status experimental
   *
   * Select and reveal an item or stable ID.
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
   */
  scrollToSelectedItem() {
    if (this.selectionIndex == null || !this.listItems?.[this.selectionIndex]) return false;
    this.listItems[this.selectionIndex].component.scrollIntoViewIfNeeded();
    return true;
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether another result page remains.
   */
  hasMoreItems() {
    return this.model.hasMore();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the number of matches beyond the displayed page.
   */
  getRemainingItemCount() {
    return Math.max(0, this.getMatchCount() - this.getDisplayedItems().length);
  }

  /**
   * @public
   * @status experimental
   *
   * Collapse displayed results to the first page.
   */
  resetDisplayedItemLimit() {
    const previousSelection = this.selectionSnapshot();
    this.model.resetDisplayLimit();
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "pagination");
    return this.component.update();
  }

  /**
   * @public
   * @status experimental
   *
   * Return recent item IDs in most-recent-first order.
   */
  getRecentItemIds() {
    return this.model.getRecentIds();
  }

  /**
   * @public
   * @status experimental
   *
   * Replace and optionally persist recent item IDs.
   */
  async setRecentItemIds(recentIds, { persist = true } = {}) {
    if (!Array.isArray(recentIds)) throw new TypeError("Recent item IDs must be an array.");
    const limit = this.getRecentLimit();
    const normalized = Array.from(new Set(recentIds)).slice(0, limit);
    const update = this.update({ recentItemIds: normalized });
    const save =
      persist && this.recentConfiguration ? this.saveRecentItemIds(normalized) : Promise.resolve();
    await Promise.all([update, save]);
    return this;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the configured maximum recent item count.
   */
  getRecentLimit() {
    return this.recentConfiguration?.limit ?? Infinity;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the maximum recent item count and trim persisted state.
   */
  setRecentLimit(limit) {
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("The recent item limit must be a non-negative integer.");
    }
    if (!this.recentConfiguration) {
      throw new Error("Cannot set a recent item limit without a recents adapter.");
    }
    this.recentConfiguration.limit = limit;
    return this.setRecentItemIds(this.getRecentItemIds());
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether an item or stable ID is recent.
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
   */
  recordRecentItem(item) {
    const id = this.getItemId(item);
    const recentIds = this.getRecentItemIds().filter((candidate) => candidate !== id);
    recentIds.unshift(id);
    return this.setRecentItemIds(recentIds);
  }

  /**
   * @public
   * @status experimental
   *
   * Remove an item from the recent section.
   */
  removeRecentItem(itemOrId) {
    const id = this.model.getItems().includes(itemOrId) ? this.model.getItemId(itemOrId) : itemOrId;
    return this.setRecentItemIds(this.getRecentItemIds().filter((candidate) => candidate !== id));
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the recent section.
   */
  clearRecentItems() {
    return this.setRecentItemIds([]);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when recent item IDs change.
   */
  onDidChangeRecentItemIds(callback) {
    return this.emitter.on("did-change-recent-item-ids", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Confirms the current selection through the applicable primary action, or
   * emits the corresponding confirmation event when none is declared.
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

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when confirmation has no primary item action.
   */
  onDidConfirmSelection(callback) {
    return this.emitter.on("did-confirm-selection", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when an empty selection is confirmed.
   */
  onDidConfirmEmptySelection(callback) {
    return this.emitter.on("did-confirm-empty-selection", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Cancels the selection, hides the list, and emits `onDidCancel`.
   */
  cancelSelection(reason = "api") {
    if (this.canceling || this.destroyed) return;
    this.canceling = true;
    this.hide();
    this.finalizeSuspendedHide();
    this.emitter.emit("did-cancel", { dialog: this, reason });
    this.canceling = false;
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
    this.onclick();
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
    etch.getScheduler().updateDocument(this.scrollIntoViewIfNeeded.bind(this));
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
