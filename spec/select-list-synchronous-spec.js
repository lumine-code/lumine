describe("SelectList synchronous search", () => {
  let list;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await list?.destroy();
    list = null;
  });

  it("prepares text only on demand even when idle preparation is requested", async () => {
    const values = Array.from({ length: 4097 }, (_, i) => `Żółć-${i}`);
    const extract = jasmine.createSpy("extract").and.callFake((value) => value);
    list = lumine.workspace.buildSelectList({
      items: values,
      search: {
        worker: false,
        prepareOnIdle: true,
        ignoreDiacritics: true,
        getFilterText: extract,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(extract).not.toHaveBeenCalled();
    expect(list.filterMatcher).toBeNull();
    expect(list.workerPreparation).toBeNull();
    const pending = list.setQuery("zolc");
    expect(list.getMatchCount()).toBe(values.length);
    expect(list.isFiltering()).toBe(false);
    expect(list.workerPreparation).toBeNull();
    await pending;
    await list.setQuery("zolc42");
    expect(extract.calls.count()).toBe(values.length);
    expect(list.getMatchIndices("Żółć-42")).toEqual([0, 1, 2, 3, 5, 6]);
  });

  for (const algorithm of ["command-t", "fuzzaldrin"]) {
    it(`reuses text but reevaluates scores and Unicode highlights with ${algorithm}`, async () => {
      const values = ["Straße", "ss", "Żółć/alpha.js", "Zolc/beta.js"];
      let factor = 1;
      const modifier = (score, item) => score * (item.includes("alpha") ? factor : 1);
      const extract = jasmine.createSpy("extract").and.callFake((value) => value);
      list = lumine.workspace.buildSelectList({
        items: values,
        search: {
          worker: false,
          algorithm,
          ignoreDiacritics: true,
          getFilterText: extract,
          scoreModifier: modifier,
        },
      });
      const reference = lumine.tools.fuzzyMatcher.setCandidates(values, { ignoreDiacritics: true });
      for (const query of ["s", "ss", "zolc", "zolc"]) {
        factor++;
        const pending = list.setQuery(query);
        const expected = reference.match(query, {
          algorithm,
          scoreModifier: (score, id) => modifier(score, values[id]),
        });
        expect(list.getFilteredItems()).toEqual(expected.map((row) => row.value));
        expect(list.isFiltering()).toBe(false);
        await pending;
        for (const row of expected)
          expect(list.getMatchIndices(row.value)).toEqual(
            reference.getMatchIndexes(row.id, query, { algorithm }),
          );
      }
      expect(extract.calls.count()).toBe(values.length);
      await list.setItems(["new alpha"]);
      await list.setQuery("alpha");
      expect(list.getFilteredItems()).toEqual(["new alpha"]);
    });
  }

  it("recovers prepared candidates after a rejected source transaction", async () => {
    let fail = false;
    list = lumine.workspace.buildSelectList({
      items: ["alpha", "beta"],
      search: {
        worker: false,
        scoreModifier(score) {
          if (fail) throw new Error("score failed");
          return score;
        },
      },
    });
    await list.setQuery("a");
    const original = list.getFilteredItems();
    fail = true;
    expect(() => list.setItems(["alpine", "other"])).toThrowError("score failed");
    expect(list.getItems()).toEqual(["alpha", "beta"]);
    expect(list.getFilteredItems()).toEqual(original);
    fail = false;
    // The next transaction reuses the rejected generation number with new records.
    await list.setItems(["alpine", "last"]);
    await list.setQuery("last");
    expect(list.getFilteredItems()).toEqual(["last"]);
    expect(list.getMatchIndices("last")).toEqual([0, 1, 2, 3]);
  });
});
