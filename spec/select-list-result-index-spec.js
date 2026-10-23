const SelectListModel = require("../src/select-list-model");

describe("SelectList prepared result positions", () => {
  let list;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await list?.destroy();
    list = null;
  });

  function denseItems() {
    const ids = [false, true, 0, "0", "", 1n, Symbol("row"), NaN];
    return Array.from({ length: 4096 }, (_, index) => ({
      id: index < ids.length ? ids[index] : `row-${index}`,
      index,
      text: "match",
    }));
  }

  function assertPositions(model, items) {
    expect(model.getFilteredItems()).toEqual(items);
    for (let index = 0; index < items.length; index++) {
      expect(model._filteredIndexById.get(items[index].id))
        .withContext(`position of source row ${items[index].index}`)
        .toBe(index);
    }
    expect(model._filteredIndexById.has("absent")).toBe(false);
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 2048, items.length - 1]) {
      model.selectId(items[index].id);
      expect(model.getSelectedIndex()).toBe(index);
      expect(model.getSelectedItem()).toBe(items[index]);
    }
  }

  it("publishes all dense mixed-ID positions atomically after real worker ranking", async () => {
    const items = denseItems();
    list = lumine.workspace.buildSelectList({
      items,
      search: { getFilterText: (item) => item.text },
    });
    const prepare = list.model._prepareResultIndex;
    let prepared;
    let publishedIndex;
    spyOn(list.model, "_prepareResultIndex").and.callFake(function (records) {
      prepared = prepare.call(this, records);
      publishedIndex = this._filteredIndexById;
      const add = prepared.add;
      prepared.add = (record, position) => {
        add(record, position);
        if (position === 0 || position === records.length - 1) {
          expect(this._filteredIndexById).toBe(publishedIndex);
          expect(this.getMatchCount()).toBe(0);
        }
      };
      return prepared;
    });

    await list.setQuery("match");
    expect(list.workerPreparation.next).toBe(items.length);
    expect(prepared.count).toBe(items.length);
    expect(list.model._filteredIndexById).toBe(prepared.index);
    expect(list.model._filteredIndexById).not.toBe(publishedIndex);
    assertPositions(list.model, items);
  });

  it("indexes flattened section records by their original source positions", async () => {
    const items = denseItems();
    list = lumine.workspace.buildSelectList({
      sections: [
        { id: "first", items: items.slice(0, 2048) },
        { id: "second", items: items.slice(2048) },
      ],
      search: { getFilterText: (item) => item.text },
    });
    await list.setQuery("match");
    expect(list.workerPreparation.next).toBe(items.length);
    assertPositions(list.model, items);
    for (const index of [0, 2047, 2048, 4095]) {
      const record = list.model._filteredRecords[index];
      expect(record.sectionId).toBeNull();
      expect(record.sourceSectionId).toBe(index < 2048 ? "first" : "second");
      expect(record.sourceIndex).toBe(index);
      expect(record).not.toBe(list.model._records[index]);
    }
    await list.setQuery("");
    expect(list.model._filteredRecords[2048].sectionId).toBe("second");
    assertPositions(list.model, items);
  });

  it("uses final custom-sort positions rather than worker rank positions", async () => {
    const items = denseItems();
    list = lumine.workspace.buildSelectList({
      items,
      search: {
        getFilterText: (item) => item.text,
        sort: (left, right, context) => (context.query ? right.index - left.index : 0),
      },
    });
    await list.setQuery("match");
    expect(list.workerPreparation.next).toBe(items.length);
    assertPositions(list.model, items.slice().reverse());
  });

  it("cannot publish a partially built index after its query is superseded", async () => {
    const items = denseItems();
    list = lumine.workspace.buildSelectList({
      items,
      search: { getFilterText: (item) => item.text },
    });
    const prepare = list.model._prepareResultIndex;
    let abandoned;
    let replacement;
    let replacementIndex;
    spyOn(list.model, "_prepareResultIndex").and.callFake(function (records) {
      abandoned = prepare.call(this, records);
      const add = abandoned.add;
      abandoned.add = (record, position) => {
        add(record, position);
        if (position === 31) {
          expect(abandoned.count).toBe(32);
          expect(abandoned.count).toBeLessThan(records.length);
          expect(this._filteredIndexById).not.toBe(abandoned.index);
          // Supersede at an observed preparation boundary, independent of the
          // host's clock speed or whether this particular batch needs to yield.
          replacement = list.setQuery("");
          replacementIndex = this._filteredIndexById;
        }
      };
      return abandoned;
    });
    await list.setQuery("match");
    expect(replacement).toBeDefined();
    await replacement;
    expect(list.isFiltering()).toBe(false);
    expect(list.model.getQuery()).toBe("");
    expect(list.model._filteredIndexById).toBe(replacementIndex);
    expect(list.model._filteredIndexById).not.toBe(abandoned.index);
    assertPositions(list.model, items);
  });

  for (const invalid of ["incomplete", "different source", "different ID table", "reordered"]) {
    it(`rebuilds positions when the prepared index is ${invalid}`, () => {
      const items = denseItems();
      const model = new SelectListModel({ items });
      const records = model._records.slice().reverse();
      const prepared = model._prepareResultIndex(records);
      const count = invalid === "incomplete" ? records.length - 1 : records.length;
      for (let index = 0; index < count; index++) prepared.add(records[index], index);
      if (invalid === "different source") prepared.sourceRecords = model._records.slice();
      if (invalid === "different ID table") prepared.recordById = new Map(model._recordById);
      const finalRecords = invalid === "reordered" ? records.slice().reverse() : records;

      model._applyUpdate({ query: "match" }, false, finalRecords, prepared);
      expect(model._filteredIndexById).not.toBe(prepared.index);
      assertPositions(
        model,
        finalRecords.map((record) => record.item),
      );
    });
  }
});
