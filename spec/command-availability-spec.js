const CommandRegistry = require("../src/command-registry");
const KeymapManager = require("../src/keymap-manager");

describe("Command availability predicates", () => {
  let registry, root, child, target, keymaps;

  beforeEach(() => {
    root = document.createElement("div");
    root.className = "availability-root";
    child = document.createElement("div");
    child.className = "availability-child";
    target = document.createElement("button");
    child.append(target);
    root.append(child);
    jasmine.attachToDOM(root);
    registry = new CommandRegistry();
    registry.attach(root);
  });

  afterEach(() => {
    keymaps?.destroy();
    keymaps = null;
    registry.destroy();
  });

  it("requires an optional predicate to be a function", () => {
    expect(() =>
      registry.add(child, "availability:invalid-registration", {
        isAvailable: true,
        didDispatch() {},
      }),
    ).toThrowError(TypeError);
  });

  it("does not evaluate unrelated commands or predicates outside their scope", () => {
    const unrelated = jasmine.createSpy("unrelated predicate").and.returnValue(false);
    const outside = jasmine.createSpy("outside scope").and.returnValue(false);
    registry.add(".availability-root", "availability:other", {
      isAvailable: unrelated,
      didDispatch() {},
    });
    registry.add("lumine-text-editor", "availability:requested", {
      isAvailable: outside,
      didDispatch() {},
    });
    registry.add(".availability-child", "availability:requested", () => {});
    registry.resolveContext = jasmine.createSpy("unneeded context");

    expect(registry.canDispatch(target, "availability:requested")).toBe(true);
    expect(unrelated).not.toHaveBeenCalled();
    expect(outside).not.toHaveBeenCalled();
    expect(registry.resolveContext).not.toHaveBeenCalled();
  });

  it("uses the matching node as this and shares one lazy context between predicate matches", () => {
    const detail = { selection: "repository" };
    const context = { window: "invoking window" };
    const calls = [];
    registry.resolveContext = jasmine.createSpy("context").and.returnValue(context);
    for (const [selector, element, enabled] of [
      [".availability-child", child, false],
      [".availability-root", root, true],
    ]) {
      registry.add(selector, "availability:query", {
        isAvailable(query) {
          expect(this).toBe(element);
          expect(query.currentTarget).toBe(element);
          expect(query.target).toBe(target);
          expect(query.detail).toBe(detail);
          expect(query.context).toBe(context);
          expect(Object.isFrozen(query)).toBe(true);
          expect(query.preventDefault).toBeUndefined();
          calls.push(element);
          return enabled;
        },
        didDispatch() {},
      });
    }

    expect(registry.canDispatch(target, "availability:query", detail)).toBe(true);
    expect(calls).toEqual([child, root]);
    expect(registry.resolveContext).toHaveBeenCalledTimes(1);
  });

  it("normalizes absent detail to null and rechecks supplied detail during dispatch", async () => {
    const handler = jasmine.createSpy("allowed handler");
    const detail = { permitted: true };
    const values = [];
    registry.add(".availability-child", "availability:details", {
      isAvailable(query) {
        values.push(query.detail);
        return query.detail?.permitted === true;
      },
      didDispatch: handler,
    });
    expect(registry.canDispatch(target, "availability:details")).toBe(false);
    expect(registry.canDispatch(target, "availability:details", detail)).toBe(true);
    await registry.dispatch(target, "availability:details", detail);
    expect(values).toEqual([null, detail, detail]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.calls.mostRecent().args[0].detail).toBe(detail);
  });

  it("keeps disabled scoped commands discoverable without exposing runtime predicates", () => {
    const predicate = jasmine.createSpy("disabled predicate").and.returnValue(false);
    registry.add(".availability-child", "availability:discover", {
      isAvailable: predicate,
      description: "A discoverable command.",
      didDispatch() {},
    });
    const discovered = registry.findCommands({ target });
    expect(discovered.map((command) => command.name)).toContain("availability:discover");
    expect(predicate).not.toHaveBeenCalled();
    expect(
      discovered.find((command) => command.name === "availability:discover").isAvailable,
    ).toBeUndefined();
    const presentation = registry.getCommandPresentation("availability:discover", { target });
    expect(presentation.enabled).toBe(false);
    expect(presentation.isAvailable).toBeUndefined();
    expect(
      registry
        .getCommandPresentations({ target })
        .find((command) => command.name === "availability:discover").enabled,
    ).toBe(false);
  });

  it("uses OR availability while dispatching each enabled listener exactly once in normal order", async () => {
    const calls = [];
    const disabled = jasmine.createSpy("disabled handler");
    const enabled = jasmine.createSpy("enabled predicate").and.returnValue(true);
    registry.add(".availability-child", "availability:many", {
      isAvailable: () => false,
      didDispatch: disabled,
    });
    registry.add(".availability-child", "availability:many", {
      isAvailable: enabled,
      didDispatch: () => calls.push("child"),
    });
    registry.add(".availability-root", "availability:many", () => calls.push("root"));

    await registry.dispatch(target, "availability:many");
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
    expect(calls).toEqual(["child", "root"]);
  });

  it("returns null without invoking handlers when every matching predicate declines", () => {
    const handler = jasmine.createSpy("disabled handler");
    registry.add(child, "availability:disabled", {
      isAvailable: () => false,
      didDispatch: handler,
    });
    expect(registry.canDispatch(target, "availability:disabled")).toBe(false);
    expect(registry.dispatch(target, "availability:disabled")).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed and reports each invalid predicate only once", () => {
    const error = spyOn(console, "error");
    const handler = jasmine.createSpy("invalid predicate handler");
    for (const [index, result] of [
      null,
      undefined,
      1,
      "yes",
      {},
      Promise.resolve(true),
    ].entries()) {
      const name = `availability:invalid-${index}`;
      registry.add(child, name, { isAvailable: () => result, didDispatch: handler });
      expect(registry.canDispatch(target, name)).toBe(false);
      expect(registry.canDispatch(target, name)).toBe(false);
      expect(registry.dispatch(target, name)).toBeNull();
    }
    registry.add(child, "availability:throws", {
      isAvailable() {
        throw new Error("Predicate failed");
      },
      didDispatch: handler,
    });
    expect(registry.canDispatch(target, "availability:throws")).toBe(false);
    expect(registry.dispatch(target, "availability:throws")).toBeNull();
    expect(error).toHaveBeenCalledTimes(7);
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets a disabled binding fall through to another matching binding without a duplicate call", () => {
    const predicate = jasmine.createSpy("keyboard predicate").and.returnValue(false);
    const disabled = jasmine.createSpy("disabled binding");
    const fallback = jasmine.createSpy("fallback binding");
    registry.add(child, "availability:keyboard-disabled", {
      isAvailable: predicate,
      didDispatch: disabled,
    });
    registry.add(root, "availability:keyboard-fallback", fallback);
    keymaps = new KeymapManager();
    keymaps.add("availability-spec", {
      ".availability-child": { "ctrl-alt-y": "availability:keyboard-disabled" },
      ".availability-root": { "ctrl-alt-y": "availability:keyboard-fallback" },
    });
    const event = new KeyboardEvent("keydown", { cancelable: true });

    expect(keymaps.dispatchKeystroke("ctrl-alt-y", target, event)).toBe(true);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not consume a disabled keystroke when no fallback handles it", () => {
    registry.add(child, "availability:keyboard-alone", {
      isAvailable: () => false,
      didDispatch() {},
    });
    keymaps = new KeymapManager();
    keymaps.add("availability-alone-spec", {
      ".availability-child": { "ctrl-alt-y": "availability:keyboard-alone" },
    });
    const event = new KeyboardEvent("keydown", { cancelable: true });

    expect(keymaps.dispatchKeystroke("ctrl-alt-y", target, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
