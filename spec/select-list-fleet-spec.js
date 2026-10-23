describe("SelectList updates from package event handlers", () => {
  let list;
  let unhandled;
  const onRejection = (event) => unhandled.push(event.reason?.message);
  beforeEach(() => {
    jasmine.useRealClock();
    unhandled = [];
    window.addEventListener("unhandledrejection", onRejection);
  });
  afterEach(async () => {
    window.removeEventListener("unhandledrejection", onRejection);
    await list?.destroy();
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
});
