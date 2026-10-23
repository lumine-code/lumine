describe("SelectList updates from package event handlers", () => {
  let list;
  let host;
  let unhandled;
  const onRejection = (event) => unhandled.push(event.reason?.message);
  beforeEach(() => {
    jasmine.useRealClock();
    unhandled = [];
    window.addEventListener("unhandledrejection", onRejection);
  });
  afterEach(async () => {
    window.removeEventListener("unhandledrejection", onRejection);
    if (host) await host.destroy();
    else await list?.destroy();
    host = list = null;
  });

  it("reports a detached worker update failure without an unhandled promise rejection", async () => {
    let fail = false;
    list = lumine.workspace.buildSelectList({
      items: ["alpha"],
      search: {
        scoreModifier(score) {
          if (fail) throw new Error("ranking unavailable");
          return score;
        },
      },
    });
    await list.setQuery("al");
    fail = true;
    // Package registry/configuration observers cannot await their subscribers.
    void list.setItems(["alpha", "alpine"]);
    await conditionPromise(() => list.getStatus()?.message === "ranking unavailable");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    expect(list.isFiltering()).toBe(false);
    fail = false;
    await list.refresh();
    expect(list.getMatchCount()).toBe(2);
    expect(list.getStatus()).toBeNull();
    fail = true;
    await expectAsync(list.refresh()).toBeRejectedWithError("ranking unavailable");
  });

  for (const input of ["api", "editor"]) {
    it(`does not confirm a previous query's result while a query source loads (${input})`, async () => {
      let publish, finish;
      host = lumine.workspace.addSelectList({
        source: {
          mode: "query",
          debounceMs: 0,
          load: ({ query, publish: next }) => {
            if (!query) return ["old result"];
            publish = next;
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        },
      });
      list = host.getModel();
      await host.show();
      expect(list.getSelectedItem()).toBe("old result");
      if (input === "api") await list.setQuery("new");
      else list.getQueryEditor().setText("new");
      expect(list.isFiltering()).toBe(true);
      expect(list.canConfirm()).toBe(false);
      await list.setRecentItemIds(["old result"]);
      await publish({ infoMessage: "Waiting for results" });
      expect(list.isFiltering()).toBe(true);
      // Keep the query source alive until the progressive result is published.
      await publish(["new result"]);
      expect(list.getFilteredItems()).toEqual(["new result"]);
      expect(list.isFiltering()).toBe(false);
      finish();
    });
  }

  it("blocks previous results when a different query source takes over at the same query", async () => {
    host = lumine.workspace.addSelectList({
      source: { mode: "query", load: () => ["first source"] },
    });
    list = host.getModel();
    await host.show();
    let finish;
    const switching = list.setSource({
      mode: "query",
      load: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    expect(list.isFiltering()).toBe(true);
    expect(list.canConfirm()).toBe(false);
    finish(["second source"]);
    await switching;
    expect(list.isFiltering()).toBe(false);
    expect(list.getSelectedItem()).toBe("second source");
    await host.destroy();
    expect(list.isFiltering()).toBe(false);
  });
});
