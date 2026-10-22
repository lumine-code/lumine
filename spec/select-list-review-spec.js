describe("SelectList query recovery and reentrant observers", () => {
  let list;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    await list?.destroy();
  });

  it("keeps core matcher scoring independent of old caller option objects", () => {
    const values = ["src/main.js", "main.js"];
    const { Matcher } = require("@lumine-code/fuzzy-search");
    // Exercise both the installed library and the public wrapper, which already
    // copies options and therefore masks this regression in older library pins.
    for (const create of [
      () => new Matcher([0, 1], values),
      () => lumine.tools.fuzzyMatcher.setCandidates(values),
    ]) {
      const matcher = create();
      const options = { algorithm: "fuzzaldrin", usePathScoring: true };
      matcher.getMatchIndexes(0, "ma", options);
      options.usePathScoring = false;
      const requested = { algorithm: "fuzzaldrin", usePathScoring: true };
      expect(matcher.match("ma", requested)).toEqual(create().match("ma", requested));
    }
  });

  it("removes its filtering error after refreshing the same query", async () => {
    let fail = true;
    list = lumine.workspace.buildSelectList({
      items: ["alpha", "beta"],
      search: {
        scoreModifier(score) {
          if (fail) throw new Error("temporary ranking failure");
          return score;
        },
      },
    });
    await expectAsync(list.setQuery("alpha")).toBeRejectedWithError("temporary ranking failure");
    expect(list.getStatus()?.type).toBe("error");
    fail = false;
    await list.refresh();
    expect(list.getFilteredItems()).toEqual(["alpha"]);
    expect(list.getStatus()).toBeNull();
  });

  it("clears a recovered filtering error when switching to synchronous search", async () => {
    let fail = true;
    const scoreModifier = (score) => {
      if (fail) throw new Error("temporary ranking failure");
      return score;
    };
    list = lumine.workspace.buildSelectList({ items: ["alpha"], search: { scoreModifier } });
    await expectAsync(list.setQuery("alpha")).toBeRejected();
    fail = false;
    await list.update({ search: { worker: false, scoreModifier } });
    expect(list.getFilteredItems()).toEqual(["alpha"]);
    expect(list.getStatus()).toBeNull();
    expect(list.workerPreparation).toBeNull();
  });

  it("preserves a package status replacing the matcher's error during recovery", async () => {
    let fail = true;
    list = lumine.workspace.buildSelectList({
      items: ["alpha"],
      search: {
        scoreModifier: (score) => {
          if (fail) throw new Error("temporary ranking failure");
          return score;
        },
      },
    });
    await expectAsync(list.setQuery("alpha")).toBeRejected();
    const status = { type: "warning", message: "The project is read-only", sticky: true };
    await list.setStatus(status);
    fail = false;
    await list.refresh();
    expect(list.getFilteredItems()).toEqual(["alpha"]);
    expect(list.getStatus()).toBe(status);
  });

  it("keeps a query chosen by a query-change observer instead of restarting the outer selection", async () => {
    list = lumine.workspace.buildSelectList({ items: ["alpha", "beta"] });
    let redirected = Promise.resolve();
    list.onDidChangeQuery(() => {
      if (list.getQuery() === "alpha") {
        redirected = list.setQuery("beta");
        void redirected.catch(() => {});
      }
    });
    await expectAsync(
      list.update({ query: "alpha", selection: { initial: { id: "alpha" } } }),
    ).toBeResolved();
    await expectAsync(redirected).toBeResolved();
    expect(list.getQuery()).toBe("beta");
    expect(list.getFilteredItems()).toEqual(["beta"]);
    expect(list.getSelectedItem()).toBe("beta");
    expect(list.getStatus()).toBeNull();
  });

  it("lets an item-change observer supersede the pending source selection", async () => {
    list = lumine.workspace.buildSelectList({ items: ["alpha", "beta"] });
    await list.setQuery("alpha");
    let redirected = Promise.resolve();
    list.onDidChangeSelection(({ reason }) => {
      if (reason === "items") {
        redirected = list.setQuery("beta");
        void redirected.catch(() => {});
      }
    });
    await expectAsync(
      list.update({
        items: ["alpha2", "beta2"],
        selection: { initial: { id: "alpha2" } },
      }),
    ).toBeResolved();
    await expectAsync(redirected).toBeResolved();
    expect(list.getFilteredItems()).toEqual(["beta2"]);
    expect(list.getSelectedItem()).toBe("beta2");
    expect(list.getStatus()).toBeNull();
  });

  it("keeps synchronous search and selection installed by an observer", async () => {
    list = lumine.workspace.buildSelectList({ items: ["alpha", "alpine"] });
    let redirected = Promise.resolve();
    list.onDidChangeQuery(() => {
      if (list.getQuery() === "al") {
        redirected = list.update({
          search: { worker: false },
          selection: { initial: { id: "alpine" } },
        });
      }
    });
    await list.update({ query: "al", selection: { initial: { id: "alpha" } } });
    await redirected;
    expect(list.getSelectedItem()).toBe("alpine");
    expect(list.workerPreparation).toBeNull();
    expect(list.isFiltering()).toBe(false);
  });

  it("does not restart a query cleared by an observer", async () => {
    list = lumine.workspace.buildSelectList({ items: ["alpha", "beta"] });
    let redirected = Promise.resolve();
    list.onDidChangeQuery(() => {
      if (list.getQuery() === "alpha") redirected = list.clearQuery();
    });
    await list.update({ query: "alpha", selection: { initial: { id: "alpha" } } });
    await redirected;
    expect(list.getQuery()).toBe("");
    expect(list.model.getQuery()).toBe("");
    expect(list.getFilteredItems()).toEqual(["alpha", "beta"]);
    expect(list.isFiltering()).toBe(false);
  });
});
