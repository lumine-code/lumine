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
// `maxResults` changes the batch size, it no longer means "drop the rest".
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
    this.legacyItemIds = new WeakMap();
    this.legacyItemIdSequence = 0;
    this.showMoreSelected = false;
    this.listBoxId = `select-list-${nextSelectListId++}`;
    this.itemDomIds = new Map();
    this.recentBoundaryIndex = -1;
    this.matchIndicesMap = new Map();
    this.filterMatcher = null;
    this.filterMatcherGeneration = null;
    this.indexMatcher = null;
    this.indexMatcherIgnoresDiacritics = null;
    this.recentConfiguration = this.normalizeRecents(this.props.recents);

    let configuredRecentIds = [];
    if (this.recentConfiguration) {
      const loaded = this.recentConfiguration.adapter.load();
      if (loaded && typeof loaded.then === "function") {
        this.recentsReady = Promise.resolve(loaded).then((recentIds) =>
          this.setRecentItemIds(recentIds ?? [], { persist: false }),
        );
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
              Promise.resolve(this.recentConfiguration.adapter.load()).then((loadedIds) =>
                this.setRecentItemIds(loadedIds ?? [], { persist: false }),
              );
            } else {
              this.setRecentItemIds(recentIds, { persist: false });
            }
          }),
        );
      }
      this.installRecentActions();
    }

    this.modelGetItemId = this.buildModelGetItemId(this.props);
    this.modelSearch = this.buildModelSearch(this.props);
    const source = Object.prototype.hasOwnProperty.call(this.props, "sections")
      ? { sections: this.props.sections }
      : { items: this.props.items ?? [] };
    this.model = new SelectListModel({
      ...source,
      getItemId: this.modelGetItemId,
      search: this.modelSearch,
      query: this.modelQuery(this.props.query ?? "", this.props),
      recentIds: this.props.recentItemIds ?? this.props.recentIds ?? configuredRecentIds,
      allowEmptySelection:
        this.props.selection?.allowEmpty === true || this.props.allowEmptySelection === true,
      pageSize: this.props.pageSize ?? this.props.maxResults ?? DEFAULT_MAX_RESULTS,
    });

    if (this.props.selection?.initial === "none") {
      this.model.selectNone();
    } else if (
      this.props.selection?.initial !== undefined &&
      this.props.selection.initial !== "first"
    ) {
      this.model.selectId(this.props.selection.initial);
    } else if (Object.prototype.hasOwnProperty.call(this.props, "initialSelectionIndex")) {
      if (this.props.initialSelectionIndex === undefined) {
        this.model.selectNone();
      } else if (this.model.getDisplayedItems().length > 0) {
        this.model.selectIndex(this.props.initialSelectionIndex);
      }
    }

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

  installRecentActions() {
    const commands = {
      ...(this.props.commands ?? {}),
      "select-list:remove-recent": {
        description: "Remove the selected item from the recent section.",
        didDispatch: (event) => this.removeRecentItem(event.detail.item),
      },
      "select-list:clear-recents": {
        description: "Clear every item from the recent section.",
        didDispatch: () => this.clearRecentItems(),
      },
    };
    const actions = [
      ...(this.props.actions ?? []),
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
    this.props.commands = commands;
    this.props.actions = actions;
    this.dialogActions.set(actions);
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
    this.component.refs.queryEditor.element.setAttribute("aria-controls", this.listBoxId);
    this.updateActiveDescendant();
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
    const getItemId = props.getItemId;
    const idForItem = props.idForItem;
    const permitsLegacyObjectIdentity = !getItemId && Boolean(props.elementForItem);
    return (item, context) => {
      if (getItemId) return getItemId(item, context);
      if (idForItem) {
        const id = idForItem(item);
        if (id !== null && id !== undefined) return id;
      }
      if (item !== null && (typeof item === "object" || typeof item === "function")) {
        if (item.id !== null && item.id !== undefined) return item.id;
        // Temporary compatibility for packages still using elementForItem with
        // anonymous object rows. New renderItem users get the model's strict
        // stable-ID contract instead.
        if (permitsLegacyObjectIdentity) {
          let id = this.legacyItemIds.get(item);
          if (!id) {
            id = Symbol(`legacy-select-list-item-${++this.legacyItemIdSequence}`);
            this.legacyItemIds.set(item, id);
          }
          return id;
        }
      }
      return item;
    };
  }

  buildModelSearch(props) {
    const explicit = typeof props.search === "function" ? { matcher: props.search } : props.search;
    const getFilterText =
      explicit && Object.prototype.hasOwnProperty.call(explicit, "getFilterText")
        ? explicit.getFilterText
        : props.filterKeyForItem;
    const filter =
      explicit && Object.prototype.hasOwnProperty.call(explicit, "filter")
        ? explicit.filter
        : props.filter;
    const sort =
      explicit && Object.prototype.hasOwnProperty.call(explicit, "sort")
        ? explicit.sort
        : props.order;
    let matcher =
      explicit && Object.prototype.hasOwnProperty.call(explicit, "matcher")
        ? explicit.matcher
        : null;

    if (!filter && !matcher) {
      const options = {
        algorithm: explicit?.algorithm ?? props.algorithm,
        removeDiacritics: explicit?.ignoreDiacritics ?? props.removeDiacritics,
        numThreads: props.numThreads,
        maxGap: props.maxGap,
        filterScoreModifier: explicit?.scoreModifier ?? props.filterScoreModifier,
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

  filterQuery(query, props = this.props) {
    return this.parseQuery(query, props).text;
  }

  parseQuery(query, props = this.props) {
    const raw = query == null ? "" : String(query);
    const parser = props.search?.parseQuery;
    let parsed;
    if (parser) {
      parsed = parser(raw);
    } else if (props.filterQuery) {
      parsed = props.filterQuery(raw);
    } else {
      parsed = raw;
    }
    if (typeof parsed === "string") return Object.freeze({ text: parsed, data: null });
    if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") {
      throw new TypeError("search.parseQuery must return a string or {text, data} object.");
    }
    return Object.freeze({ text: parsed.text, data: parsed.data ?? null });
  }

  getParsedQuery() {
    return this.parseQuery(this.getQuery());
  }

  getFilterQuery() {
    return this.getParsedQuery().text;
  }

  modelQuery(query, props = this.props) {
    return props.source?.mode === "query" ? "" : this.filterQuery(query, props);
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
    this.updateActiveDescendant();
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
    this.confirmSelection();
  }

  cancel() {
    this.cancelSelection();
  }

  /**
   * Resolves the semantic action represented by core:confirm for the current
   * item. This is display metadata for the item-actions list only: Enter keeps
   * dispatching core:confirm, including inside the actions list itself.
   * @param {*} item - The selected item, or null when the selection is empty
   * @returns {string|null} The package command whose row should display Enter
   * @private
   */
  confirmActionForItem(item) {
    if (this.selectedItemRaw() === SHOW_MORE_ITEM) return null;
    const confirmAction = this.props.confirmAction;
    if (typeof confirmAction === "function") return confirmAction(item) ?? null;
    if (typeof confirmAction === "string" && item != null) return confirmAction;
    return null;
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
    return this.getIdForItem(item);
  }

  resolveActionItemById(id) {
    const record = this.model?._recordById.get(id);
    return record?.item ?? null;
  }

  recordActionRecent({ item }) {
    if (item != null) return this.recordRecentItem(item);
  }

  updateProps(props) {
    const previousSelection = this.selectionSnapshot();
    const nextProps = { ...this.props, ...props };
    const modelChanges = {};
    const itemsChanged = "items" in props || "sections" in props;
    const recentItemIdsChanged = "recentIds" in props || "recentItemIds" in props;
    const identityChanged = "getItemId" in props || "idForItem" in props;
    const searchChanged = [
      "search",
      "filterKeyForItem",
      "filter",
      "order",
      "algorithm",
      "removeDiacritics",
      "filterScoreModifier",
      "numThreads",
      "maxGap",
    ].some((key) => key in props);

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
      modelChanges.recentIds = "recentItemIds" in props ? props.recentItemIds : props.recentIds;
    }
    if ("allowEmptySelection" in props) {
      modelChanges.allowEmptySelection = props.allowEmptySelection;
    }
    if ("selection" in props) {
      modelChanges.allowEmptySelection = props.selection?.allowEmpty === true;
    }
    if ("pageSize" in props || "maxResults" in props) {
      modelChanges.pageSize = nextProps.pageSize ?? nextProps.maxResults ?? DEFAULT_MAX_RESULTS;
    }
    if ("query" in props || "filterQuery" in props || "source" in props) {
      const query = "query" in props ? props.query : this.getQuery();
      modelChanges.query = this.modelQuery(query == null ? "" : String(query), nextProps);
    }

    const changesModel = Object.keys(modelChanges).length > 0;
    if (changesModel) this.model.update(modelChanges);

    if ("initialSelectionIndex" in props) {
      this.applyInitialSelection(props.initialSelectionIndex);
    } else if ("selection" in props && props.selection?.initial !== undefined) {
      if (props.selection.initial === "first") this.model.selectFirst();
      else if (props.selection.initial === "none") this.model.selectNone();
      else this.model.selectId(props.selection.initial);
    } else if (props.itemUpdateOptions?.selection === "first") {
      this.model.selectFirst();
    } else if (props.itemUpdateOptions?.selection === "none") {
      this.model.selectNone();
    }

    const listProps = [
      "items",
      "sections",
      "getItemId",
      "idForItem",
      "search",
      "renderItem",
      "elementForItem",
      "filterKeyForItem",
      "filter",
      "filterQuery",
      "filterScoreModifier",
      "order",
      "algorithm",
      "removeDiacritics",
      "numThreads",
      "maxGap",
      "pageSize",
      "maxResults",
      "recentIds",
      "recentItemIds",
      "initialSelectionIndex",
      "allowEmptySelection",
      "selection",
      "emptyMessage",
      "itemsClassList",
      "separatorIds",
      "confirmAction",
      "itemUpdateOptions",
    ];
    for (const key of listProps) {
      if (key in props) this.props[key] = props[key];
    }
    if ("items" in props) delete this.props.sections;
    if ("sections" in props) this.props.sections = props.sections;
    if (itemsChanged) this.props.items = this.model.getItems();
    if (recentItemIdsChanged) {
      const recentIds = this.model.getRecentIds();
      this.props.recentIds = recentIds;
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

    if (changesModel || "initialSelectionIndex" in props || props.itemUpdateOptions) {
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

  getItems() {
    return this.model.getItems();
  }

  getFilteredItems() {
    return this.model.getFilteredItems();
  }

  getDisplayedItems() {
    return this.model.getDisplayedItems();
  }

  getItemCount() {
    return this.model.getItems().length;
  }

  getMatchCount() {
    return this.model.getFilteredItems().length;
  }

  onDidChangeItems(callback) {
    return this.emitter.on("did-change-items", callback);
  }

  onDidChangeSelection(callback) {
    return this.emitter.on("did-change-selection", callback);
  }

  setItems(items, options = {}) {
    return this.update({ items, itemUpdateOptions: options });
  }

  refresh(options = {}) {
    return "sections" in this.props
      ? this.update({ sections: this.props.sections, itemUpdateOptions: options })
      : this.setItems(this.model.getItems(), options);
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the stable identifier used by separatorIds for an item. Object
   * items default to their `id` property; primitive items identify themselves.
   * @param {*} item - The item to identify
   * @returns {*} The item's identifier
   */
  getIdForItem(item) {
    const record = this.model?._recordByItem.get(item);
    if (record) return record.id;
    return this.modelGetItemId(item, {
      index: -1,
      section: null,
      sectionId: null,
      sectionIndex: -1,
      itemIndex: -1,
    });
  }

  /**
   * Returns whether a standalone separator should be rendered immediately
   * before an item.
   * @param {*} item - The item about to render
   * @returns {boolean} Whether to insert a separator
   * @private
   */
  hasSeparatorBefore(item) {
    if (item === SHOW_MORE_ITEM || !Array.isArray(this.props.separatorIds)) return false;
    // Legacy idForItem predicates sometimes return null under a query solely
    // to suppress their separator. Keep that presentation behavior separate
    // from the model's stable identity.
    const id = this.props.idForItem ? this.props.idForItem(item) : this.getIdForItem(item);
    return this.props.separatorIds.includes(id);
  }

  hasSectionSeparatorBefore(index) {
    if (index <= 0 || index >= this.displayedRecords.length) return false;
    const current = this.displayedRecords[index];
    const previous = this.displayedRecords[index - 1];
    if (current.recent || previous.recent) return false;
    return current.sectionId != null && current.sectionId !== previous.sectionId;
  }

  applyInitialSelection(index) {
    if (index === undefined || this.model.getDisplayedItems().length === 0) {
      this.model.selectNone();
      return;
    }
    const itemCount = this.model.getDisplayedItems().length;
    let target = index;
    if (target >= itemCount) target = 0;
    if (target < 0) target = itemCount - 1;
    this.model.selectIndex(target);
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
    if (this.selectionIndex !== undefined && this.props.didChangeSelection) {
      this.props.didChangeSelection(item);
    }
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
        // The recent boundary is the list's own rule and needs no `separatorIds`
        // entry; a caller that names the same row anyway still gets one line.
        const key =
          index === this.recentBoundaryIndex
            ? "separator:recent"
            : this.hasSectionSeparatorBefore(index)
              ? `separator:section:${String(this.displayedRecords[index].sectionId)}:${index}`
              : this.hasSeparatorBefore(this.items[index])
                ? `separator:${String(this.getIdForItem(this.items[index]))}`
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
    this.confirmSelection();
  }

  didContextMenuItem(itemIndex) {
    this.selectIndex(itemIndex);
    const available =
      this.dialogActions.getAll().length > 0
        ? this.hasAvailableActions(this.getActionContext("context-menu"))
        : this.itemActions().length > 0;
    if (!available) return false;
    this.showItemActions();
    return true;
  }

  /**
   * Filters items based on current query.
   * Called on query change (uses existing candidates).
   * @param {boolean} [updateComponent] - Whether to render the result
   * @param {number} [selectionIndex] - The index to select afterwards;
   *   defaults to the configured initial selection
   * @private
   */
  filterItems(updateComponent, selectionIndex) {
    const previousSelection = this.selectionSnapshot();
    // Re-supplying recentIds resets the page while keeping this operation
    // inside the model's single atomic update.
    this.model.update({
      query: this.modelQuery(this.getQuery()),
      recentIds: this.model.getRecentIds(),
    });
    if (arguments.length > 1) {
      if (selectionIndex === undefined) this.model.selectNone();
      else this.applyInitialSelection(selectionIndex);
    }
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "filter");
    return updateComponent === false ? Promise.resolve() : this.component.update();
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
        ignoreDiacritics: !!options.removeDiacritics,
      });
      this.filterMatcherGeneration = context.generation;
    }
    const matchOptions = {
      recordMatchIndexes: false,
    };
    if (options.algorithm) matchOptions.algorithm = options.algorithm;
    if (options.numThreads) matchOptions.numThreads = options.numThreads;
    if (options.maxGap !== undefined) matchOptions.maxGap = options.maxGap;
    const results = this.filterMatcher.match(query, matchOptions);
    const modifyScore = options.filterScoreModifier;
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

    const record = this.model._recordByItem.get(item);
    if (!record) return null;
    return this.model._filterTextForRecord(record, {
      search: this.model._search,
      filterTextCache: this.model._filterTextCache,
    });
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the match indices for an item, computing lazily if needed.
   * Match indices indicate which characters in the filter key matched the query.
   * @param {*} item - The item to get match indices for
   * @param {string} [filterKey] - Optional filter key override. If not provided,
   *   uses the stored filterKey from fuzzyFilter or computes from filterKeyForItem.
   * @returns {number[]|null} Array of character indices that matched, or null
   */
  getMatchIndices(item, filterKey) {
    const itemId = this.getIdForItem(item);
    const cached = this.matchIndicesMap?.get(itemId);
    if (cached !== undefined) return cached;

    // Use provided filterKey or get from item
    if (!filterKey) {
      filterKey = this.getFilterKey(item);
    }

    if (!filterKey || !this.processedQuery) {
      return null;
    }

    // Use reusable matcher for index computation. It folds diacritics the same
    // way as the filter matcher so indexes map back to the original filterKey.
    const ignoreDiacritics = !!this.props.removeDiacritics;
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
    if (this.props.algorithm) indexMatchOptions.algorithm = this.props.algorithm;
    if (this.props.maxGap !== undefined) indexMatchOptions.maxGap = this.props.maxGap;

    const results = this.indexMatcher.match(this.processedQuery, indexMatchOptions);

    const indexes = results.length > 0 ? results[0].matchIndexes : null;
    this.matchIndicesMap?.set(itemId, indexes);
    return indexes;
  }

  getSelectedItem() {
    return this.showMoreSelected ? null : this.model.getSelectedItem();
  }

  getSelectedItemId() {
    return this.showMoreSelected ? null : this.model.getSelectedId();
  }

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
   * If elementForItem returns an HTML element, uses it directly.
   * If it returns a descriptor object, builds the row from it and hands the
   * result to the descriptor's `didRender`, so a caller can decorate a row it
   * did not build — apply an icon, set a dataset key — without owning the markup.
   * @param {*} item - The item to get an element for
   * @param {Object} opts - Options passed to elementForItem
   * @returns {HTMLElement} The resolved element
   * @private
   */
  resolveElement(item, opts) {
    // The component renders its own last row; the consumer's renderer never
    // sees the sentinel.
    if (item === SHOW_MORE_ITEM) {
      return createTwoLineItem({ primary: "Show more…", className: "show-more-item" });
    }
    const renderItem = this.props.renderItem ?? this.props.elementForItem;
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

  // With `allowEmptySelection`, the empty selection sits between the two ends
  // of the cycle: stepping off either end returns to it, and stepping again
  // enters the list at the far end. Without it the ends wrap straight into
  // each other, since there is no empty state to pass through. Only these two
  // route through the empty selection — `selectFirst`/`selectLast` are asked
  // for an end by name, and give it.
  selectPrevious() {
    if (this.selectionIndex === undefined) return this.selectLast();
    if (this.allowsEmptySelectionAt(0)) return this.selectNone();
    return this.selectIndexOrShowMore(this.selectionIndex - 1);
  }

  selectNext() {
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
      (this.props.selection?.allowEmpty === true || this.props.allowEmptySelection === true) &&
      this.selectionIndex === edge
    );
  }

  selectFirst() {
    return this.selectIndexOrShowMore(0);
  }

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

  selectNone() {
    return this.selectIndex(undefined);
  }

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

  selectItemById(id) {
    const record = this.model._recordById.get(id);
    if (!record) throw new Error("Cannot select the specified item because its id does not exist.");
    return this.selectItem(record.item);
  }

  getScrollTop() {
    return this.component.refs.items?.scrollTop ?? 0;
  }

  setScrollTop(scrollTop) {
    if (this.component.refs.items) this.component.refs.items.scrollTop = scrollTop;
  }

  scrollToItem(itemOrId) {
    const record = this.model._recordByItem.get(itemOrId) ?? this.model._recordById.get(itemOrId);
    if (!record || !this.model._filteredIndexById.has(record.id)) return false;
    this.selectItem(record.item);
    return true;
  }

  scrollToSelectedItem() {
    if (this.selectionIndex == null || !this.listItems?.[this.selectionIndex]) return false;
    this.listItems[this.selectionIndex].component.scrollIntoViewIfNeeded();
    return true;
  }

  hasMoreItems() {
    return this.model.hasMore();
  }

  getRemainingItemCount() {
    return Math.max(0, this.getMatchCount() - this.getDisplayedItems().length);
  }

  resetDisplayedItemLimit() {
    const previousSelection = this.selectionSnapshot();
    this.model.update({ recentIds: this.model.getRecentIds() });
    this.showMoreSelected = false;
    this.resetRenderedItems();
    this.syncModelState();
    this.publishSelectionChange(previousSelection, "pagination");
    return this.component.update();
  }

  getRecentItemIds() {
    return this.model.getRecentIds();
  }

  async setRecentItemIds(recentIds, { persist = true } = {}) {
    if (!Array.isArray(recentIds)) throw new TypeError("Recent item IDs must be an array.");
    const limit = this.getRecentLimit();
    const normalized = Array.from(new Set(recentIds)).slice(0, limit);
    await this.update({ recentIds: normalized });
    if (persist && this.recentConfiguration) {
      await this.recentConfiguration.adapter.save(this.getRecentItemIds());
    }
    return this;
  }

  getRecentLimit() {
    return this.recentConfiguration?.limit ?? Infinity;
  }

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

  isRecentItem(itemOrId) {
    const record = this.model._recordByItem.get(itemOrId);
    const id = record ? record.id : itemOrId;
    return this.getRecentItemIds().includes(id);
  }

  recordRecentItem(item) {
    const id = this.getIdForItem(item);
    const recentIds = this.getRecentItemIds().filter((candidate) => candidate !== id);
    recentIds.unshift(id);
    return this.setRecentItemIds(recentIds);
  }

  removeRecentItem(itemOrId) {
    const record = this.model._recordByItem.get(itemOrId);
    const id = record ? record.id : itemOrId;
    return this.setRecentItemIds(this.getRecentItemIds().filter((candidate) => candidate !== id));
  }

  clearRecentItems() {
    return this.setRecentItemIds([]);
  }

  onDidChangeRecentItemIds(callback) {
    return this.emitter.on("did-change-recent-item-ids", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Confirms the current selection.
   * Calls didConfirmSelection with the selected item, or didConfirmEmptySelection if none.
   */
  confirmSelection() {
    if (this.selectedItemRaw() === SHOW_MORE_ITEM) {
      this.showMore();
      return;
    }
    const selectedItem = this.getSelectedItem();
    const primary = this.dialogActions.getPrimary(this.getActionContext("primary"));
    if (primary) return this.runAction(primary.command, { source: "primary" });
    if (selectedItem != null) {
      if (this.props.didConfirmSelection) {
        this.props.didConfirmSelection(selectedItem);
      }
      this.emitter.emit("did-confirm-selection", {
        list: this,
        item: selectedItem,
        itemId: this.getIdForItem(selectedItem),
      });
    } else {
      if (this.props.didConfirmEmptySelection) {
        this.props.didConfirmEmptySelection();
      }
      this.emitter.emit("did-confirm-empty-selection", { list: this });
    }
  }

  onDidConfirmSelection(callback) {
    return this.emitter.on("did-confirm-selection", callback);
  }

  onDidConfirmEmptySelection(callback) {
    return this.emitter.on("did-confirm-empty-selection", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Cancels the selection and calls the didCancelSelection callback if provided.
   */
  cancelSelection(reason = "api") {
    if (this.canceling || this.destroyed) return;
    this.canceling = true;
    this.hide();
    if (this.props.didCancelSelection) this.props.didCancelSelection();
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
    this.element.removeEventListener("mousedown", this.mouseDown);
    this.element.removeEventListener("mouseup", this.mouseUp);
    this.element.removeEventListener("click", this.didClick);
    this.element.removeEventListener("contextmenu", this.didContextMenu);

    this.releaseElement();
    if (this.element.parentNode) {
      this.element.parentNode.replaceChild(props.element, this.element);
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
