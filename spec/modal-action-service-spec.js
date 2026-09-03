const { Disposable, Emitter } = require("@lumine-code/event-kit");
const ModalActionService = require("../src/modal-action-service");

describe("ModalActionService", () => {
  let service, picker, commandRegistry, workspace, createSelectList;

  class FakePicker {
    constructor(options) {
      this.options = options;
      this.element = {};
      this.emitter = new Emitter();
      this.visible = false;
      this.updates = [];
      this.statuses = [];
    }

    update(options) {
      this.updates.push(options);
      return Promise.resolve();
    }

    reset() {}

    show(options) {
      this.visible = true;
      this.showOptions = options;
    }

    hide() {
      this.visible = false;
      this.emitter.emit("did-hide");
    }

    isVisible() {
      return this.visible;
    }

    getElement() {
      return this.element;
    }

    setStatus(status) {
      this.statuses.push(status);
      return Promise.resolve();
    }

    onDidConfirmSelection(callback) {
      return this.emitter.on("did-confirm-selection", callback);
    }

    onDidCancel(callback) {
      return this.emitter.on("did-cancel", callback);
    }

    onDidHide(callback) {
      return this.emitter.on("did-hide", callback);
    }

    destroy() {
      this.destroyed = true;
      this.emitter.dispose();
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    createSelectList = jasmine.createSpy("createSelectList").and.callFake((options) => {
      picker = new FakePicker(options);
      return picker;
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
    workspace = { popModal: jasmine.createSpy("popModal").and.returnValue(true) };
    service = new ModalActionService({ createSelectList, commandRegistry, workspace });
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

    expect(createSelectList).toHaveBeenCalledTimes(1);
    expect(picker.options.className).toBe("select-list-actions");
    expect(picker.options.className).not.toContain("owner");
    expect(picker.updates[0].separatorIds).toEqual(["spec:copy"]);
    expect(picker.showOptions).toEqual({ crumb: "Actions" });
  });

  it("returns to the owner and runs an enabled action with its captured context", async () => {
    const result = Promise.resolve({ status: "success" });
    const owner = {
      runAction: jasmine.createSpy("runAction").and.returnValue(result),
      getPanel: () => ({ show() {} }),
    };
    const context = { itemId: "one", query: "kept" };
    await service.show({ owner, actions: [action("spec:open")], context });

    const returned = service.confirmAction(picker.updates[0].items[0]);

    expect(workspace.popModal).toHaveBeenCalled();
    expect(owner.runAction).toHaveBeenCalled();
    const [command, options] = owner.runAction.calls.mostRecent().args;
    expect(command).toBe("spec:open");
    expect(options.source).toBe("actions");
    expect(options.context).toEqual(context);
    await expectAsync(returned).toBeResolvedTo({ status: "success" });
    expect(commandRegistry.listeners).toBeNull();
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

  it("destroys the shared picker and rejects later shows", async () => {
    await service.show({
      owner: { runAction() {} },
      actions: [action("spec:open")],
      context: {},
    });

    await service.destroy();
    await service.destroy();

    expect(picker.destroyed).toBe(true);
    await expectAsync(
      service.show({ owner: {}, actions: [action("spec:late")], context: {} }),
    ).toBeRejectedWithError(/destroyed/);
  });
});
