const ServiceHub = require("../src/service-hub");

describe("ServiceHub", () => {
  let hub;

  beforeEach(() => {
    hub = new ServiceHub();
  });

  describe("name matching", () => {
    it("delivers a service to a consumer of the same name", () => {
      const service = { name: "the-service" };
      const consume = jasmine.createSpy("consume");

      hub.provide("status-bar", "1.0.0", service);
      hub.consume("status-bar", "^1.0.0", consume);

      expect(consume.calls.count()).toBe(1);
      expect(consume).toHaveBeenCalledWith(service);
    });

    it("does not deliver to a consumer of a different name", () => {
      const consume = jasmine.createSpy("consume");

      hub.provide("status-bar", "1.0.0", {});
      hub.consume("title-bar", "^1.0.0", consume);

      expect(consume).not.toHaveBeenCalled();
    });

    // Names are opaque strings. The `.` groups related services for humans and
    // has no lookup meaning, so a parent name must not capture its children.
    it("does not deliver a dotted service to a consumer of its first segment", () => {
      const consume = jasmine.createSpy("consume");

      hub.provide("linter.provider", "1.0.0", {});
      hub.consume("linter", "^1.0.0", consume);

      expect(consume).not.toHaveBeenCalled();
    });

    it("does not deliver a bare service to a consumer of a name beneath it", () => {
      const consume = jasmine.createSpy("consume");

      hub.provide("linter", "1.0.0", {});
      hub.consume("linter.provider", "^1.0.0", consume);

      expect(consume).not.toHaveBeenCalled();
    });

    it("keeps siblings in the same group independent", () => {
      const registry = { kind: "registry" };
      const background = { kind: "background" };
      const consumeRegistry = jasmine.createSpy("consumeRegistry");
      const consumeBackground = jasmine.createSpy("consumeBackground");

      hub.provide("busy-signal.registry", "1.0.0", registry);
      hub.provide("busy-signal.background-registry", "1.0.0", background);
      hub.consume("busy-signal.registry", "^1.0.0", consumeRegistry);
      hub.consume("busy-signal.background-registry", "^1.0.0", consumeBackground);

      expect(consumeRegistry.calls.count()).toBe(1);
      expect(consumeRegistry).toHaveBeenCalledWith(registry);
      expect(consumeBackground.calls.count()).toBe(1);
      expect(consumeBackground).toHaveBeenCalledWith(background);
    });

    it("delivers once per matching provider", () => {
      const first = { id: 1 };
      const second = { id: 2 };
      const consume = jasmine.createSpy("consume");

      hub.provide("linter.provider", "1.0.0", first);
      hub.provide("linter.provider", "1.0.0", second);
      hub.consume("linter.provider", "^1.0.0", consume);

      expect(consume.calls.count()).toBe(2);
      expect(consume).toHaveBeenCalledWith(first);
      expect(consume).toHaveBeenCalledWith(second);
    });
  });

  describe("ordering", () => {
    it("delivers when the consumer registers first", () => {
      const service = {};
      const consume = jasmine.createSpy("consume");

      hub.consume("tree-view.roots", "^1.0.0", consume);
      expect(consume).not.toHaveBeenCalled();

      hub.provide("tree-view.roots", "1.0.0", service);
      expect(consume).toHaveBeenCalledWith(service);
    });

    it("delivers when the provider registers first", () => {
      const service = {};
      const consume = jasmine.createSpy("consume");

      hub.provide("tree-view.roots", "1.0.0", service);
      hub.consume("tree-view.roots", "^1.0.0", consume);

      expect(consume).toHaveBeenCalledWith(service);
    });
  });

  describe("versions", () => {
    it("delivers the highest version satisfying the consumer's range", () => {
      const consume = jasmine.createSpy("consume");

      hub.provide("example.service", { "1.0.0": "v1", "1.2.0": "v1.2", "2.0.0": "v2" });
      hub.consume("example.service", "^1.0.0", consume);

      expect(consume.calls.count()).toBe(1);
      expect(consume).toHaveBeenCalledWith("v1.2");
    });

    it("does not deliver when no version satisfies the range", () => {
      const consume = jasmine.createSpy("consume");

      hub.provide("example.service", "1.0.0", {});
      hub.consume("example.service", "^2.0.0", consume);

      expect(consume).not.toHaveBeenCalled();
    });
  });

  describe("disposal", () => {
    it("stops delivering to a disposed consumer", () => {
      const consume = jasmine.createSpy("consume");

      hub.consume("terminal", "^1.0.0", consume).dispose();
      hub.provide("terminal", "1.0.0", {});

      expect(consume).not.toHaveBeenCalled();
    });

    it("disposes the disposable a consumer returned when the provider goes away", () => {
      const dispose = jasmine.createSpy("dispose");

      const providerDisposable = hub.provide("terminal", "1.0.0", {});
      hub.consume("terminal", "^1.0.0", () => ({ dispose }));
      expect(dispose).not.toHaveBeenCalled();

      providerDisposable.dispose();
      expect(dispose).toHaveBeenCalled();
    });

    it("stops delivering a disposed service to later consumers", () => {
      const consume = jasmine.createSpy("consume");

      hub.provide("terminal", "1.0.0", {}).dispose();
      hub.consume("terminal", "^1.0.0", consume);

      expect(consume).not.toHaveBeenCalled();
    });

    it("clear() drops every provider and consumer and disposes their disposables", () => {
      const dispose = jasmine.createSpy("dispose");
      const consume = jasmine.createSpy("consume");

      hub.provide("terminal", "1.0.0", {});
      hub.consume("terminal", "^1.0.0", () => ({ dispose }));
      hub.clear();
      expect(dispose).toHaveBeenCalled();

      hub.provide("terminal", "1.0.0", {});
      hub.consume("terminal", "^1.0.0", consume);
      expect(consume.calls.count()).toBe(1);
    });
  });
});
