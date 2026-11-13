const CommandRegistry = require("../src/command-registry");
const ScrollbarManager = require("../src/scrollbar-manager");

describe("Scrollbar navigation commands", () => {
  let manager, registry, fixture, scope, target, port;

  beforeEach(() => {
    manager = new ScrollbarManager({});
    spyOn(manager, "reveal").and.returnValue(true);
    fixture = document.createElement("section");
    scope = document.createElement("div");
    scope.className = "scrollbar-navigation-scope";
    target = document.createElement("span");
    target.className = "scrollbar-navigation-target";
    port = document.createElement("div");
    scope.append(target, port);
    fixture.append(scope);
    jasmine.attachToDOM(fixture);
    registry = new CommandRegistry();
    registry.attach(fixture);
  });

  afterEach(() => registry.destroy());

  for (const result of [undefined, false]) {
    it(`reveals a handled boundary operation returning ${result} without moving the viewport`, () => {
      const handler = jasmine.createSpy("navigation").and.returnValue(result);
      const commands = manager.navigationCommands(port, { "test:move": handler });
      expect(commands["test:move"].call(scope)).toBe(result);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(manager.reveal).toHaveBeenCalledOnceWith(port);
      expect(port.scrollTop).toBe(0);
      expect(port.scrollLeft).toBe(0);
    });
  }

  it("preserves metadata attached to a function without mutating the source command map", () => {
    const handler = jasmine.createSpy("navigation");
    const metadata = { group: "navigation" };
    Object.assign(handler, {
      description: "Move the selection.",
      hiddenInCommandPalette: true,
      metadata,
    });
    const original = { "test:move": handler };
    const commands = manager.navigationCommands(port, original);
    expect(commands).not.toBe(original);
    expect(typeof commands["test:move"]).toBe("function");
    expect(commands["test:move"]).not.toBe(handler);
    expect(commands["test:move"].description).toBe(handler.description);
    expect(commands["test:move"].hiddenInCommandPalette).toBeTrue();
    expect(commands["test:move"].metadata).toBe(metadata);
    expect(original["test:move"]).toBe(handler);
    expect(manager.reveal).not.toHaveBeenCalled();
  });

  it("preserves descriptor metadata and availability through ordinary command registration", () => {
    const handler = jasmine.createSpy("navigation");
    const available = jasmine.createSpy("available").and.returnValue(true);
    const checked = jasmine.createSpy("checked").and.returnValue(false);
    const metadata = { group: "navigation" };
    const original = {
      description: "Move the selection.",
      displayName: "Move Selection",
      hiddenInCommandPalette: true,
      isAvailable: available,
      checked,
      type: "radio",
      metadata,
      didDispatch: handler,
    };
    const commands = manager.navigationCommands(port, { "test:move": original });
    const wrapped = commands["test:move"];
    expect(wrapped).not.toBe(original);
    expect(wrapped.isAvailable).toBe(available);
    expect(wrapped.checked).toBe(checked);
    expect(wrapped.metadata).toBe(metadata);
    expect(original.didDispatch).toBe(handler);
    registry.add(scope, commands);
    const descriptor = registry.findCommands({ target }).find(({ name }) => name === "test:move");
    expect(descriptor.description).toBe(original.description);
    expect(descriptor.displayName).toBe(original.displayName);
    expect(descriptor.hiddenInCommandPalette).toBeTrue();
    expect(descriptor.metadata).toBe(metadata);
  });

  it("resolves the current exact port after the handler with its receiver and original arguments", () => {
    const replacement = document.createElement("div");
    const unrelatedInput = document.createElement("input");
    fixture.append(unrelatedInput);
    const event = { type: "test:move", currentTarget: scope };
    const detail = { direction: 1 };
    let currentPort = port;
    const sequence = [];
    const handler = function (...args) {
      expect(this).toBe(scope);
      expect(args).toEqual([event, detail]);
      sequence.push("handler");
      port.replaceWith(replacement);
      currentPort = replacement;
      unrelatedInput.focus();
      return detail;
    };
    const resolver = function (...args) {
      expect(this).toBe(scope);
      expect(args).toEqual([event, detail]);
      expect(document.activeElement).toBe(unrelatedInput);
      sequence.push("resolver");
      return currentPort;
    };
    const commands = manager.navigationCommands(resolver, { "test:move": handler });
    expect(commands["test:move"].call(scope, event, detail)).toBe(detail);
    expect(sequence).toEqual(["handler", "resolver"]);
    expect(manager.reveal).toHaveBeenCalledOnceWith(replacement);
  });

  it("reveals immediately and returns the identical pending Promise without awaiting completion", () => {
    let complete;
    const result = new Promise((resolve) => (complete = resolve));
    const then = spyOn(result, "then").and.callThrough();
    const commands = manager.navigationCommands(port, { "test:move": () => result });
    expect(commands["test:move"]()).toBe(result);
    expect(manager.reveal).toHaveBeenCalledOnceWith(port);
    expect(then).not.toHaveBeenCalled();
    complete();
  });

  it("preserves a thrown handler error without resolving a port or revealing chrome", () => {
    const failure = new Error("navigation failed");
    const resolver = jasmine.createSpy("port resolver").and.returnValue(port);
    const commands = manager.navigationCommands(resolver, {
      "test:move": () => {
        throw failure;
      },
    });
    expect(() => commands["test:move"]()).toThrow(failure);
    expect(resolver).not.toHaveBeenCalled();
    expect(manager.reveal).not.toHaveBeenCalled();
  });

  it("allows a late resolver to return null while preserving the handler result", () => {
    const result = {};
    const resolver = jasmine.createSpy("port resolver").and.returnValue(null);
    const commands = manager.navigationCommands(resolver, { "test:move": () => result });
    expect(resolver).not.toHaveBeenCalled();
    expect(commands["test:move"]()).toBe(result);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(manager.reveal).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid handlers before any command is invoked", () => {
    const resolver = jasmine.createSpy("port resolver").and.returnValue(port);
    for (const listener of [null, {}, { didDispatch: "not a function" }]) {
      expect(() => manager.navigationCommands(resolver, { "test:move": listener })).toThrowError(
        TypeError,
      );
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(manager.reveal).not.toHaveBeenCalled();
  });

  it("uses the registry's matching scope, availability and disposable without false activity", async () => {
    const handler = jasmine.createSpy("navigation");
    const resolver = jasmine.createSpy("port resolver").and.returnValue(port);
    let available = false;
    const commands = manager.navigationCommands(resolver, {
      "test:move": { isAvailable: () => available, didDispatch: handler },
    });
    const registration = registry.add(".scrollbar-navigation-scope", commands);
    expect(registry.dispatch(fixture, "test:move")).toBeNull();
    expect(registry.dispatch(target, "test:move")).toBeNull();
    expect(handler).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(manager.reveal).not.toHaveBeenCalled();
    available = true;
    await registry.dispatch(target, "test:move");
    expect(handler.calls.mostRecent().object).toBe(scope);
    expect(resolver.calls.mostRecent().object).toBe(scope);
    expect(manager.reveal).toHaveBeenCalledOnceWith(port);
    registration.dispose();
    expect(registry.dispatch(target, "test:move")).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(manager.reveal).toHaveBeenCalledTimes(1);
  });

  it("does not reveal for typing commands outside the explicit navigation map", async () => {
    const typing = jasmine.createSpy("typing");
    registry.add(scope, {
      ...manager.navigationCommands(port, { "test:move": () => {} }),
      "test:type": typing,
    });
    await registry.dispatch(target, "test:type");
    expect(typing).toHaveBeenCalledTimes(1);
    expect(manager.reveal).not.toHaveBeenCalled();
  });

  it("does not reveal an ancestor port when an inner handler consumes the command", async () => {
    const handler = jasmine.createSpy("parent navigation");
    registry.add(scope, manager.navigationCommands(port, { "test:move": handler }));
    registry.add(target, "test:move", (event) => event.stopPropagation());
    await registry.dispatch(target, "test:move");
    expect(handler).not.toHaveBeenCalled();
    expect(manager.reveal).not.toHaveBeenCalled();
  });

  it("only reveals chrome without attaching, measuring or refreshing geometry", () => {
    const geometry = ["getGeometry", "observe", "refresh", "attach", "forDocument"].map((method) =>
      spyOn(manager, method),
    );
    const measurements = [
      ...["clientWidth", "clientHeight", "scrollWidth", "scrollHeight"].map((property) =>
        spyOnProperty(port, property, "get").and.callThrough(),
      ),
      spyOn(port, "getBoundingClientRect").and.callThrough(),
    ];
    manager.reveal.and.callThrough();
    const reveal = jasmine.createSpy("local reveal").and.callFake((element) => {
      element.classList.add("is-revealed");
      return true;
    });
    manager.documents.set(document, { reveal });
    const commands = manager.navigationCommands(port, { "test:move": () => {} });
    commands["test:move"]();
    expect(port.classList.contains("is-revealed")).toBeTrue();
    expect(reveal).toHaveBeenCalledOnceWith(port);
    for (const measurement of [...geometry, ...measurements])
      expect(measurement).not.toHaveBeenCalled();
  });
});
