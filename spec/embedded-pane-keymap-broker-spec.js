const Broker = require("../src/embedded-pane-keymap-broker");

describe("embedded pane native keymap broker", () => {
  let broker, dispatch, replay;
  const input = (key, options = {}) => ({ type: "keyDown", key, ...options });
  const set = (bindings, overrides = {}) => {
    expect(
      broker.setSnapshot({
        hostId: "host",
        revision: 1,
        enabled: true,
        partialMatchTimeout: 1000,
        bindings: bindings.map((binding, rank) => ({ depth: 0, rank, ...binding })),
        ...overrides,
      }),
    ).toBe(true);
  };
  beforeEach(() => {
    dispatch = jasmine.createSpy("dispatch");
    replay = jasmine.createSpy("replay");
    broker = new Broker({ dispatch, replay });
  });
  afterEach(() => broker.dispose());

  it("only cancels allowed pane commands and their real pending suffixes", () => {
    set([{ keystrokes: "alt-z up", command: "pane:split-up-and-move-active-item" }]);
    expect(broker.handleInput(input("x"))).toBe(false);
    expect(broker.handleInput(input("z", { alt: true }))).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(broker.handleInput(input("ArrowUp"))).toBe(true);
    expect(dispatch.calls.count()).toBe(1);
    expect(dispatch.calls.mostRecent().args[0].command).toBe("pane:split-up-and-move-active-item");
  });

  it("respects a nearer unrelated exact binding and leaves its native key alone", () => {
    set([
      { keystrokes: "left", command: "pdf-view:previous-page", depth: 0 },
      { keystrokes: "left", command: "window:focus-pane-left", depth: 1 },
      { keystrokes: "alt-up", command: "window:focus-pane-up", depth: 1 },
    ]);
    expect(broker.handleInput(input("ArrowLeft"))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it("does not capture an unrelated command's chord prefix", () => {
    set([
      { keystrokes: "alt-j x", command: "jupyter-repl:run" },
      { keystrokes: "alt-up", command: "window:focus-pane-up" },
    ]);
    expect(broker.handleInput(input("j", { alt: true }))).toBe(false);
    expect(broker.handleInput(input("x"))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  for (const directive of ["native!", "abort!"]) {
    it(`lets an unrelated ${directive} binding block pane capture without swallowing native input`, () => {
      set([
        { keystrokes: "alt-z", command: directive, depth: 0 },
        { keystrokes: "alt-z up", command: "window:focus-pane-up", depth: 1 },
      ]);
      expect(broker.handleInput(input("z", { alt: true }))).toBe(false);
      expect(broker.handleInput(input("ArrowUp"))).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
    });
  }

  it("replays a suppressed wrong prefix and leaves its unbound suffix native", () => {
    set([{ keystrokes: "g up", command: "window:focus-pane-up" }]);
    expect(broker.handleInput(input("g"))).toBe(true);
    expect(broker.handleInput(input("x"))).toBe(false);
    expect(replay.calls.count()).toBe(1);
    expect(replay.calls.mostRecent().args[0].key).toBe("g");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps keyup rules and native translation on the shared matcher", () => {
    set([{ keystrokes: "alt-z ^alt", command: "window:focus-pane-up" }]);
    expect(broker.handleInput(input("z", { alt: true }))).toBe(true);
    expect(broker.handleInput(input("Alt", { type: "keyUp" }))).toBe(true);
    expect(dispatch.calls.count()).toBe(1);
    expect(dispatch.calls.mostRecent().args[0].command).toBe("window:focus-pane-up");
  });

  it("lets ignored modifier releases reach the child during a keydown chord", () => {
    set([{ keystrokes: "alt-z up", command: "window:focus-pane-up" }]);
    expect(broker.handleInput(input("z", { alt: true }))).toBe(true);
    expect(broker.handleInput(input("Alt", { type: "keyUp" }))).toBe(false);
    expect(broker.handleInput(input("ArrowUp"))).toBe(true);
    expect(dispatch.calls.count()).toBe(1);
    expect(replay).not.toHaveBeenCalled();
  });

  it("clears pending ownership when the registered host changes", () => {
    set([{ keystrokes: "alt-z up", command: "window:focus-pane-up" }]);
    expect(broker.handleInput(input("z", { alt: true }))).toBe(true);
    set([{ keystrokes: "alt-z up", command: "window:focus-pane-up" }], {
      hostId: "other",
      revision: 2,
    });
    expect(broker.handleInput(input("ArrowUp"))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves composition and disabled custom-resolver snapshots native", () => {
    set([{ keystrokes: "alt-up", command: "window:focus-pane-up" }]);
    expect(broker.handleInput(input("ArrowUp", { alt: true, isComposing: true }))).toBe(false);
    set([{ keystrokes: "alt-up", command: "window:focus-pane-up" }], {
      enabled: false,
      revision: 2,
    });
    expect(broker.handleInput(input("ArrowUp", { alt: true }))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects malformed snapshots without replacing a valid route", () => {
    set([{ keystrokes: "alt-up", command: "window:focus-pane-up" }]);
    expect(broker.setSnapshot({ hostId: "bad", revision: 2, bindings: [] })).toBe(false);
    expect(broker.handleInput(input("ArrowUp", { alt: true }))).toBe(true);
    expect(dispatch.calls.count()).toBe(1);
    expect(dispatch.calls.mostRecent().args[0].hostId).toBe("host");
  });
});
