const OverlayComponent = require("../src/overlay-component");

describe("Shared UI measurement in editor windows", () => {
  let overlay, list, host;

  afterEach(async () => {
    overlay?.destroy();
    await host?.destroy();
    await list?.destroy();
    await lumine.workspace.discardEditorWindows();
  });

  it("rebinds an editor overlay observer after its DOM is adopted", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    overlay = new OverlayComponent({
      element: document.createElement("div"),
      overlayComponents: new Set(),
      didResize() {},
    });
    overlay.didDetach();
    extra.getDocument().body.appendChild(overlay.element);
    overlay.didAttach();
    expect(overlay.resizeObserver instanceof extra.getDOMWindow().ResizeObserver).toBeTrue();
  });

  it("measures a select list viewport using the modal host's window", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    list = lumine.workspace.buildSelectList({
      items: ["one", "two"],
      overflowSections: [{ id: "all", items: ["one", "two"] }],
      renderItem: (item) => ({ primary: item }),
    });
    host = lumine.workspace.addSelectList(list, { window: extra });
    host.show();
    await list.update({});
    expect(list.overflowResizeObserver instanceof extra.getDOMWindow().ResizeObserver).toBeTrue();
  });
});
