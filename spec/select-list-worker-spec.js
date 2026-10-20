describe("SelectList worker search", () => {
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
        worker: true,
        ignoreDiacritics: true,
        algorithm: "command-t",
        ...search,
      },
    };
  }
  for (const algorithm of ["command-t", "fuzzaldrin"]) {
    it(`keeps every adjusted result and visible highlight equivalent with ${algorithm}`, async () => {
      let factor = 1;
      const modifier = (score, item) => score * (item.includes("-42.") ? factor : 1);
      list = lumine.workspace.buildSelectList(options({ algorithm, scoreModifier: modifier }));
      const reference = lumine.tools.fuzzyMatcher.setCandidates(values, { ignoreDiacritics: true });
      for (const query of ["s", "sa", "sample42", "zolc", "s"]) {
        factor++;
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
    expect(button.querySelector(".loading-spinner-tiny")).not.toBeNull();
    expect(list.getElement().textContent).toContain("Reading source data");
    expect(list.getSelectedItem()).toBeNull();
    await list.selectIndex(1);
    expect(list.getSelectedItem()).toBeNull();
    release();
    await pending;
    expect(list.isFiltering()).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.querySelector(".loading-spinner-tiny")).toBeNull();
    expect(list.getElement().textContent).toContain("Reading source data");
    expect(list.getMatchCount()).toBeGreaterThan(0);
    expect(list.getMatchCount()).toBeLessThan(values.length);
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
