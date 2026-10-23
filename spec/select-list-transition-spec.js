describe("SelectList backend state transitions", () => {
  let worker;
  let synchronous;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await Promise.all([worker?.destroy(), synchronous?.destroy()]);
  });

  it("keeps results, selection and highlights equivalent through changing sources and searches", async () => {
    const sources = [0, 1].map((revision) =>
      Object.freeze(
        Array.from({ length: 2173 }, (_, id) =>
          Object.freeze({ id, text: `src/Żółć-${id % 17}/sample-${revision}-${id}.js` }),
        ),
      ),
    );
    const search = (step) => ({
      getFilterText: (item) => item.text,
      algorithm: step % 2 ? "command-t" : "fuzzaldrin",
      ignoreDiacritics: step % 3 !== 0,
      scoreModifier: (score, item) => (item.id % 11 === 0 ? 0 : score * (1 + (item.id % 3))),
      ...(step % 4 === 0 ? { sort: (a, b) => b.id - a.id } : {}),
    });
    worker = lumine.workspace.buildSelectList({ items: sources[0], search: search(0) });
    synchronous = lumine.workspace.buildSelectList({
      items: sources[0],
      search: { ...search(0), worker: false },
    });
    const queries = ["s", "sa", "sample-1", "zolc", "Żółć", "missing", "", "42"];
    for (let step = 0; step < 24; step++) {
      const props = {
        query: queries[step % queries.length],
        ...(step % 3 === 0 ? { items: sources[Math.floor(step / 3) % 2] } : {}),
        ...(step % 4 === 0 ? { search: search(step / 4) } : {}),
        ...(step % 5 === 0 ? { recentItemIds: [42, 7, 11] } : {}),
      };
      // Supersede real worker work before applying the final state.
      const obsolete = worker.setQuery("obsolete");
      await Promise.all([
        obsolete,
        worker.update(props),
        synchronous.update({
          ...props,
          ...(props.search ? { search: { ...props.search, worker: false } } : {}),
        }),
      ]);
      expect(worker.getFilteredItems())
        .withContext(`results at step ${step}`)
        .toEqual(synchronous.getFilteredItems());
      expect(worker.getSelectedItemId())
        .withContext(`selection at step ${step}`)
        .toBe(synchronous.getSelectedItemId());
      const matches = worker.getFilteredItems();
      for (const item of [matches[0], matches[110], matches.at(-1)].filter(Boolean)) {
        expect(worker.getMatchIndices(item))
          .withContext(`highlight at step ${step}`)
          .toEqual(synchronous.getMatchIndices(item));
      }
    }
  });
});
