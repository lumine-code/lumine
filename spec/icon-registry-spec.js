const IconRegistry = require("../src/icon-registry");
const { Icon } = require("../src/icon-descriptor");
// The same object a package reaches for, which is the only way it can express
// `Icon.none()` — the answer that stops the chain.
const { Icon: PublicIcon } = require("atom");

describe("IconRegistry", () => {
  let registry;
  let container;

  beforeEach(() => {
    registry = new IconRegistry();
    container = document.createElement("div");
    // Live re-application only reaches elements that are in the document, so
    // the specs work against attached elements like real consumers do.
    document.body.appendChild(container);
  });

  afterEach(() => {
    registry.destroy();
    container.remove();
  });

  const element = () => {
    const node = document.createElement("span");
    container.appendChild(node);
    return node;
  };

  const provider = (iconFor, extra = {}) => ({ iconFor, ...extra });

  it("hands packages the same Icon factories core uses", () => {
    expect(PublicIcon).toBe(Icon);
    expect(PublicIcon.none().render).toBe("none");
    expect(PublicIcon.classes(["a"]).classes).toEqual(["a"]);
  });

  describe("the provider chain", () => {
    it("asks the next provider when one returns null", () => {
      registry.addProvider(provider(() => null, { id: "quiet" }));
      expect(registry.iconFor({ path: "/a/b.png" }).classes).toEqual(["icon-file-media"]);
    });

    it("stops at the first provider that answers", () => {
      const low = jasmine.createSpy("low").and.returnValue(Icon.classes(["low"]));
      registry.addProvider(provider(low), { priority: 1 });
      registry.addProvider(
        provider(() => Icon.classes(["high"])),
        { priority: 2 },
      );

      expect(registry.iconFor({ path: "/a/b.png" }).classes).toEqual(["high"]);
      expect(low).not.toHaveBeenCalled();
    });

    it("orders by priority regardless of registration order", () => {
      registry.addProvider(
        provider(() => Icon.classes(["first"])),
        { priority: 1 },
      );
      registry.addProvider(
        provider(() => Icon.classes(["second"])),
        { priority: 9 },
      );
      expect(registry.iconFor({ path: "/a" }).classes).toEqual(["second"]);
    });

    it("breaks ties by registration order", () => {
      registry.addProvider(
        provider(() => Icon.classes(["first"])),
        { priority: 5 },
      );
      registry.addProvider(
        provider(() => Icon.classes(["second"])),
        { priority: 5 },
      );
      expect(registry.iconFor({ path: "/a" }).classes).toEqual(["first"]);
    });

    // The distinction provider authors most need: `null` passes the question
    // along, `Icon.none()` answers it.
    it("treats Icon.none() as an answer that ends the chain", () => {
      registry.addProvider(provider(() => Icon.none()));
      expect(registry.iconFor({ path: "/a/b.png" }).render).toBe("none");
    });

    it("accepts a bare class string or array from a provider", () => {
      const disposable = registry.addProvider(
        provider(() => "one two"),
        { priority: 2 },
      );
      expect(registry.iconFor({ path: "/a" }).classes).toEqual(["one", "two"]);
      disposable.dispose();

      registry.addProvider(
        provider(() => ["three"]),
        { priority: 2 },
      );
      expect(registry.iconFor({ path: "/a" }).classes).toEqual(["three"]);
    });

    it("never calls a provider for a type it does not declare", () => {
      const spy = jasmine.createSpy("kinds").and.returnValue(Icon.classes(["k"]));
      registry.addProvider(provider(spy, { handles: ["kind"] }));
      registry.iconFor({ path: "/a" });
      expect(spy).not.toHaveBeenCalled();
      expect(registry.iconFor({ kind: "class" }).classes).toEqual(["k"]);
    });

    it("skips a provider that throws rather than failing the chain", () => {
      spyOn(console, "error");
      registry.addProvider(
        provider(() => {
          throw new Error("boom");
        }),
        { priority: 5 },
      );
      expect(registry.iconFor({ path: "/a/b.png" }).classes).toEqual(["icon-file-media"]);
      expect(console.error).toHaveBeenCalled();
    });

    it("falls back to the built-in answer once a provider is disposed", () => {
      const disposable = registry.addProvider(provider(() => Icon.classes(["mine"])));
      expect(registry.iconFor({ path: "/a/b.png" }).classes).toEqual(["mine"]);
      disposable.dispose();
      expect(registry.iconFor({ path: "/a/b.png" }).classes).toEqual(["icon-file-media"]);
    });

    it("rejects a provider with no iconFor", () => {
      expect(() => registry.addProvider({})).toThrow();
      expect(() =>
        registry.addProvider(
          provider(() => null),
          { priority: NaN },
        ),
      ).toThrow();
    });

    it("stamps the answering provider onto the descriptor", () => {
      registry.addProvider(provider(() => Icon.classes(["mine"]), { id: "mine" }));
      expect(registry.iconFor({ path: "/a" }).providerId).toBe("mine");
    });
  });

  describe("skipFallback", () => {
    // What keeps a plain tab's title unadorned: an icon only appears when
    // something other than the built-in mapping had an opinion.
    it("renders nothing when only the built-in provider answered", () => {
      expect(registry.iconFor({ path: "/a/b.png" }, { skipFallback: true }).render).toBe("none");
    });

    it("renders once a real provider answers", () => {
      registry.addProvider(provider(() => Icon.classes(["mine"])));
      expect(registry.iconFor({ path: "/a/b.png" }, { skipFallback: true }).classes).toEqual([
        "mine",
      ]);
    });
  });

  describe("the vocabularies", () => {
    it("prefixes a semantic name", () => {
      expect(registry.iconFor({ name: "gear" }).classes).toEqual(["icon-gear"]);
    });

    it("resolves a pane item through its icon name", () => {
      const item = { getIconName: () => "markdown", getPath: () => "/a/b.md" };
      expect(registry.iconFor({ item }).classes).toEqual(["icon-markdown"]);
    });

    it("maps known kinds and badges unknown ones", () => {
      expect(registry.iconFor({ kind: "class" }).classes).toEqual(["icon-puzzle"]);
      expect(registry.iconFor({ kind: "type-parameter" }).render).toBe("none");

      const unknown = registry.iconFor({ kind: "macro" });
      expect(unknown.render).toBe("letter");
      expect(unknown.letter).toBe("m");
    });

    it("lets names and kinds be overridden and restored", () => {
      const disposable = registry.defineNames({ gear: "icon-tools" });
      expect(registry.iconFor({ name: "gear" }).classes).toEqual(["icon-tools"]);
      disposable.dispose();
      expect(registry.iconFor({ name: "gear" }).classes).toEqual(["icon-gear"]);
    });

    it("lets an override remove an icon entirely", () => {
      registry.defineKinds({ class: null });
      expect(registry.iconFor({ kind: "class" }).render).toBe("none");
    });
  });

  describe("caching", () => {
    it("asks a provider once per distinct target", () => {
      const spy = jasmine.createSpy("provider").and.returnValue(Icon.classes(["x"]));
      registry.addProvider(provider(spy));

      registry.iconFor({ path: "/a/b.png" });
      registry.iconFor({ path: "/a/b.png" });
      expect(spy.calls.count()).toBe(1);
    });

    // The hint tri-state is part of the key, so a caller that knows and a
    // caller that is guessing never share an answer.
    it("keeps known and unknown hints apart", () => {
      const spy = jasmine.createSpy("provider").and.returnValue(Icon.classes(["x"]));
      registry.addProvider(provider(spy));

      registry.iconFor({ path: "/a" });
      registry.iconFor({ path: "/a", hints: { directory: true } });
      registry.iconFor({ path: "/a", hints: { directory: false } });
      expect(spy.calls.count()).toBe(3);
    });

    it("ignores context until a provider says it uses it", () => {
      const spy = jasmine.createSpy("provider").and.returnValue(Icon.classes(["x"]));
      const disposable = registry.addProvider(provider(spy));

      registry.iconFor({ path: "/a", context: "tabs" });
      registry.iconFor({ path: "/a", context: "tree-view" });
      expect(spy.calls.count()).toBe(1);

      disposable.dispose();
      registry.addProvider(provider(spy, { usesContext: true }));
      registry.iconFor({ path: "/a", context: "tabs" });
      registry.iconFor({ path: "/a", context: "tree-view" });
      expect(spy.calls.count()).toBe(3);
    });

    it("re-asks after invalidation", () => {
      const spy = jasmine.createSpy("provider").and.returnValue(Icon.classes(["x"]));
      registry.addProvider(provider(spy));

      registry.iconFor({ path: "/a" });
      registry.invalidate({ paths: ["/a"] });
      registry.iconFor({ path: "/a" });
      expect(spy.calls.count()).toBe(2);
    });

    it("invalidates only the named path", () => {
      const spy = jasmine.createSpy("provider").and.returnValue(Icon.classes(["x"]));
      registry.addProvider(provider(spy));

      registry.iconFor({ path: "/a" });
      registry.iconFor({ path: "/b" });
      registry.invalidate({ paths: ["/a"] });
      registry.iconFor({ path: "/a" });
      registry.iconFor({ path: "/b" });
      expect(spy.calls.count()).toBe(3);
    });

    it("invalidates a whole vocabulary by type", () => {
      const spy = jasmine.createSpy("provider").and.returnValue(Icon.classes(["x"]));
      registry.addProvider(provider(spy));

      registry.iconFor({ path: "/a" });
      registry.iconFor({ kind: "class" });
      registry.invalidate({ types: ["path"] });
      registry.iconFor({ path: "/a" });
      registry.iconFor({ kind: "class" });
      expect(spy.calls.count()).toBe(3);
    });
  });

  describe("applyTo", () => {
    it("adds the icon class and the resolved classes", () => {
      const node = element();
      registry.applyTo(node, { path: "/a/b.png" });
      expect(node.classList.contains("icon")).toBe(true);
      expect(node.classList.contains("icon-file-media")).toBe(true);
    });

    it("adds the caller's own classes too", () => {
      const node = element();
      registry.applyTo(node, { path: "/a/b.png" }, { classes: ["name"] });
      expect(node.classList.contains("name")).toBe(true);
    });

    it("writes data-name and data-path", () => {
      const node = element();
      registry.applyTo(node, { path: "/a/b.png" });
      expect(node.dataset.name).toBe("b.png");
      expect(node.dataset.path).toBe("/a/b.png");
    });

    it("takes an explicit data-name over the basename", () => {
      const node = element();
      registry.applyTo(node, { path: "/a/b" }, { name: "bcd" });
      expect(node.dataset.name).toBe("bcd");
    });

    it("leaves the dataset alone when the caller owns it", () => {
      const node = element();
      node.dataset.name = "mine";
      registry.applyTo(node, { path: "/a/b.png" }, { setData: false });
      expect(node.dataset.name).toBe("mine");
      expect(node.dataset.path).toBeUndefined();
    });

    it("adds no icon class at all when there is no icon", () => {
      const node = element();
      node.className = "title";
      registry.applyTo(node, { path: "/a/b.png" }, { skipFallback: true, setData: false });
      // A bare `icon` class would still reserve the glyph's right margin.
      expect(node.className).toBe("title");
    });

    describe("cleanup", () => {
      it("removes only what it added", () => {
        const node = element();
        node.classList.add("name", "status-modified", "icon");
        const disposable = registry.applyTo(node, { path: "/a/b.png" }, { classes: ["name"] });
        expect(node.classList.contains("icon-file-media")).toBe(true);

        disposable.dispose();
        expect(Array.from(node.classList).sort()).toEqual(["icon", "name", "status-modified"]);
      });

      it("restores attributes it overwrote", () => {
        const node = element();
        node.dataset.name = "original";
        const disposable = registry.applyTo(node, { path: "/a/b.png" });
        expect(node.dataset.name).toBe("b.png");

        disposable.dispose();
        expect(node.dataset.name).toBe("original");
        expect(node.dataset.path).toBeUndefined();
      });

      it("is idempotent", () => {
        const node = element();
        const disposable = registry.applyTo(node, { path: "/a/b.png" });
        disposable.dispose();
        disposable.dispose();
        expect(node.className).toBe("");
        expect(disposable.disposed).toBe(true);
      });

      it("replaces a previous application on the same element", () => {
        const node = element();
        registry.applyTo(node, { path: "/a/b.png" });
        registry.applyTo(node, { path: "/a/b.pdf" });
        expect(node.classList.contains("icon-file-media")).toBe(false);
        expect(node.classList.contains("icon-file-pdf")).toBe(true);
        expect(node.dataset.name).toBe("b.pdf");
      });
    });

    describe("descriptor kinds", () => {
      it("renders an image into a custom property", () => {
        registry.addProvider(provider(() => Icon.image("data:image/png;base64,AAAA")));
        const node = element();
        registry.applyTo(node, { path: "/a" });
        expect(node.classList.contains("icon-image")).toBe(true);
        expect(node.style.getPropertyValue("--icon-image")).toBe(
          'url("data:image/png;base64,AAAA")',
        );
      });

      it("renders a letter into a child element", () => {
        const node = element();
        registry.applyTo(node, { kind: "macro" });
        expect(node.classList.contains("icon-letter")).toBe(true);
        expect(node.querySelector(".icon-letter-glyph").textContent).toBe("m");
      });

      it("renders svg markup into a child element", () => {
        registry.addProvider(
          provider(() => Icon.svg("<path d='M0 0'/>", { viewBox: "0 0 16 16" })),
        );
        const node = element();
        registry.applyTo(node, { path: "/a" });
        const svg = node.querySelector("svg.icon-glyph");
        expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
      });

      it("leaves no residue when the kind changes", () => {
        let descriptor = Icon.image("data:image/png;base64,AAAA");
        registry.addProvider(provider(() => descriptor));
        const node = element();
        registry.applyTo(node, { path: "/a" });

        descriptor = Icon.classes(["plain"]);
        registry.invalidateAll();
        expect(node.classList.contains("icon-image")).toBe(false);
        expect(node.style.getPropertyValue("--icon-image")).toBe("");
        expect(node.classList.contains("plain")).toBe(true);
      });

      it("applies a colour as a custom property", () => {
        registry.addProvider(provider(() => Icon.classes(["g"], { color: "#ff0000" })));
        const node = element();
        registry.applyTo(node, { path: "/a" });
        expect(node.classList.contains("icon-tinted")).toBe(true);
        expect(node.style.getPropertyValue("--icon-color")).toBe("#ff0000");
      });

      it("applies classes only when asked not to render", () => {
        registry.addProvider(provider(() => Icon.image("data:image/png;base64,AAAA")));
        const node = element();
        registry.applyTo(node, { path: "/a" }, { render: false });
        expect(node.classList.contains("icon-image")).toBe(true);
        expect(node.style.getPropertyValue("--icon-image")).toBe("");
      });
    });

    describe("live re-application", () => {
      it("repaints without the consumer subscribing to anything", () => {
        let classes = ["one"];
        registry.addProvider(provider(() => Icon.classes(classes)));
        const node = element();
        registry.applyTo(node, { path: "/a" });
        expect(node.classList.contains("one")).toBe(true);

        classes = ["two"];
        registry.invalidateAll();
        expect(node.classList.contains("one")).toBe(false);
        expect(node.classList.contains("two")).toBe(true);
      });

      // A provider that resolves one extension asynchronously must repaint the
      // rows showing that extension, not every row in the tree.
      it("repaints only the elements bound to an invalidated path", () => {
        const answers = new Map([
          ["/a.js", ["js-one"]],
          ["/b.py", ["py-one"]],
        ]);
        registry.addProvider(provider((target) => Icon.classes(answers.get(target.path))));

        const js = element();
        const py = element();
        registry.applyTo(js, { path: "/a.js" });
        registry.applyTo(py, { path: "/b.py" });

        answers.set("/a.js", ["js-two"]);
        answers.set("/b.py", ["py-two"]);
        registry.invalidate({ paths: ["/a.js"] });

        expect(js.classList.contains("js-two")).toBe(true);
        expect(py.classList.contains("py-one")).toBe(true);
        expect(py.classList.contains("py-two")).toBe(false);
      });

      it("does not touch the DOM when the answer has not changed", () => {
        registry.addProvider(provider(() => Icon.classes(["same"])));
        const node = element();
        registry.applyTo(node, { path: "/a" });

        // Take the class off by hand. A re-render would put it back, so its
        // absence afterwards is proof no DOM write happened.
        node.classList.remove("same");
        registry.invalidateAll();
        expect(node.classList.contains("same")).toBe(false);
      });

      it("stops repainting a disposed application", () => {
        let classes = ["one"];
        registry.addProvider(provider(() => Icon.classes(classes)));
        const node = element();
        registry.applyTo(node, { path: "/a" }).dispose();

        classes = ["two"];
        registry.invalidateAll();
        expect(node.classList.contains("two")).toBe(false);
      });

      // A select-list row is rebuilt on every keystroke and nothing disposes
      // it, so the registry must not be the thing keeping it alive. Held
      // strongly, every row ever rendered would stay until something happened
      // to invalidate its key.
      it("holds its live bindings weakly", () => {
        const application = registry.applyTo(element(), { path: "/a" });
        const bound = registry.applications.get(application.key);
        expect(bound.size).toBe(1);
        for (const ref of bound) expect(ref instanceof WeakRef).toBe(true);
      });

      it("drops a binding whose application has been collected", () => {
        const application = registry.applyTo(element(), { path: "/a" });
        const key = application.key;

        // Stands in for a collected application: the registry cannot tell the
        // difference, and this is the branch that would otherwise accumulate.
        registry.applications.get(key).add({ deref: () => undefined });
        expect(registry.applications.get(key).size).toBe(2);

        registry.invalidate({ paths: ["/a"] });
        expect(registry.applications.get(key).size).toBe(1);
      });

      // A consumer routinely builds a row, gives it an icon and appends it
      // afterwards — the tree view does exactly that. Skipping what is not in
      // the document yet left such a row wearing the classes of whichever icon
      // package was installed when it was built, for the rest of its life.
      it("keeps repainting an element that is not in the document", () => {
        let classes = ["one"];
        registry.addProvider(provider(() => Icon.classes(classes)));
        const node = document.createElement("span");
        registry.applyTo(node, { path: "/a" });
        expect(node.classList.contains("one")).toBe(true);

        classes = ["two"];
        registry.invalidateAll();
        registry.invalidateAll();
        registry.invalidateAll();

        expect(node.classList.contains("two")).toBe(true);
        expect(node.classList.contains("one")).toBe(false);
      });

      it("repaints when a provider is added or removed", () => {
        const node = element();
        registry.applyTo(node, { path: "/a/b.png" });
        expect(node.classList.contains("icon-file-media")).toBe(true);

        const disposable = registry.addProvider(provider(() => Icon.classes(["mine"])));
        expect(node.classList.contains("mine")).toBe(true);
        expect(node.classList.contains("icon-file-media")).toBe(false);

        disposable.dispose();
        expect(node.classList.contains("icon-file-media")).toBe(true);
      });
    });

    // A provider whose answer is not ready yet returns null, so the chain still
    // produces something to paint, then reports the paths it can now answer.
    it("supports a provider that answers late", () => {
      let ready = false;
      let notify = null;
      registry.addProvider(
        provider((target) => (ready ? Icon.image(`data:${target.path}`) : null), {
          async: true,
          onDidChange(callback) {
            notify = callback;
            return { dispose() {} };
          },
        }),
      );

      const node = element();
      registry.applyTo(node, { path: "/a/b.png" });
      expect(node.classList.contains("icon-file-media")).toBe(true);

      ready = true;
      notify({ paths: ["/a/b.png"] });
      expect(node.classList.contains("icon-image")).toBe(true);
      expect(node.classList.contains("icon-file-media")).toBe(false);
    });

    it("warns about an async provider that cannot report back", () => {
      spyOn(console, "warn");
      registry.addProvider(provider(() => null, { async: true }));
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("drops package providers and keeps the core chain", () => {
      registry.addProvider(provider(() => Icon.classes(["mine"])));
      expect(registry.iconFor({ path: "/a/b.png" }).classes).toEqual(["mine"]);

      registry.clear();
      expect(registry.iconFor({ path: "/a/b.png" }).classes).toEqual(["icon-file-media"]);
      expect(registry.iconFor({ name: "gear" }).classes).toEqual(["icon-gear"]);
    });
  });

  // Resetting the window runs PackageManager#reset, which clears every consumer
  // off the service hub. Subscribing only in the constructor would keep that
  // subscription in name alone and no provider would reach the chain again.
  describe("consuming icons.provider from the hub", () => {
    const ServiceHub = require("../src/service-hub");

    it("receives providers registered on the hub", () => {
      const serviceHub = new ServiceHub();
      const hubRegistry = new IconRegistry({ packageManager: { serviceHub } });

      serviceHub.provide("icons.provider", "1.0.0", { iconFor: () => "from-hub" });
      expect(hubRegistry.iconFor({ path: "/a" }).classes).toEqual(["from-hub"]);

      hubRegistry.destroy();
    });

    it("reconnects after clear, which the window reset relies on", () => {
      const serviceHub = new ServiceHub();
      const hubRegistry = new IconRegistry({ packageManager: { serviceHub } });

      serviceHub.clear();
      hubRegistry.clear();
      serviceHub.provide("icons.provider", "1.0.0", { iconFor: () => "after-reset" });

      expect(hubRegistry.iconFor({ path: "/a" }).classes).toEqual(["after-reset"]);

      hubRegistry.destroy();
    });
  });

  describe("onDidChange", () => {
    it("fires on invalidation with the scope", () => {
      const spy = jasmine.createSpy("changed");
      registry.onDidChange(spy);
      registry.invalidate({ paths: ["/a"] });
      expect(spy).toHaveBeenCalledWith({ paths: ["/a"] });
    });
  });
});
