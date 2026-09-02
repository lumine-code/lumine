"use strict";

const { Disposable } = require("@lumine-code/event-kit");
const etch = require("@lumine-code/etch");
const { InputDialogView } = require("./input-dialog-view");
const { highlightMatches, createTwoLineItem } = require("./select-list-helpers");
const fuzzyMatcher = require("./fuzzy-matcher");
const $ = etch.dom;

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
//
// Guarded, unlike the packages that do the same thing: this is a library, and
// its own test suite loads it under plain Node with no editor around it.
if (typeof lumine !== "undefined" && lumine.views) {
  etch.setScheduler(lumine.views);
}

// Rendering hundreds of rows costs real time and nobody scans them; the list
// caps itself and ends with a "Show more…" row that reveals the next batch.
// `maxResults` changes the batch size, it no longer means "drop the rest".
const DEFAULT_MAX_RESULTS = 99;

// The library's own last row when matches exceed the cap. Never handed to the
// consumer's callbacks: confirming it grows the list, selecting it reads as
// no selection, and the library renders it itself.
const SHOW_MORE_ITEM = Object.freeze({ showMoreSentinel: true });

/**
 * Fuzzy-searchable select list. Extends InputDialogView — which owns the
 * modal panel, query editor, focus handling, and confirm/cancel commands —
 * with items, filtering, selection, and list rendering.
 */
class SelectListView extends InputDialogView {
  initializeState() {
    this.recentBoundaryIndex = -1;
    if (!Object.prototype.hasOwnProperty.call(this.props, "initialSelectionIndex")) {
      // A list that allows an empty selection starts in it. The state exists
      // to mean something — usually that confirming acts on the query rather
      // than on a row — and starting on the first item would hide it.
      this.props.initialSelectionIndex = this.props.allowEmptySelection ? undefined : 0;
    }
    if (this.props.initiallyVisibleItemCount) {
      this.initializeVisibilityObserver();
    }
    if (!this.props.items) {
      this.props.items = [];
    } else {
      this.buildCandidates();
      this.filterItems(false);
    }
  }

  // A select list *is* an input dialog with a list in it, so it carries both
  // classes and the stylesheet hierarchy mirrors the class hierarchy. Dropping
  // `input-dialog` here is what used to leave every base dialog rule — the
  // message line among them — matching nothing inside a list. A rule meant for
  // dialogs and not lists is written `.input-dialog:not(.select-list)`.
  rootClasses() {
    return [...super.rootClasses(), "select-list"];
  }

  /**
   * Creates the IntersectionObserver used when `initiallyVisibleItemCount` is
   * set. Items beyond that count render with `visible: false` until they are
   * scrolled into view, at which point they re-render with `visible: true`.
   */
  initializeVisibilityObserver() {
    this.visibilityObserver = new IntersectionObserver((changes) => {
      for (const change of changes) {
        if (change.intersectionRatio > 0) {
          const element = change.target;
          this.visibilityObserver.unobserve(element);
          const index =
            this.listItems?.findIndex((listItem) => listItem.component.element === element) ?? -1;
          if (index >= 0) {
            this.renderItemAtIndex(index);
          }
        }
      }
    });
  }

  /**
   * Destroys the select list and cleans up resources.
   * @returns {Promise} Resolves when destruction is complete
   */
  destroy() {
    if (this.visibilityObserver) {
      this.visibilityObserver.disconnect();
    }
    this.filterMatcher = null;
    this.indexMatcher = null;
    this.cachedCandidates = null;
    this.cachedItemByIndex = null;
    return super.destroy();
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
   */
  confirmActionForItem(item) {
    if (this.selectedItemRaw() === SHOW_MORE_ITEM) return null;
    const confirmAction = this.props.confirmAction;
    if (typeof confirmAction === "function") return confirmAction(item) ?? null;
    if (typeof confirmAction === "string" && item != null) return confirmAction;
    return null;
  }

  updateProps(props) {
    let shouldBuildCandidates = false;
    let shouldFilterItems = false;

    // Props that require rebuilding candidates
    if ("items" in props) {
      this.props.items = props.items;
      shouldBuildCandidates = true;
    }

    if ("filterKeyForItem" in props) {
      this.props.filterKeyForItem = props.filterKeyForItem;
      shouldBuildCandidates = true;
    }

    if ("removeDiacritics" in props) {
      this.props.removeDiacritics = props.removeDiacritics;
      shouldBuildCandidates = true;
    }

    // Props that only require re-filtering
    if ("maxResults" in props) {
      this.props.maxResults = props.maxResults;
      shouldFilterItems = true;
    }

    if ("filter" in props) {
      this.props.filter = props.filter;
      shouldFilterItems = true;
    }

    if ("filterQuery" in props) {
      this.props.filterQuery = props.filterQuery;
      shouldFilterItems = true;
    }

    if ("filterScoreModifier" in props) {
      this.props.filterScoreModifier = props.filterScoreModifier;
      shouldFilterItems = true;
    }

    if ("algorithm" in props) {
      this.props.algorithm = props.algorithm;
      shouldFilterItems = true;
    }

    if ("numThreads" in props) {
      this.props.numThreads = props.numThreads;
      shouldFilterItems = true;
    }

    if ("maxGap" in props) {
      this.props.maxGap = props.maxGap;
      shouldFilterItems = true;
    }

    if ("order" in props) {
      this.props.order = props.order;
      shouldFilterItems = true;
    }

    if ("recentIds" in props) {
      this.props.recentIds = props.recentIds;
      shouldFilterItems = true;
    }

    if ("emptyMessage" in props) {
      this.props.emptyMessage = props.emptyMessage;
    }

    if ("itemsClassList" in props) {
      this.props.itemsClassList = props.itemsClassList;
    }

    if ("separatorIds" in props) {
      this.props.separatorIds = props.separatorIds;
    }

    if ("idForItem" in props) {
      this.props.idForItem = props.idForItem;
    }

    if ("initialSelectionIndex" in props) {
      this.props.initialSelectionIndex = props.initialSelectionIndex;
    }

    if ("allowEmptySelection" in props) {
      this.props.allowEmptySelection = props.allowEmptySelection;
    }

    if ("confirmAction" in props) {
      this.props.confirmAction = props.confirmAction;
    }

    super.updateProps(props);

    if (shouldBuildCandidates) {
      this.buildCandidates();
      this.filterItems();
    } else if (shouldFilterItems) {
      this.filterItems();
    }
  }

  renderBody() {
    return this.renderItems();
  }

  /**
   * Returns the stable identifier used by separatorIds for an item. Object
   * items default to their `id` property; primitive items identify themselves.
   * @param {*} item - The item to identify
   * @returns {*} The item's identifier
   */
  getIdForItem(item) {
    if (this.props.idForItem) return this.props.idForItem(item);
    if (item !== null && typeof item === "object") return item.id;
    return item;
  }

  /**
   * Returns whether a standalone separator should be rendered immediately
   * before an item.
   * @param {*} item - The item about to render
   * @returns {boolean} Whether to insert a separator
   */
  hasSeparatorBefore(item) {
    if (item === SHOW_MORE_ITEM || !Array.isArray(this.props.separatorIds)) return false;
    return this.props.separatorIds.includes(this.getIdForItem(item));
  }

  /**
   * Whether the recent section applies right now: there are recent ids, and
   * the list is showing its resting order rather than a query's ranking.
   * Under a query the rows are ordered by score, and hoisting a handful of
   * them to the top would be overriding the answer the user asked for.
   * @returns {boolean} Whether recents lead the list
   */
  hasRecentSection() {
    return (
      Array.isArray(this.props.recentIds) && this.props.recentIds.length > 0 && !this.processedQuery
    );
  }

  /**
   * Moves the items named by `recentIds` to the front, in that order, leaving
   * everything else as it was. `recentIds` is most-recent-first, so the order
   * carries through unchanged.
   * @param {Array} items - The filtered items
   * @returns {Object} `{items, recentCount}`
   */
  applyRecentOrder(items) {
    const rank = new Map();
    this.props.recentIds.forEach((id, index) => {
      if (!rank.has(id)) rank.set(id, index);
    });
    const recent = [];
    const rest = [];
    for (const item of items) {
      const position = rank.get(this.getIdForItem(item));
      if (position === undefined) {
        rest.push(item);
      } else {
        recent.push({ item, position });
      }
    }
    if (recent.length === 0) return { items, recentCount: 0 };
    recent.sort((a, b) => a.position - b.position);
    return {
      items: [...recent.map((entry) => entry.item), ...rest],
      recentCount: recent.length,
    };
  }

  renderItems() {
    if (this.items && this.items.length > 0) {
      const className = ["list-group"].concat(this.props.itemsClassList || []).join(" ");

      this.listItems = this.items.map((item, index) => {
        const selected = this.selectedItemRaw() === item;
        const filterKey = this.getFilterKey(item);
        const visible = !this.visibilityObserver || index < this.props.initiallyVisibleItemCount;
        const opts = { selected, index, filterKey, visible };
        // Lazy getter - matchIndices only computed when accessed
        Object.defineProperty(opts, "matchIndices", {
          get: () => this.getMatchIndices(item, filterKey),
          enumerable: true,
        });
        opts.highlight = (text, indices = opts.matchIndices) => highlightMatches(text, indices);
        return $(ListItemView, {
          element: this.resolveElement(item, opts),
          selected: selected,
          onclick: () => this.didClickItem(index),
          onmiddleclick: () => this.selectIndex(index),
          oncontextmenu: () => this.didContextMenuItem(index),
        });
      });

      if (this.visibilityObserver) {
        const listItems = this.listItems;
        etch.getScheduler().updateDocument(() => {
          if (!this.refs.items || this.listItems !== listItems) return;
          listItems
            .slice(this.props.initiallyVisibleItemCount)
            .forEach((listItem) => this.visibilityObserver.observe(listItem.component.element));
        });
      }

      const children = [];
      for (let index = 0; index < this.items.length; index++) {
        // The recent boundary is the list's own rule and needs no `separatorIds`
        // entry; a caller that names the same row anyway still gets one line.
        const key =
          index === this.recentBoundaryIndex
            ? "separator:recent"
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

      return $.ol({ className, ref: "items" }, ...children);
    } else if (!this.hasMessage() && this.props.emptyMessage) {
      return $.div({ ref: "emptyMessage", className: "empty-message" }, this.props.emptyMessage);
    } else {
      return "";
    }
  }

  didChangeQuery() {
    super.didChangeQuery();
    // A new query starts from the base cap again.
    this.visibleCap = null;
    this.filterItems();
  }

  didClickItem(itemIndex) {
    this.selectIndex(itemIndex);
    this.confirmSelection();
  }

  didContextMenuItem(itemIndex) {
    this.selectIndex(itemIndex);
    this.showItemActions();
  }

  /**
   * Filters items based on current query.
   * Called on query change (uses existing candidates).
   * @param {boolean} [updateComponent] - Whether to render the result
   * @param {number} [selectionIndex] - The index to select afterwards;
   *   defaults to the configured initial selection
   */
  filterItems(updateComponent, selectionIndex = this.props.initialSelectionIndex) {
    this.listItems = null;
    if (this.visibilityObserver) {
      this.visibilityObserver.disconnect();
    }
    this.matchIndicesMap = new Map();
    this.filterKeyMap = new Map();

    const filterFn = this.props.filter || this.fuzzyFilter.bind(this);
    this.processedQuery = this.getFilterQuery();
    let filtered = filterFn(this.props.items.slice(), this.processedQuery);
    if (this.props.order) {
      filtered.sort(this.props.order);
    }
    let recentCount = 0;
    if (this.hasRecentSection()) {
      ({ items: filtered, recentCount } = this.applyRecentOrder(filtered));
    }
    const cap = this.visibleCap ?? this.props.maxResults ?? DEFAULT_MAX_RESULTS;
    if (filtered.length > cap) {
      filtered = filtered.slice(0, cap);
      filtered.push(SHOW_MORE_ITEM);
    }
    this.items = filtered;
    // Where the recents stop. Nothing to mark when every visible row is one,
    // when none is, or when the boundary fell past the visible cap.
    this.recentBoundaryIndex =
      recentCount > 0 && recentCount < this.items.length ? recentCount : -1;

    this.selectIndex(selectionIndex, updateComponent);
  }

  /**
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
    const base = this.props.maxResults ?? DEFAULT_MAX_RESULTS;
    const revealIndex = this.items.length - 1;
    const scroller = this.refs.items;
    const scrollTop = scroller ? scroller.scrollTop : 0;

    this.visibleCap = (this.visibleCap ?? base) + base;
    this.filterItems(false, revealIndex);
    await etch.update(this);

    // The ol persists across the update, and the selection's own
    // scroll-into-view runs inside it; putting the viewport back last is what
    // makes the pressed-button paths stable.
    if (!followSelection && this.refs.items) {
      this.refs.items.scrollTop = scrollTop;
    }
  }

  /**
   * Builds candidates array and initializes the matcher.
   * Called when items or filter settings change.
   */
  buildCandidates() {
    // New items mean a new list; expansion state does not carry over.
    this.visibleCap = null;
    this.candidates = [];
    this.itemByIndex = [];
    for (const item of this.props.items) {
      // Keep the original (possibly accented) filter key; diacritic folding is
      // handled inside the native matcher via the `ignoreDiacritics` option so
      // that reported match indexes line up with the original text.
      const filterKey = this.props.filterKeyForItem ? this.props.filterKeyForItem(item) : item;
      this.candidates.push(filterKey);
      this.itemByIndex.push(item);
    }
    // When a custom `filter` is supplied, the built-in fuzzy matcher is never
    // used, so skip building it. This also avoids handing non-string filter
    // keys (e.g. object items without a `filterKeyForItem`) to the native
    // matcher, which requires strings.
    if (this.props.filter) {
      return;
    }
    if (this.filterMatcher) {
      fuzzyMatcher.setCandidates(this.filterMatcher, this.candidates);
    } else {
      this.filterMatcher = fuzzyMatcher.setCandidates(this.candidates, {
        ignoreDiacritics: !!this.props.removeDiacritics,
      });
    }
  }

  fuzzyFilter(items, query) {
    if (query.length === 0) {
      return items;
    }
    const matchOptions = {
      recordMatchIndexes: false,
    };
    if (this.props.algorithm) matchOptions.algorithm = this.props.algorithm;
    if (this.props.numThreads) matchOptions.numThreads = this.props.numThreads;
    if (this.props.maxGap !== undefined) matchOptions.maxGap = this.props.maxGap;
    if (!this.filterMatcher) return [];
    const results = this.filterMatcher.match(query, matchOptions);
    const modifyScore = this.props.filterScoreModifier;
    const scoredItems = [];
    for (const result of results) {
      const item = this.itemByIndex[result.id];
      let score = result.score;
      if (modifyScore) {
        score = modifyScore(score, item);
      }
      if (score > 0) {
        scoredItems.push({
          item,
          score,
          filterKey: this.candidates[result.id],
        });
      }
    }
    if (modifyScore) {
      scoredItems.sort((a, b) => b.score - a.score);
    }
    for (const { item, filterKey } of scoredItems) {
      this.filterKeyMap.set(item, filterKey);
    }
    return scoredItems.map((i) => i.item);
  }

  /**
   * Returns the filter key for an item.
   * @param {*} item - The item to get the filter key for
   * @returns {string|null} The filter key string, or null
   */
  getFilterKey(item) {
    // The sentinel never matches a query and has no consumer-facing key.
    if (item === SHOW_MORE_ITEM) return null;

    // Check stored filterKey from fuzzyFilter
    let filterKey = this.filterKeyMap?.get(item);
    if (filterKey) return filterKey;

    // Compute from filterKeyForItem. The original (accented) key is returned;
    // the native matcher folds diacritics internally when enabled.
    if (this.props.filterKeyForItem) {
      return this.props.filterKeyForItem(item);
    }

    // Fall back to item itself if string
    return typeof item === "string" ? item : null;
  }

  /**
   * Returns the match indices for an item, computing lazily if needed.
   * Match indices indicate which characters in the filter key matched the query.
   * @param {*} item - The item to get match indices for
   * @param {string} [filterKey] - Optional filter key override. If not provided,
   *   uses the stored filterKey from fuzzyFilter or computes from filterKeyForItem.
   * @returns {number[]|null} Array of character indices that matched, or null
   */
  getMatchIndices(item, filterKey) {
    // Check cache first
    const cached = this.matchIndicesMap?.get(item);
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
    if (!this.indexMatcher) {
      this.indexMatcher = fuzzyMatcher.setCandidates([filterKey], {
        ignoreDiacritics: !!this.props.removeDiacritics,
      });
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
    this.matchIndicesMap?.set(item, indexes);
    return indexes;
  }

  getSelectedItem() {
    const item = this.selectedItemRaw();
    // The "Show more…" row is chrome, not an item — a consumer reading the
    // selection while it is highlighted must not receive the sentinel.
    return item === SHOW_MORE_ITEM ? null : item;
  }

  selectedItemRaw() {
    if (this.selectionIndex === undefined) return null;
    return this.items[this.selectionIndex];
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
   */
  resolveElement(item, opts) {
    // The library renders its own last row; the consumer's renderer never
    // sees the sentinel.
    if (item === SHOW_MORE_ITEM) {
      return createTwoLineItem({ primary: "Show more…", className: "show-more-item" });
    }
    const result = this.props.elementForItem(item, opts);
    if (result instanceof HTMLElement) {
      return result;
    }
    const element = createTwoLineItem(result);
    result.didRender?.(element);
    return element;
  }

  renderItemAtIndex(index) {
    if (!this.listItems || index < 0 || index >= this.listItems.length) return;
    const item = this.items[index];
    const selected = this.selectedItemRaw() === item;
    const filterKey = this.getFilterKey(item);
    const opts = { selected, index, filterKey, visible: true };
    // Lazy getter - matchIndices only computed when accessed
    Object.defineProperty(opts, "matchIndices", {
      get: () => this.getMatchIndices(item, filterKey),
      enumerable: true,
    });
    opts.highlight = (text, indices = opts.matchIndices) => highlightMatches(text, indices);
    const component = this.listItems[index].component;
    if (this.visibilityObserver) {
      this.visibilityObserver.unobserve(component.element);
    }
    component.update({
      element: this.resolveElement(item, opts),
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
   */
  allowsEmptySelectionAt(edge) {
    return this.props.allowEmptySelection === true && this.selectionIndex === edge;
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

  selectIndex(index, updateComponent = true) {
    if (index >= this.items.length) {
      index = 0;
    } else if (index < 0) {
      index = this.items.length - 1;
    }

    const oldIndex = this.selectionIndex;

    this.selectionIndex = index;
    if (index !== undefined && this.props.didChangeSelection) {
      // Reports null while the "Show more…" row is highlighted.
      this.props.didChangeSelection(this.getSelectedItem());
    }
    this.refreshItemActionsIndicator();

    if (updateComponent) {
      if (this.listItems) {
        if (oldIndex >= 0) this.renderItemAtIndex(oldIndex);
        if (index >= 0) this.renderItemAtIndex(index);
        return etch.getScheduler().getNextUpdatePromise();
      } else {
        return etch.update(this);
      }
    } else {
      return Promise.resolve();
    }
  }

  selectItem(item) {
    const index = this.items.indexOf(item);
    if (index === -1) {
      throw new Error("Cannot select the specified item because it does not exist.");
    } else {
      return this.selectIndex(index);
    }
  }

  /**
   * Confirms the current selection.
   * Calls didConfirmSelection with the selected item, or didConfirmEmptySelection if none.
   */
  confirmSelection() {
    if (this.selectedItemRaw() === SHOW_MORE_ITEM) {
      this.showMore();
      return;
    }
    const selectedItem = this.getSelectedItem();
    if (selectedItem != null) {
      if (this.props.didConfirmSelection) {
        this.props.didConfirmSelection(selectedItem);
      }
    } else {
      if (this.props.didConfirmEmptySelection) {
        this.props.didConfirmEmptySelection();
      }
    }
  }

  /**
   * Cancels the selection and calls the didCancelSelection callback if provided.
   */
  cancelSelection() {
    if (this.props.didCancelSelection) {
      this.props.didCancelSelection();
    }
  }
}

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
    event.preventDefault();
    event.stopPropagation();
    this.oncontextmenu();
  }

  destroy() {
    this.element.remove();
    this.domEventsDisposable.dispose();
  }

  update(props) {
    this.element.removeEventListener("mousedown", this.mouseDown);
    this.element.removeEventListener("mouseup", this.mouseUp);
    this.element.removeEventListener("click", this.didClick);
    this.element.removeEventListener("contextmenu", this.didContextMenu);

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
}

// The public surface is the two view classes and nothing else. The render
// helpers in ./helpers are reached through a view: `highlight` on the
// `elementForItem` options, and a descriptor return from `elementForItem`.
module.exports.SelectListView = SelectListView;
module.exports.InputDialogView = InputDialogView;
