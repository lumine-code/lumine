describe("Dialog command availability", () => {
  let host, model, source, registration;
  const command = "dialog-availability:execute";

  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    source = document.createElement("button");
    lumine.workspace.getElement().appendChild(source);
  });

  afterEach(async () => {
    registration?.dispose();
    registration = null;
    await host?.destroy();
    host = model = null;
    source.remove();
  });

  async function openDialog(isAvailable, didDispatch, action = {}) {
    host = lumine.workspace.addInputDialog({
      commands: { [command]: { isAvailable, didDispatch } },
      actions: [{ command, context: "dialog", primary: true, disposition: "close", ...action }],
    });
    model = host.getModel();
    source.focus();
    await host.show();
    return model;
  }

  it("uses the actual query detail once per action presentation and remains silently disabled", async () => {
    const predicate = jasmine
      .createSpy("query predicate")
      .and.callFake(({ detail }) => detail.query === "run");
    const handler = jasmine.createSpy("conditional command");
    await openDialog(predicate, handler, { disabledReason: "An unrelated local reason." });
    predicate.calls.reset();

    const [action] = model.getAvailableActions();

    expect(predicate).toHaveBeenCalledTimes(1);
    expect(action.enabled).toBe(false);
    expect(action.disabledReason).toBeNull();
    expect((await model.getActionAvailability(command)).status).toBe("disabled");
    expect((await model.confirm()).status).toBe("disabled");
    expect(handler).not.toHaveBeenCalled();
    expect(host.isVisible()).toBe(true);
    expect(model.getStatus()).toBeNull();
  });

  it("adapts a local command keystroke to its action detail and invokes the handler once", async () => {
    const handler = jasmine.createSpy("conditional keyboard command");
    await openDialog(({ detail }) => detail.query === "run", handler);
    await model.setQuery("run");

    await lumine.commands.dispatch(model.getQueryEditor().getElement(), command);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.calls.mostRecent().args[0].detail.query).toBe("run");
    expect(host.isVisible()).toBe(false);
  });

  it("quietly declines if the condition changes at actual command dispatch", async () => {
    let available = true;
    const handler = jasmine.createSpy("declined at dispatch");
    await openDialog(() => available, handler);
    registration = lumine.commands.onWillDispatch((event) => {
      if (event.type === command && event.detail?.dialog === model) available = false;
    });

    const result = await model.confirm();

    expect(result.status).toBe("disabled");
    expect(handler).not.toHaveBeenCalled();
    expect(host.isVisible()).toBe(true);
    expect(model.getStatus()).toBeNull();
  });

  it("queries and dispatches an opener action with the same selected item and target", async () => {
    const handler = jasmine.createSpy("opener action");
    registration = lumine.commands.add(source, command, {
      isAvailable: ({ target, detail }) => target === source && detail.item?.id === "allowed",
      didDispatch: handler,
    });
    host = lumine.workspace.addSelectList({
      items: [{ id: "blocked" }, { id: "allowed" }],
      getItemId: (item) => item.id,
      search: { getFilterText: (item) => item.id },
      actions: [
        { command, context: "item", dispatch: "opener", primary: true, disposition: "close" },
      ],
    });
    model = host.getModel();
    source.focus();
    await host.show();
    await model.selectItemById("blocked");
    expect(model.getAvailableActions()[0].enabled).toBe(false);
    await model.selectItemById("allowed");
    expect(model.getAvailableActions()[0].enabled).toBe(true);

    await model.confirmSelection();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.calls.mostRecent().args[0].target).toBe(source);
    expect(handler.calls.mostRecent().args[0].detail.item.id).toBe("allowed");
    expect(host.isVisible()).toBe(false);
  });
});
