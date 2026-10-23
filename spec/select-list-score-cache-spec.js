describe("SelectList score cache", () => {
  let list;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await list?.destroy();
  });

  for (const worker of [false, true]) {
    for (const algorithm of ["command-t", "fuzzaldrin"]) {
      it(`refreshes changed modifier state without rebuilding candidates (${worker}/${algorithm})`, async () => {
        let wanted = "alpha";
        const modifier = jasmine
          .createSpy("modifier")
          .and.callFake((score, item) => (item === wanted ? score : 0));
        const text = jasmine.createSpy("text").and.callFake((item) => item);
        list = lumine.workspace.buildSelectList({
          items: Object.freeze(["alpha", "alpine"]),
          search: { worker, algorithm, getFilterText: text, scoreModifier: modifier },
        });
        await list.setQuery("al");
        expect(list.getFilteredItems()).toEqual(["alpha"]);
        const preparation = list.workerPreparation;
        const matcher = list.filterMatcher;
        if (worker) spyOn(preparation.client, "request").and.callThrough();
        await list.setQuery("");
        await list.setQuery("al");
        expect(modifier.calls.count()).toBe(2);
        if (worker) expect(preparation.client.request).not.toHaveBeenCalled();
        wanted = "alpine";
        await list.refreshScores();
        expect(list.getFilteredItems()).toEqual(["alpine"]);
        expect(modifier.calls.count()).toBe(4);
        expect(text.calls.count()).toBe(2);
        expect(list.workerPreparation).toBe(preparation);
        expect(list.filterMatcher).toBe(matcher);
        await list.setQuery("al");
        expect(modifier.calls.count()).toBe(4);
        await list.setItems(["alpha", "alpine", "all"]);
        expect(modifier.calls.count()).toBe(7);
        const replacement = jasmine
          .createSpy("replacement")
          .and.callFake((score, item) => (item === "all" ? score : 0));
        await list.update({ search: { worker, algorithm, scoreModifier: replacement } });
        expect(list.getFilteredItems()).toEqual(["all"]);
        expect(replacement.calls.count()).toBe(3);
      });
    }

    it(`refresh invalidates both scores and extracted text with worker=${worker}`, async () => {
      let wanted = "alpha";
      const modifier = (score, item) => (item === wanted ? score : 0);
      list = lumine.workspace.buildSelectList({
        items: Object.freeze(["alpha", "alpine"]),
        search: { worker, scoreModifier: modifier },
      });
      await list.setQuery("al");
      wanted = "alpine";
      await list.refresh();
      expect(list.getFilteredItems()).toEqual(["alpine"]);
    });
  }

  it("does not publish or cache results cancelled during score invalidation", async () => {
    let wanted = "alpha",
      invalidation;
    let invalidate = true;
    list = lumine.workspace.buildSelectList({
      items: ["alpha", "alpine"],
      search: {
        scoreModifier: (score, item) => {
          if (invalidate) {
            invalidate = false;
            wanted = "alpine";
            invalidation = list.refreshScores();
          }
          return item === wanted ? score : 0;
        },
      },
    });
    await list.setQuery("al");
    await invalidation;
    expect(list.getFilteredItems()).toEqual(["alpine"]);
    await list.setQuery("al");
    expect(list.getFilteredItems()).toEqual(["alpine"]);
  });

  it("owns cached highlights and bounds retained worker rankings", async () => {
    const values = Array.from({ length: 120 }, (_, i) => `alpha-${i}`);
    list = lumine.workspace.buildSelectList({
      items: values,
      search: { scoreModifier: (score) => score },
    });
    await list.setQuery("al");
    list.getMatchIndices(values[0]).push(999);
    await list.setQuery("al");
    expect(list.getMatchIndices(values[0])).not.toContain(999);
    for (const query of ["a", "alp", "alph", "alpha", "0", "1", "2", "3", "4", "5"])
      await list.setQuery(query);
    expect(list.workerPreparation.rankings.size).toBeLessThanOrEqual(8);
    expect(list.workerPreparation.rankingBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    await list.setQuery("al");
    expect(list.getMatchCount()).toBe(values.length);
  });
});
