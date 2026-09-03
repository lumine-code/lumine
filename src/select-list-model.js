"use strict";

const DEFAULT_PAGE_SIZE = 99;
const NO_SELECTION = Symbol("no-selection");

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isObject(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isStableId(value) {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean" ||
      typeof value === "symbol")
  );
}

function assertStableId(id, description) {
  if (!isStableId(id)) {
    throw new TypeError(`${description} must be a non-null primitive value`);
  }
  return id;
}

function normalizePageSize(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError("pageSize must be a positive integer");
  }
  return value;
}

function normalizeQuery(value) {
  return value == null ? "" : String(value);
}

function normalizeRecentIds(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("recentIds must be an array");
  }

  const result = [];
  const seen = new Set();
  for (const id of value) {
    assertStableId(id, "A recent item ID");
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function normalizeSearch(previous, value) {
  const empty = {
    getFilterText: null,
    filter: null,
    sort: null,
    matcher: null,
  };

  if (value == null) return Object.freeze(empty);
  if (typeof value === "function") {
    return Object.freeze({ ...empty, matcher: value });
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("search must be an object, a matcher function, or null");
  }

  const search = { ...(previous ?? empty) };
  for (const key of Object.keys(empty)) {
    if (!hasOwn(value, key)) continue;
    const callback = value[key];
    if (callback != null && typeof callback !== "function") {
      throw new TypeError(`search.${key} must be a function or null`);
    }
    search[key] = callback ?? null;
  }

  if (search.filter && search.matcher) {
    throw new TypeError("search.filter and search.matcher are mutually exclusive");
  }
  return Object.freeze(search);
}

function defaultItemId(item) {
  if (!isObject(item)) return assertStableId(item, "A primitive item");
  if (isStableId(item.id)) return item.id;
  throw new TypeError("Object items require a stable `id` or a getItemId callback");
}

/**
 * Pure state model for a selectable, searchable list.
 *
 * The model knows nothing about DOM nodes, panels, Etch, or a concrete fuzzy
 * matcher. Object items need a stable primitive `id`; primitive items are their
 * own IDs. `getItemId` overrides both rules. IDs are unique across the complete
 * source, including every section.
 *
 * `search.matcher(candidates, query, context)` receives frozen candidates with
 * `{id, item, index, filterText}` and returns them in result order. It may also
 * return stable IDs, original items, or `{id}` / `{index}` result objects.
 * `search.filter(items, query, context)` returns original items (or replacements
 * carrying the same stable IDs). `search.sort(a, b, context)` compares original
 * items. With no custom filter or matcher, filtering is a case-insensitive
 * substring match over cached filter text.
 */
module.exports = class SelectListModel {
  constructor(options = {}) {
    if (options == null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("SelectListModel options must be an object");
    }

    this._source = { kind: "items", items: [] };
    this._getItemId = null;
    this._search = normalizeSearch(null, null);
    this._query = "";
    this._recentIds = [];
    this._allowEmptySelection = false;
    this._pageSize = DEFAULT_PAGE_SIZE;
    this._displayLimit = DEFAULT_PAGE_SIZE;
    this._generation = 0;
    this._filterTextCache = new Map();
    this._records = [];
    this._recordById = new Map();
    this._recordByItem = new Map();
    this._filteredRecords = [];
    this._filteredIndexById = new Map();
    this._selectedId = NO_SELECTION;

    this._applyUpdate(options, true);
  }

  /** Returns source items in their declared order, with sections flattened. */
  getItems() {
    return this._records.map((record) => record.item);
  }

  getItemId(item) {
    const record = this._recordByItem.get(item);
    if (record) return record.id;
    return this._resolveItemId(item, {
      index: -1,
      section: null,
      sectionId: null,
      sectionIndex: -1,
      itemIndex: -1,
    });
  }

  getItemById(id) {
    return this._recordById.get(id)?.item ?? null;
  }

  getFilterText(item) {
    const record = this._recordForValue(item, {
      recordByItem: this._recordByItem,
      recordById: this._recordById,
      getItemId: this._getItemId,
    });
    if (!record) return null;
    return this._filterTextForRecord(record, {
      search: this._search,
      filterTextCache: this._filterTextCache,
    });
  }

  /** Returns items after filtering, sorting, and unqueried recents ordering. */
  getFilteredItems() {
    return this._filteredRecords.map((record) => record.item);
  }

  /** Returns the currently displayed page prefix. No sentinel is appended. */
  getDisplayedItems() {
    return this._filteredRecords.slice(0, this._displayLimit).map((record) => record.item);
  }

  /** Internal record access for the view that will render this model. */
  _getItemRecords() {
    return this._records.slice();
  }

  /** Internal record access for the view that will render this model. */
  _getFilteredRecords() {
    return this._filteredRecords.slice();
  }

  /** Internal record access for the view that will render this model. */
  _getDisplayedRecords() {
    return this._filteredRecords.slice(0, this._displayLimit);
  }

  getQuery() {
    return this._query;
  }

  getRecentIds() {
    return this._recentIds.slice();
  }

  getPageSize() {
    return this._pageSize;
  }

  getDisplayedCount() {
    return Math.min(this._displayLimit, this._filteredRecords.length);
  }

  getGeneration() {
    return this._generation;
  }

  hasMore() {
    return this._displayLimit < this._filteredRecords.length;
  }

  getSelectedItem() {
    const record = this._selectedRecord();
    return record ? record.item : null;
  }

  getSelectedId() {
    return this._selectedId === NO_SELECTION ? null : this._selectedId;
  }

  getSelectedIndex() {
    if (this._selectedId === NO_SELECTION) return -1;
    return this._filteredIndexById.get(this._selectedId) ?? -1;
  }

  selectNone() {
    this._selectedId = NO_SELECTION;
    return null;
  }

  selectIndex(index) {
    if (!Number.isInteger(index)) {
      throw new TypeError("Selection index must be an integer");
    }
    const displayedCount = this.getDisplayedCount();
    if (index < 0 || index >= displayedCount) {
      throw new RangeError(`Selection index ${index} is outside the displayed items`);
    }
    this._selectedId = this._filteredRecords[index].id;
    return this._filteredRecords[index].item;
  }

  selectId(id) {
    assertStableId(id, "Selection ID");
    const index = this._filteredIndexById.get(id);
    if (index === undefined) {
      throw new RangeError(`No filtered item has ID ${String(id)}`);
    }
    this._ensureIndexDisplayed(index);
    this._selectedId = id;
    return this._filteredRecords[index].item;
  }

  selectItem(item) {
    let record = this._recordByItem.get(item);
    if (!record) {
      const id = this._resolveItemId(item, {
        index: -1,
        section: null,
        sectionId: null,
        sectionIndex: -1,
        itemIndex: -1,
      });
      record = this._recordById.get(id);
    }
    if (!record) {
      throw new RangeError("The selected item is not part of this model");
    }
    return this.selectId(record.id);
  }

  selectFirst() {
    if (this._filteredRecords.length === 0) return this.selectNone();
    this._selectedId = this._filteredRecords[0].id;
    return this._filteredRecords[0].item;
  }

  selectLast() {
    const displayedCount = this.getDisplayedCount();
    if (displayedCount === 0) return this.selectNone();
    return this.selectIndex(displayedCount - 1);
  }

  selectNext() {
    if (this._filteredRecords.length === 0) return this.selectNone();
    const index = this.getSelectedIndex();
    if (index < 0) return this.selectFirst();
    if (index + 1 < this.getDisplayedCount()) return this.selectIndex(index + 1);
    if (this.hasMore()) {
      const firstNewIndex = this.getDisplayedCount();
      this.showMore();
      return this.selectIndex(firstNewIndex);
    }
    if (this._allowEmptySelection) return this.selectNone();
    return this.selectFirst();
  }

  selectPrevious() {
    if (this._filteredRecords.length === 0) return this.selectNone();
    const index = this.getSelectedIndex();
    if (index < 0) return this.selectLast();
    if (index > 0) return this.selectIndex(index - 1);
    if (this._allowEmptySelection) return this.selectNone();
    return this.selectLast();
  }

  /** Reveals one more page and returns whether anything was revealed. */
  showMore() {
    if (!this.hasMore()) return false;
    this._displayLimit = Math.min(
      this._filteredRecords.length,
      this._displayLimit + this._pageSize,
    );
    return true;
  }

  resetDisplayLimit() {
    this._displayLimit = this._pageSize;
    const selectedIndex = this.getSelectedIndex();
    if (selectedIndex >= this._displayLimit) {
      this._selectedId = this._defaultSelectionId(this._filteredRecords, this._allowEmptySelection);
    }
    return this.hasMore();
  }

  /**
   * Atomically applies any combination of source, query, search, recents, and
   * selection-policy changes. If validation or a search callback throws, the
   * prior model state remains observable.
   */
  update(changes = {}) {
    if (changes == null || typeof changes !== "object" || Array.isArray(changes)) {
      throw new TypeError("SelectListModel updates must be objects");
    }
    return this._applyUpdate(changes, false);
  }

  _applyUpdate(changes, initial) {
    if (hasOwn(changes, "items") && hasOwn(changes, "sections")) {
      throw new TypeError("items and sections are alternative list sources");
    }

    let source = this._source;
    let sourceChanged = false;
    if (hasOwn(changes, "items")) {
      source = this._normalizeItemsSource(changes.items);
      sourceChanged = true;
    } else if (hasOwn(changes, "sections")) {
      source = this._normalizeSectionsSource(changes.sections);
      sourceChanged = true;
    }

    let getItemId = this._getItemId;
    let idResolverChanged = false;
    if (hasOwn(changes, "getItemId")) {
      if (changes.getItemId != null && typeof changes.getItemId !== "function") {
        throw new TypeError("getItemId must be a function or null");
      }
      getItemId = changes.getItemId ?? null;
      idResolverChanged = getItemId !== this._getItemId;
    }

    let search = this._search;
    let searchChanged = false;
    if (hasOwn(changes, "search")) {
      search = normalizeSearch(this._search, changes.search);
      searchChanged = true;
    }

    const query = hasOwn(changes, "query") ? normalizeQuery(changes.query) : this._query;
    const queryChanged = query !== this._query;
    const recentIds = hasOwn(changes, "recentIds")
      ? normalizeRecentIds(changes.recentIds)
      : this._recentIds;
    const recentsChanged = hasOwn(changes, "recentIds");
    const allowEmptySelection = hasOwn(changes, "allowEmptySelection")
      ? Boolean(changes.allowEmptySelection)
      : this._allowEmptySelection;
    const pageSize = hasOwn(changes, "pageSize")
      ? normalizePageSize(changes.pageSize)
      : this._pageSize;
    const pageSizeChanged = pageSize !== this._pageSize;

    const generationChanged = initial || sourceChanged || idResolverChanged || searchChanged;
    const generation = generationChanged ? this._generation + 1 : this._generation;
    const built =
      initial || sourceChanged || idResolverChanged
        ? this._buildRecords(source, getItemId)
        : {
            records: this._records,
            recordById: this._recordById,
            recordByItem: this._recordByItem,
          };
    const filterTextCache = generationChanged ? new Map() : new Map(this._filterTextCache);

    const draft = {
      source,
      getItemId,
      search,
      query,
      recentIds,
      allowEmptySelection,
      pageSize,
      generation,
      filterTextCache,
      ...built,
    };
    const filteredRecords = this._deriveFilteredRecords(draft);
    const filteredIndexById = new Map(filteredRecords.map((record, index) => [record.id, index]));

    let selectedId;
    if (hasOwn(changes, "initialSelection")) {
      const requestedSelection = changes.initialSelection;
      if (
        !requestedSelection ||
        typeof requestedSelection !== "object" ||
        Array.isArray(requestedSelection)
      ) {
        throw new TypeError("initialSelection must be {mode: 'first'|'none'} or {id}.");
      }
      const hasMode = hasOwn(requestedSelection, "mode");
      const hasId = hasOwn(requestedSelection, "id");
      if (hasMode === hasId) {
        throw new TypeError("initialSelection must declare exactly one of mode or id.");
      }
      if (hasMode && requestedSelection.mode === "none") {
        selectedId = NO_SELECTION;
      } else if (hasMode && requestedSelection.mode === "first") {
        selectedId = filteredRecords[0]?.id ?? NO_SELECTION;
      } else if (hasMode) {
        throw new TypeError("initialSelection mode must be 'first' or 'none'.");
      } else {
        const requestedId = assertStableId(requestedSelection.id, "Initial selection ID");
        if (!filteredIndexById.has(requestedId)) {
          throw new RangeError(`No filtered item has ID ${String(requestedId)}`);
        }
        selectedId = requestedId;
      }
    } else if (initial || queryChanged) {
      selectedId = this._defaultSelectionId(filteredRecords, allowEmptySelection);
    } else if (this._selectedId !== NO_SELECTION && filteredIndexById.has(this._selectedId)) {
      selectedId = this._selectedId;
    } else {
      selectedId = this._defaultSelectionId(filteredRecords, allowEmptySelection);
    }

    const resetPage =
      initial ||
      sourceChanged ||
      searchChanged ||
      queryChanged ||
      recentsChanged ||
      pageSizeChanged;
    let displayLimit = resetPage ? pageSize : this._displayLimit;
    if (selectedId !== NO_SELECTION) {
      const selectedIndex = filteredIndexById.get(selectedId);
      if (selectedIndex >= displayLimit) {
        displayLimit = Math.ceil((selectedIndex + 1) / pageSize) * pageSize;
      }
    }

    // Commit only after every callback and validation step above has succeeded.
    this._source = source;
    this._getItemId = getItemId;
    this._search = search;
    this._query = query;
    this._recentIds = recentIds.slice();
    this._allowEmptySelection = allowEmptySelection;
    this._pageSize = pageSize;
    this._displayLimit = displayLimit;
    this._generation = generation;
    this._filterTextCache = filterTextCache;
    this._records = built.records;
    this._recordById = built.recordById;
    this._recordByItem = built.recordByItem;
    this._filteredRecords = filteredRecords;
    this._filteredIndexById = filteredIndexById;
    this._selectedId = selectedId;
    return this;
  }

  _normalizeItemsSource(items) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    return { kind: "items", items: items.slice() };
  }

  _normalizeSectionsSource(sections) {
    if (!Array.isArray(sections)) throw new TypeError("sections must be an array");
    const seen = new Set();
    const normalized = sections.map((section, sectionIndex) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        throw new TypeError(`Section ${sectionIndex} must be an object`);
      }
      const id = assertStableId(section.id, `Section ${sectionIndex} ID`);
      if (seen.has(id)) throw new Error(`Duplicate section ID: ${String(id)}`);
      seen.add(id);
      if (!Array.isArray(section.items)) {
        throw new TypeError(`Section ${String(id)} items must be an array`);
      }
      return Object.freeze({ ...section, id, items: section.items.slice() });
    });
    return { kind: "sections", sections: normalized };
  }

  _buildRecords(source, getItemId) {
    const records = [];
    const recordById = new Map();
    const recordByItem = new Map();

    const add = (item, section, sectionIndex, itemIndex) => {
      const context = {
        index: records.length,
        section,
        sectionId: section?.id ?? null,
        sectionIndex,
        itemIndex,
      };
      const id = this._resolveItemId(item, context, getItemId);
      if (recordById.has(id)) throw new Error(`Duplicate item ID: ${String(id)}`);
      const record = Object.freeze({
        id,
        item,
        sourceIndex: records.length,
        sectionId: context.sectionId,
        sectionIndex,
        itemIndex,
        recent: false,
      });
      records.push(record);
      recordById.set(id, record);
      recordByItem.set(item, record);
    };

    if (source.kind === "sections") {
      source.sections.forEach((section, sectionIndex) => {
        section.items.forEach((item, itemIndex) => add(item, section, sectionIndex, itemIndex));
      });
    } else {
      source.items.forEach((item, index) => add(item, null, -1, index));
    }

    return { records, recordById, recordByItem };
  }

  _resolveItemId(item, context, resolver = this._getItemId) {
    const id = resolver ? resolver(item, context) : defaultItemId(item);
    return assertStableId(id, `Item ID at source index ${context.index}`);
  }

  _deriveFilteredRecords(state) {
    let records;
    if (state.query) {
      records = this._searchRecords(state);
      if (state.search.sort) records = this._sortRecords(records, state);
    } else {
      records = state.records.slice();
      if (state.search.sort) {
        records =
          state.source.kind === "sections"
            ? this._sortRecordsWithinSections(records, state)
            : this._sortRecords(records, state);
      }
      records = this._applyRecentOrder(records, state.recentIds);
    }

    const recentSet = state.query ? new Set() : new Set(state.recentIds);
    return records.map((record) =>
      Object.freeze({
        ...record,
        // A query is one ranked result set; source groups no longer create
        // visual boundaries. Keep the source section separately for callers
        // inside core that need provenance.
        sourceSectionId: record.sectionId,
        sectionId: state.query ? null : record.sectionId,
        sectionIndex: state.query ? -1 : record.sectionIndex,
        recent: recentSet.has(record.id),
      }),
    );
  }

  _searchRecords(state) {
    if (state.search.filter) {
      const context = this._searchContext(state);
      const result = state.search.filter(
        state.records.map((record) => record.item),
        state.query,
        context,
      );
      return this._normalizeSearchResults(result, state, null, "search.filter");
    }

    if (state.search.matcher) {
      const candidates = state.records.map((record, index) =>
        Object.freeze({
          id: record.id,
          item: record.item,
          index,
          filterText: this._filterTextForRecord(record, state),
        }),
      );
      const context = this._searchContext(state);
      const result = state.search.matcher(candidates, state.query, context);
      return this._normalizeSearchResults(result, state, candidates, "search.matcher");
    }

    const query = state.query.toLowerCase();
    return state.records.filter((record) =>
      this._filterTextForRecord(record, state).toLowerCase().includes(query),
    );
  }

  _searchContext(state) {
    return Object.freeze({
      query: state.query,
      generation: state.generation,
      getItemId: (item) => {
        const record = state.recordByItem.get(item);
        if (record) return record.id;
        return this._resolveItemId(
          item,
          {
            index: -1,
            section: null,
            sectionId: null,
            sectionIndex: -1,
            itemIndex: -1,
          },
          state.getItemId,
        );
      },
      getFilterText: (item) => {
        const record = this._recordForValue(item, state);
        if (!record) throw new RangeError("Cannot get filter text for an unknown item");
        return this._filterTextForRecord(record, state);
      },
    });
  }

  _normalizeSearchResults(result, state, candidates, source) {
    if (!Array.isArray(result)) throw new TypeError(`${source} must return an array`);
    const candidateSet = candidates ? new Set(candidates) : null;
    const seen = new Set();
    return result.map((value) => {
      let record = null;
      if (candidateSet?.has(value)) {
        record = state.recordById.get(value.id);
      } else if (state.recordByItem.has(value)) {
        // An original object item may itself have an `id` or `index` field.
        // Identity wins over the matcher-result shorthand below.
        record = state.recordByItem.get(value);
      } else if (candidates && value && typeof value === "object" && hasOwn(value, "index")) {
        if (Number.isInteger(value.index)) record = state.records[value.index] ?? null;
      } else if (candidates && value && typeof value === "object" && hasOwn(value, "id")) {
        record = state.recordById.get(value.id) ?? null;
      } else {
        record = this._recordForValue(value, state);
      }

      if (!record) throw new RangeError(`${source} returned an unknown item`);
      if (seen.has(record.id)) {
        throw new Error(`${source} returned duplicate item ID ${String(record.id)}`);
      }
      seen.add(record.id);
      return record;
    });
  }

  _recordForValue(value, state) {
    const direct = state.recordByItem.get(value);
    if (direct) return direct;
    if (state.recordById.has(value)) return state.recordById.get(value);
    if (isObject(value)) {
      try {
        const id = this._resolveItemId(
          value,
          {
            index: -1,
            section: null,
            sectionId: null,
            sectionIndex: -1,
            itemIndex: -1,
          },
          state.getItemId,
        );
        return state.recordById.get(id) ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  _filterTextForRecord(record, state) {
    if (state.filterTextCache.has(record.id)) return state.filterTextCache.get(record.id);
    let text;
    if (state.search.getFilterText) {
      text = state.search.getFilterText(record.item, {
        id: record.id,
        index: record.sourceIndex,
        sectionId: record.sectionId,
        sectionIndex: record.sectionIndex,
        itemIndex: record.itemIndex,
      });
    } else if (typeof record.item === "string") {
      text = record.item;
    } else if (isObject(record.item)) {
      text =
        record.item.filterText ??
        record.item.label ??
        record.item.name ??
        record.item.text ??
        record.id;
    } else {
      text = record.item;
    }
    text = text == null ? "" : String(text);
    state.filterTextCache.set(record.id, text);
    return text;
  }

  _sortRecords(records, state) {
    const context = this._searchContext(state);
    return records.slice().sort((left, right) => state.search.sort(left.item, right.item, context));
  }

  _sortRecordsWithinSections(records, state) {
    const groups = [];
    for (const record of records) {
      const index = Math.max(0, record.sectionIndex);
      if (!groups[index]) groups[index] = [];
      groups[index].push(record);
    }
    return groups.flatMap((group) => this._sortRecords(group ?? [], state));
  }

  _applyRecentOrder(records, recentIds) {
    if (recentIds.length === 0) return records;
    const positionById = new Map(recentIds.map((id, index) => [id, index]));
    const recent = [];
    const rest = [];
    for (const record of records) {
      if (positionById.has(record.id)) recent.push(record);
      else rest.push(record);
    }
    recent.sort((left, right) => positionById.get(left.id) - positionById.get(right.id));
    return recent.concat(rest);
  }

  _defaultSelectionId(records, allowEmptySelection) {
    if (allowEmptySelection || records.length === 0) return NO_SELECTION;
    return records[0].id;
  }

  _selectedRecord() {
    if (this._selectedId === NO_SELECTION) return null;
    const index = this._filteredIndexById.get(this._selectedId);
    return index === undefined ? null : this._filteredRecords[index];
  }

  _ensureIndexDisplayed(index) {
    if (index < this._displayLimit) return;
    this._displayLimit = Math.min(
      this._filteredRecords.length,
      Math.ceil((index + 1) / this._pageSize) * this._pageSize,
    );
  }
};

module.exports.DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
