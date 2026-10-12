describe("Pane item resource uniqueness", () => {
  let workspace;
  function view(uri, key) {
    const { Emitter } = require("@lumine-code/event-kit");
    const emitter = new Emitter();
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Resource",
      getURI: () => uri,
      getSingletonKey: () => key,
      canCopy: () => false,
      onDidDestroy: (callback) => emitter.on("did-destroy", callback),
      destroy: jasmine.createSpy("destroy unpresented resource").and.callFake(() => {
        item.destroyed = true;
        emitter.emit("did-destroy");
        emitter.dispose();
      }),
    };
    return item;
  }

  beforeEach(() => {
    workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
  });

  it("reuses an existing key from an opener before creating a requested split", async () => {
    const source = view("test://tool/first", "test:tool");
    await workspace.open(source);
    const candidate = view("test://tool/second", "test:tool");
    const opener = workspace.addOpener((uri) =>
      uri === candidate.getURI() ? candidate : undefined,
    );
    try {
      const panes = workspace.getPanes();
      const result = await workspace.open(candidate.getURI(), { split: "right" });
      expect(result).toBe(source);
      expect(workspace.getPanes()).toEqual(panes);
      expect(candidate.destroy).toHaveBeenCalledTimes(1);
      expect(source.destroy).not.toHaveBeenCalled();
    } finally {
      opener.dispose();
    }
  });

  it("allows different result keys to coexist and move with their exact views", async () => {
    const first = await workspace.open(view("test://results", "test:result-one"));
    const second = await workspace.open(view("test://results", "test:result-two"));
    expect(workspace.getPaneItems()).toContain(first);
    expect(workspace.getPaneItems()).toContain(second);
    const root = first.element;
    const moved = await workspace.movePaneItem(first, { splitDirection: "right" });
    expect(moved.item).toBe(first);
    expect(first.element).toBe(root);
    expect(workspace.getPaneItems()).toContain(second);
  });

  it("rejects duplicate keys in a staged split before changing its geometry", () => {
    const pane = workspace.getActivePane();
    const panes = workspace.getPanes();
    expect(() =>
      pane.splitRight({
        items: [view("test://one", "test:same"), view("test://two", "test:same")],
      }),
    ).toThrowError(/singleton keys/);
    expect(workspace.getPanes()).toEqual(panes);
  });
});
