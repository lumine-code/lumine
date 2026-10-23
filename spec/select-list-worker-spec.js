describe("SelectList worker search", () => {
  it("keeps required long-input highlights across the Chromium worker boundary", async () => {
    const Client = require("../src/fuzzy-search-worker-client");
    const client = new Client({ ignoreDiacritics: false });
    try {
      await client.ready;
      await client.request("add", { offset: 0, values: ["a".repeat(43000)] });
      const result = await client.request("rank", {
        query: "-" + "a".repeat(100),
        options: { algorithm: "fuzzaldrin" },
        highlightCount: 1,
      });
      expect(Array.from(result.order)).toEqual([0]);
      expect(result.highlights[0].indexes).toEqual(Array.from({ length: 100 }, (_, i) => i));
    } finally {
      client.close();
    }
  });

  it("uses corrected long-input scoring across worker requests", async () => {
    const Client = require("../src/fuzzy-search-worker-client");
    const client = new Client({ ignoreDiacritics: false });
    try {
      await client.ready;
      await client.request("add", { offset: 0, values: ["A".repeat(20) + "b" + "a".repeat(500)] });
      const options = { algorithm: "command-t", smartCase: true };
      expect(
        Array.from(
          (await client.request("rank", { query: "A".repeat(20), options, highlightCount: 1 }))
            .order,
        ),
      ).toEqual([]);
      const result = await client.request("rank", {
        query: "A".repeat(20) + "b",
        options,
        highlightCount: 1,
      });
      expect(Array.from(result.order)).toEqual([0]);
      expect(result.highlights[0].indexes).toEqual(Array.from({ length: 21 }, (_, i) => i));
    } finally {
      client.close();
    }
  });
  let list;
  let host;
  const values = Array.from({ length: 4097 }, (_, i) => `src/Żółć-${i % 17}/sample-${i}.js`);
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    if (host) await host.destroy();
    else await list?.destroy();
    host = list = null;
  });
  function options(search = {}) {
    return {
      items: values,
      search: {
        ignoreDiacritics: true,
        algorithm: "command-t",
        ...search,
      },
    };
  }
  for (const worker of [true, false]) {
    it(`invalidates external filter text on explicit refresh with worker=${worker}`, async () => {
      let descriptions = false;
      const items = Object.freeze([Object.freeze({ id: "command", name: "Run" })]);
      list = lumine.workspace.buildSelectList({
        items,
        search: { worker, getFilterText: (item) => item.name + (descriptions ? " zzyzx" : "") },
      });
      await list.setQuery("zzyzx");
      expect(list.getMatchCount()).toBe(0);
      descriptions = true;
      await list.refresh();
      expect(list.getFilteredItems()).toEqual(items);
      descriptions = false;
      await list.refresh();
      expect(list.getMatchCount()).toBe(0);
    });
  }
  it("uses a worker by default even for a small list without search options", async () => {
    list = lumine.workspace.buildSelectList({
      items: ["alpha", "beta"],
    });
    expect(list.workerPreparation).toBeNull();
    const small = list.setQuery("a");
    expect(list.isFiltering()).toBe(true);
    await small;
    expect(list.getMatchCount()).toBe(2);
    expect(list.workerPreparation.next).toBe(2);
    const preparation = list.workerPreparation;
    await list.setQuery("al");
    expect(list.getFilteredItems()).toEqual(["alpha"]);
    expect(list.workerPreparation).toBe(preparation);
  });
  it("lets a list explicitly disable the worker", async () => {
    list = lumine.workspace.buildSelectList({
      items: ["alpha", "beta"],
      search: { worker: false, prepareOnIdle: true },
    });
    const ordinary = list.setQuery("a");
    expect(list.getMatchCount()).toBe(2);
    expect(list.queryWork).toBeNull();
    expect(list.workerPreparation).toBeNull();
    await ordinary;
  });
  it("does not create a worker for an empty source", async () => {
    list = lumine.workspace.buildSelectList({ items: [], query: "a" });
    expect(list.queryWork).toBeNull();
    expect(list.workerPreparation).toBeNull();
    await list.update({ items: ["alpha"] });
    expect(list.getFilteredItems()).toEqual(["alpha"]);
    expect(list.workerPreparation.next).toBe(1);
  });
  it("keeps a custom sort and its context after worker ranking", async () => {
    const items = [
      { id: "a", text: "alpha" },
      { id: "b", text: "alpine" },
    ];
    const sort = (left, right, context) => {
      expect(context.getItemId(left)).toBe(left.id);
      expect(context.getFilterText(right)).toBe(right.text);
      return context.query ? right.id.localeCompare(left.id) : 0;
    };
    list = lumine.workspace.buildSelectList({
      items,
      search: { getFilterText: (item) => item.text, sort },
    });
    await list.setQuery("al");
    expect(list.workerPreparation.next).toBe(2);
    expect(list.getFilteredItems()).toEqual([items[1], items[0]]);
    expect(list.getSelectedItem()).toBe(items[1]);
  });
  it("closes the worker when explicitly disabled and can enable it again", async () => {
    list = lumine.workspace.buildSelectList({ items: ["alpha", "beta"] });
    await list.setQuery("a");
    const client = list.workerPreparation.client;
    const expected = list.getFilteredItems();
    await list.update({ search: { worker: false } });
    expect(client.closed).toBe(true);
    expect(list.workerPreparation).toBeNull();
    expect(list.getFilteredItems()).toEqual(expected);
    await list.update({ search: {} });
    expect(list.workerPreparation.client).not.toBe(client);
    expect(list.getFilteredItems()).toEqual(expected);
  });
  it("keeps filtered selection and pending ranking when another window updates recents", async () => {
    list = lumine.workspace.buildSelectList({ items: ["alpha", "alpine"] });
    await list.setQuery("al");
    await list.selectItem("alpine");
    const results = list.model._filteredRecords;
    const changed = list.setRecentItemIds(["alpha"]);
    expect(list.isFiltering()).toBe(false);
    expect(list.getSelectedItem()).toBe("alpine");
    expect(list.model._filteredRecords).toBe(results);
    await changed;
    const pending = list.setQuery("a");
    const work = list.queryWork;
    const recent = list.setRecentItemIds(["alpine"]);
    expect(list.queryWork).toBe(work);
    await Promise.all([pending, recent]);
    expect(list.getMatchCount()).toBe(2);
  });
  for (const algorithm of ["command-t", "fuzzaldrin"]) {
    it(`keeps every adjusted result and visible highlight equivalent with ${algorithm}`, async () => {
      let factor = 1;
      const modifier = (score, item) => score * (item.includes("-42.") ? factor : 1);
      list = lumine.workspace.buildSelectList(options({ algorithm, scoreModifier: modifier }));
      const reference = lumine.tools.fuzzyMatcher.setCandidates(values, { ignoreDiacritics: true });
      for (const query of ["s", "sa", "sample42", "zolc", "s"]) {
        factor++;
        await list.refreshScores();
        await list.setQuery(query);
        const expected = reference.match(query, {
          algorithm,
          scoreModifier: (score, id) => modifier(score, values[id]),
        });
        expect(list.getFilteredItems()).toEqual(expected.map((match) => match.value));
        expect(list.filterMatcher).toBeNull();
        expect(list.workerPreparation.next).toBe(values.length);
        for (const match of expected.slice(0, 3))
          expect(list.getMatchIndices(match.value)).toEqual(
            reference.getMatchIndexes(match.id, query, { algorithm }),
          );
      }
    });
  }

  it("retains the rendered rows and replaces only the action affordance while filtering", async () => {
    const workspace = lumine.workspace.getElement();
    jasmine.attachToDOM(workspace);
    host = lumine.workspace.addSelectList(options());
    list = host.getModel();
    await host.show();
    await list.setQuery("zolc");
    await list.update({ loadingMessage: "Reading source data" });
    const viewport = list.component.refs.items;
    const children = Array.from(viewport.children);
    const text = viewport.textContent;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const match = list.matchInWorker;
    spyOn(list, "matchInWorker").and.callFake(async function (...args) {
      await gate;
      return match.apply(this, args);
    });
    const pending = list.setQuery("sample42");
    expect(list.shouldShowFilteringProgress()).toBe(false);
    await list.updateComponent();
    expect(list.isFiltering()).toBe(true);
    expect(list.component.refs.items).toBe(viewport);
    expect(Array.from(viewport.children).every((child, index) => child === children[index])).toBe(
      true,
    );
    expect(viewport.textContent).toBe(text);
    expect(viewport.getAttribute("aria-busy")).toBe("true");
    const button = list.component.refs.itemActionsIndicator;
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(list.getElement().textContent).toContain("Reading source data");
    expect(list.getSelectedItem()).toBeNull();
    await list.selectIndex(1);
    expect(list.getSelectedItem()).toBeNull();
    const confirm = jasmine.createSpy("confirm");
    const actions = jasmine.createSpy("actions");
    list.emitter.on("did-confirm-empty-selection", confirm);
    list.emitter.on("did-request-actions", actions);
    list.confirmSelection();
    list.requestActions();
    expect(list.canConfirm()).toBe(false);
    expect(list.hasAvailableActions()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(actions).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 275));
    await list.updateComponent();
    expect(button.querySelector(".loading-spinner-tiny")).not.toBeNull();
    const continued = list.setQuery("sample42");
    expect(list.shouldShowFilteringProgress()).toBe(true);
    release();
    await Promise.all([pending, continued]);
    expect(list.isFiltering()).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.querySelector(".loading-spinner-tiny")).toBeNull();
    expect(list.getElement().textContent).toContain("Reading source data");
    expect(list.getMatchCount()).toBeGreaterThan(0);
    expect(list.getMatchCount()).toBeLessThan(values.length);
  });

  it("delays the filtering indicator for 250 ms and preserves it across superseded queries", () => {
    list = lumine.workspace.buildSelectList(options());
    spyOn(list, "updateComponent").and.returnValue(Promise.resolve());
    const clock = require("sinon").useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = () => ({ controller: new AbortController(), promise: Promise.resolve() });
    try {
      list.queryWork = pending();
      list.startFilteringProgress();
      clock.tick(249);
      expect(list.shouldShowFilteringProgress()).toBe(false);
      clock.tick(1);
      expect(list.shouldShowFilteringProgress()).toBe(true);
      list.cancelQueryWork(true);
      list.queryWork = pending();
      list.startFilteringProgress();
      expect(list.shouldShowFilteringProgress()).toBe(true);
      list.cancelQueryWork();
      expect(list.shouldShowFilteringProgress()).toBe(false);
      list.queryWork = pending();
      list.startFilteringProgress();
      clock.tick(100);
      list.cancelQueryWork();
      clock.tick(1000);
      expect(list.shouldShowFilteringProgress()).toBe(false);
      expect(list.updateComponent.calls.count()).toBe(1);
    } finally {
      clock.restore();
      list.cancelQueryWork();
    }
  });
  it("discards superseded results, replaces the worker with its source and terminates it", async () => {
    list = lumine.workspace.buildSelectList(options());
    await list.setQuery("s");
    const client = list.workerPreparation.client;
    const old = list.setQuery("sample42");
    const current = list.setQuery("zolc");
    await Promise.all([old, current]);
    expect(list.getQuery()).toBe("zolc");
    expect(list.getMatchCount()).toBe(values.length);
    const replacement = values.map((_, i) => `other-${i}`);
    await list.update({ items: replacement });
    expect(client.closed).toBe(true);
    expect(list.getMatchCount()).toBe(0);
    await list.setQuery("other");
    const currentClient = list.workerPreparation.client;
    expect(list.getMatchCount()).toBe(values.length);
    const pending = list.setQuery("oth");
    await list.destroy();
    await pending;
    expect(currentClient.closed).toBe(true);
    expect(currentClient.pending.size).toBe(0);
  });

  it("prepares idle data once and ignores a cancelled transport response", async () => {
    const extract = jasmine.createSpy("extract").and.callFake((value) => value);
    list = lumine.workspace.buildSelectList(
      options({ prepareOnIdle: true, getFilterText: extract }),
    );
    const preparation = list.workerPreparation;
    expect(list.isFiltering()).toBe(false);
    expect(list.getMatchCount()).toBe(values.length);
    await preparation.promise;
    expect(extract.calls.count()).toBe(values.length);
    const controller = new AbortController();
    const pending = preparation.client.request(
      "rank",
      {
        query: "s",
        options: { algorithm: "command-t" },
        highlightCount: 0,
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expectAsync(pending).toBeRejected();
    expect(preparation.client.pending.size).toBe(0);
    await list.setQuery("sample42");
    expect(list.getMatchCount()).toBeGreaterThan(0);
    expect(list.workerPreparation).toBe(preparation);
    expect(extract.calls.count()).toBe(values.length);
  });

  it("keeps session opening with a query on the worker path", async () => {
    host = lumine.workspace.addSelectList(options());
    list = host.getModel();
    spyOn(list, "matchCandidates").and.callThrough();
    await host.show({ query: "sample" });
    expect(list.getMatchCount()).toBe(values.length);
    expect(list.matchCandidates).not.toHaveBeenCalled();
  });

  it("replaces an unfinished idle preparation when the source changes", async () => {
    list = lumine.workspace.buildSelectList(options({ prepareOnIdle: true }));
    const previous = list.workerPreparation;
    const replacement = values.map((_, index) => `beta-${index}`);
    await list.setItems(replacement);
    expect(previous.client.closed).toBe(true);
    await list.workerPreparation.promise;
    await list.setQuery("zolc");
    expect(list.getFilteredItems()).toEqual([]);
    await list.setQuery("beta");
    expect(list.getMatchCount()).toBe(replacement.length);
  });

  it("terminates idle preparation without extracting text after destruction", async () => {
    const extract = jasmine.createSpy("extract").and.callFake((value) => value);
    list = lumine.workspace.buildSelectList(
      options({ prepareOnIdle: true, getFilterText: extract }),
    );
    const preparation = list.workerPreparation;
    await list.destroy();
    await expectAsync(preparation.promise).toBeRejected();
    expect(extract).not.toHaveBeenCalled();
    expect(preparation.client.closed).toBe(true);
    expect(preparation.client.pending.size).toBe(0);
  });

  it("retries a failed idle extraction when a query needs the data", async () => {
    let fail = true;
    list = lumine.workspace.buildSelectList(
      options({
        prepareOnIdle: true,
        getFilterText(value) {
          if (fail && value === values[1024]) throw new Error("extraction failed");
          return value;
        },
      }),
    );
    const preparation = list.workerPreparation;
    await expectAsync(preparation.promise).toBeRejectedWithError("extraction failed");
    expect(list.getQuery()).toBe("");
    expect(list.isFiltering()).toBe(false);
    fail = false;
    await list.setQuery("sample");
    expect(list.getMatchCount()).toBe(values.length);
    expect(list.workerPreparation).not.toBe(preparation);
  });

  it("leaves idle work to custom matching callbacks and query sources", async () => {
    const extract = jasmine.createSpy("extract").and.callFake((value) => value);
    for (const custom of [{ matcher: (rows) => rows }, { filter: (items) => items }]) {
      list = lumine.workspace.buildSelectList(
        options({ prepareOnIdle: true, getFilterText: extract, ...custom }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(extract).not.toHaveBeenCalled();
      expect(list.workerPreparation).toBeNull();
      await list.destroy();
    }
    list = lumine.workspace.buildSelectList({
      ...options({ prepareOnIdle: true, getFilterText: extract }),
      source: { mode: "query", load: () => values },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(extract).not.toHaveBeenCalled();
    expect(list.workerPreparation).toBeNull();
  });

  it("flattens sectioned matches in a worker and restores sections when cleared", async () => {
    list = lumine.workspace.buildSelectList({
      sections: [
        { id: "first", items: ["alpha", "beta"] },
        { id: "second", items: ["alpine"] },
      ],
      query: "al",
    });
    await list.queryWork.promise;
    expect(list.getFilteredItems()).toEqual(["alpha", "alpine"]);
    expect(list.workerPreparation.next).toBe(3);
    expect(list.model._getDisplayedRecords().map((row) => row.sectionId)).toEqual([null, null]);
    expect(list.model._getDisplayedRecords().map((row) => row.sourceSectionId)).toEqual([
      "first",
      "second",
    ]);
    await list.setQuery("");
    expect(list.model._getDisplayedRecords().map((row) => row.sectionId)).toEqual([
      "first",
      "first",
      "second",
    ]);
  });

  it("does not run a constructor query synchronously or show a premature empty result", async () => {
    const SelectList = require("../src/select-list");
    spyOn(SelectList.prototype, "matchCandidates").and.callThrough();
    list = lumine.workspace.buildSelectList({
      ...options(),
      query: "sample",
      emptyMessage: "No matches found",
    });
    expect(list.isFiltering()).toBe(true);
    expect(list.getElement().textContent).not.toContain("No matches found");
    await list.queryWork.promise;
    expect(list.getMatchCount()).toBe(values.length);
    expect(list.matchCandidates).not.toHaveBeenCalled();
  });

  it("retains selection across source refreshes and honors explicit selection policies", async () => {
    list = lumine.workspace.buildSelectList(options());
    await list.setQuery("sample");
    const chosen = list.getDisplayedItems()[5];
    await list.selectItem(chosen);
    await list.update({ items: values.slice() });
    expect(list.getSelectedItem()).toBe(chosen);
    await list.update({ selection: { initial: { mode: "none" } } });
    expect(list.getSelectedItem()).toBeNull();
    await list.update({ selection: { initial: { id: chosen } } });
    expect(list.getSelectedItem()).toBe(chosen);
  });

  it("cancels local filtering when a query source takes ownership", async () => {
    list = lumine.workspace.buildSelectList(options());
    await list.setQuery("s");
    const client = list.workerPreparation.client;
    const pending = list.setQuery("sample");
    await list.setSource({ mode: "query", load: () => ["external result"] });
    await pending;
    expect(list.model.getQuery()).toBe("");
    expect(client.closed).toBe(true);
    await list.reload();
    expect(list.getFilteredItems()).toEqual(["external result"]);
  });

  it("recovers after a main-thread modifier fails without publishing stale worker results", async () => {
    let fail = true;
    list = lumine.workspace.buildSelectList(
      options({
        scoreModifier(score) {
          if (fail) throw new Error("modifier failed");
          return score;
        },
      }),
    );
    await expectAsync(list.setQuery("s")).toBeRejectedWithError("modifier failed");
    expect(list.isFiltering()).toBe(false);
    expect(list.workerPreparation).toBeNull();
    fail = false;
    await list.setQuery("s");
    expect(list.getMatchCount()).toBe(values.length);
  });
});
