const Panel = require("../src/panel");

describe("Modal panel departure policy", () => {
  let panels, hosts, outside, contextViews;
  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    panels = [];
    hosts = [];
    outside = document.createElement("input");
    lumine.workspace.getElement().append(outside);
    contextViews = lumine.menu.ensureContextViewManager(document);
    spyOn(document, "hasFocus").and.returnValue(true);
  });
  afterEach(async () => {
    contextViews.hide({ restoreFocus: false });
    panels.forEach((panel) => panel.destroy());
    await Promise.all(hosts.map((host) => host.destroy()));
    outside.remove();
    await lumine.workspace.discardEditorWindows();
  });
  const frames = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const press = (element) =>
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  function raw({ deferShow = false, ...options } = {}) {
    const item = document.createElement("div");
    const input = document.createElement("input");
    const button = document.createElement("button");
    button.textContent = "Action";
    item.append(input, button);
    const panel = lumine.workspace.addModalPanel({
      item,
      visible: false,
      dismissOnBlur: true,
      ...options,
    });
    panels.push(panel);
    if (!deferShow) panel.show();
    return { panel, input, button, item };
  }
  function portal(ownerElement) {
    return contextViews.show({
      ownerElement,
      render(surface) {
        const button = document.createElement("button");
        button.textContent = "Choice";
        surface.append(button);
      },
      focus(surface) {
        surface.firstChild.focus();
      },
    });
  }

  it("defaults to a nondismissing panel and validates an opt-in predicate", () => {
    const item = document.createElement("div");
    expect(new Panel({ item }, lumine.views).autoFocus).toBe(false);
    expect(new Panel({ item, dismissOnBlur: true }, lumine.views).autoFocus).toBe(true);
    expect(
      new Panel({ item, dismissOnBlur: () => false, autoFocus: false }, lumine.views).autoFocus,
    ).toBe(false);
    expect(() => new Panel({ item, dismissOnBlur: "yes" }, lumine.views)).toThrowError(TypeError);
  });

  it("keeps internal controls and an owned portal, then dismisses only a real outside press", async () => {
    const { panel, button } = raw();
    button.focus();
    const child = portal(button);
    expect(child.element.contains(document.activeElement)).toBe(true);
    press(child.surface.firstChild);
    await frames();
    expect(panel.isVisible()).toBe(true);
    expect(child.closed).toBe(false);
    press(outside);
    await frames();
    expect(panel.isVisible()).toBe(false);
    expect(child.closed).toBe(true);
  });

  it("evaluates busy state after the event and preserves native window controls", async () => {
    let busy = true;
    const { panel } = raw({ dismissOnBlur: () => !busy });
    press(outside);
    await frames();
    expect(panel.isVisible()).toBe(true);
    const control = document.createElement("button");
    control.dataset.windowControl = "minimize";
    lumine.workspace.getElement().append(control);
    busy = false;
    press(control);
    await frames();
    expect(panel.isVisible()).toBe(true);
    control.remove();
    press(outside);
    await frames();
    expect(panel.isVisible()).toBe(false);
  });

  it("preserves OS blur but dismisses same-document focus departure with autofocus disabled", async () => {
    const { panel, input } = raw({ autoFocus: false });
    input.focus();
    document.hasFocus.and.returnValue(false);
    outside.focus();
    await frames();
    expect(panel.isVisible()).toBe(true);
    document.hasFocus.and.returnValue(true);
    input.focus();
    outside.focus();
    await frames();
    expect(panel.isVisible()).toBe(false);
  });

  it("does not let stale click-away callbacks hide a resumed modal-flow parent", async () => {
    const first = raw();
    press(outside);
    const second = raw({ deferShow: true });
    second.panel.show({ crumb: "Child" });
    await frames();
    lumine.workspace.getModalFlow().pop();
    await frames();
    expect(first.panel.isVisible()).toBe(true);
    expect(second.panel.isVisible()).toBe(false);
  });

  it("includes owned portals in a shared input host and retains an oversized editable query", async () => {
    const button = document.createElement("button");
    const host = lumine.workspace.addInputDialog({ contentElement: button, maxQueryLength: 4 });
    hosts.push(host);
    await host.show({ query: "oversized" });
    const model = host.getModel();
    const child = portal(button);
    expect(child.element.contains(document.activeElement)).toBe(true);
    press(child.surface.firstChild);
    await frames();
    expect(host.isVisible()).toBe(true);
    expect(model.getQueryStatus().available).toBe(false);
    expect(model.getQueryEditor().getBuffer().getLength()).toBe(9);
    host.hide();
    expect(child.closed).toBe(true);
  });

  it("lets a SelectBox handle Escape and returns portal Tab through the actual form trigger", async () => {
    const { panel, item, button } = raw();
    const select = lumine.menu.createSelectBox({ items: ["one", "two"] });
    item.prepend(select.element);
    const tab = jasmine.createSpy("form Tab");
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      tab(event.target);
      event.preventDefault();
      button.focus();
    });
    try {
      await select.open();
      select.listElement.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(panel.isVisible()).toBe(true);
      expect(document.activeElement).toBe(select.element);
      await select.open();
      select.listElement.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
      await frames();
      expect(tab).toHaveBeenCalledOnceWith(select.element);
      expect(select.popup).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(panel.isVisible()).toBe(true);
    } finally {
      select.destroy();
    }
  });

  it("observes existing and new window-local modal panels until disposal", () => {
    const existing = raw().panel;
    const observed = [];
    const subscription = lumine.workspace
      .getMainWindow()
      .observeModalPanels((panel) => observed.push(panel));
    expect(observed).toContain(existing);
    const next = raw().panel;
    expect(observed.filter((panel) => panel === next).length).toBe(1);
    subscription.dispose();
    expect(observed).not.toContain(raw().panel);
  });

  it("closes only a detached window's owned portal when that window is destroyed", async () => {
    const main = raw();
    const mainChild = portal(main.button);
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const remote = raw({ window: extra });
    const document = extra.getDocument();
    const manager = lumine.menu.ensureContextViewManager(document);
    const remoteChild = manager.show({ ownerElement: remote.button, render() {} });
    expect(remote.panel.getElement().ownerDocument).toBe(document);
    expect(manager.getOwnedSurfaces(remote.panel.getElement())).toEqual([remoteChild.element]);
    await lumine.workspace.closeEditorWindow(extra);
    expect(remoteChild.closed).toBe(true);
    expect(mainChild.closed).toBe(false);
    expect(main.panel.isVisible()).toBe(true);
  });
});
