const CommandRegistry = require("../src/command-registry");
const _ = require("@lumine-code/underscore-plus");

describe("CommandRegistry", () => {
  let registry, parent, child, grandchild;

  beforeEach(() => {
    parent = document.createElement("div");
    child = document.createElement("div");
    grandchild = document.createElement("div");
    parent.classList.add("parent");
    child.classList.add("child");
    grandchild.classList.add("grandchild");
    child.appendChild(grandchild);
    parent.appendChild(child);
    document.querySelector("#jasmine-content").appendChild(parent);

    registry = new CommandRegistry();
    registry.attach(parent);
  });

  afterEach(() => registry.destroy());

  it("dispatches in another document without reaching the owning window's listeners", async () => {
    const frame = document.createElement("iframe");
    parent.append(frame);
    const childWindow = frame.contentWindow;
    const root = document.createElement("div");
    root.className = "auxiliary-command-root";
    childWindow.document.body.append(root);
    const observation = registry.attach(childWindow);
    const local = jasmine.createSpy("local");
    const main = jasmine.createSpy("main");
    registry.add(childWindow, "test:auxiliary", local);
    registry.add(window, "test:auxiliary", main);
    await registry.dispatch(root, "test:auxiliary");
    expect(local).toHaveBeenCalledTimes(1);
    expect(main).not.toHaveBeenCalled();
    expect(registry.findCommands({ target: root }).map(({ name }) => name)).toContain(
      "test:auxiliary",
    );
    observation.dispose();
    root.dispatchEvent(new CustomEvent("test:auxiliary", { bubbles: true }));
    expect(local).toHaveBeenCalledTimes(1);
    frame.remove();
  });

  describe("when a command event is dispatched on an element", () => {
    it("invokes callbacks with selectors matching the target", () => {
      let called = false;
      registry.add(".grandchild", "command", function (event) {
        expect(this).toBe(grandchild);
        expect(event.type).toBe("command");
        expect(event.eventPhase).toBe(Event.BUBBLING_PHASE);
        expect(event.target).toBe(grandchild);
        expect(event.currentTarget).toBe(grandchild);
        called = true;
      });

      grandchild.dispatchEvent(new CustomEvent("command", { bubbles: true }));
      expect(called).toBe(true);
    });

    it("invokes callbacks with selectors matching ancestors of the target", () => {
      const calls = [];

      registry.add(".child", "command", function (event) {
        expect(this).toBe(child);
        expect(event.target).toBe(grandchild);
        expect(event.currentTarget).toBe(child);
        calls.push("child");
      });

      registry.add(".parent", "command", function (event) {
        expect(this).toBe(parent);
        expect(event.target).toBe(grandchild);
        expect(event.currentTarget).toBe(parent);
        calls.push("parent");
      });

      grandchild.dispatchEvent(new CustomEvent("command", { bubbles: true }));
      expect(calls).toEqual(["child", "parent"]);
    });

    it("invokes inline listeners prior to listeners applied via selectors", () => {
      const calls = [];
      registry.add(".grandchild", "command", () => calls.push("grandchild"));
      registry.add(child, "command", () => calls.push("child-inline"));
      registry.add(".child", "command", () => calls.push("child"));
      registry.add(".parent", "command", () => calls.push("parent"));

      grandchild.dispatchEvent(new CustomEvent("command", { bubbles: true }));
      expect(calls).toEqual(["grandchild", "child-inline", "child", "parent"]);
    });

    it("orders multiple matching listeners for an element by selector specificity", () => {
      child.classList.add("foo", "bar");
      const calls = [];

      registry.add(".foo.bar", "command", () => calls.push(".foo.bar"));
      registry.add(".foo", "command", () => calls.push(".foo"));
      registry.add(".bar", "command", () => calls.push(".bar")); // specificity ties favor commands added later, like CSS

      grandchild.dispatchEvent(new CustomEvent("command", { bubbles: true }));
      expect(calls).toEqual([".foo.bar", ".bar", ".foo"]);
    });

    it("orders inline listeners by reverse registration order", () => {
      const calls = [];
      registry.add(child, "command", () => calls.push("child1"));
      registry.add(child, "command", () => calls.push("child2"));
      child.dispatchEvent(new CustomEvent("command", { bubbles: true }));
      expect(calls).toEqual(["child2", "child1"]);
    });

    it("stops bubbling through ancestors when .stopPropagation() is called on the event", () => {
      const calls = [];

      registry.add(".parent", "command", () => calls.push("parent"));
      registry.add(".child", "command", () => calls.push("child-2"));
      registry.add(".child", "command", (event) => {
        calls.push("child-1");
        event.stopPropagation();
      });

      const dispatchedEvent = new CustomEvent("command", { bubbles: true });
      spyOn(dispatchedEvent, "stopPropagation");
      grandchild.dispatchEvent(dispatchedEvent);
      expect(calls).toEqual(["child-1", "child-2"]);
      expect(dispatchedEvent.stopPropagation).toHaveBeenCalled();
    });

    it("stops invoking callbacks when .stopImmediatePropagation() is called on the event", () => {
      const calls = [];

      registry.add(".parent", "command", () => calls.push("parent"));
      registry.add(".child", "command", () => calls.push("child-2"));
      registry.add(".child", "command", (event) => {
        calls.push("child-1");
        event.stopImmediatePropagation();
      });

      const dispatchedEvent = new CustomEvent("command", { bubbles: true });
      spyOn(dispatchedEvent, "stopImmediatePropagation");
      grandchild.dispatchEvent(dispatchedEvent);
      expect(calls).toEqual(["child-1"]);
      expect(dispatchedEvent.stopImmediatePropagation).toHaveBeenCalled();
    });

    it("forwards .preventDefault() calls from the synthetic event to the original", () => {
      registry.add(".child", "command", (event) => event.preventDefault());

      const dispatchedEvent = new CustomEvent("command", { bubbles: true });
      spyOn(dispatchedEvent, "preventDefault");
      grandchild.dispatchEvent(dispatchedEvent);
      expect(dispatchedEvent.preventDefault).toHaveBeenCalled();
    });

    it("forwards .abortKeyBinding() calls from the synthetic event to the original", () => {
      registry.add(".child", "command", (event) => event.abortKeyBinding());

      const dispatchedEvent = new CustomEvent("command", { bubbles: true });
      dispatchedEvent.abortKeyBinding = jasmine.createSpy("abortKeyBinding");
      grandchild.dispatchEvent(dispatchedEvent);
      expect(dispatchedEvent.abortKeyBinding).toHaveBeenCalled();
    });

    it("copies non-standard properties from the original event to the synthetic event", () => {
      let syntheticEvent = null;
      registry.add(".child", "command", (event) => (syntheticEvent = event));

      const dispatchedEvent = new CustomEvent("command", { bubbles: true });
      dispatchedEvent.nonStandardProperty = "testing";
      grandchild.dispatchEvent(dispatchedEvent);
      expect(syntheticEvent.nonStandardProperty).toBe("testing");
    });

    it("allows listeners to be removed via a disposable returned by ::add", () => {
      let calls = [];

      const disposable1 = registry.add(".parent", "command", () => calls.push("parent"));
      const disposable2 = registry.add(".child", "command", () => calls.push("child"));

      disposable1.dispose();
      grandchild.dispatchEvent(new CustomEvent("command", { bubbles: true }));
      expect(calls).toEqual(["child"]);

      calls = [];
      disposable2.dispose();
      grandchild.dispatchEvent(new CustomEvent("command", { bubbles: true }));
      expect(calls).toEqual([]);
    });

    it("allows multiple commands to be registered under one selector when called with an object", () => {
      let calls = [];

      const disposable = registry.add(".child", {
        "command-1"() {
          calls.push("command-1");
        },
        "command-2"() {
          calls.push("command-2");
        },
      });

      grandchild.dispatchEvent(new CustomEvent("command-1", { bubbles: true }));
      grandchild.dispatchEvent(new CustomEvent("command-2", { bubbles: true }));

      expect(calls).toEqual(["command-1", "command-2"]);

      calls = [];
      disposable.dispose();
      grandchild.dispatchEvent(new CustomEvent("command-1", { bubbles: true }));
      grandchild.dispatchEvent(new CustomEvent("command-2", { bubbles: true }));
      expect(calls).toEqual([]);
    });

    it("invokes callbacks registered with ::onWillDispatch and ::onDidDispatch", () => {
      const sequence = [];

      registry.onDidDispatch((event) => sequence.push(["onDidDispatch", event]));

      registry.add(".grandchild", "command", (event) => sequence.push(["listener", event]));

      registry.onWillDispatch((event) => sequence.push(["onWillDispatch", event]));

      grandchild.dispatchEvent(new CustomEvent("command", { bubbles: true }));

      expect(sequence[0][0]).toBe("onWillDispatch");
      expect(sequence[1][0]).toBe("listener");
      expect(sequence[2][0]).toBe("onDidDispatch");

      expect(sequence[0][1] === sequence[1][1] && sequence[1][1] === sequence[2][1]).toBe(true);
      expect(sequence[0][1].constructor).toBe(CustomEvent);
      expect(sequence[0][1].target).toBe(grandchild);
    });
  });

  describe("::add(selector, commandName, callback)", () => {
    it("throws an error when called with an invalid selector", () => {
      const badSelector = "<>";
      let addError = null;
      try {
        registry.add(badSelector, "foo:bar", () => {});
      } catch (error) {
        addError = error;
      }
      expect(addError.message).toContain(badSelector);
    });

    it("throws an error when called with a null callback and selector target", () => {
      const badCallback = null;

      expect(() => {
        registry.add(".selector", "foo:bar", badCallback);
      }).toThrow(new Error("Cannot register a command with a null listener."));
    });

    it("throws an error when called with a null callback and object target", () => {
      const badCallback = null;

      expect(() => {
        registry.add(document.body, "foo:bar", badCallback);
      }).toThrow(new Error("Cannot register a command with a null listener."));
    });

    it("throws an error when called with an object listener without a didDispatch method", () => {
      const badListener = {
        title: "a listener without a didDispatch callback",
        description: "this should throw an error",
      };

      expect(() => {
        registry.add(document.body, "foo:bar", badListener);
      }).toThrow(
        new Error("Listener must be a callback function or an object with a didDispatch method."),
      );
    });
  });

  describe("::canDispatch(target, commandName)", () => {
    it("matches the target and its ancestors without invoking handlers", () => {
      const handler = jasmine.createSpy("handler");
      registry.add(".grandchild", "test:local", handler);
      registry.add(".parent", "test:ancestor", handler);

      expect(registry.canDispatch(grandchild, "test:local")).toBe(true);
      expect(registry.canDispatch(child, "test:local")).toBe(false);
      expect(registry.canDispatch(grandchild, "test:ancestor")).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });

    it("honors mini and read-only exclusions in the registered scope", () => {
      child.classList.add("text-editor");
      registry.add(".text-editor:not([mini]):not([readonly])", "test:edit", () => {});

      expect(registry.canDispatch(grandchild, "test:edit")).toBe(true);
      child.setAttribute("mini", "");
      expect(registry.canDispatch(grandchild, "test:edit")).toBe(false);
      child.removeAttribute("mini");
      child.setAttribute("readonly", "");
      expect(registry.canDispatch(grandchild, "test:edit")).toBe(false);
      child.removeAttribute("readonly");
      expect(registry.canDispatch(grandchild, "test:edit")).toBe(true);
    });

    it("finds inline handlers only on the target's route and observes their disposal", () => {
      const registration = registry.add(child, "test:inline", () => {});

      expect(registry.canDispatch(grandchild, "test:inline")).toBe(true);
      expect(registry.canDispatch(parent, "test:inline")).toBe(false);
      registration.dispose();
      expect(registry.canDispatch(grandchild, "test:inline")).toBe(false);
    });

    it("observes selector disposal without treating the remaining command event as registered", () => {
      const registration = registry.add(".parent", "test:scoped", () => {});

      expect(registry.canDispatch(grandchild, "test:scoped")).toBe(true);
      registration.dispose();
      expect(registry.canDispatch(grandchild, "test:scoped")).toBe(false);
    });

    it("includes detached ancestors and the target's window", () => {
      parent.remove();
      registry.add(".parent", "test:detached", () => {});
      registry.add(window, "test:window", () => {});

      expect(registry.canDispatch(grandchild, "test:detached")).toBe(true);
      expect(registry.canDispatch(grandchild, "test:window")).toBe(true);
      expect(registry.canDispatch(document, "test:window")).toBe(true);
      expect(registry.canDispatch(window, "test:window")).toBe(true);
    });

    it("stays in a foreign target's window instead of reaching the registry's window", () => {
      const frame = document.createElement("iframe");
      parent.append(frame);
      const childWindow = frame.contentWindow;
      const target = childWindow.document.createElement("div");
      childWindow.document.body.append(target);
      registry.add(window, "test:main-window", () => {});
      registry.add(childWindow, "test:foreign-window", () => {});

      expect(registry.canDispatch(target, "test:main-window")).toBe(false);
      expect(registry.canDispatch(target, "test:foreign-window")).toBe(true);
      expect(registry.canDispatch(childWindow.document, "test:foreign-window")).toBe(true);
      expect(registry.canDispatch(childWindow, "test:foreign-window")).toBe(true);
      frame.remove();
    });

    it("returns false for missing commands or targets", () => {
      registry.add(".parent", "test:known", () => {});

      expect(registry.canDispatch(grandchild, "test:unknown")).toBe(false);
      expect(registry.canDispatch(grandchild, "toString")).toBe(false);
      expect(registry.canDispatch(grandchild, null)).toBe(false);
      expect(registry.canDispatch(grandchild, "")).toBe(false);
      expect(registry.canDispatch(null, "test:known")).toBe(false);
      expect(registry.canDispatch(undefined, "test:known")).toBe(false);
      expect(registry.canDispatch()).toBe(false);
    });

    it("looks up only the requested command and stops at the first match", () => {
      registry.add(".grandchild", "test:requested", () => {});
      registry.add(".parent", "test:requested", () => {});
      registry.add(".grandchild", "test:unrelated", () => {});
      registry.add(grandchild, "test:unrelated-inline", () => {});
      spyOn(registry, "findCommands").and.throwError("Must not build a command catalogue");
      const laterMatch = registry.selectorBasedListenersByCommandName["test:requested"][1];
      spyOn(laterMatch, "matchesTarget").and.throwError("Must stop after the first match");
      const preventScan = {
        ownKeys() {
          throw new Error("Must not scan unrelated commands");
        },
      };
      registry.selectorBasedListenersByCommandName = new Proxy(
        registry.selectorBasedListenersByCommandName,
        preventScan,
      );
      registry.inlineListenersByCommandName = new Proxy(
        registry.inlineListenersByCommandName,
        preventScan,
      );

      expect(registry.canDispatch(grandchild, "test:requested")).toBe(true);
      expect(registry.canDispatch(child, "test:unrelated-inline")).toBe(false);
    });
  });

  describe("::onDidChange(callback)", () => {
    it("notifies after selector and inline registrations are added and removed", () => {
      const states = [];
      registry.onDidChange(() => states.push(registry.canDispatch(grandchild, "test:change")));

      const selector = registry.add(".parent", "test:change", () => {});
      selector.dispose();
      const inline = registry.add(child, "test:change", () => {});
      inline.dispose();

      expect(states).toEqual([true, false, true, false]);
    });

    it("survives clear and ignores disposal from a cleared generation", () => {
      const oldSelector = registry.add(".parent", "test:change", () => {});
      const oldInline = registry.add(child, "test:inline-change", () => {});
      const changed = jasmine.createSpy("changed");
      registry.onDidChange(changed);

      registry.clear();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(registry.canDispatch(grandchild, "test:change")).toBe(false);
      registry.add(".parent", "test:change", () => {});
      registry.add(child, "test:inline-change", () => {});
      expect(changed).toHaveBeenCalledTimes(3);
      oldSelector.dispose();
      oldInline.dispose();
      expect(changed).toHaveBeenCalledTimes(3);
      expect(registry.canDispatch(grandchild, "test:change")).toBe(true);
      expect(registry.canDispatch(grandchild, "test:inline-change")).toBe(true);
    });

    it("notifies after restoring a snapshot and ignores a displaced registration's disposal", () => {
      registry.add(".parent", "test:snapshot", () => {});
      const snapshot = registry.getSnapshot();
      const discarded = registry.add(".grandchild", "test:discarded", () => {});
      const changed = jasmine.createSpy("changed").and.callFake(() => {
        expect(registry.canDispatch(grandchild, "test:snapshot")).toBe(true);
        expect(registry.canDispatch(grandchild, "test:discarded")).toBe(false);
      });
      registry.onDidChange(changed);

      registry.restoreSnapshot(snapshot);
      expect(changed).toHaveBeenCalledTimes(1);
      discarded.dispose();
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("stops notifications when the subscription or registry is disposed", () => {
      const changed = jasmine.createSpy("changed");
      const subscription = registry.onDidChange(changed);
      registry.add(".parent", "test:before-dispose", () => {});
      subscription.dispose();
      registry.add(".parent", "test:after-dispose", () => {});
      expect(changed).toHaveBeenCalledTimes(1);

      const destroyed = jasmine.createSpy("destroyed");
      registry.onDidChange(destroyed);
      registry.destroy();
      registry.clear();
      expect(destroyed).not.toHaveBeenCalled();
    });
  });

  describe("::findCommands({target})", () => {
    it("returns command descriptors that can be invoked on the target or its ancestors", () => {
      registry.add(".parent", "namespace:command-1", () => {});
      registry.add(".child", "namespace:command-2", () => {});
      registry.add(".grandchild", "namespace:command-3", () => {});
      registry.add(".grandchild.no-match", "namespace:command-4", () => {});

      registry.add(grandchild, "namespace:inline-command-1", () => {});
      registry.add(child, "namespace:inline-command-2", () => {});

      const commands = registry.findCommands({ target: grandchild });
      const nonJqueryCommands = _.reject(commands, (cmd) => cmd.jQuery);
      expect(nonJqueryCommands).toEqual([
        {
          name: "namespace:inline-command-1",
          displayName: "Namespace: Inline Command 1",
        },
        { name: "namespace:command-3", displayName: "Namespace: Command 3" },
        {
          name: "namespace:inline-command-2",
          displayName: "Namespace: Inline Command 2",
        },
        { name: "namespace:command-2", displayName: "Namespace: Command 2" },
        { name: "namespace:command-1", displayName: "Namespace: Command 1" },
      ]);
    });

    it("returns command descriptors with arbitrary metadata if set in a listener object", () => {
      registry.add(".grandchild", "namespace:command-1", () => {});
      registry.add(".grandchild", "namespace:command-2", {
        displayName: "Custom Command 2",
        metadata: {
          some: "other",
          object: "data",
        },
        didDispatch() {},
      });
      registry.add(".grandchild", "namespace:command-3", {
        name: "some:other:incorrect:commandname",
        displayName: "Custom Command 3",
        metadata: {
          some: "other",
          object: "data",
        },
        didDispatch() {},
      });

      const commands = registry.findCommands({ target: grandchild });
      expect(commands).toEqual([
        {
          displayName: "Namespace: Command 1",
          name: "namespace:command-1",
        },
        {
          displayName: "Custom Command 2",
          metadata: {
            some: "other",
            object: "data",
          },
          name: "namespace:command-2",
        },
        {
          displayName: "Custom Command 3",
          metadata: {
            some: "other",
            object: "data",
          },
          name: "namespace:command-3",
        },
      ]);
    });

    it("returns command descriptors with arbitrary metadata if set on a listener function", () => {
      function listener() {}
      listener.displayName = "Custom Command 2";
      listener.metadata = {
        some: "other",
        object: "data",
      };

      registry.add(".grandchild", "namespace:command-2", listener);
      const commands = registry.findCommands({ target: grandchild });
      expect(commands).toEqual([
        {
          displayName: "Custom Command 2",
          metadata: {
            some: "other",
            object: "data",
          },
          name: "namespace:command-2",
        },
      ]);
    });
  });

  describe("::getCommandPresentation(commandName, {target})", () => {
    it("combines command metadata with deduplicated effective keybindings", () => {
      const keymapManager = {
        findKeyBindings: jasmine
          .createSpy("findKeyBindings")
          .and.returnValue([
            { keystrokes: "ctrl-x" },
            { keystrokes: "ctrl-x" },
            { keystrokes: "alt-x" },
          ]),
      };
      registry.destroy();
      registry = new CommandRegistry({ keymapManager });
      registry.attach(parent);
      registry.add(grandchild, "namespace:command", {
        displayName: "A Command",
        description: "Does one thing.",
        didDispatch() {},
      });

      const presentation = registry.getCommandPresentation("namespace:command", {
        target: grandchild,
        bindingTarget: child,
      });

      expect(presentation).toEqual({
        name: "namespace:command",
        displayName: "A Command",
        description: "Does one thing.",
        keystrokes: ["ctrl-x", "alt-x"],
      });
      expect(Object.isFrozen(presentation)).toBe(true);
      expect(Object.isFrozen(presentation.keystrokes)).toBe(true);
      expect(keymapManager.findKeyBindings).toHaveBeenCalledWith({
        command: "namespace:command",
        target: child,
      });
      expect(
        registry.getCommandPresentation("namespace:missing", { target: grandchild }),
      ).toBeNull();
    });
  });

  describe("::getCommandPresentations({target})", () => {
    it("scans commands and keybindings once for a complete frozen catalogue", () => {
      const keymapManager = {
        findKeyBindings: jasmine.createSpy("findKeyBindings").and.returnValue([
          { command: "namespace:first", keystrokes: "ctrl-x" },
          { command: "namespace:first", keystrokes: "ctrl-x" },
          { command: "namespace:second", keystrokes: "alt-y" },
        ]),
      };
      registry.destroy();
      registry = new CommandRegistry({ keymapManager });
      registry.attach(parent);
      registry.add(grandchild, {
        "namespace:first": { displayName: "First", didDispatch() {} },
        "namespace:second": { displayName: "Second", didDispatch() {} },
      });
      spyOn(registry, "findCommands").and.callThrough();

      const presentations = registry.getCommandPresentations({
        target: grandchild,
        bindingTarget: child,
      });

      expect(presentations).toEqual([
        { name: "namespace:first", displayName: "First", keystrokes: ["ctrl-x"] },
        { name: "namespace:second", displayName: "Second", keystrokes: ["alt-y"] },
      ]);
      expect(registry.findCommands).toHaveBeenCalledTimes(1);
      expect(keymapManager.findKeyBindings).toHaveBeenCalledOnceWith({ target: child });
      expect(Object.isFrozen(presentations)).toBe(true);
      expect(presentations.every(Object.isFrozen)).toBe(true);
      expect(presentations.every(({ keystrokes }) => Object.isFrozen(keystrokes))).toBe(true);
    });
  });

  describe("::dispatch(target, commandName)", () => {
    it("simulates invocation of the given command ", () => {
      let called = false;
      registry.add(".grandchild", "command", function (event) {
        expect(this).toBe(grandchild);
        expect(event.type).toBe("command");
        expect(event.eventPhase).toBe(Event.BUBBLING_PHASE);
        expect(event.target).toBe(grandchild);
        expect(event.currentTarget).toBe(grandchild);
        called = true;
      });

      registry.dispatch(grandchild, "command");
      expect(called).toBe(true);
    });

    it("returns a promise if any listeners matched the command", () => {
      registry.add(".grandchild", "command", () => {});

      expect(registry.dispatch(grandchild, "command").constructor.name).toBe("Promise");
      expect(registry.dispatch(grandchild, "bogus")).toBe(null);
      expect(registry.dispatch(parent, "command")).toBe(null);
    });

    it("returns a promise that resolves when the listeners resolve", async () => {
      jasmine.useRealClock();
      registry.add(".grandchild", "command", () => 1);
      registry.add(".grandchild", "command", () => Promise.resolve(2));
      registry.add(
        ".grandchild",
        "command",
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(3);
            }, 1);
          }),
      );

      const values = await registry.dispatch(grandchild, "command");
      expect(values).toEqual([3, 2, 1]);
    });

    it("returns a promise that rejects when a listener is rejected", async () => {
      jasmine.useRealClock();
      registry.add(".grandchild", "command", () => 1);
      registry.add(".grandchild", "command", () => Promise.resolve(2));
      registry.add(
        ".grandchild",
        "command",
        () =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              reject(3);
            }, 1);
          }),
      );

      let value;
      try {
        value = await registry.dispatch(grandchild, "command");
      } catch (err) {
        value = err;
      }
      expect(value).toBe(3);
    });
  });

  describe("::getSnapshot and ::restoreSnapshot", () =>
    it("removes all command handlers except for those in the snapshot", () => {
      registry.add(".parent", "namespace:command-1", () => {});
      registry.add(".child", "namespace:command-2", () => {});
      const snapshot = registry.getSnapshot();
      registry.add(".grandchild", "namespace:command-3", () => {});

      expect(registry.findCommands({ target: grandchild }).slice(0, 3)).toEqual([
        { name: "namespace:command-3", displayName: "Namespace: Command 3" },
        { name: "namespace:command-2", displayName: "Namespace: Command 2" },
        { name: "namespace:command-1", displayName: "Namespace: Command 1" },
      ]);

      registry.restoreSnapshot(snapshot);

      expect(registry.findCommands({ target: grandchild }).slice(0, 2)).toEqual([
        { name: "namespace:command-2", displayName: "Namespace: Command 2" },
        { name: "namespace:command-1", displayName: "Namespace: Command 1" },
      ]);

      registry.add(".grandchild", "namespace:command-3", () => {});
      registry.restoreSnapshot(snapshot);

      expect(registry.findCommands({ target: grandchild }).slice(0, 2)).toEqual([
        { name: "namespace:command-2", displayName: "Namespace: Command 2" },
        { name: "namespace:command-1", displayName: "Namespace: Command 1" },
      ]);
    }));

  describe("::attach(rootNode)", () =>
    it("adds event listeners for any previously-added commands", () => {
      const registry2 = new CommandRegistry();

      const commandSpy = jasmine.createSpy("command-callback");
      registry2.add(".grandchild", "command-1", commandSpy);

      grandchild.dispatchEvent(new CustomEvent("command-1", { bubbles: true }));
      expect(commandSpy).not.toHaveBeenCalled();

      registry2.attach(parent);

      grandchild.dispatchEvent(new CustomEvent("command-1", { bubbles: true }));
      expect(commandSpy).toHaveBeenCalled();
    }));
});

describe("command registry reset generations", () => {
  it("keeps a replacement command when a lease from the cleared generation is disposed", () => {
    const CommandRegistry = require("../src/command-registry");
    const commands = new CommandRegistry();
    const old = commands.add("lumine-workspace", { "test:reset-command": () => {} });
    commands.clear();
    const current = commands.add("lumine-workspace", {
      "test:reset-command": { description: "Current generation.", didDispatch() {} },
    });
    old.dispose();
    expect(
      commands
        .findCommands({ target: lumine.workspace.getElement() })
        .some(
          (command) =>
            command.name === "test:reset-command" && command.description === "Current generation.",
        ),
    ).toBe(true);
    current.dispose();
    commands.clear();
  });
});
