const { Disposable } = require("@lumine-code/event-kit");
const CommandRegistry = require("../src/command-registry");
const MenuManager = require("../src/menu-manager");
const { menuItemState } = require("../src/menu-helpers");

describe("Command choice state", () => {
  let registry, root, child, target, menu;

  beforeEach(() => {
    root = document.createElement("div");
    root.className = "choice-state-root";
    child = document.createElement("div");
    child.className = "choice-state-child";
    target = document.createElement("button");
    target.className = "choice-state-target";
    child.append(target);
    root.append(child);
    jasmine.attachToDOM(root);
    registry = new CommandRegistry();
    registry.attach(root);
  });

  afterEach(() => {
    menu?.destroy();
    menu = null;
    registry.destroy();
  });

  function createMenu(template) {
    menu = new MenuManager({
      commandRegistry: registry,
      keymapManager: {
        onDidLoadBundledKeymaps: () => new Disposable(),
        findKeyBindings: () => [],
      },
      packageManager: {
        onDidActivateInitialPackages: () => new Disposable(),
        onDidActivatePackage: () => new Disposable(),
      },
    });
    menu.template = template;
    return menu;
  }

  it("reads dynamic state without dispatch and passes a frozen, lazily resolved context", () => {
    const context = { source: "original surface" };
    const detail = { mode: "project" };
    const handler = jasmine.createSpy("handler");
    const available = jasmine.createSpy("availability").and.returnValue(false);
    registry.resolveContext = jasmine.createSpy("context").and.returnValue(context);
    let checked = false;
    registry.add(".choice-state-child", "choice-state:dynamic", {
      type: "radio",
      isAvailable: available,
      checked(query) {
        expect(this).toBe(child);
        expect(query.target).toBe(target);
        expect(query.currentTarget).toBe(child);
        expect(query.detail).toBe(detail);
        expect(Object.isFrozen(query)).toBe(true);
        expect(registry.resolveContext).not.toHaveBeenCalled();
        expect(query.context).toBe(context);
        expect(query.context).toBe(context);
        return checked;
      },
      didDispatch: handler,
    });

    const state = registry.getCommandState("choice-state:dynamic", { target, detail });
    expect(state).toEqual({ type: "radio", checked: false });
    expect(Object.isFrozen(state)).toBe(true);
    expect(registry.resolveContext).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();

    checked = true;
    registry.resolveContext.calls.reset();
    expect(registry.getCommandState("choice-state:dynamic", { target, detail })).toEqual({
      type: "radio",
      checked: true,
    });
  });

  it("uses selector specificity and newest registration before ancestor state", () => {
    registry.add(".choice-state-root", "choice-state:precedence", {
      checked: true,
      didDispatch() {},
    });
    registry.add("button", "choice-state:precedence", {
      checked: true,
      didDispatch() {},
    });
    registry.add("button.choice-state-target", "choice-state:precedence", {
      checked: true,
      didDispatch() {},
    });
    registry.add("button.choice-state-target", "choice-state:precedence", {
      checked: false,
      isAvailable: () => false,
      didDispatch() {},
    });

    // Choice state remains visible even when its owning registration is unavailable.
    expect(registry.getCommandState("choice-state:precedence", { target })).toEqual({
      type: "checkbox",
      checked: false,
    });
    expect(registry.canDispatch(target, "choice-state:precedence")).toBe(true);
  });

  it("lets an inline ordinary handler shadow an inherited choice", () => {
    registry.add(".choice-state-root", "choice-state:shadowed", {
      checked: true,
      didDispatch() {},
    });
    registry.add(".choice-state-target", "choice-state:shadowed", {
      checked: true,
      didDispatch() {},
    });
    registry.add(target, "choice-state:shadowed", () => {});

    expect(registry.getCommandState("choice-state:shadowed", { target })).toBeNull();
    expect(registry.getCommandState("choice-state:unregistered", { target })).toBeNull();
    expect(registry.getCommandState("toString", { target })).toBeNull();
  });

  it("evaluates state in shared command presentations without leaking its callback", () => {
    registry.add(".choice-state-child", "choice-state:mixed", {
      checked: () => "mixed",
      didDispatch() {},
    });
    registry.resolveContext = jasmine.createSpy("unneeded context");

    const single = registry.getCommandPresentation("choice-state:mixed", { target });
    const batch = registry.getCommandPresentations({ target });
    expect(single.checked).toBe("mixed");
    expect(single.type).toBe("checkbox");
    expect(single.enabled).toBe(true);
    expect(batch.find((entry) => entry.name === "choice-state:mixed").checked).toBe("mixed");
    expect(registry.resolveContext).not.toHaveBeenCalled();
  });

  it("drops older choice metadata when a newer ordinary registration shadows it", () => {
    registry.add(target, "choice-state:ordinary-override", {
      type: "radio",
      checked: () => true,
      didDispatch() {},
    });
    registry.add(target, "choice-state:ordinary-override", () => {});

    expect(registry.getCommandState("choice-state:ordinary-override", { target })).toBeNull();
    const single = registry.getCommandPresentation("choice-state:ordinary-override", { target });
    const batch = registry
      .getCommandPresentations({ target })
      .find((entry) => entry.name === "choice-state:ordinary-override");
    expect(single.checked).toBeUndefined();
    expect(single.type).toBeUndefined();
    expect(batch.checked).toBeUndefined();
    expect(batch.type).toBeUndefined();
  });

  it("reports an invalid asynchronous state once and keeps a safe unchecked fallback", async () => {
    spyOn(console, "error");
    registry.add(".choice-state-child", "choice-state:invalid", {
      checked: () => Promise.reject(new Error("State must be synchronous")),
      didDispatch() {},
    });

    expect(registry.getCommandState("choice-state:invalid", { target })).toEqual({
      type: "checkbox",
      checked: false,
    });
    expect(registry.getCommandState("choice-state:invalid", { target })).toEqual({
      type: "checkbox",
      checked: false,
    });
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("does not invalidate command surfaces after an ordinary cursor command", async () => {
    registry.add(target, "choice-state:move-cursor", () => {});
    const changes = jasmine.createSpy("state changes");
    registry.onDidChange(changes);

    await registry.dispatch(target, "choice-state:move-cursor");
    await Promise.resolve();
    expect(changes).not.toHaveBeenCalled();
  });

  it("waits for every matching handler before invalidating partially failed choice work", async () => {
    let resolveSlow, rejectFast;
    const slow = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    const fast = new Promise((resolve, reject) => {
      rejectFast = reject;
    });
    registry.add(target, "choice-state:multiple-handlers", {
      checked: false,
      didDispatch: () => slow,
    });
    registry.add(target, "choice-state:multiple-handlers", () => fast);
    const changes = jasmine.createSpy("state changes");
    registry.onDidChange(changes);

    const operation = registry.dispatch(target, "choice-state:multiple-handlers");
    const caught = operation.catch((error) => error);
    const failure = new Error("One handler failed");
    rejectFast(failure);
    expect(await caught).toBe(failure);
    expect(changes).not.toHaveBeenCalled();

    resolveSlow();
    await Promise.allSettled([fast, slow]);
    await Promise.resolve();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.calls.mostRecent().args[0].target).toBe(target);
  });

  it("refreshes partially changed choice state while preserving a synchronous handler error", async () => {
    let checked = false;
    const failure = new Error("Choice changed before failure");
    registry.add(target, "choice-state:sync-failure", {
      checked: () => checked,
      didDispatch() {
        checked = true;
        throw failure;
      },
    });
    const changes = jasmine.createSpy("state changes");
    registry.onDidChange(changes);
    const event = new CustomEvent("choice-state:sync-failure", { bubbles: true });
    Object.defineProperty(event, "target", { value: target });

    expect(() => registry.handleCommandEvent(event)).toThrow(failure);
    expect(changes).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.calls.mostRecent().args[0].target).toBe(target);
    expect(registry.getCommandState("choice-state:sync-failure", { target }).checked).toBe(true);
  });

  it("derives menu state from the command and lets an explicit row state override it", () => {
    registry.add(".choice-state-child", "choice-state:menu", {
      type: "radio",
      checked: true,
      didDispatch() {},
    });

    expect(menuItemState({ command: "choice-state:menu" }, target, registry)).toEqual({
      type: "radio",
      checked: true,
    });
    expect(
      menuItemState({ command: "choice-state:menu", checked: false }, target, registry),
    ).toEqual({
      type: "checkbox",
      checked: false,
    });
    expect(menuItemState({ type: "radio" }, target, registry)).toEqual({
      type: "radio",
      checked: false,
    });
    expect(menuItemState({ type: "separator" }, target, registry)).toBeNull();
    expect(menuItemState({ submenu: [], checked: true }, target, registry)).toBeNull();
  });

  it("validates row callback state and gives it the original target and detail", () => {
    const detail = { selected: 3 };
    const checked = jasmine.createSpy("checked").and.callFake((query) => {
      expect(query.target).toBe(target);
      expect(query.detail).toBe(detail);
      expect(Object.isFrozen(query)).toBe(true);
      return "mixed";
    });
    expect(menuItemState({ checked, commandDetail: detail }, target, registry)).toEqual({
      type: "checkbox",
      checked: "mixed",
    });
    spyOn(console, "error");
    expect(menuItemState({ type: "radio", checked: "mixed" }, target, registry)).toEqual({
      type: "radio",
      checked: false,
    });
    const invalidState = () => 1;
    expect(menuItemState({ checked: invalidState }, target, registry)).toEqual({
      type: "checkbox",
      checked: false,
    });
    expect(menuItemState({ checked: invalidState }, target, registry)).toEqual({
      type: "checkbox",
      checked: false,
    });
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("keeps a failing row callback isolated from other menu choices", () => {
    spyOn(console, "error");
    const invalidState = () => {
      throw new Error("No choice state available");
    };
    const rows = [
      { checked: invalidState },
      { type: "radio", checked: true },
      { type: "checkbox", checked: false },
    ];
    expect(rows.map((row) => menuItemState(row, target, registry))).toEqual([
      { type: "checkbox", checked: false },
      { type: "radio", checked: true },
      { type: "checkbox", checked: false },
    ]);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("prepares a serializable native snapshot and reevaluates without mutating menu definitions", () => {
    let current = true;
    registry.add(".choice-state-child", "choice-state:native", {
      type: "radio",
      checked: () => current,
      didDispatch() {},
    });
    const rowState = ({ target: commandTarget }) => commandTarget === target;
    createMenu([
      {
        label: "Choices",
        checked: () => true,
        submenu: [
          { label: "Command State", command: "choice-state:native" },
          {
            label: "Row State",
            type: "checkbox",
            checked: rowState,
            keyBindingTarget: () => target,
          },
          { label: "Mixed", type: "checkbox", checked: "mixed" },
          { type: "separator", checked: () => true },
          { label: "Plain Action" },
        ],
      },
    ]);

    const snapshot = menu.prepareNativeTemplate(target);
    expect(snapshot[0].submenu.map((item) => item.checked)).toEqual([
      true,
      true,
      false,
      undefined,
      undefined,
    ]);
    expect(snapshot[0].submenu.map((item) => item.type)).toEqual([
      "radio",
      "checkbox",
      "checkbox",
      "separator",
      undefined,
    ]);
    expect(snapshot[0].checked).toBeUndefined();
    expect(snapshot[0].submenu[2].label).toBe("Mixed (Mixed)");
    expect(snapshot[0].submenu[1].keyBindingTarget).toBeUndefined();
    expect(() => structuredClone(snapshot)).not.toThrow();
    expect(menu.template[0].submenu[0].checked).toBeUndefined();
    expect(menu.template[0].submenu[1].checked).toBe(rowState);
    expect(menu.template[0].submenu[2].checked).toBe("mixed");

    current = false;
    expect(menu.prepareNativeTemplate(target)[0].submenu[0].checked).toBe(false);
    expect(snapshot[0].submenu[0].checked).toBe(true);
  });
});
