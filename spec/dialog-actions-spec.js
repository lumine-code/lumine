const DialogActions = require("../src/dialog-actions");

describe("DialogActions", () => {
  let actions, dispatch, hooks;

  const itemAction = (command, options = {}) => ({
    command,
    context: "item",
    disposition: "stay",
    ...options,
  });

  const dialogAction = (command, options = {}) => ({
    command,
    context: "dialog",
    disposition: "stay",
    ...options,
  });

  beforeEach(() => {
    dispatch = jasmine.createSpy("dispatch").and.resolveTo("result");
    hooks = {
      close: jasmine.createSpy("close").and.resolveTo(),
      stay: jasmine.createSpy("stay").and.resolveTo(),
      push: jasmine.createSpy("push").and.resolveTo(),
      recordRecent: jasmine.createSpy("recordRecent").and.resolveTo(),
    };
    actions = new DialogActions({ dispatch, hooks });
  });

  afterEach(async () => {
    await actions.destroy();
  });

  it("requires injected collaborators with valid types", () => {
    expect(() => new DialogActions()).toThrowError(TypeError, /dispatch callback/);
    expect(() => new DialogActions({ dispatch, confirm: true })).toThrowError(
      TypeError,
      /confirm must be a function/,
    );
    expect(() => new DialogActions({ dispatch, hooks: { stay: true } })).toThrowError(
      TypeError,
      /hook 'stay' must be a function/,
    );
  });

  describe("catalogue", () => {
    it("sets arrays and command-keyed maps atomically", () => {
      actions.set([dialogAction("spec:first"), dialogAction("spec:second")]);
      expect(actions.getAvailable().map(({ command }) => command)).toEqual([
        "spec:first",
        "spec:second",
      ]);
      expect(actions.getAll().map(({ command }) => command)).toEqual(["spec:first", "spec:second"]);
      expect(actions.has("spec:first")).toBe(true);
      expect(actions.has("spec:missing")).toBe(false);

      actions.set({
        "spec:mapped": { context: "dialog", disposition: "close" },
      });
      expect(actions.getAvailable().map(({ command }) => command)).toEqual(["spec:mapped"]);

      expect(() =>
        actions.set([dialogAction("spec:duplicate"), dialogAction("spec:duplicate")]),
      ).toThrowError(/duplicated/);
      expect(actions.getAvailable().map(({ command }) => command)).toEqual(["spec:mapped"]);
    });

    it("adds actions through both overloads and disposes only those registrations", () => {
      const first = actions.add("spec:first", {
        context: "dialog",
        disposition: "stay",
      });
      const more = actions.add([dialogAction("spec:second"), dialogAction("spec:third")]);
      expect(actions.getAvailable().map(({ command }) => command)).toEqual([
        "spec:first",
        "spec:second",
        "spec:third",
      ]);

      more.dispose();
      expect(actions.getAvailable().map(({ command }) => command)).toEqual(["spec:first"]);

      actions.set([dialogAction("spec:first", { order: 7 })]);
      first.dispose();
      expect(actions.getAvailable()[0].order).toBe(7);
    });

    it("rejects duplicate additions and malformed descriptors", () => {
      actions.add(dialogAction("spec:one"));
      expect(() => actions.add(dialogAction("spec:one"))).toThrowError(/already registered/);
      expect(() => actions.add({ command: "spec:no-context", disposition: "stay" })).toThrowError(
        /must declare context/,
      );
      expect(() => actions.add({ command: "spec:no-disposition", context: "dialog" })).toThrowError(
        /must declare disposition/,
      );
      expect(() =>
        actions.add(dialogAction("spec:bad-order", { order: Number.POSITIVE_INFINITY })),
      ).toThrowError(/finite number/);
    });

    it("keeps groups in first-declaration order and actions in order/declaration order", () => {
      actions.set([
        dialogAction("spec:tools-late", { group: "tools", order: 20 }),
        dialogAction("spec:files-second", { group: "files", order: 0 }),
        dialogAction("spec:tools-first", { group: "tools", order: 10 }),
        dialogAction("spec:files-first", { group: "files", order: -1 }),
        dialogAction("spec:ungrouped-second", { order: 2 }),
        dialogAction("spec:ungrouped-first", { order: 1 }),
      ]);

      expect(actions.getAvailable().map(({ command }) => command)).toEqual([
        "spec:tools-first",
        "spec:tools-late",
        "spec:files-first",
        "spec:files-second",
        "spec:ungrouped-first",
        "spec:ungrouped-second",
      ]);
    });
  });

  describe("availability", () => {
    it("separates visibility from enabled state and evaluates a disabled reason", () => {
      actions.set([
        dialogAction("spec:hidden", { when: false }),
        dialogAction("spec:disabled", {
          enabled: ({ canRun }) => canRun,
          disabledReason: ({ reason }) => reason,
        }),
        dialogAction("spec:enabled"),
      ]);

      const available = actions.getAvailable({ canRun: false, reason: "Not ready" });
      expect(available.map(({ command }) => command)).toEqual(["spec:disabled", "spec:enabled"]);
      expect(available[0].enabled).toBe(false);
      expect(available[0].disabledReason).toBe("Not ready");
      expect(available[1].enabled).toBe(true);
      expect(available[1].disabledReason).toBeNull();
      expect(actions.hasAvailable({ canRun: false })).toBe(true);
    });

    it("omits item actions without an item but keeps dialog actions", () => {
      actions.set([itemAction("spec:item"), dialogAction("spec:dialog")]);
      expect(actions.getAvailable().map(({ command }) => command)).toEqual(["spec:dialog"]);
      expect(actions.getAvailable({ item: "one" }).map(({ command }) => command)).toEqual([
        "spec:item",
        "spec:dialog",
      ]);
    });

    it("finds one dynamic primary and rejects multiple applicable primaries", () => {
      actions.set([
        itemAction("spec:first", { primary: ({ item }) => item.kind === "first" }),
        itemAction("spec:second", { primary: ({ item }) => item.kind === "second" }),
      ]);
      expect(actions.getPrimary({ item: { kind: "second" } }).command).toBe("spec:second");

      actions.add(
        itemAction("spec:also-second", { primary: ({ item }) => item.kind === "second" }),
      );
      expect(() => actions.getAvailable({ item: { kind: "second" } })).toThrowError(
        /Multiple primary dialog actions apply: spec:second, spec:also-second/,
      );
      expect(() => actions.hasAvailable({ item: { kind: "second" } })).toThrowError(
        /Multiple primary/,
      );
    });

    it("uses a shallow frozen snapshot and rejects asynchronous predicates", () => {
      let seen;
      actions.set([
        dialogAction("spec:snapshot", {
          when: (context) => {
            seen = context;
            return true;
          },
        }),
      ]);
      const source = { query: "before", items: ["one"] };
      actions.getAvailable(source);
      source.query = "after";
      source.items.push("two");
      expect(Object.isFrozen(seen)).toBe(true);
      expect(Object.isFrozen(seen.items)).toBe(true);
      expect(seen.query).toBe("before");
      expect(seen.items).toEqual(["one"]);

      actions.set([dialogAction("spec:async", { when: () => Promise.resolve(true) })]);
      expect(() => actions.getAvailable()).toThrowError(/when must be synchronous/);
    });
  });

  describe("runner", () => {
    it("dispatches with the snapshot, then records recency and applies disposition", async () => {
      const order = [];
      dispatch.and.callFake(async ({ context, signal }) => {
        order.push("dispatch");
        expect(context.query).toBe("before");
        expect(signal).toBeInstanceOf(AbortSignal);
        return "done";
      });
      hooks.recordRecent.and.callFake(() => order.push("recent"));
      hooks.close.and.callFake(() => order.push("close"));
      actions.set([
        dialogAction("spec:run", {
          disposition: "close",
          recordsRecent: true,
        }),
      ]);
      const context = { query: "before" };
      const promise = actions.run("spec:run", context);
      context.query = "after";
      const result = await promise;

      expect(result.status).toBe("success");
      expect(result.value).toBe("done");
      expect(order).toEqual(["dispatch", "recent", "close"]);
      expect(hooks.stay).not.toHaveBeenCalled();
      expect(hooks.push).not.toHaveBeenCalled();
    });

    it("passes every explicit disposition to its matching hook after dispatch", async () => {
      actions.set([
        dialogAction("spec:close", { disposition: "close" }),
        dialogAction("spec:stay", { disposition: "stay" }),
        dialogAction("spec:push", { disposition: "push" }),
      ]);
      for (const disposition of ["close", "stay", "push"]) {
        await actions.run(`spec:${disposition}`);
        expect(hooks[disposition]).toHaveBeenCalled();
      }
      expect(dispatch.calls.count()).toBe(3);
    });

    it("does not dispatch actions that are unavailable or disabled", async () => {
      actions.set([
        dialogAction("spec:hidden", { when: false }),
        dialogAction("spec:disabled", {
          enabled: false,
          disabledReason: "No permission",
        }),
      ]);

      const hidden = await actions.run("spec:hidden");
      const disabled = await actions.run("spec:disabled");
      expect(hidden.status).toBe("unavailable");
      expect(hidden.reason).toBe("when");
      expect(disabled.status).toBe("disabled");
      expect(disabled.reason).toBe("No permission");
      expect(dispatch).not.toHaveBeenCalled();
      expect(hooks.stay).not.toHaveBeenCalled();
    });

    it("asks for confirmation only when the descriptor requests it", async () => {
      const confirm = jasmine.createSpy("confirm").and.resolveTo(false);
      await actions.destroy();
      actions = new DialogActions({ dispatch, confirm, hooks });
      actions.set([
        dialogAction("spec:plain"),
        dialogAction("spec:confirmed", { confirm: { message: "Proceed?" } }),
      ]);

      expect((await actions.run("spec:plain")).status).toBe("success");
      expect(confirm).not.toHaveBeenCalled();
      const cancelled = await actions.run("spec:confirmed");
      expect(cancelled.status).toBe("cancelled");
      expect(confirm.calls.mostRecent().args[0].confirmation).toEqual({ message: "Proceed?" });
      expect(dispatch.calls.count()).toBe(1);
    });

    it("requires a confirmation collaborator for confirmed actions", async () => {
      actions.set([dialogAction("spec:confirmed", { confirm: true })]);
      await expectAsync(actions.run("spec:confirmed")).toBeRejectedWithError(
        /requires a confirm callback/,
      );
    });

    it("revalidates an item by id and dispatches the matching current object", async () => {
      const oldItem = { id: "same", version: 1 };
      const newItem = { id: "same", version: 2 };
      const resolveItemById = jasmine.createSpy("resolveItemById").and.returnValue(newItem);
      await actions.destroy();
      actions = new DialogActions({ dispatch, resolveItemById, hooks });
      actions.set([itemAction("spec:item")]);

      const result = await actions.run("spec:item", { item: oldItem, query: "kept" });
      const [resolvedId, resolvedContext, resolvedSignal] = resolveItemById.calls.first().args;
      expect(resolvedId).toBe("same");
      expect(resolvedContext.item).toBe(oldItem);
      expect(resolvedSignal).toBeInstanceOf(AbortSignal);
      expect(dispatch.calls.mostRecent().args[0].context.item).toBe(newItem);
      expect(dispatch.calls.mostRecent().args[0].context.query).toBe("kept");
      expect(result.context.item).toBe(newItem);
    });

    it("never retargets an item action when the selected identity disappeared", async () => {
      const resolveItemById = jasmine.createSpy("resolveItemById").and.returnValue(null);
      await actions.destroy();
      actions = new DialogActions({ dispatch, resolveItemById, hooks });
      actions.set([itemAction("spec:remove", { recordsRecent: true })]);

      const result = await actions.run("spec:remove", { item: { id: "gone" } });
      expect(result.status).toBe("unavailable");
      expect(result.reason).toBe("missing-item");
      expect(dispatch).not.toHaveBeenCalled();
      expect(hooks.recordRecent).not.toHaveBeenCalled();
      expect(hooks.stay).not.toHaveBeenCalled();
    });

    it("revalidates again after an asynchronous confirmation", async () => {
      let releaseConfirmation;
      const confirmation = new Promise((resolve) => (releaseConfirmation = resolve));
      const confirm = jasmine.createSpy("confirm").and.returnValue(confirmation);
      let currentItem = { id: "item" };
      await actions.destroy();
      actions = new DialogActions({
        dispatch,
        confirm,
        resolveItemById: () => currentItem,
        hooks,
      });
      actions.set([itemAction("spec:remove", { confirm: true })]);

      const promise = actions.run("spec:remove", { item: currentItem });
      await conditionPromise(() => confirm.calls.count() === 1);
      currentItem = null;
      releaseConfirmation(true);

      const result = await promise;
      expect(result.status).toBe("unavailable");
      expect(result.reason).toBe("missing-item");
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("returns the same pending promise for a double submit and dispatches once", async () => {
      let release;
      dispatch.and.returnValue(new Promise((resolve) => (release = resolve)));
      actions.set([dialogAction("spec:slow")]);

      const first = actions.run("spec:slow");
      const second = actions.run("spec:slow");
      expect(second).toBe(first);
      expect(actions.isPending()).toBe(true);
      expect(actions.isPending("spec:slow")).toBe(true);
      await conditionPromise(() => dispatch.calls.count() === 1);
      release("done");
      await first;
      expect(actions.isPending()).toBe(false);
      expect(dispatch.calls.count()).toBe(1);
    });

    it("blocks a duplicate submitted synchronously from did-start", async () => {
      actions.set([dialogAction("spec:reentrant")]);
      let duplicate;
      actions.onDidStart(() => {
        duplicate = actions.run("spec:reentrant");
      });

      const original = actions.run("spec:reentrant");
      const result = await original;
      expect(duplicate).toBe(original);
      expect(result.status).toBe("success");
      expect(dispatch.calls.count()).toBe(1);
    });

    it("emits one start and finish event and rethrows dispatch errors", async () => {
      const error = new Error("broken");
      dispatch.and.rejectWith(error);
      actions.set([dialogAction("spec:error", { recordsRecent: true })]);
      const starts = [];
      const finishes = [];
      actions.onDidStart((event) => starts.push(event));
      actions.onDidFinish((event) => finishes.push(event));

      await expectAsync(actions.run("spec:error")).toBeRejectedWith(error);
      expect(starts.length).toBe(1);
      expect(starts[0].command).toBe("spec:error");
      expect(finishes.length).toBe(1);
      expect(finishes[0].status).toBe("error");
      expect(finishes[0].error).toBe(error);
      expect(hooks.recordRecent).not.toHaveBeenCalled();
      expect(hooks.stay).not.toHaveBeenCalled();
    });

    it("does not dispatch a registration removed while item resolution is pending", async () => {
      let resolveItem;
      const resolution = new Promise((resolve) => (resolveItem = resolve));
      await actions.destroy();
      actions = new DialogActions({ dispatch, resolveItemById: () => resolution, hooks });
      const registration = actions.add(itemAction("spec:stale"));

      const promise = actions.run("spec:stale", { item: { id: "item" } });
      registration.dispose();
      resolveItem({ id: "item", current: true });

      const result = await promise;
      expect(result.status).toBe("unavailable");
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("aborts a pending dispatch on idempotent destruction", async () => {
      let signal;
      dispatch.and.callFake(({ signal: actionSignal }) => {
        signal = actionSignal;
        return new Promise(() => {});
      });
      actions.set([dialogAction("spec:slow", { recordsRecent: true })]);
      const finishes = [];
      actions.onDidFinish((event) => finishes.push(event));
      const runPromise = actions.run("spec:slow");
      await conditionPromise(() => Boolean(signal));

      const firstDestroy = actions.destroy();
      const secondDestroy = actions.destroy();
      expect(secondDestroy).toBe(firstDestroy);
      expect(signal.aborted).toBe(true);
      const result = await runPromise;
      await firstDestroy;

      expect(result.status).toBe("aborted");
      expect(finishes.map(({ status }) => status)).toEqual(["aborted"]);
      expect(hooks.recordRecent).not.toHaveBeenCalled();
      expect(hooks.stay).not.toHaveBeenCalled();
      expect(actions.getAvailable()).toEqual([]);
      expect(actions.hasAvailable()).toBe(false);
      expect((await actions.run("spec:slow")).status).toBe("destroyed");
    });

    it("does not enter dispatch when destruction aborts pending item resolution", async () => {
      let beginResolution;
      const resolutionStarted = new Promise((resolve) => (beginResolution = resolve));
      let resolveItem;
      const resolution = new Promise((resolve) => (resolveItem = resolve));
      await actions.destroy();
      actions = new DialogActions({
        dispatch,
        resolveItemById: () => {
          beginResolution();
          return resolution;
        },
        hooks,
      });
      actions.set([itemAction("spec:waiting")]);

      const runPromise = actions.run("spec:waiting", { item: { id: "item" } });
      await resolutionStarted;
      const destroyPromise = actions.destroy();
      resolveItem({ id: "item" });

      expect((await runPromise).status).toBe("aborted");
      await destroyPromise;
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
