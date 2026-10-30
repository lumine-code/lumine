const ContextViewManager = require("../src/context-view-manager");
const { showMenuPopup } = require("../src/menu-view");
const SelectBoxView = require("../src/select-box-view");

describe("Context view ownership", () => {
  let manager, owner, trigger, other, selectBox;
  beforeEach(() => {
    manager = new ContextViewManager({ document, window });
    owner = document.createElement("section");
    trigger = document.createElement("button");
    other = document.createElement("button");
    owner.append(trigger);
    document.body.append(owner, other);
  });
  afterEach(() => {
    selectBox?.destroy();
    manager.destroy();
    owner.remove();
    other.remove();
  });

  it("publishes explicit ownership before focusing and retires only its own portal", () => {
    const changes = jasmine.createSpy("active changes");
    manager.onDidChangeActive(changes);
    const handle = manager.show({
      ownerElement: trigger,
      render: (surface) => {
        surface.tabIndex = -1;
      },
      focus: (surface) => {
        expect(manager.containsOwnedElement(owner, surface)).toBe(true);
        expect(changes).toHaveBeenCalledTimes(1);
        surface.focus();
      },
    });
    expect(manager.getOwnedSurfaces(owner)).toEqual([handle.element]);
    expect(manager.hideOwnedBy(other)).toBe(false);
    expect(handle.closed).toBe(false);
    expect(manager.hideOwnedBy(owner, { restoreFocus: false })).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("does not infer ownership from saved focus and keeps explicit ownership through child replacement", () => {
    trigger.focus();
    const unrelated = manager.show({ render() {}, anchor: other });
    expect(manager.getOwnedSurfaces(owner)).toEqual([]);
    manager.hideOwnedBy(owner);
    expect(unrelated.closed).toBe(false);
    const parent = manager.show({ ownerElement: trigger, render() {} });
    const childTrigger = document.createElement("button");
    parent.surface.append(childTrigger);
    const child = manager.show({ ownerElement: childTrigger, render() {} });
    expect(parent.closed).toBe(true);
    expect(manager.containsOwnedElement(owner, child.surface)).toBe(true);
  });

  it("forwards an actual menu trigger instead of its previously focused editor", () => {
    trigger.focus();
    const popup = showMenuPopup(manager, {
      target: other,
      focusTarget: trigger,
      anchor: other,
      template: [{ label: "Action", command: "test:action" }],
    });
    expect(manager.getOwnedSurfaces(owner)).toEqual([]);
    expect(manager.containsOwnedElement(other, popup.element)).toBe(true);
    const eventPopup = showMenuPopup(manager, {
      target: trigger,
      focusTarget: trigger,
      anchor: { target: other, clientX: 1, clientY: 1 },
      template: [{ label: "Action", command: "test:action" }],
    });
    expect(manager.getOwnedSurfaces(owner)).toEqual([]);
    expect(manager.containsOwnedElement(other, eventPopup.element)).toBe(true);
  });

  it("opens select options with their adopted document's manager and explicit trigger", async () => {
    const ensure = jasmine.createSpy("document manager").and.returnValue(manager);
    selectBox = new SelectBoxView(
      { ensureContextViewManager: ensure },
      {
        items: ["alpha", "beta"],
        document,
      },
    );
    owner.append(selectBox.element);
    await selectBox.open();
    expect(ensure).toHaveBeenCalledOnceWith(selectBox.element.ownerDocument);
    expect(selectBox.listElement.ownerDocument).toBe(document);
    expect(manager.containsOwnedElement(owner, selectBox.listElement)).toBe(true);
    selectBox.listElement.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(selectBox.popup).toBeNull();
    expect(document.activeElement).toBe(selectBox.element);
  });

  it("creates adopted select options in the detached document", async () => {
    jasmine.useRealClock();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const remote = lumine.menu.ensureContextViewManager(extra.getDocument());
    try {
      selectBox = new SelectBoxView(lumine.menu, { items: ["alpha", "beta"] });
      extra.getDocument().body.append(selectBox.element);
      await selectBox.open();
      expect(selectBox.listElement.ownerDocument).toBe(extra.getDocument());
      expect(remote.containsOwnedElement(selectBox.element, selectBox.listElement)).toBe(true);
      expect(manager.getOwnedSurfaces(selectBox.element)).toEqual([]);
    } finally {
      selectBox.destroy();
      await lumine.workspace.closeEditorWindow(extra);
    }
  });
});
