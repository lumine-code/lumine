describe("SelectList idle candidate preparation", () => {
  let list;
  const values = Array.from({ length: 3072 }, (_, i) => `Żółć-${i}`);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function ready() {
    const deadline = performance.now() + 5000;
    while (list.matcherPreparation && performance.now() < deadline) await pause();
    expect(list.matcherPreparation).toBeNull();
  }
  function create(search = {}, items = values, source) {
    return lumine.workspace.buildSelectList({
      items,
      source,
      search: {
        worker: false,
        prepareOnIdle: true,
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

  it("prepares each text once before a query and preserves ordered results and original offsets", async () => {
    const text = jasmine.createSpy("text").and.callFake((value) => value);
    list = create({ getFilterText: text });
    await ready();
    expect(text.calls.count()).toBe(values.length);
    const expected = lumine.tools.fuzzyMatcher
      .setCandidates(values, { ignoreDiacritics: true })
      .match("zolc42", { algorithm: "command-t" })
      .map((match) => match.value);
    await list.setQuery("zolc42");
    expect(list.getFilteredItems()).toEqual(expected);
    expect(list.getMatchIndices("Żółć-42")).toEqual([0, 1, 2, 3, 5, 6]);
    expect(text.calls.count()).toBe(values.length);
  });

  it("finishes an immediate query exactly once and cancels its pending task", async () => {
    const text = jasmine.createSpy("text").and.callFake((value) => value);
    list = create({ getFilterText: text });
    await list.setQuery("zolc");
    expect(list.getMatchCount()).toBe(values.length);
    await pause();
    expect(text.calls.count()).toBe(values.length);
    expect(list.matcherPreparation).toBeNull();
  });

  it("discards an old source when replacement arrives before preparation finishes", async () => {
    list = create();
    const replacement = values.map((_, i) => `beta-${i}`);
    await list.update({ items: replacement });
    await ready();
    await list.setQuery("zolc");
    expect(list.getFilteredItems()).toEqual([]);
    await list.setQuery("beta");
    expect(list.getMatchCount()).toBe(replacement.length);
  });

  it("does not keep preparing a destroyed list", async () => {
    const text = jasmine.createSpy("text").and.callFake((value) => value);
    list = create({ getFilterText: text });
    await list.destroy();
    await pause();
    expect(text).not.toHaveBeenCalled();
    expect(list.matcherPreparation).toBeNull();
  });

  it("leaves custom matchers and query sources in charge of their work", async () => {
    const text = jasmine.createSpy("text").and.callFake((value) => value);
    list = create({ getFilterText: text, matcher: (candidates) => candidates });
    await pause();
    expect(text).not.toHaveBeenCalled();
    await list.destroy();
    list = create({ getFilterText: text }, values, { mode: "query", load: () => values });
    await pause();
    expect(text).not.toHaveBeenCalled();
    expect(list.matcherPreparation).toBeNull();
  });

  it("retries extraction failures on the normal transactional query path", async () => {
    let fail = true;
    list = create({
      getFilterText(value) {
        if (fail && value === values[1024]) throw new Error("extraction failed");
        return value;
      },
    });
    await ready();
    expect(() => list.model.update({ query: "zolc" })).toThrowError("extraction failed");
    expect(list.model.getQuery()).toBe("");
    fail = false;
    await list.setQuery("zolc");
    expect(list.getMatchCount()).toBe(values.length);
  });
});
