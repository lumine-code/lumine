const { PieceTree } = require("../src/text-model");

describe("Dialog query input budgets", () => {
  let view, host;
  beforeEach(() => jasmine.useRealClock());
  afterEach(async () => {
    if (host) await host.destroy();
    else if (view) await view.destroy();
    view = host = null;
  });
  function giantSource() {
    let source = new PieceTree("x".repeat(32768));
    for (let index = 0; index < 15; index++)
      source = source.replace(source.length, source.length, source);
    return source;
  }
  it("preserves oversized snapshots, suspends callbacks and actions, and recovers after shrinking", async () => {
    view = lumine.workspace.buildInputDialog({ maxQueryLength: 8 });
    const changed = jasmine.createSpy("changed"),
      confirmed = jasmine.createSpy("confirmed");
    view.onDidChangeQuery(changed);
    view.onDidConfirm(confirmed);
    const source = giantSource();
    await view.setQuery(source);
    const editor = view.getQueryEditor();
    expect(editor.getBuffer().getTextSnapshot().equals(source)).toBeTrue();
    const read = spyOn(editor, "getText").and.throwError("must not read giant query");
    expect(view.getQueryStatus()).toEqual({
      available: false,
      length: source.length,
      maxLength: 8,
    });
    expect(view.canConfirm()).toBeFalse();
    expect(view.hasAvailableActions()).toBeFalse();
    expect(view.getAvailableActions()).toEqual([]);
    view.getElement();
    expect(view.getElement().textContent).toContain("Shorten it to resume");
    view.confirm();
    expect(confirmed).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(() => view.getQuery()).toThrowError(/Query exceeds/);
    expect(read).not.toHaveBeenCalled();
    read.and.callThrough();
    await view.setQuery("small");
    expect(view.getQuery()).toBe("small");
    view.confirm();
    expect(confirmed).toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(view.getElement().textContent).not.toContain("Shorten it to resume");
  });

  it("aborts and suppresses late source results, then reloads once with the recovered complete query", async () => {
    let resolve, signal;
    const load = jasmine.createSpy("load").and.callFake((context) => {
      signal = context.signal;
      if (context.query === "good") return { status: { message: "fresh" } };
      return new Promise((finish) => {
        resolve = finish;
      });
    });
    host = lumine.workspace.addInputDialog({
      query: "old",
      maxQueryLength: 8,
      source: { mode: "query", debounceMs: 0, load },
    });
    view = host.getModel();
    host.show({ query: "old" });
    await Promise.resolve();
    await view.setQuery("oversized query");
    expect(signal.aborted).toBeTrue();
    resolve({ status: { message: "stale" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(view.getElement().textContent).not.toContain("stale");
    await view.setQuery("good");
    await Promise.resolve();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.calls.mostRecent().args[0].query).toBe("good");
  });

  it("retains an oversized draft through hiding and explicit restoration without flattening it", async () => {
    host = lumine.workspace.addInputDialog({ maxQueryLength: 8 });
    view = host.getModel();
    await host.show({ query: "small" });
    const source = giantSource();
    await view.setQuery(source);
    const read = spyOn(view.getQueryEditor(), "getText").and.throwError("must not flatten draft");
    host.hide();
    expect(host.lastQuery.equals(source)).toBeTrue();
    read.and.callThrough();
    await host.show({ query: "new" });
    host.restoreQuery();
    expect(view.getQueryEditor().getBuffer().getTextSnapshot().equals(source)).toBeTrue();
    expect(view.getQueryStatus().available).toBeFalse();
  });

  it("keeps oversized SelectList queries out of custom parsers and matchers during updates", async () => {
    const parse = jasmine.createSpy("parse").and.callFake((value) => value);
    view = lumine.workspace.buildSelectList({
      maxQueryLength: 8,
      items: ["one", "two"],
      search: { parseQuery: parse },
      renderItem: (item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      },
    });
    view.getElement();
    parse.calls.reset();
    await view.setQuery(giantSource());
    expect(parse).not.toHaveBeenCalled();
    expect(view.getElement().textContent).toContain("Shorten it to resume");
    await view.update({ items: ["changed"], source: null });
    expect(view.getElement().querySelectorAll("li").length).toBe(0);
    expect(view.canConfirm()).toBeFalse();
    await view.setQuery("change");
    expect(parse).toHaveBeenCalledWith("change");
    expect(view.getElement().textContent).toContain("changed");
  });

  it("supports configured smaller query limits and validates finite upper bounds", async () => {
    expect(() => lumine.workspace.buildInputDialog({ maxQueryLength: Infinity })).toThrow();
    view = lumine.workspace.buildInputDialog({ query: "complete", maxQueryLength: 8 });
    await view.update({ maxQueryLength: 4 });
    expect(view.getQueryStatus().available).toBeFalse();
    await view.update({ maxQueryLength: 8 });
    expect(view.getQuery()).toBe("complete");
    expect(view.canConfirm()).toBeTrue();
  });
});
