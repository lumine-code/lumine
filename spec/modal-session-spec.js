"use strict";

const {
  activeSession,
  visibleLabels,
  focusedLabel,
  confirm,
  cancel,
  moveDown,
  moveUp,
  dispatch,
  setQuery,
  statusText,
  flush,
  settle,
} = require("./helpers/modal-helpers");

describe("ModalSession", () => {
  afterEach(() => {
    if (atom.modals.isOpen()) atom.modals.cancel("api");
    flush(1000);
  });

  describe("selection", () => {
    it("wraps at both ends", async () => {
      atom.modals.open({ id: "spec.sel", source: ["a", "b", "c"] });
      await settle();

      moveUp();
      expect(focusedLabel()).toBe("c");
      moveDown();
      expect(focusedLabel()).toBe("a");
    });

    it("honours initialActivation none", async () => {
      atom.modals.open({ id: "spec.sel", source: ["a", "b"], initialActivation: "none" });
      await settle();
      expect(activeSession().getFocusedItem()).toBeNull();
    });

    it("skips unselectable rows", async () => {
      atom.modals.open({
        id: "spec.sel",
        source: [{ kind: "separator", label: "Group" }, { label: "a" }, { label: "b" }],
      });
      await settle();

      expect(focusedLabel()).toBe("a");
      moveDown();
      expect(focusedLabel()).toBe("b");
    });

    it("follows the focused row by id across an item change", async () => {
      const session = atom.modals.open({
        id: "spec.follow",
        source: [
          { id: "1", label: "one" },
          { id: "2", label: "two" },
          { id: "3", label: "three" },
        ],
      });
      await settle();
      moveDown();
      expect(focusedLabel()).toBe("two");

      await session.setSource([
        { id: "0", label: "zero" },
        { id: "2", label: "two" },
      ]);
      await settle();

      expect(focusedLabel()).toBe("two");
    });

    it("resets selection when the strategy says so", async () => {
      const session = atom.modals.open({
        id: "spec.reset",
        selectionStrategy: "reset",
        source: [
          { id: "1", label: "one" },
          { id: "2", label: "two" },
        ],
      });
      await settle();
      moveDown();

      await session.setSource([
        { id: "1", label: "one" },
        { id: "2", label: "two" },
      ]);
      await settle();

      expect(focusedLabel()).toBe("one");
    });
  });

  describe("confirm resolution order", () => {
    it("prefers the focused row over the typed text", async () => {
      let confirmed = null;
      atom.modals.open({
        id: "spec.order",
        source: ["alpha"],
        confirm: (ctx) => {
          confirmed = ctx.item;
        },
        confirmEmpty: () => {
          confirmed = "EMPTY";
        },
      });
      await settle();
      setQuery("al");
      await settle();
      confirm();
      await settle();

      expect(confirmed).toBe("alpha");
    });

    it("falls back to the empty action when nothing is focused", async () => {
      let confirmed = null;
      atom.modals.open({
        id: "spec.order",
        source: ["alpha"],
        confirmEmpty: (ctx) => {
          confirmed = ctx.query.text;
        },
      });
      await settle();
      setQuery("zzz");
      await settle();
      confirm();
      await settle();

      expect(confirmed).toBe("zzz");
    });

    it("resolves the raw query when there is no source at all", async () => {
      const session = atom.modals.open({ id: "spec.raw", template: "input" });
      await settle();
      setQuery("typed");
      await settle();
      confirm();

      const result = await session.result;
      expect(result.value).toBe("typed");
    });
  });

  describe("ActionResult", () => {
    it("keepOpen leaves the session open", async () => {
      let runs = 0;
      atom.modals.open({
        id: "spec.keep",
        source: ["a"],
        confirm: () => {
          runs++;
          return { keepOpen: true };
        },
      });
      await settle();
      confirm();
      await settle();
      confirm();
      await settle();

      expect(runs).toBe(2);
      expect(atom.modals.isOpen()).toBe(true);
    });

    it("refresh re-runs the source", async () => {
      let calls = 0;
      atom.modals.open({
        id: "spec.refresh",
        source: () => {
          calls++;
          return [`run-${calls}`];
        },
        confirm: () => ({ keepOpen: true, refresh: true }),
      });
      await settle();
      expect(visibleLabels()).toEqual(["run-1"]);

      confirm();
      await settle();
      expect(visibleLabels()).toEqual(["run-2"]);
    });

    it("select none clears the focused row so the next confirm is empty", async () => {
      const seen = [];
      atom.modals.open({
        id: "spec.select-none",
        source: ["a"],
        confirm: (ctx) => {
          seen.push(ctx.item);
          return ctx.item ? { keepOpen: true, select: "none" } : { keepOpen: true };
        },
      });
      await settle();
      confirm();
      await settle();
      confirm();
      await settle();

      expect(seen).toEqual(["a", null]);
    });

    it("query rewrites the field without confirming", async () => {
      atom.modals.open({
        id: "spec.query",
        source: ["src/"],
        confirm: () => ({ keepOpen: true, query: "src/" }),
      });
      await settle();
      confirm();
      await settle();

      expect(activeSession().getQuery().raw).toBe("src/");
      expect(atom.modals.isOpen()).toBe(true);
    });
  });

  describe("terminal callbacks", () => {
    it("runs didClose exactly once, whatever the reason", async () => {
      const reasons = [];
      atom.modals.open({ id: "spec.close", source: ["a"], didClose: (r) => reasons.push(r) });
      await settle();

      cancel();
      await settle();
      atom.modals.cancel("api");
      flush(10);

      expect(reasons.length).toBe(1);
      expect(reasons[0].reason).toBe("escape");
    });

    it("runs didClose when a foreign panel force-hides the host", async () => {
      // The container element is what force-hides, so the workspace view has to
      // be realized for this path to run at all.
      jasmine.attachToDOM(atom.workspace.getElement());
      const reasons = [];
      atom.modals.open({ id: "spec.foreign", source: ["a"], didClose: (r) => reasons.push(r) });
      await settle();

      // A legacy addModalPanel consumer showing its own panel force-hides ours.
      const intruder = atom.workspace.addModalPanel({ item: document.createElement("div") });
      flush(10);

      expect(reasons.length).toBe(1);
      expect(reasons[0].reason).toBe("foreign");
      intruder.destroy();
    });
  });

  describe("async sources", () => {
    it("shows busy chrome while the source is in flight", async () => {
      let resolveItems;
      atom.modals.open({
        id: "spec.async",
        source: () => new Promise((resolve) => (resolveItems = resolve)),
      });
      flush(0);
      await Promise.resolve();

      expect(activeSession().isBusy()).toBe(true);

      resolveItems(["done"]);
      await settle();

      expect(activeSession().isBusy()).toBe(false);
      expect(visibleLabels()).toEqual(["done"]);
    });

    it("discards a delivery from a superseded run", async () => {
      const resolvers = [];
      const session = atom.modals.open({
        id: "spec.stale",
        source: {
          dynamic: true,
          debounce: 0,
          run: (req) =>
            new Promise((resolve) => resolvers.push({ resolve, query: req.query.text })),
        },
      });
      await Promise.resolve();
      flush(0);

      setQuery("a");
      flush(0);
      await Promise.resolve();
      setQuery("ab");
      flush(0);
      await Promise.resolve();

      // The first (stale) run answers last; its items must never paint.
      const stale = resolvers[resolvers.length - 2];
      const fresh = resolvers[resolvers.length - 1];
      if (fresh) fresh.resolve(["fresh"]);
      await settle();
      if (stale) stale.resolve(["stale"]);
      await settle();

      expect(visibleLabels()).not.toContain("stale");
      expect(session.getQuery().raw).toBe("ab");
    });

    it("defers a confirm until an in-flight run settles, and runs it once", async () => {
      let resolveItems;
      let runs = 0;
      atom.modals.open({
        id: "spec.defer",
        source: {
          dynamic: true,
          debounce: 0,
          run: () => new Promise((resolve) => (resolveItems = resolve)),
        },
        confirm: () => {
          runs++;
        },
      });
      await Promise.resolve();
      flush(0);

      // Enter pressed twice while the list is still provisional.
      confirm();
      confirm();
      expect(runs).toBe(0);

      resolveItems(["late"]);
      await settle();
      flush(300);
      await settle();

      expect(runs).toBe(1);
    });
  });

  describe("validation", () => {
    it("blocks confirming typed text at error severity", async () => {
      let confirmed = false;
      atom.modals.open({
        id: "spec.validate",
        template: "input",
        validate: (query) => (query.text === "bad" ? "Not allowed" : null),
        confirm: () => {
          confirmed = true;
        },
      });
      await settle();
      setQuery("bad");
      flush(200);
      await settle();

      expect(statusText()).toContain("Not allowed");
      confirm();
      await settle();
      expect(confirmed).toBe(false);
    });

    it("flushes a pending validator before confirming", async () => {
      let confirmed = false;
      atom.modals.open({
        id: "spec.validate-fast",
        template: "input",
        validate: (query) => (query.text === "bad" ? "Not allowed" : null),
        confirm: () => {
          confirmed = true;
        },
      });
      await settle();

      // Type and hit Enter inside the debounce window.
      setQuery("bad");
      confirm();
      flush(300);
      await settle();

      expect(confirmed).toBe(false);
    });
  });

  describe("actions", () => {
    it("dispatches a named action command", async () => {
      let ran = null;
      atom.modals.open({
        id: "spec.actions",
        source: ["a"],
        actions: [
          {
            name: "shout",
            label: "Shout",
            run: (ctx) => {
              ran = ctx.item;
              return { keepOpen: true };
            },
          },
        ],
      });
      await settle();

      atom.commands.dispatch(activeSession().element, "modals:shout");
      await settle();

      expect(ran).toBe("a");
    });

    it("registers an action's declared keystroke under the view's scope", async () => {
      atom.modals.open({
        id: "spec.keystroke",
        source: ["a"],
        actions: [{ name: "shout", label: "Shout", keystroke: "alt-s", run: () => {} }],
      });
      await settle();

      const bindings = atom.keymaps.findKeyBindings({
        command: "modals:shout",
        target: activeSession().element,
      });
      expect(bindings.length).toBe(1);
      expect(bindings[0].keystrokes).toBe("alt-s");
      // Above package keymaps (0) so a foreign binding cannot win, below the
      // user keymap (100) so an override still can.
      expect(bindings[0].priority).toBe(50);

      cancel();
      await settle();
      // The scope goes away with the view, so the next modal does not inherit
      // some other package's verbs.
      expect(
        atom.keymaps.findKeyBindings({ command: "modals:shout", target: document.body }).length,
      ).toBe(0);
    });

    it("keeps the session alive when an action throws", async () => {
      atom.modals.open({
        id: "spec.throw",
        source: ["a"],
        actions: [
          {
            name: "boom",
            label: "Boom",
            run: () => {
              throw new Error("nope");
            },
          },
        ],
      });
      await settle();

      spyOn(console, "error");
      atom.commands.dispatch(activeSession().element, "modals:boom");
      await settle();

      expect(atom.modals.isOpen()).toBe(true);
      expect(statusText()).toContain("nope");
    });
  });

  describe("parseQuery", () => {
    it("feeds the matcher the parsed text and exposes the extras", async () => {
      let seen = null;
      atom.modals.open({
        id: "spec.parse",
        source: ["main.js"],
        parseQuery: (raw) => {
          const match = /^(.*?):(\d+)$/.exec(raw);
          return match ? { text: match[1], line: Number(match[2]) } : { text: raw };
        },
        didChangeQuery: (query) => {
          seen = query;
        },
      });
      await settle();
      setQuery("main:42");
      await settle();

      expect(seen.text).toBe("main");
      expect(seen.line).toBe(42);
      expect(visibleLabels()).toEqual(["main.js"]);
    });
  });

  describe("checkboxes", () => {
    it("binds a checkbox to a config key in both directions", async () => {
      atom.config.set("core.followSymlinks", false);
      atom.modals.open({
        id: "spec.checkbox",
        source: ["a"],
        checkboxes: [{ label: "Follow symlinks", config: "core.followSymlinks" }],
      });
      await settle();

      const input = activeSession().element.querySelector(".modals-checkboxes input");
      expect(input.checked).toBe(false);

      input.checked = true;
      input.dispatchEvent(new Event("change"));
      expect(atom.config.get("core.followSymlinks")).toBe(true);

      atom.config.set("core.followSymlinks", false);
      expect(input.checked).toBe(false);
    });
  });

  describe("focus", () => {
    it("keeps focus on the query editor when a row is clicked", async () => {
      jasmine.attachToDOM(atom.workspace.getElement());
      atom.modals.open({
        id: "spec.focus",
        source: ["a", "b"],
        confirm: () => ({ keepOpen: true }),
      });
      await settle();

      const row = activeSession().element.querySelectorAll("ol.list-group > li")[1];
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await settle();

      expect(activeSession().element.contains(document.activeElement)).toBe(true);
    });
  });

  describe("help", () => {
    it("toggles the help panel and lists the actions", async () => {
      atom.modals.open({
        id: "spec.help",
        source: ["a"],
        help: "Some **help** text.",
        actions: [{ name: "shout", label: "Shout", keystroke: "alt-s", run: () => {} }],
      });
      await settle();

      dispatch("modals:help");
      const element = activeSession().element;
      const help = element.querySelector(".modals-help");
      expect(help.style.display).not.toBe("none");
      expect(help.textContent).toContain("Shout");
      expect(help.textContent).toContain("alt-s");

      dispatch("modals:help");
      expect(element.querySelector(".modals-help").style.display).toBe("none");
    });
  });
});
