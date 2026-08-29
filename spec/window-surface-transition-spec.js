const WindowSurfaceTransitionCoordinator = require("../src/window-surface-transition");

function surface(id) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  return {
    id,
    kind: id,
    window: frame.contentWindow,
    document: frame.contentDocument,
    element: frame.contentDocument.body,
    destroy: () => frame.remove(),
  };
}

describe("WindowSurfaceTransitionCoordinator", () => {
  let coordinator, from, to;

  beforeEach(() => {
    coordinator = new WindowSurfaceTransitionCoordinator();
    from = surface("primary");
    to = surface("detached");
  });

  afterEach(() => {
    coordinator.destroy();
    from.destroy();
    to.destroy();
  });

  it("prepares before movement and commits after the caller connects the new DOM", async () => {
    const events = [];
    const element = from.document.createElement("div");
    from.document.body.appendChild(element);
    const item = {
      beginWindowSurfaceTransition(context) {
        events.push(["begin", element.ownerDocument, element.isConnected, context.reason]);
        return {
          commit() {
            events.push(["commit", element.ownerDocument, element.isConnected]);
          },
        };
      },
    };
    const transition = await coordinator.begin({ item, from, to, reason: "detach" });
    to.document.adoptNode(element);
    to.document.body.appendChild(element);
    await transition.commit();
    transition.complete();
    expect(events).toEqual([
      ["begin", from.document, true, "detach"],
      ["commit", to.document, true],
    ]);
  });

  it("rolls participants back in reverse order after physical DOM restoration", async () => {
    const events = [];
    const element = from.document.createElement("div");
    from.document.body.appendChild(element);
    const item = {
      beginWindowSurfaceTransition() {
        events.push("item-begin");
        return {
          commit() {
            throw new Error("rebuild failed");
          },
          rollback() {
            events.push(["item-rollback", element.ownerDocument, element.isConnected]);
          },
        };
      },
    };
    coordinator.addObserver(() => {
      events.push("observer-begin");
      return { rollback: () => events.push("observer-rollback") };
    });
    const transition = await coordinator.begin({ item, from, to, reason: "detach" });
    to.document.adoptNode(element);
    to.document.body.appendChild(element);
    let failure;
    try {
      await transition.commit();
    } catch (error) {
      failure = error;
    }
    from.document.adoptNode(element);
    from.document.body.appendChild(element);
    await transition.rollback(failure);
    expect(events).toEqual([
      "item-begin",
      "observer-begin",
      "observer-rollback",
      ["item-rollback", from.document, true],
    ]);
  });

  it("aborts an in-flight preparation when the coordinator is destroyed", async () => {
    let release;
    const item = {
      beginWindowSurfaceTransition: (context) =>
        new Promise((resolve) => {
          release = () => resolve({ signal: context.signal });
        }),
    };
    const pending = coordinator.begin({ item, from, to, reason: "detach" });
    coordinator.destroy();
    release();
    await expectAsync(pending).toBeRejectedWithError(/aborted/);
  });
});
