const SelectListModel = require("../src/select-list-model");

describe("SelectListModel", () => {
  function item(id, label = id) {
    return { id, label };
  }

  describe("stable item identity", () => {
    it("uses primitive items as their own IDs", () => {
      const symbol = Symbol("symbol-item");
      const model = new SelectListModel({ items: [0, false, "text", symbol] });

      expect(model.getSelectedId()).toBe(0);
      model.selectItem(false);
      expect(model.getSelectedId()).toBe(false);
      model.selectId(symbol);
      expect(model.getSelectedItem()).toBe(symbol);
    });

    it("uses item.id for object items by default", () => {
      const alpha = item("alpha");
      const model = new SelectListModel({ items: [alpha] });

      expect(model.getSelectedId()).toBe("alpha");
      expect(model.getSelectedItem()).toBe(alpha);
    });

    it("lets getItemId override primitive and object IDs", () => {
      const model = new SelectListModel({
        items: [item("ignored", "Alpha"), "Beta"],
        getItemId: (value, { index }) => `${index}:${value.label ?? value}`,
      });

      expect(model.getSelectedId()).toBe("0:Alpha");
      expect(model.selectId("1:Beta")).toBe("Beta");
    });

    it("rejects object items without a stable ID", () => {
      expect(() => new SelectListModel({ items: [{ label: "Alpha" }] })).toThrowError(
        TypeError,
        /require a stable `id`/,
      );
    });

    it("rejects null IDs returned by getItemId", () => {
      expect(
        () => new SelectListModel({ items: [item("alpha")], getItemId: () => null }),
      ).toThrowError(TypeError, /non-null primitive/);
    });

    it("rejects duplicate IDs among primitives, objects, and sections", () => {
      expect(() => new SelectListModel({ items: ["same", "same"] })).toThrowError(
        /Duplicate item ID: same/,
      );
      expect(() => new SelectListModel({ items: [item("same"), item("same")] })).toThrowError(
        /Duplicate item ID: same/,
      );
      expect(
        () =>
          new SelectListModel({
            sections: [
              { id: "left", items: [item("same")] },
              { id: "right", items: [item("same")] },
            ],
          }),
      ).toThrowError(/Duplicate item ID: same/);
    });

    it("preserves a selection by ID when objects are replaced", () => {
      const model = new SelectListModel({ items: [item("a"), item("b"), item("c")] });
      model.selectId("b");

      const replacement = item("b", "Replacement");
      model.update({ items: [item("c"), replacement, item("a")] });

      expect(model.getSelectedId()).toBe("b");
      expect(model.getSelectedItem()).toBe(replacement);
      expect(model.getSelectedIndex()).toBe(1);
    });

    it("selectItem can resolve a replacement object carrying the same ID", () => {
      const original = item("alpha");
      const model = new SelectListModel({ items: [original] });

      expect(model.selectItem(item("alpha", "Equal by ID"))).toBe(original);
    });
  });

  describe("atomic updates", () => {
    it("updates source, query, search, and recents as one state change", () => {
      const matcher = jasmine
        .createSpy("matcher")
        .and.callFake((candidates, query) =>
          candidates.filter(({ filterText }) => filterText.startsWith(query)).reverse(),
        );
      const model = new SelectListModel({ items: [item("old", "Old")] });

      model.update({
        items: [item("a", "alpha"), item("b", "beta"), item("ab", "albatross")],
        query: "al",
        recentIds: ["b"],
        search: {
          getFilterText: (value) => value.label,
          matcher,
        },
      });

      expect(matcher).toHaveBeenCalledTimes(1);
      expect(model.getItems().map(({ id }) => id)).toEqual(["a", "b", "ab"]);
      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["ab", "a"]);
      expect(model.getSelectedId()).toBe("ab");
      expect(model.getRecentIds()).toEqual(["b"]);
    });

    it("leaves all prior state intact when a replacement has duplicate IDs", () => {
      const original = [item("a"), item("b")];
      const model = new SelectListModel({ items: original, query: "a", recentIds: ["b"] });
      model.selectId("a");
      const generation = model.getGeneration();

      expect(() =>
        model.update({
          items: [item("duplicate"), item("duplicate")],
          query: "changed",
          recentIds: ["duplicate"],
        }),
      ).toThrowError(/Duplicate item ID/);

      expect(model.getItems()).toEqual(original);
      expect(model.getQuery()).toBe("a");
      expect(model.getRecentIds()).toEqual(["b"]);
      expect(model.getSelectedId()).toBe("a");
      expect(model.getGeneration()).toBe(generation);
    });

    it("leaves all prior state intact when a search callback throws", () => {
      const model = new SelectListModel({ items: ["alpha", "beta"] });
      model.selectId("beta");
      const generation = model.getGeneration();

      expect(() =>
        model.update({
          query: "a",
          search: {
            filter: () => {
              throw new Error("broken filter");
            },
          },
        }),
      ).toThrowError("broken filter");

      expect(model.getQuery()).toBe("");
      expect(model.getFilteredItems()).toEqual(["alpha", "beta"]);
      expect(model.getSelectedId()).toBe("beta");
      expect(model.getGeneration()).toBe(generation);
    });

    it("does not let callers mutate the source through input or output arrays", () => {
      const input = ["alpha", "beta"];
      const model = new SelectListModel({ items: input });
      input.push("gamma");
      model.getItems().pop();
      model.getFilteredItems().splice(0);

      expect(model.getItems()).toEqual(["alpha", "beta"]);
      expect(model.getFilteredItems()).toEqual(["alpha", "beta"]);
    });

    it("treats items and sections as alternative atomic sources", () => {
      const model = new SelectListModel({ items: ["alpha"] });

      expect(() =>
        model.update({ items: ["beta"], sections: [{ id: "group", items: ["gamma"] }] }),
      ).toThrowError(/alternative list sources/);
      expect(model.getItems()).toEqual(["alpha"]);

      model.update({ sections: [{ id: "group", items: ["gamma"] }] });
      expect(model.getItems()).toEqual(["gamma"]);
      model.update({ items: ["delta"] });
      expect(model.getItems()).toEqual(["delta"]);
    });
  });

  describe("filter-text generations and search", () => {
    it("caches filter text across query and recents updates within one generation", () => {
      const getFilterText = jasmine.createSpy("getFilterText").and.callFake((value) => value.label);
      const model = new SelectListModel({
        items: [item("a", "alpha"), item("b", "beta"), item("g", "gamma")],
        search: { getFilterText },
      });

      expect(getFilterText).not.toHaveBeenCalled();
      model.update({ query: "a" });
      expect(getFilterText).toHaveBeenCalledTimes(3);
      model.update({ query: "m" });
      model.update({ recentIds: ["g"] });
      model.getFilteredItems();
      expect(getFilterText).toHaveBeenCalledTimes(3);

      model.update({
        items: [item("a", "alfa"), item("b", "bravo"), item("g", "golf")],
      });
      expect(getFilterText).toHaveBeenCalledTimes(6);
    });

    it("starts a new filter-text generation when search configuration changes", () => {
      const first = jasmine.createSpy("first").and.callFake((value) => value.label);
      const second = jasmine.createSpy("second").and.callFake((value) => value.label.toUpperCase());
      const model = new SelectListModel({
        items: [item("a", "alpha"), item("b", "beta")],
        query: "a",
        search: { getFilterText: first },
      });
      const generation = model.getGeneration();

      model.update({ search: { getFilterText: second } });

      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);
      expect(model.getGeneration()).toBe(generation + 1);
    });

    it("caches repeated context.getFilterText calls inside a custom filter", () => {
      const getFilterText = jasmine.createSpy("getFilterText").and.callFake((value) => value.label);
      const model = new SelectListModel({
        items: [item("a", "alpha"), item("b", "beta")],
        query: "a",
        search: {
          getFilterText,
          filter: (items, query, context) =>
            items.filter((value) => {
              context.getFilterText(value);
              return context.getFilterText(value).includes(query);
            }),
        },
      });

      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["a", "b"]);
      expect(getFilterText).toHaveBeenCalledTimes(2);
    });

    it("performs a default case-insensitive substring search", () => {
      const model = new SelectListModel({
        items: [item("a", "Alpha"), item("b", "BETA"), item("g", "gamma")],
        query: "TA",
      });

      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["b"]);
    });

    it("accepts a custom filter and a replacement object with the same ID", () => {
      const replacement = item("b", "Replacement");
      const filter = jasmine.createSpy("filter").and.returnValue([replacement]);
      const model = new SelectListModel({
        items: [item("a"), item("b")],
        query: "anything",
        search: { filter },
      });

      expect(filter).toHaveBeenCalledTimes(1);
      const [items, query, context] = filter.calls.mostRecent().args;
      expect(items.map(({ id }) => id)).toEqual(["a", "b"]);
      expect(query).toBe("anything");
      expect(context.getFilterText).toEqual(jasmine.any(Function));
      expect(model.getFilteredItems()[0].id).toBe("b");
      expect(model.getFilteredItems()[0].label).toBe("b");
    });

    it("accepts an injected matcher without importing a concrete fuzzy implementation", () => {
      const matcher = jasmine.createSpy("matcher").and.callFake((candidates, query, context) => {
        expect(query).toBe("pick");
        expect(context.generation).toBeGreaterThan(0);
        expect(candidates.map(({ filterText }) => filterText)).toEqual(["Alpha", "Beta", "Gamma"]);
        expect(Object.isFrozen(candidates[0])).toBe(true);
        return [candidates[2], { id: "a" }];
      });
      const model = new SelectListModel({
        items: [item("a", "Alpha"), item("b", "Beta"), item("g", "Gamma")],
        query: "pick",
        search: { getFilterText: (value) => value.label, matcher },
      });

      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["g", "a"]);
      expect(matcher).toHaveBeenCalledTimes(1);
    });

    it("supports matcher index results for a native-matcher adapter", () => {
      const model = new SelectListModel({
        items: ["alpha", "beta", "gamma"],
        query: "query delegated elsewhere",
        search: { matcher: () => [{ index: 1 }, { index: 0 }] },
      });

      expect(model.getFilteredItems()).toEqual(["beta", "alpha"]);
    });

    it("does not confuse an original item index field with a matcher result", () => {
      const indexed = { id: "indexed", index: 999, label: "Indexed item" };
      const model = new SelectListModel({
        items: [indexed, item("other")],
        query: "delegated",
        search: { matcher: () => [indexed] },
      });

      expect(model.getFilteredItems()).toEqual([indexed]);
    });

    it("applies a custom sort after filtering", () => {
      const model = new SelectListModel({
        items: [item("a", "Alpha"), item("b", "Beta"), item("g", "Gamma")],
        query: "a",
        search: {
          getFilterText: (value) => value.label,
          sort: (left, right) => right.label.localeCompare(left.label),
        },
      });

      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["g", "b", "a"]);
    });

    it("rejects ambiguous search strategies and malformed callback results", () => {
      expect(
        () =>
          new SelectListModel({
            items: ["alpha"],
            query: "a",
            search: { filter: () => [], matcher: () => [] },
          }),
      ).toThrowError(/mutually exclusive/);
      expect(
        () =>
          new SelectListModel({
            items: ["alpha"],
            query: "a",
            search: { filter: () => null },
          }),
      ).toThrowError(/must return an array/);
      expect(
        () =>
          new SelectListModel({
            items: ["alpha"],
            query: "a",
            search: { matcher: () => ["missing"] },
          }),
      ).toThrowError(/unknown item/);
      expect(
        () =>
          new SelectListModel({
            items: ["alpha"],
            query: "a",
            search: { matcher: (candidates) => [candidates[0], candidates[0]] },
          }),
      ).toThrowError(/duplicate item ID/);
    });
  });

  describe("sections and recents", () => {
    it("keeps section order without a query and sorts only inside each section", () => {
      const model = new SelectListModel({
        sections: [
          { id: "letters", items: [item("b", "Beta"), item("a", "Alpha")] },
          { id: "numbers", items: [item("two", "Two"), item("one", "One")] },
        ],
        search: { sort: (left, right) => left.label.localeCompare(right.label) },
      });

      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["a", "b", "one", "two"]);
      expect(model._getFilteredRecords().map(({ sectionId }) => sectionId)).toEqual([
        "letters",
        "letters",
        "numbers",
        "numbers",
      ]);
    });

    it("flattens sections into one ranked result set while querying", () => {
      const model = new SelectListModel({
        sections: [
          { id: "first", items: [item("z", "Zulu"), item("a", "Alpha")] },
          { id: "second", items: [item("m", "Mike"), item("b", "Bravo")] },
        ],
        query: "a",
        search: {
          getFilterText: (value) => value.label,
          sort: (left, right) => left.label.localeCompare(right.label),
        },
      });

      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["a", "b"]);
      expect(model._getFilteredRecords().map(({ sectionId }) => sectionId)).toEqual([null, null]);
      expect(model._getFilteredRecords().map(({ sourceSectionId }) => sourceSectionId)).toEqual([
        "first",
        "second",
      ]);
    });

    it("rejects malformed and duplicate sections", () => {
      expect(() => new SelectListModel({ sections: [{ items: [] }] })).toThrowError(/Section 0 ID/);
      expect(
        () =>
          new SelectListModel({
            sections: [
              { id: "same", items: [] },
              { id: "same", items: [] },
            ],
          }),
      ).toThrowError(/Duplicate section ID: same/);
      expect(() => new SelectListModel({ sections: [{ id: "broken", items: null }] })).toThrowError(
        /items must be an array/,
      );
    });

    it("hoists known recent IDs only while the query is empty", () => {
      const model = new SelectListModel({
        items: [item("a", "Alpha"), item("b", "Beta"), item("g", "Gamma")],
        recentIds: ["g", "missing", "a", "g"],
        search: { getFilterText: (value) => value.label },
      });

      expect(model.getRecentIds()).toEqual(["g", "missing", "a"]);
      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["g", "a", "b"]);
      expect(model._getFilteredRecords().map(({ recent }) => recent)).toEqual([true, true, false]);

      model.update({ query: "a" });
      expect(model.getFilteredItems().map(({ id }) => id)).toEqual(["a", "b", "g"]);
      expect(model._getFilteredRecords().every(({ recent }) => !recent)).toBe(true);
    });

    it("preserves selection by ID when recents reorder the list", () => {
      const model = new SelectListModel({ items: ["alpha", "beta", "gamma"] });
      model.selectId("beta");

      model.update({ recentIds: ["gamma"] });

      expect(model.getFilteredItems()).toEqual(["gamma", "alpha", "beta"]);
      expect(model.getSelectedId()).toBe("beta");
      expect(model.getSelectedIndex()).toBe(2);
    });
  });

  describe("selection", () => {
    it("selects the first result initially and after a query change", () => {
      const model = new SelectListModel({ items: ["alpha", "beta", "gamma"] });
      model.selectId("gamma");

      model.update({ query: "a" });

      expect(model.getSelectedItem()).toBe("alpha");
      expect(model.getSelectedIndex()).toBe(0);
    });

    it("selects none initially and after query changes when empty selection is allowed", () => {
      const model = new SelectListModel({
        items: ["alpha", "beta"],
        allowEmptySelection: true,
      });
      expect(model.getSelectedItem()).toBeNull();
      expect(model.getSelectedId()).toBeNull();
      expect(model.getSelectedIndex()).toBe(-1);

      model.selectId("beta");
      model.update({ query: "a" });
      expect(model.getSelectedItem()).toBeNull();
    });

    it("falls back to first or none when a data update removes the selection", () => {
      const first = new SelectListModel({ items: ["alpha", "beta"] });
      first.selectId("beta");
      first.update({ items: ["gamma"] });
      expect(first.getSelectedItem()).toBe("gamma");

      const empty = new SelectListModel({
        items: ["alpha", "beta"],
        allowEmptySelection: true,
      });
      empty.selectId("beta");
      empty.update({ items: ["gamma"] });
      expect(empty.getSelectedItem()).toBeNull();
    });

    it("supports strict index, ID, item, first, last, and none selection", () => {
      const model = new SelectListModel({ items: ["alpha", "beta", "gamma"] });

      expect(model.selectIndex(1)).toBe("beta");
      expect(model.selectLast()).toBe("gamma");
      expect(model.selectFirst()).toBe("alpha");
      expect(model.selectNone()).toBeNull();
      expect(model.selectItem("beta")).toBe("beta");
      expect(() => model.selectIndex(-1)).toThrowError(RangeError);
      expect(() => model.selectIndex(3)).toThrowError(RangeError);
      expect(() => model.selectId("missing")).toThrowError(RangeError);
    });

    it("wraps navigation and passes through an allowed empty selection", () => {
      const wrapping = new SelectListModel({ items: ["alpha", "beta"] });
      expect(wrapping.selectPrevious()).toBe("beta");
      expect(wrapping.selectNext()).toBe("alpha");

      const withEmpty = new SelectListModel({
        items: ["alpha", "beta"],
        allowEmptySelection: true,
      });
      expect(withEmpty.selectNext()).toBe("alpha");
      expect(withEmpty.selectPrevious()).toBeNull();
      expect(withEmpty.selectPrevious()).toBe("beta");
      expect(withEmpty.selectNext()).toBeNull();
    });

    it("has no selection when filtering produces no results", () => {
      const model = new SelectListModel({ items: ["alpha"], query: "missing" });

      expect(model.getSelectedItem()).toBeNull();
      expect(model.getSelectedIndex()).toBe(-1);
      expect(model.selectNext()).toBeNull();
      expect(model.selectPrevious()).toBeNull();
    });
  });

  describe("pagination", () => {
    it("displays 99 items per page without appending a sentinel", () => {
      const items = Array.from({ length: 250 }, (_, index) => `item-${index}`);
      const model = new SelectListModel({ items });

      expect(model.getFilteredItems().length).toBe(250);
      expect(model.getDisplayedItems()).toEqual(items.slice(0, 99));
      expect(model.getDisplayedCount()).toBe(99);
      expect(model.hasMore()).toBe(true);

      expect(model.showMore()).toBe(true);
      expect(model.getDisplayedItems()).toEqual(items.slice(0, 198));
      expect(model.showMore()).toBe(true);
      expect(model.getDisplayedItems()).toEqual(items);
      expect(model.hasMore()).toBe(false);
      expect(model.showMore()).toBe(false);
    });

    it("keeps selection while revealing another page", () => {
      const items = Array.from({ length: 120 }, (_, index) => `item-${index}`);
      const model = new SelectListModel({ items });
      model.selectId("item-50");

      model.showMore();

      expect(model.getSelectedId()).toBe("item-50");
    });

    it("reveals the next page when navigation crosses the displayed boundary", () => {
      const items = Array.from({ length: 120 }, (_, index) => `item-${index}`);
      const model = new SelectListModel({ items });
      model.selectIndex(98);

      expect(model.selectNext()).toBe("item-99");
      expect(model.getDisplayedCount()).toBe(120);
      expect(model.hasMore()).toBe(false);
    });

    it("expands enough pages to make an explicitly selected ID visible", () => {
      const items = Array.from({ length: 250 }, (_, index) => item(index, `Item ${index}`));
      const model = new SelectListModel({ items });

      model.selectId(210);

      expect(model.getSelectedId()).toBe(210);
      expect(model.getDisplayedCount()).toBe(250);
      expect(model.getDisplayedItems()).toContain(items[210]);
    });

    it("keeps a preserved selection visible after a replacement data update", () => {
      const original = Array.from({ length: 150 }, (_, index) => item(index));
      const model = new SelectListModel({ items: original });
      model.selectId(120);

      const replacements = original.map(({ id }) => item(id, `Replacement ${id}`));
      model.update({ items: replacements });

      expect(model.getSelectedId()).toBe(120);
      expect(model.getDisplayedCount()).toBe(150);
      expect(model.getSelectedItem()).toBe(replacements[120]);
    });

    it("resets pagination when the query changes", () => {
      const items = Array.from({ length: 220 }, (_, index) => `item-${index}`);
      const model = new SelectListModel({ items });
      model.showMore();
      expect(model.getDisplayedCount()).toBe(198);

      model.update({ query: "item" });

      expect(model.getDisplayedCount()).toBe(99);
      expect(model.hasMore()).toBe(true);
    });

    it("supports an explicit positive page size", () => {
      const model = new SelectListModel({ items: [1, 2, 3, 4, 5], pageSize: 2 });
      expect(model.getDisplayedItems()).toEqual([1, 2]);
      model.showMore();
      expect(model.getDisplayedItems()).toEqual([1, 2, 3, 4]);

      expect(() => model.update({ pageSize: 0 })).toThrowError(RangeError, /positive integer/);
      expect(model.getPageSize()).toBe(2);
    });
  });
});
