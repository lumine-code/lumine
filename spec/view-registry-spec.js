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

  describe("::getNextUpdatePromise()", () => {
    it("returns a promise that resolves at the end of the next update cycle", async () => {
      let updateDocumentSpy = jasmine.createSpy("update document");
      let readDocumentSpy = jasmine.createSpy("read document");

      registry.updateDocument(updateDocumentSpy);
      registry.readDocument(readDocumentSpy);

      await registry.getNextUpdatePromise();

      expect(updateDocumentSpy).toHaveBeenCalled();
      expect(readDocumentSpy).toHaveBeenCalled();
    });

    it("resolves immediately when no update is pending", async () => {
      let resolved = false;
      const promise = registry.getNextUpdatePromise().then(() => (resolved = true));

      await Promise.resolve();

      expect(resolved).toBe(true);
      await promise;
    });

    it("waits for a pending update in the primary document scheduler", async () => {
      let frame;
      spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
        frame = callback;
        return 1;
      });
      const update = jasmine.createSpy("primary document update");
      registry.forDocument(document).updateDocument(update);
      const promise = registry.getNextUpdatePromise();

      expect(update).not.toHaveBeenCalled();
      frame();
      await promise;

      expect(update).toHaveBeenCalled();
    });

    it("waits for every document that had work pending at call time", async () => {
      const firstFrame = document.createElement("iframe");
      const secondFrame = document.createElement("iframe");
      document.body.append(firstFrame, secondFrame);
      try {
        const callbacks = [];
        for (const domWindow of [firstFrame.contentWindow, secondFrame.contentWindow]) {
          spyOn(domWindow, "requestAnimationFrame").and.callFake((callback) => {
            callbacks.push(callback);
            return callbacks.length;
          });
        }
        registry.forDocument(firstFrame.contentDocument).updateDocument(() => {});
        registry.forDocument(secondFrame.contentDocument).updateDocument(() => {});
        let resolved = false;
        const promise = registry.getNextUpdatePromise().then(() => (resolved = true));

        callbacks[0]();
        await Promise.resolve();
        expect(resolved).toBe(false);

        callbacks[1]();
        await promise;
        expect(resolved).toBe(true);
      } finally {
        firstFrame.remove();
        secondFrame.remove();
      }
    });

    it("waits for legacy and per-document work together", async () => {
      const callbacks = [];
      spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      registry.updateDocument(() => {});
      registry.forDocument(document).updateDocument(() => {});
      let resolved = false;
      const promise = registry.getNextUpdatePromise().then(() => (resolved = true));

      callbacks[0]();
      await Promise.resolve();
      expect(resolved).toBe(false);

      callbacks[1]();
      await promise;
      expect(resolved).toBe(true);
    });

    it("resolves a global waiter created inside the current legacy write/read cycle", async () => {
      let frame;
      spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
        frame = callback;
        return 1;
      });
      let writerWaiter, readerWaiter;
      registry.updateDocument(() => {
        writerWaiter = registry.getNextUpdatePromise();
      });
      registry.readDocument(() => {
        readerWaiter = registry.getNextUpdatePromise();
      });

      frame();

      expect(writerWaiter).toEqual(jasmine.any(Promise));
      expect(readerWaiter).toEqual(jasmine.any(Promise));
      await Promise.all([writerWaiter, readerWaiter]);
    });

    it("waits for cross-document work scheduled by a pending callback", async () => {
      const firstFrame = document.createElement("iframe");
      const secondFrame = document.createElement("iframe");
      document.body.append(firstFrame, secondFrame);
      try {
        let firstCallback, secondCallback;
        spyOn(firstFrame.contentWindow, "requestAnimationFrame").and.callFake((callback) => {
          firstCallback = callback;
          return 1;
        });
        spyOn(secondFrame.contentWindow, "requestAnimationFrame").and.callFake((callback) => {
          secondCallback = callback;
          return 1;
        });
        const secondUpdate = jasmine.createSpy("cascading second-document update");
        registry.forDocument(firstFrame.contentDocument).updateDocument(() => {
          registry.forDocument(secondFrame.contentDocument).updateDocument(secondUpdate);
        });
        let resolved = false;
        const promise = registry.getNextUpdatePromise().then(() => (resolved = true));

        firstCallback();
        await Promise.resolve();
        expect(secondCallback).toEqual(jasmine.any(Function));
        expect(resolved).toBe(false);

        secondCallback();
        await promise;
        expect(secondUpdate).toHaveBeenCalled();
        expect(resolved).toBe(true);
      } finally {
        firstFrame.remove();
        secondFrame.remove();
      }
    });

    it("keeps a final-writer waiter pending for a reader deferred to the second frame", async () => {
      const callbacks = [];
      spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      const scheduler = registry.forDocument(document);
      const deferredReader = jasmine.createSpy("deferred reader");
      let nestedWaiter;
      let nestedResolved = false;
      scheduler.readDocument(() => {
        scheduler.updateDocument(() => {
          scheduler.readDocument(deferredReader);
          nestedWaiter = registry.getNextUpdatePromise().then(() => (nestedResolved = true));
        });
      });

      callbacks.shift()();
      await flushMicrotasks();

      expect(nestedWaiter).toEqual(jasmine.any(Promise));
      expect(deferredReader).not.toHaveBeenCalled();
      expect(nestedResolved).toBe(false);
      expect(callbacks.length).toBe(1);

      callbacks.shift()();
      await nestedWaiter;
      expect(deferredReader).toHaveBeenCalled();
      expect(nestedResolved).toBe(true);
    });

    it("does not treat a scheduler's future promise as pending work", async () => {
      const scheduler = registry.forDocument(document);
      let futureResolved = false;
      const future = scheduler.getNextUpdatePromise().then(() => (futureResolved = true));

      await registry.getNextUpdatePromise();
      expect(futureResolved).toBe(false);

      scheduler.clear();
      await future;
      expect(futureResolved).toBe(true);
    });

    it("settles pending legacy and document promises when requests are cleared", async () => {
      spyOn(window, "requestAnimationFrame").and.returnValue(1);
      const legacyUpdate = jasmine.createSpy("legacy update");
      const documentUpdate = jasmine.createSpy("document update");
      registry.updateDocument(legacyUpdate);
      registry.forDocument(document).updateDocument(documentUpdate);
      const promise = registry.getNextUpdatePromise();

      registry.clearDocumentRequests();
      await promise;

      expect(legacyUpdate).not.toHaveBeenCalled();
      expect(documentUpdate).not.toHaveBeenCalled();
    });

    it("continues pending legacy work on another frame after a callback throws", async () => {
      const callbacks = [];
      spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      const remainingUpdate = jasmine.createSpy("remaining legacy update");
      registry.updateDocument(() => {
        throw new Error("legacy update failed");
      });
      registry.updateDocument(remainingUpdate);
      const promise = registry.getNextUpdatePromise();

      expect(() => callbacks.shift()()).toThrowError("legacy update failed");
      expect(callbacks.length).toBe(1);
      callbacks.shift()();
      await promise;

      expect(remainingUpdate).toHaveBeenCalled();
    });

    it("settles a document promise when its scheduler is destroyed", async () => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      try {
        spyOn(frame.contentWindow, "requestAnimationFrame").and.returnValue(1);
        const registration = registry.registerDocument(frame.contentWindow);
        const update = jasmine.createSpy("destroyed document update");
        registry.forDocument(frame.contentDocument).updateDocument(update);
        const promise = registry.getNextUpdatePromise();

        registration.dispose();
        await promise;

        expect(update).not.toHaveBeenCalled();
      } finally {
        frame.remove();
      }
    });
  });
});
