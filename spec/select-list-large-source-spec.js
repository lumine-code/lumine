describe("SelectList large sources", () => {
  let list;
  const values = Array.from({ length: 8193 }, (_, i) => `Żółć/sample-${i}.js`);
  function create(search = {}) {
    return lumine.workspace.buildSelectList({
      items: values,
      search: {
        ignoreDiacritics: true,
        algorithm: "command-t",
        ...search,
      },
    });
  }
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await list?.destroy();
    list = null;
  });

  it("reuses preparation when new input arrives after extraction has started", async () => {
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    let extractions = 0;
    list = create({
      getFilterText(value) {
        extractions++;
        began();
        return value;
      },
    });
    const old = list.setQuery("zolc");
    await started;
    const latest = list.setQuery("sample");
    await Promise.all([old, latest]);
    expect(list.getMatchCount()).toBe(values.length);
    expect(extractions).toBe(values.length);
    expect(list.workerPreparation.next).toBe(values.length);
  });
  it("cancels when the query clears or the list is destroyed", async () => {
    list = create();
    const pending = list.setQuery("sample");
    await list.setQuery("");
    await pending;
    expect(list.getMatchCount()).toBe(values.length);
    const later = list.setQuery("sample");
    await list.destroy();
    await later;
    expect(list.queryWork).toBeNull();
  });
  it("keeps the current search alive when a replacement transaction is rejected", async () => {
    list = create();
    const pending = list.setQuery("sample");
    expect(() => list.update({ items: ["duplicate", "duplicate"] })).toThrow();
    await pending;
    expect(list.getMatchCount()).toBe(values.length);
    expect(list.getQuery()).toBe("sample");
  });
  it("keeps custom matcher callbacks synchronous", async () => {
    const matcher = jasmine.createSpy("matcher").and.callFake((rows) => rows);
    list = create({ matcher });
    const pending = list.setQuery("sample");
    expect(matcher).toHaveBeenCalled();
    expect(list.getMatchCount()).toBe(values.length);
    await pending;
  });
  it("does not materialize complete item snapshots to count or move selection", async () => {
    list = create();
    spyOn(list.model, "getItems").and.callThrough();
    spyOn(list.model, "getFilteredItems").and.callThrough();
    expect(list.getItemCount()).toBe(values.length);
    expect(list.getMatchCount()).toBe(values.length);
    await list.selectIndex(1);
    expect(list.model.getItems).not.toHaveBeenCalled();
    expect(list.model.getFilteredItems).not.toHaveBeenCalled();
  });

  it("captures action items lazily from the original source with frozen snapshot semantics", async () => {
    list = create();
    const context = list.getActionContext();
    Object.freeze(context);
    const records = list.model._records;
    spyOn(records, "map").and.callThrough();
    const snapshot = list.dialogActions.snapshot(context);
    expect(records.map).not.toHaveBeenCalled();
    await list.update({ items: ["replacement"] });
    expect(snapshot.items).toEqual(values);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(records.map.calls.count()).toBe(1);
    expect(snapshot.items).toBe(snapshot.items);

    const modified = list.getActionContext();
    modified.items.push("extra");
    expect(list.dialogActions.snapshot(modified).items).toEqual(["replacement", "extra"]);
    modified.items = ["override"];
    expect(list.dialogActions.snapshot(modified).items).toEqual(["override"]);
    expect(list.getItems()).toEqual(["replacement"]);
  });
});
