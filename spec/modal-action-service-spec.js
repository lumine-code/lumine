const { Disposable, Emitter } = require("@lumine-code/event-kit");
const ModalActionService = require("../src/modal-action-service");

describe("ModalActionService", () => {
  let service, picker, pickerHost, commandRegistry, keymapManager, workspace, createSelectListHost;

  class FakePicker {
    constructor(options) {
      this.options = options;
      this.element = {};
      this.updates = [];
      this.statuses = [];
    }

    update(options) {
      this.updates.push(options);
      return Promise.resolve();
    }

    reset() {}

    getElement() {
      return this.element;
    }

    isDestroyed() {
      return Boolean(this.destroyed);
    }

    setStatus(status) {
      this.statuses.push(status);
      return Promise.resolve();
    }

    destroy() {
      this.destroyed = true;
      return Promise.resolve();
    }
  }

  class FakePickerHost {
    constructor(options) {
      this.model = new FakePicker(options);
      this.emitter = new Emitter();
      this.visible = false;
      this.suspendedByFlow = false;
    }

    getModel() {
      return this.model;
    }

    show(options) {
      this.visible = true;
      this.showOptions = options;
    }

    hide() {
      if (!this.visible) return false;
      this.visible = false;
      this.emitter.emit("did-change-visible", { visible: false });
      return true;
    }

    isVisible() {
      return this.visible;
    }

    onDidCancel(callback) {
      return this.emitter.on("did-cancel", callback);
    }

    onDidChangeVisible(callback) {
      return this.emitter.on("did-change-visible", callback);
    }

    onDidDestroy(callback) {
      return this.emitter.on("did-destroy", callback);
    }

    destroy() {
      if (this.destroyed) return Promise.resolve();
      this.destroyed = true;
      this.visible = false;
      this.emitter.emit("did-destroy");
      this.emitter.dispose();
      return this.model.destroy();
    }
  }

  beforeEach(() => {
    createSelectListHost = jasmine
      .createSpy("createSelectListHost")
      .and.callFake((options, hostOptions) => {
        pickerHost = new FakePickerHost(options);
        pickerHost.hostOptions = hostOptions;
        picker = pickerHost.getModel();
        return pickerHost;
      });
    commandRegistry = {
      add: jasmine.createSpy("add").and.callFake((element, listeners) => {
        commandRegistry.element = element;
        commandRegistry.listeners = listeners;
        return new Disposable(() => {
          commandRegistry.listeners = null;
        });
      }),
    };
    keymapManager = {
      add: jasmine.createSpy("add").and.callFake((source, bindings) => {
        keymapManager.source = source;
        keymapManager.bindings = bindings;
        return new Disposable(() => {
          keymapManager.bindings = null;
        });
      }),
    };
    workspace = { popModal: jasmine.createSpy("popModal").and.returnValue(true) };
    service = new ModalActionService({
      createSelectListHost,
      commandRegistry,
      keymapManager,
      workspace,
    });
  });

  afterEach(async () => {
    await service.destroy();
  });

  function action(command, options = {}) {
    return {
      command,
      name: command,
      context: "item",
      disposition: "stay",
      enabled: true,
      keystrokes: [],
      commandKeystrokes: [],
      ...options,
    };
  }

  it("reuses one neutral picker and derives separators from groups", async () => {
    const owner = { runAction: jasmine.createSpy("runAction") };
    const actions = [
      action("spec:open", { group: "Open" }),
      action("spec:split", { group: "Open" }),
      action("spec:copy", { group: "Copy" }),
    ];

    await service.show({ owner, actions, context: { itemId: "one" } });
    await service.show({ owner, actions: actions.slice(0, 1), context: { itemId: "two" } });

    expect(createSelectListHost).toHaveBeenCalledTimes(1);
    expect(picker.options.className).toBeUndefined();
    expect(pickerHost.hostOptions).toEqual({ className: "select-list-actions" });
    expect(picker.updates[0].sections.map(({ label }) => label)).toEqual(["Open", "Copy"]);
    expect(
      picker.updates[0].sections.map(({ items }) => items.map(({ command }) => command)),
    ).toEqual([["spec:open", "spec:split"], ["spec:copy"]]);
    expect(pickerHost.showOptions).toEqual({ crumb: "Actions" });
  });

  it("uses the model for data and the host for modal lifecycle", async () => {
    await service.show({
      owner: { runAction() {} },
      actions: [action("spec:open")],
      context: {},
    });

    expect(commandRegistry.element).toBe(picker.getElement());
    expect(pickerHost.isVisible()).toBe(true);
    expect(picker.isVisible).toBeUndefined();
    expect(picker.show).toBeUndefined();
  });

  it("recreates the shared picker after its host is destroyed externally", async () => {
    const owner = { runAction() {} };
    const actions = [action("spec:open")];
    await service.show({ owner, actions, context: {} });
    const firstHost = pickerHost;

    await firstHost.destroy();
    await service.show({ owner, actions, context: {} });

    expect(createSelectListHost).toHaveBeenCalledTimes(2);
    expect(pickerHost).not.toBe(firstHost);
    expect(pickerHost.isVisible()).toBe(true);
  });

  it("returns to the owner and runs an enabled action with its captured context", async () => {
    const result = Promise.resolve({ status: "success" });
    const owner = {
      runAction: jasmine.createSpy("runAction").and.returnValue(result),
      getPanel: () => ({ show: jasmine.createSpy("show") }),
    };
    const context = { itemId: "one", query: "kept" };
    await service.show({ owner, actions: [action("spec:open")], context });

    const returned = service.confirmAction(picker.updates[0].sections[0].items[0]);

    expect(workspace.popModal).toHaveBeenCalled();
    expect(owner.runAction).toHaveBeenCalled();
    const [command, options] = owner.runAction.calls.mostRecent().args;
    expect(command).toBe("spec:open");
    expect(options.source).toBe("actions");
    expect(options.context).toEqual(context);
    await expectAsync(returned).toBeResolvedTo({ status: "success" });
    expect(commandRegistry.listeners).toBeNull();
  });

  it("falls back to the owner host when the modal trail cannot be popped", async () => {
    workspace.popModal.and.returnValue(false);
    const panel = { show: jasmine.createSpy("show") };
    const owner = {
      runAction: jasmine.createSpy("runAction").and.resolveTo({ status: "success" }),
      getPanel: () => panel,
    };
    await service.show({ owner, actions: [action("spec:open")], context: {} });

    await service.confirmAction(picker.updates[0].sections[0].items[0]);

    expect(pickerHost.isVisible()).toBe(false);
    expect(panel.show).toHaveBeenCalled();
  });

  it("keeps a disabled action open and reports its reason", async () => {
    const owner = { runAction: jasmine.createSpy("runAction") };
    const disabled = action("spec:remove", {
      enabled: false,
      disabledReason: "The item disappeared.",
    });
    await service.show({ owner, actions: [disabled], context: { itemId: "gone" } });

    expect(await service.confirmAction(disabled)).toBe(false);
    expect(picker.statuses).toEqual([{ type: "warning", message: "The item disappeared." }]);
    expect(owner.runAction).not.toHaveBeenCalled();
    expect(workspace.popModal).not.toHaveBeenCalled();
  });

  it("revalidates both directions of enabled state before leaving the picker", async () => {
    const owner = {
      getActionAvailability: jasmine
        .createSpy("getActionAvailability")
        .and.resolveTo({ status: "available" }),
      runAction: jasmine.createSpy("runAction").and.resolveTo({ status: "success" }),
      getPanel: () => ({ show() {} }),
    };
    const formerlyDisabled = action("spec:open", {
      enabled: false,
      disabledReason: "Old reason",
    });
    await service.show({ owner, actions: [formerlyDisabled], context: {} });

    await service.confirmAction(formerlyDisabled);

    expect(owner.runAction.calls.mostRecent().args[0]).toBe("spec:open");
    expect(owner.runAction.calls.mostRecent().args[1].source).toBe("actions");
    expect(workspace.popModal).toHaveBeenCalled();

    workspace.popModal.calls.reset();
    owner.runAction.calls.reset();
    owner.getActionAvailability.and.resolveTo({
      status: "disabled",
      reason: "Current reason",
    });
    const formerlyEnabled = action("spec:open");
    await service.show({ owner, actions: [formerlyEnabled], context: {} });

    expect(await service.confirmAction(formerlyEnabled)).toBe(false);
    expect(picker.statuses.at(-1)).toEqual({ type: "warning", message: "Current reason" });
    expect(owner.runAction).not.toHaveBeenCalled();
    expect(workspace.popModal).not.toHaveBeenCalled();
  });

  it("forwards action commands only while the picker is open", async () => {
    const owner = {
      runAction: jasmine.createSpy("runAction").and.resolveTo({ status: "success" }),
      getPanel: () => ({ show() {} }),
    };
    const open = action("spec:open");
    await service.show({ owner, actions: [open], context: { itemId: "one" } });
    const listener = commandRegistry.listeners[open.command];
    const event = { stopPropagation: jasmine.createSpy("stopPropagation") };

    await listener(event);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(owner.runAction).toHaveBeenCalledTimes(1);
    expect(commandRegistry.listeners).toBeNull();
  });

  it("bridges owner command keystrokes into the neutral picker", async () => {
    const owner = { runAction: jasmine.createSpy("runAction") };
    await service.show({
      owner,
      actions: [
        action("spec:open", {
          keystrokes: ["enter", "ctrl-o"],
          commandKeystrokes: ["ctrl-o"],
        }),
      ],
      context: {},
    });

    expect(keymapManager.bindings).toEqual({
      ".select-list-actions lumine-text-editor[mini]": { "ctrl-o": "spec:open" },
    });
  });

  it("cleans up a flow return and cancels the owner on picker cancellation", async () => {
    const owner = {
      cancel: jasmine.createSpy("cancel"),
      isDestroyed: () => false,
      runAction() {},
      setActionsExpanded: jasmine.createSpy("setActionsExpanded"),
    };
    await service.show({ owner, actions: [action("spec:open")], context: {} });

    pickerHost.suspendedByFlow = true;
    pickerHost.emitter.emit("did-change-visible", { visible: false });
    expect(commandRegistry.listeners).toBeNull();
    expect(owner.setActionsExpanded).toHaveBeenCalledWith(false);
    expect(picker.updates.at(-1).sections).toEqual([]);

    pickerHost.suspendedByFlow = false;
    await service.show({ owner, actions: [action("spec:open")], context: {} });
    pickerHost.emitter.emit("did-cancel");
    expect(owner.cancel).toHaveBeenCalledWith("action-picker");
  });

  it("ignores a stale show after a newer owner wins the shared picker", async () => {
    picker = service.getPicker();
    let resolveFirstUpdate;
    const firstUpdate = new Promise((resolve) => (resolveFirstUpdate = resolve));
    let updateCount = 0;
    picker.update = jasmine.createSpy("update").and.callFake(() => {
      updateCount++;
      return updateCount === 1 ? firstUpdate : Promise.resolve();
    });
    const firstOwner = { runAction() {} };
    const secondOwner = { runAction() {} };

    const firstShow = service.show({
      owner: firstOwner,
      actions: [action("spec:first")],
      context: { owner: "first" },
    });
    const secondShow = service.show({
      owner: secondOwner,
      actions: [action("spec:second")],
      context: { owner: "second" },
    });

    await expectAsync(secondShow).toBeResolvedTo(true);
    resolveFirstUpdate();
    await expectAsync(firstShow).toBeResolvedTo(false);
    expect(service.owner).toBe(secondOwner);
    expect(commandRegistry.listeners["spec:second"]).toEqual(jasmine.any(Function));
    expect(commandRegistry.listeners["spec:first"]).toBeUndefined();
  });

  it("does not open after the pending owner is released", async () => {
    picker = service.getPicker();
    const finishUpdates = [];
    picker.update = () => new Promise((resolve) => finishUpdates.push(resolve));
    const owner = { runAction() {} };
    const showing = service.show({
      owner,
      actions: [action("spec:open")],
      context: {},
    });

    expect(service.release(owner)).toBe(true);
    finishUpdates.forEach((finish) => finish());

    await expectAsync(showing).toBeResolvedTo(false);
    expect(pickerHost.isVisible()).toBe(false);
    expect(commandRegistry.listeners).toBeUndefined();
  });

  it("destroys the shared picker and rejects later shows", async () => {
    await service.show({
      owner: { runAction() {} },
      actions: [action("spec:open")],
      context: {},
    });

    await service.destroy();
    await service.destroy();

    expect(pickerHost.destroyed).toBe(true);
    expect(picker.destroyed).toBe(true);
    await expectAsync(
      service.show({ owner: {}, actions: [action("spec:late")], context: {} }),
    ).toBeRejectedWithError(/destroyed/);
  });
});
