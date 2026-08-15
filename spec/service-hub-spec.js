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
      spyOn(console, "warn");

      hub.provide("example.service", "1.0.0", {});
      hub.consume("example.service", "^2.0.0", consume);

      expect(consume).not.toHaveBeenCalled();
    });

    // Silently delivering nothing is how a one-sided version bump hides: the
    // consumer looks registered and the feature simply is not there.
    it("warns when the name matches but the versions do not", () => {
      spyOn(console, "warn");

      hub.provide("example.service", "1.0.0", {});
      hub.consume("example.service", "^2.0.0", () => {});

      expect(console.warn.calls.count()).toBe(1);
      const message = console.warn.calls.argsFor(0)[0];
      expect(message).toContain("example.service");
      expect(message).toContain("1.0.0");
      expect(message).toContain("^2.0.0");
    });

    it("does not warn when a name simply has no provider", () => {
      spyOn(console, "warn");

      hub.consume("example.service", "^1.0.0", () => {});

      expect(console.warn).not.toHaveBeenCalled();
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

    // The mirror of the case above, and the one that used to be missing: a
    // package that deactivates has to unregister itself from the services it
    // took, or the provider keeps a live registration for a package that is
    // gone.
    it("disposes the disposable a consumer returned when the consumer goes away", () => {
      const dispose = jasmine.createSpy("dispose");

      hub.provide("terminal", "1.0.0", {});
      const consumerDisposable = hub.consume("terminal", "^1.0.0", () => ({ dispose }));
      expect(dispose).not.toHaveBeenCalled();

      consumerDisposable.dispose();
      expect(dispose.calls.count()).toBe(1);
    });

    it("disposes a returned disposable once even when both sides go away", () => {
      const dispose = jasmine.createSpy("dispose");

      const providerDisposable = hub.provide("terminal", "1.0.0", {});
      const consumerDisposable = hub.consume("terminal", "^1.0.0", () => ({ dispose }));

      consumerDisposable.dispose();
      providerDisposable.dispose();
      expect(dispose.calls.count()).toBe(1);
    });

    // A package deactivating and activating again used to leave its first
    // registration behind, so the provider fired both when it went away.
    it("does not accumulate registrations across consume/dispose cycles", () => {
      const first = jasmine.createSpy("first");
      const second = jasmine.createSpy("second");

      const providerDisposable = hub.provide("terminal", "1.0.0", {});
      hub.consume("terminal", "^1.0.0", () => ({ dispose: first })).dispose();
      hub.consume("terminal", "^1.0.0", () => ({ dispose: second }));

      expect(first.calls.count()).toBe(1);

      providerDisposable.dispose();
      expect(first.calls.count()).toBe(1);
      expect(second.calls.count()).toBe(1);
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

  // A consumer callback is package activation code, so it can throw. Left
  // alone that leaves half a delivery standing: some consumers hold a service
  // nobody can take back, and the caller has no disposable to undo it with.
  describe("registration failure", () => {
    it("rolls back a new provider without disturbing existing consumers", () => {
      spyOn(console, "warn");
      const existingDispose = jasmine.createSpy("existingDispose");
      const failedKeepDispose = jasmine.createSpy("failedKeepDispose");
      const failedPartialDispose = jasmine.createSpy("failedPartialDispose");
      const replacementKeepDispose = jasmine.createSpy("replacementKeepDispose");
      const replacementPartialDispose = jasmine.createSpy("replacementPartialDispose");
      const failure = new Error("consumer activation failed");

      const existingProvider = hub.provide("terminal", "1.0.0", {
        id: "existing",
      });
      const keepConsumer = hub.consume("terminal", "*", (service) => ({
        dispose:
          service.id === "existing"
            ? existingDispose
            : service.id === "failed"
              ? failedKeepDispose
              : replacementKeepDispose,
      }));
      const partialConsumer = hub.consume("terminal", "^2.0.0", (service) => ({
        dispose: service.id === "failed" ? failedPartialDispose : replacementPartialDispose,
      }));
      const failingConsumer = hub.consume("terminal", "^2.0.0", (service) => {
        if (service.id === "failed") {
          throw failure;
        }
      });

      let thrownError;
      try {
        hub.provide("terminal", "2.0.0", { id: "failed" });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(failure);
      expect(failedKeepDispose).toHaveBeenCalledTimes(1);
      expect(failedPartialDispose).toHaveBeenCalledTimes(1);
      expect(existingDispose).not.toHaveBeenCalled();
      expect(hub.unmatchedConsumers()).toEqual([
        { keyPath: "terminal", versionRange: "^2.0.0" },
        { keyPath: "terminal", versionRange: "^2.0.0" },
      ]);

      const lateConsumer = jasmine.createSpy("lateConsumer");
      const lateConsumerDisposable = hub.consume("terminal", "^2.0.0", lateConsumer);
      expect(lateConsumer).not.toHaveBeenCalled();

      const replacementProvider = hub.provide("terminal", "2.0.0", {
        id: "replacement",
      });
      expect(lateConsumer).toHaveBeenCalledOnceWith({ id: "replacement" });

      replacementProvider.dispose();
      existingProvider.dispose();
      keepConsumer.dispose();
      partialConsumer.dispose();
      failingConsumer.dispose();
      lateConsumerDisposable.dispose();

      expect(replacementKeepDispose).toHaveBeenCalledTimes(1);
      expect(replacementPartialDispose).toHaveBeenCalledTimes(1);
      expect(existingDispose).toHaveBeenCalledTimes(1);
      expect(failedKeepDispose).toHaveBeenCalledTimes(1);
      expect(failedPartialDispose).toHaveBeenCalledTimes(1);
    });

    it("rolls back a new consumer without disturbing existing providers", () => {
      const firstProvider = hub.provide("outline", "1.0.0", { id: "first" });
      const secondProvider = hub.provide("outline", "1.0.0", { id: "second" });
      const partialDispose = jasmine.createSpy("partialDispose");
      const failure = new Error("consumer activation failed");
      const failingConsumer = jasmine.createSpy("failingConsumer").and.callFake((service) => {
        if (service.id === "first") {
          return { dispose: partialDispose };
        }
        throw failure;
      });

      let thrownError;
      try {
        hub.consume("outline", "^1.0.0", failingConsumer);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(failure);
      expect(failingConsumer).toHaveBeenCalledTimes(2);
      expect(partialDispose).toHaveBeenCalledTimes(1);

      const thirdProvider = hub.provide("outline", "1.0.0", { id: "third" });
      expect(failingConsumer).toHaveBeenCalledTimes(2);

      const healthyConsumer = jasmine.createSpy("healthyConsumer");
      const healthyConsumerDisposable = hub.consume("outline", "^1.0.0", healthyConsumer);
      expect(healthyConsumer.calls.allArgs()).toEqual([
        [{ id: "first" }],
        [{ id: "second" }],
        [{ id: "third" }],
      ]);

      firstProvider.dispose();
      secondProvider.dispose();
      thirdProvider.dispose();
      healthyConsumerDisposable.dispose();
      expect(partialDispose).toHaveBeenCalledTimes(1);
    });

    it("disposes every partial registration when rollback cleanup fails", () => {
      const firstDispose = jasmine.createSpy("firstDispose").and.throwError("first cleanup failed");
      const secondDispose = jasmine.createSpy("secondDispose");
      const callbackFailure = new Error("consumer activation failed");

      hub.consume("tree-view", "^1.0.0", () => ({ dispose: firstDispose }));
      hub.consume("tree-view", "^1.0.0", () => ({ dispose: secondDispose }));
      hub.consume("tree-view", "^1.0.0", () => {
        throw callbackFailure;
      });

      let thrownError;
      try {
        hub.provide("tree-view", "1.0.0", {});
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toEqual(jasmine.any(AggregateError));
      expect(thrownError.errors[0]).toBe(callbackFailure);
      expect(thrownError.errors[1].message).toBe("first cleanup failed");
      expect(firstDispose).toHaveBeenCalledTimes(1);
      expect(secondDispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("unmatchedConsumers", () => {
    it("reports a consumer no provider has satisfied", () => {
      hub.consume("outline", "^1.0.0", () => {});

      expect(hub.unmatchedConsumers()).toEqual([{ keyPath: "outline", versionRange: "^1.0.0" }]);
    });

    it("drops a consumer once it has been satisfied, even if the provider leaves", () => {
      hub.consume("outline", "^1.0.0", () => {});
      const providerDisposable = hub.provide("outline", "1.0.0", {});
      expect(hub.unmatchedConsumers()).toEqual([]);

      providerDisposable.dispose();
      expect(hub.unmatchedConsumers()).toEqual([]);
    });

    it("drops a disposed consumer", () => {
      hub.consume("outline", "^1.0.0", () => {}).dispose();

      expect(hub.unmatchedConsumers()).toEqual([]);
    });
  });
});
