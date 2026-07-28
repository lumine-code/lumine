"use strict";

const {
  activeSession,
  isModalOpen,
  visibleLabels,
  focusedLabel,
  confirm,
  cancel,
  moveDown,
  setQuery,
  emptyMessageText,
  flush,
  settle,
} = require("./helpers/modal-helpers");

describe("atom.modals", () => {
  const listSpec = (overrides = {}) => ({
    id: "spec.list",
    source: ["alpha", "beta", "gamma"],
    ...overrides,
  });

  afterEach(() => {
    if (atom.modals.isOpen()) atom.modals.cancel("api");
    flush(1000);
  });

  describe("open", () => {
    it("shows the panel and renders the source items", async () => {
      atom.modals.open(listSpec());
      await settle();

      expect(isModalOpen()).toBe(true);
      expect(visibleLabels()).toEqual(["alpha", "beta", "gamma"]);
      expect(focusedLabel()).toBe("alpha");
    });

    it("requires a ViewSpec id", () => {
      expect(() => atom.modals.open({ source: [] })).toThrow();
      expect(() => atom.modals.open()).toThrow();
    });

    it("creates the panel lazily and reuses one host across sessions", async () => {
      const before = atom.workspace.getModalPanels().length;
      atom.modals.open(listSpec());
      await settle();
      const during = atom.workspace.getModalPanels().length;

      atom.modals.open(listSpec({ id: "spec.other" }));
      await settle();

      expect(during).toBe(before + 1);
      expect(atom.workspace.getModalPanels().length).toBe(during);
    });

    it("puts a modals-open class on the body while a session is active", async () => {
      atom.modals.open(listSpec());
      await settle();
      expect(document.body.classList.contains("modals-open")).toBe(true);

      cancel();
      await settle();
      expect(document.body.classList.contains("modals-open")).toBe(false);
    });
  });

  describe("ifOpen", () => {
    it("replaces the active session by default, closing the outgoing one once", async () => {
      const closes = [];
      atom.modals.open(listSpec({ didClose: (result) => closes.push(result) }));
      await settle();

      atom.modals.open(listSpec({ id: "spec.second", source: ["one"] }));
      await settle();

      expect(closes.length).toBe(1);
      expect(closes[0].status).toBe("cancelled");
      expect(closes[0].reason).toBe("replaced");
      expect(visibleLabels()).toEqual(["one"]);
    });

    it("rejects a second open when asked to", async () => {
      const first = atom.modals.open(listSpec());
      await settle();

      const second = atom.modals.open(listSpec({ id: "spec.second" }), { ifOpen: "reject" });

      expect(second).toBeNull();
      expect(activeSession()).toBe(first);
    });

    it("closes a matching session when toggling", async () => {
      atom.modals.open(listSpec());
      await settle();

      const again = atom.modals.toggle(listSpec());
      await settle();

      expect(again).toBeNull();
      expect(isModalOpen()).toBe(false);
    });

    it("opens through toggle when a different view is active", async () => {
      atom.modals.open(listSpec());
      await settle();

      atom.modals.toggle(listSpec({ id: "spec.other", source: ["x"] }));
      await settle();

      expect(isModalOpen()).toBe(true);
      expect(visibleLabels()).toEqual(["x"]);
    });
  });

  describe("result", () => {
    it("resolves confirmed with the focused item", async () => {
      const session = atom.modals.open(listSpec());
      await settle();
      moveDown();
      confirm();

      const result = await session.result;
      expect(result.status).toBe("confirmed");
      expect(result.value).toBe("beta");
    });

    it("resolves rather than rejects on cancel", async () => {
      const session = atom.modals.open(listSpec());
      await settle();
      cancel();

      const result = await session.result;
      expect(result.status).toBe("cancelled");
      expect(result.reason).toBe("escape");
    });
  });

  describe("sugar", () => {
    it("pick resolves the confirmed value", async () => {
      const picked = atom.modals.pick(listSpec());
      await settle();
      confirm();
      expect(await picked).toBe("alpha");
    });

    it("pick resolves undefined on cancel", async () => {
      const picked = atom.modals.pick(listSpec());
      await settle();
      cancel();
      expect(await picked).toBeUndefined();
    });

    it("pick with detailed reports why it was rejected", async () => {
      atom.modals.open(listSpec());
      await settle();

      const result = await atom.modals.pick(listSpec({ id: "spec.blocked" }), {
        ifOpen: "reject",
        detailed: true,
      });
      expect(result.status).toBe("cancelled");
      expect(result.reason).toBe("rejected");
    });

    it("input resolves the typed text", async () => {
      const typed = atom.modals.input({ id: "spec.input" });
      await settle();
      setQuery("hello");
      await settle();
      confirm();
      expect(await typed).toBe("hello");
    });

    it("confirmChoice resolves the chosen value", async () => {
      const chosen = atom.modals.confirmChoice({
        id: "spec.choice",
        choices: [
          { label: "Keep", value: "keep" },
          { label: "Discard", value: "discard" },
        ],
      });
      await settle();
      moveDown();
      confirm();
      expect(await chosen).toBe("discard");
    });
  });

  describe("empty state", () => {
    it("shows the empty message when nothing matches", async () => {
      atom.modals.open(listSpec({ emptyMessage: "Nothing here" }));
      await settle();
      setQuery("zzzzzz");
      await settle();

      expect(visibleLabels()).toEqual([]);
      expect(emptyMessageText()).toBe("Nothing here");
    });
  });

  describe("clear", () => {
    it("closes the session and lets the next open rebuild the panel", async () => {
      const closes = [];
      const session = atom.modals.open(listSpec({ didClose: (r) => closes.push(r) }));
      await settle();

      atom.modals.clear();

      expect(closes.length).toBe(1);
      expect(closes[0].reason).toBe("destroyed");
      expect(atom.modals.isOpen()).toBe(false);
      expect((await session.result).status).toBe("cancelled");

      atom.modals.open(listSpec());
      await settle();
      expect(isModalOpen()).toBe(true);
      expect(visibleLabels()).toEqual(["alpha", "beta", "gamma"]);
    });
  });

  describe("target capture", () => {
    it("captures the pre-modal editor before focus moves into the host", async () => {
      const editor = await atom.workspace.open();
      const session = atom.modals.open(listSpec());
      await settle();

      expect(session.target.editor).toBe(editor);
    });

    it("degrades restore() when the captured pane item is gone", async () => {
      await atom.workspace.open();
      const session = atom.modals.open(listSpec());
      await settle();

      for (const item of atom.workspace.getPaneItems()) item.destroy();
      expect(() => session.target.restore()).not.toThrow();
    });
  });
});
