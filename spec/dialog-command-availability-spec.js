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

  it("reflects local action eligibility in registry state even without a command predicate", async () => {
    let enabled = false;
    const handler = jasmine.createSpy("local action handler");
    host = lumine.workspace.addSelectList({
      items: [],
      getItemId: (item) => item.id,
      commands: { [command]: handler },
      actions: [
        { command, context: "item", primary: true, disposition: "stay", enabled: () => enabled },
      ],
    });
    model = host.getModel();
    await host.show();
    const target = model.getQueryEditor().getElement();
    expect(lumine.commands.canDispatch(target, command)).toBe(false);
    await model.update({ items: [{ id: "one" }] });
    expect(lumine.commands.canDispatch(target, command)).toBe(false);
    enabled = true;
    expect(lumine.commands.canDispatch(target, command)).toBe(true);
    await model.confirmSelection();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("lets a custom Confirm registration override the dialog default exactly once", async () => {
    const handler = jasmine.createSpy("custom confirm");
    host = lumine.workspace.addInputDialog({ commands: { "core:confirm": handler } });
    model = host.getModel();
    const defaultConfirm = spyOn(model, "confirm").and.callThrough();
    await host.show();
    await lumine.commands.dispatch(model.getQueryEditor().getElement(), "core:confirm");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(defaultConfirm).not.toHaveBeenCalled();
  });

  it("disables a pending local command while allowing its owned dispatch exactly once", async () => {
    let finish;
    const handler = jasmine.createSpy("pending action").and.callFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    host = lumine.workspace.addInputDialog({
      commands: { [command]: handler },
      actions: [{ command, context: "dialog", primary: true, disposition: "stay" }],
    });
    model = host.getModel();
    await host.show();
    const running = model.confirm();
    await conditionPromise(() => handler.calls.count() === 1);
    expect(lumine.commands.canDispatch(model.getQueryEditor().getElement(), command)).toBe(false);
    finish();
    await running;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(lumine.commands.canDispatch(model.getQueryEditor().getElement(), command)).toBe(true);
  });

  it("updates picker forwarders and silently declines an action that became unavailable", async () => {
    let available = true;
    const handler = jasmine.createSpy("forwarded conditional action");
    await openDialog(() => available, handler, { disposition: "stay" });
    await host.showActions();
    const picker = host.services.actionService.picker;
    expect(lumine.commands.canDispatch(picker.getQueryEditor().getElement(), command)).toBe(true);
    available = false;
    lumine.commands.invalidateAvailability({ target: model.getElement() });
    await globalThis.flushMicrotasks();
    expect(lumine.commands.canDispatch(picker.getQueryEditor().getElement(), command)).toBe(false);
    expect(picker.getItems()[0].enabled).toBe(false);
    await picker.confirmSelection();
    expect(handler).not.toHaveBeenCalled();
    expect(picker.getStatus()).toBeNull();
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
