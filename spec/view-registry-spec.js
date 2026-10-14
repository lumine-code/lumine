/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
const ViewRegistry = require("../src/view-registry");

describe("ViewRegistry", () => {
  let registry = null;

  beforeEach(() => {
    registry = new ViewRegistry();
  });

  afterEach(() => {
    registry.clearDocumentRequests();
  });

  describe("::getView(object)", () => {
    describe("when passed a DOM node", () =>
      it("returns the given DOM node", () => {
        const node = document.createElement("div");
        expect(registry.getView(node)).toBe(node);
      }));

    describe("when passed an object with an element property", () =>
      it("returns the element property if it's an instance of HTMLElement", () => {
        class TestComponent {
          constructor() {
            this.element = document.createElement("div");
          }
        }

        const component = new TestComponent();
        expect(registry.getView(component)).toBe(component.element);
      }));

    describe("when passed an object with a getElement function", () =>
      it("returns the return value of getElement if it's an instance of HTMLElement", () => {
        class TestComponent {
          getElement() {
            if (this.myElement == null) {
              this.myElement = document.createElement("div");
            }
            return this.myElement;
          }
        }

        const component = new TestComponent();
        expect(registry.getView(component)).toBe(component.myElement);
      }));

    describe("when passed a model object", () => {
      describe("when a view provider is registered matching the object's constructor", () =>
        it("constructs a view element and assigns the model on it", () => {
          class TestModel {}

          class TestModelSubclass extends TestModel {}

          class TestView {
            initialize(model) {
              this.model = model;
              return this;
            }
          }

          const model = new TestModel();

          registry.addViewProvider(TestModel, (model) => new TestView().initialize(model));

          const view = registry.getView(model);
          expect(view instanceof TestView).toBe(true);
          expect(view.model).toBe(model);

          const subclassModel = new TestModelSubclass();
          const view2 = registry.getView(subclassModel);
          expect(view2 instanceof TestView).toBe(true);
          expect(view2.model).toBe(subclassModel);
        }));

      describe("when a view provider is registered generically, and works with the object", () =>
        it("constructs a view element and assigns the model on it", () => {
          registry.addViewProvider((model) => {
            if (model.a === "b") {
              const element = document.createElement("div");
              element.className = "test-element";
              return element;
            }
          });

          const view = registry.getView({ a: "b" });
          expect(view.className).toBe("test-element");

          expect(() => registry.getView({ a: "c" })).toThrow();
        }));

      describe("when no view provider is registered for the object's constructor", () =>
        it("throws an exception", () => {
          expect(() => registry.getView({})).toThrow();
        }));
    });
  });

  describe("::addViewProvider(providerSpec)", () =>
    it("returns a disposable that can be used to remove the provider", () => {
      class TestModel {}
      class TestView {
        initialize(model) {
          this.model = model;
          return this;
        }
      }

      const disposable = registry.addViewProvider(TestModel, (model) =>
        new TestView().initialize(model),
      );

      expect(registry.getView(new TestModel()) instanceof TestView).toBe(true);
      disposable.dispose();
      expect(() => registry.getView(new TestModel())).toThrow();
    }));

  describe("::updateDocument(fn) and ::readDocument(fn)", () => {
    let frameRequests = null;

    beforeEach(() => {
      frameRequests = [];
      spyOn(window, "requestAnimationFrame").and.callFake((fn) => frameRequests.push(fn));
    });

    it("performs all pending writes before all pending reads on the next animation frame", () => {
      let events = [];

      registry.updateDocument(() => events.push("write 1"));
      registry.readDocument(() => events.push("read 1"));
      registry.readDocument(() => events.push("read 2"));
      registry.updateDocument(() => events.push("write 2"));

      expect(events).toEqual([]);

      expect(frameRequests.length).toBe(1);
      frameRequests[0]();
      expect(events).toEqual(["write 1", "write 2", "read 1", "read 2"]);

      frameRequests = [];
      events = [];
      const disposable = registry.updateDocument(() => events.push("write 3"));
      registry.updateDocument(() => events.push("write 4"));
      registry.readDocument(() => events.push("read 3"));

      disposable.dispose();

      expect(frameRequests.length).toBe(1);
      frameRequests[0]();
      expect(events).toEqual(["write 4", "read 3"]);
    });

    it("performs writes requested from read callbacks in the same animation frame", () => {
      const events = [];

      registry.updateDocument(() => events.push("write 1"));
      registry.readDocument(() => {
        registry.updateDocument(() => events.push("write from read 1"));
        events.push("read 1");
      });
      registry.readDocument(() => {
        registry.updateDocument(() => events.push("write from read 2"));
        events.push("read 2");
      });
      registry.updateDocument(() => events.push("write 2"));

      expect(frameRequests.length).toBe(1);
      frameRequests[0]();
      expect(frameRequests.length).toBe(1);

      expect(events).toEqual([
        "write 1",
        "write 2",
        "read 1",
        "read 2",
        "write from read 1",
        "write from read 2",
      ]);
    });
  });

  describe("::getNextUpdatePromise()", () =>
    it("returns a promise that resolves at the end of the next update cycle", async () => {
      let updateDocumentSpy = jasmine.createSpy("update document");
      let readDocumentSpy = jasmine.createSpy("read document");

      registry.updateDocument(updateDocumentSpy);
      registry.readDocument(readDocumentSpy);

      await registry.getNextUpdatePromise();

      expect(updateDocumentSpy).toHaveBeenCalled();
      expect(readDocumentSpy).toHaveBeenCalled();
    }));
  describe("presentation scheduling", () => {
    const hiddenWindow = () => ({
      closed: false,
      document: { visibilityState: "hidden" },
      requestAnimationFrame: jasmine.createSpy("hidden frame"),
      cancelAnimationFrame() {},
    });
    function withWindows(windows) {
      const presentations = windows.map((window) => ({ getDOMWindow: () => window }));
      return new ViewRegistry({
        workspace: { getWindows: () => presentations, getFocusedWindow: () => presentations[0] },
      });
    }

    it("moves an already queued frame off a presentation that becomes hidden", async () => {
      const presentationDocument = document.implementation.createHTMLDocument();
      let visibility = "visible";
      Object.defineProperty(presentationDocument, "visibilityState", { get: () => visibility });
      const presentation = {
        closed: false,
        document: presentationDocument,
        requestAnimationFrame: jasmine.createSpy("queued frame").and.returnValue(51),
        cancelAnimationFrame: jasmine.createSpy("cancel hidden frame"),
      };
      registry = withWindows([presentation]);
      const update = jasmine.createSpy("update after occlusion");
      registry.updateDocument(update);
      const done = registry.getNextUpdatePromise();
      visibility = "hidden";
      presentationDocument.dispatchEvent(new Event("visibilitychange"));
      await done;
      expect(presentation.cancelAnimationFrame).toHaveBeenCalledWith(51);
      expect(presentation.requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("uses a visible presentation when the focused or preferred document is hidden", async () => {
      const hidden = hiddenWindow();
      let fire;
      const visible = {
        closed: false,
        document: { visibilityState: "visible" },
        requestAnimationFrame: (callback) => {
          fire = callback;
          return 1;
        },
        cancelAnimationFrame() {},
      };
      registry = withWindows([hidden, visible]);
      registry.setAnimationFrameWindow(hidden);
      const updated = jasmine.createSpy("updated");
      registry.updateDocument(updated);
      const done = registry.getNextUpdatePromise();
      fire();
      await done;
      expect(updated).toHaveBeenCalledTimes(1);
      expect(hidden.requestAnimationFrame).not.toHaveBeenCalled();
    });

    it("keeps shared model updates running when every native window is hidden", async () => {
      const hidden = hiddenWindow();
      registry = withWindows([hidden]);
      const updated = jasmine.createSpy("updated");
      registry.updateDocument(updated);
      await registry.getNextUpdatePromise();
      expect(updated).toHaveBeenCalledTimes(1);
      expect(hidden.requestAnimationFrame).not.toHaveBeenCalled();
    });

    it("cancels the fallback timer before switching to a visible window's frame", async () => {
      const hidden = hiddenWindow();
      registry = withWindows([hidden]);
      const updated = jasmine.createSpy("updated");
      registry.updateDocument(updated);
      let fire;
      registry.setAnimationFrameWindow({
        closed: false,
        document: { visibilityState: "visible" },
        requestAnimationFrame: (callback) => {
          fire = callback;
          return 1;
        },
        cancelAnimationFrame() {},
      });
      const done = registry.getNextUpdatePromise();
      fire();
      await done;
      await globalThis.timeoutPromise(30);
      expect(updated).toHaveBeenCalledTimes(1);
    });
  });
});
