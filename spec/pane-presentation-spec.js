const { copyableElement } = require("./helpers/pane-item-fixtures");

const PROBE_TAG = "pane-presentation-probe";
if (!customElements.get(PROBE_TAG)) {
  customElements.define(
    PROBE_TAG,
    class extends HTMLElement {
      connectedCallback() {
        this.connections = (this.connections ?? 0) + 1;
      }
      disconnectedCallback() {
        this.disconnections = (this.disconnections ?? 0) + 1;
      }
      connectedMoveCallback() {}
    },
  );
}

describe("Pane presentations", () => {
  let container, left, middle, right, workspaceElement, presentation;

  beforeEach(() => {
    lumine.config.set("core.destroyEmptyPanes", false);
    container = lumine.workspace.getMainWindow().getEditorContainer();
    left = container.getActivePane();
    middle = left.splitRight();
    right = middle.splitRight();
    left.setFlexScale(1);
    middle.setFlexScale(2);
    right.setFlexScale(1);
    middle.activate();
    workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "500px";
    jasmine.attachToDOM(workspaceElement);
  });

  afterEach(() => {
    presentation?.dispose();
    container.dismissPanePresentation();
  });

  it("preserves split sizes, model order and the pane/resize-handle sequence", () => {
    const elements = [left, middle, right].map((pane) => pane.getElement());
    const before = elements.map((element) => element.getBoundingClientRect().width);
    const parent = middle.getElement().parentElement;
    presentation = container.presentPane(middle);
    // Presentation styling may take the live pane out of normal layout.
    middle.getElement().style.position = "fixed";
    const after = [elements[0], presentation.slot, elements[2]].map(
      (element) => element.getBoundingClientRect().width,
    );

    expect(container.getPanes()).toEqual([left, middle, right]);
    expect(presentation.element).toBe(elements[1]);
    expect(presentation.slot.model).toBe(middle);
    expect(parent.children.length).toBe(5);
    expect(parent.children[2]).toBe(presentation.slot);
    for (let index = 0; index < before.length; index++)
      expect(after[index]).toBeCloseTo(before[index], 1);

    middle.getElement().style.removeProperty("position");
    presentation.dispose();
    expect(middle.getElement().parentElement).toBe(parent);
    expect(parent.children[2]).toBe(elements[1]);
    expect(middle.getFlexScale()).toBe(2);
  });

  for (const orientation of ["horizontal", "vertical"]) {
    it(`preserves exact ${orientation} split rectangles with unequal scales and asymmetric boxes`, () => {
      if (orientation === "vertical") {
        right.destroy();
        middle.destroy();
        middle = left.splitDown({ activate: false });
        right = middle.splitDown({ activate: false });
        middle.activate();
      }
      const panes = [left, middle, right];
      for (const [index, pane] of panes.entries()) {
        const style = pane.getElement().style;
        style.borderStyle = "solid";
        style.borderWidth = `${index + 1}px ${index + 3}px ${index + 2}px ${index + 4}px`;
        style.padding = `${index + 2}px ${index + 1}px ${index + 4}px ${index + 3}px`;
        style.margin = `${index + 1}px ${index + 2}px ${index + 3}px ${index + 4}px`;
        pane.setFlexScale(index + 1);
      }
      const rectangle = (element) => {
        const { left, top, width, height } = element.getBoundingClientRect();
        return { left, top, width, height };
      };
      const before = panes.map((pane) => rectangle(pane.getElement()));
      presentation = container.presentPane(middle);
      middle.getElement().style.position = "fixed";
      const during = [left.getElement(), presentation.slot, right.getElement()].map(rectangle);
      expect(during).toEqual(before);

      middle.getElement().style.removeProperty("position");
      presentation.dispose();
      expect(panes.map((pane) => rectangle(pane.getElement()))).toEqual(before);
    });
  }

  it("does not disconnect or recreate the active item's live subtree", () => {
    const probe = document.createElement(PROBE_TAG);
    probe.canCopy = () => false;
    probe.getAllowedLocations = () => ["center"];
    middle.activateItem(probe);
    const connections = probe.connections;
    presentation = container.presentPane(middle);
    presentation.dispose();

    expect(middle.getActiveItem()).toBe(probe);
    expect(probe.connections).toBe(connections);
    expect(probe.disconnections ?? 0).toBe(0);
    expect(probe.isConnected).toBe(true);
  });

  jasmine.itWithDocumentFocus("retains the focused input and selection across presentation", () => {
    const input = copyableElement("input");
    input.value = "a live selection";
    middle.activateItem(input);
    input.focus();
    input.setSelectionRange(2, 6);

    presentation = container.presentPane(middle);
    expect(document.activeElement).toBe(input);
    presentation.dispose();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);
  });

  it("retains the presentation when the active item changes inside its pane", () => {
    const first = copyableElement();
    const second = copyableElement();
    middle.activateItem(first);
    presentation = container.presentPane(middle);
    middle.activateItem(second);
    expect(container.getPresentedPane()).toBe(middle);
    expect(presentation.element.getActiveView()).toBe(second);
  });

  it("cancels before an explicitly selected sibling becomes active", () => {
    presentation = container.presentPane(middle);
    const disposed = jasmine.createSpy("disposed");
    presentation.onDidDispose(disposed);
    right.activate();
    expect(container.getPresentedPane()).toBeNull();
    expect(container.getActivePane()).toBe(right);
    expect(presentation.disposed).toBe(true);
    expect(disposed).toHaveBeenCalledTimes(1);
    presentation.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot's flex weight synchronized without changing the model", () => {
    presentation = container.presentPane(middle);
    middle.setFlexScale(3);
    expect(presentation.slot.style.flexGrow).toBe("3");
    expect(middle.getElement().getLayoutElement()).toBe(presentation.slot);
    presentation.dispose();
    expect(middle.getElement().getLayoutElement()).toBe(middle.getElement());
    expect(middle.getFlexScale()).toBe(3);
  });

  for (const direction of ["Right", "Down"]) {
    it(`releases the presentation before a ${direction.toLowerCase()} split changes the tree`, () => {
      presentation = container.presentPane(middle);
      const added = middle[`split${direction}`]({ activate: false });
      expect(presentation.disposed).toBe(true);
      expect(container.getPanes()).toContain(added);
      expect(container.getPresentedPane()).toBeNull();
      for (const pane of container.getPanes())
        expect(pane.getElement().parentElement.model).toBe(pane.getParent());
      expect(workspaceElement.querySelector(".pane-presentation-slot")).toBeNull();
    });
  }

  it("releases a presented pane before destroying it", () => {
    presentation = container.presentPane(middle);
    middle.destroy();
    expect(presentation.disposed).toBe(true);
    expect(container.getPanes()).toEqual([left, right]);
    expect(workspaceElement.querySelector(".pane-presentation-slot")).toBeNull();
  });

  it("releases the presentation before another pane is removed", () => {
    presentation = container.presentPane(middle);
    right.destroy();
    expect(presentation.disposed).toBe(true);
    expect(container.getPanes()).toEqual([left, middle]);
    expect(middle.getElement().parentElement.model).toBe(middle.getParent());
  });

  it("supports presenting the sole root pane", () => {
    right.destroy();
    left.destroy();
    presentation = container.presentPane(middle);
    expect(container.getElement().firstElementChild).toBe(presentation.slot);
    presentation.dispose();
    expect(container.getElement().firstElementChild).toBe(middle.getElement());
  });

  it("rejects panes owned by another container", () => {
    const other = lumine.workspace.getLeftDock().getActivePane();
    expect(() => container.presentPane(other)).toThrowError(/live pane in this container/);
  });

  it("leaves an existing presentation intact after rejecting a foreign activation", () => {
    presentation = container.presentPane(middle);
    expect(() =>
      container.didActivatePane(lumine.workspace.getLeftDock().getActivePane()),
    ).toThrowError(/not present in pane container/);
    expect(container.getPresentedPane()).toBe(middle);
    expect(presentation.disposed).toBeFalse();
  });

  for (const change of ["redirect", "destroy"]) {
    it(`does not create a stale presentation when activation observers ${change} its pane`, () => {
      left.activate();
      const subscription = middle.onDidActivate(() => {
        if (change === "redirect") right.activate();
        else middle.destroy();
      });
      try {
        expect(() => container.presentPane(middle)).toThrowError(/pane changed/);
        expect(container.getPresentedPane()).toBeNull();
        expect(workspaceElement.querySelector(".pane-presentation-slot")).toBeNull();
        for (const pane of container.getPanes())
          expect(pane.getElement().getLayoutElement()).toBe(pane.getElement());
      } finally {
        subscription.dispose();
      }
    });
  }

  it("restores DOM and subscriptions if creating the presentation fails", () => {
    const element = middle.getElement();
    const parent = element.parentElement;
    const listenerCount = middle.emitter.listenerCountForEventName("did-change-flex-scale");
    spyOn(middle, "onWillDestroy").and.throwError("Unable to observe the pane lifetime");

    expect(() => container.presentPane(middle)).toThrowError("Unable to observe the pane lifetime");

    expect(container.getPresentedPane()).toBeNull();
    expect(element.parentElement).toBe(parent);
    expect(element.getLayoutElement()).toBe(element);
    expect(element.isConnected).toBeTrue();
    expect(middle.emitter.listenerCountForEventName("did-change-flex-scale")).toBe(listenerCount);
    expect(workspaceElement.querySelector(".pane-presentation-slot")).toBeNull();
  });

  it("runs every disposal callback and releases ownership when a callback throws", () => {
    const element = middle.getElement();
    const parent = element.parentElement;
    const listenerCount = middle.emitter.listenerCountForEventName("did-change-flex-scale");
    presentation = container.presentPane(middle);
    const failure = new Error("Unable to finish owner cleanup");
    const cleanup = jasmine.createSpy("second owner cleanup");
    presentation.onDidDispose(() => {
      throw failure;
    });
    presentation.onDidDispose(cleanup);

    expect(() => presentation.dispose()).toThrow(failure);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(container.getPresentedPane()).toBeNull();
    expect(element.parentElement).toBe(parent);
    expect(element.getLayoutElement()).toBe(element);
    expect(element.isConnected).toBeTrue();
    expect(presentation.slot.isConnected).toBeFalse();
    expect(middle.emitter.listenerCountForEventName("did-change-flex-scale")).toBe(listenerCount);
    expect(() => presentation.dispose()).not.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("prevents a disposal observer from reopening a presentation during split mutation", () => {
    presentation = container.presentPane(middle);
    presentation.onDidDispose(() => {
      expect(() => container.presentPane(left)).toThrowError(/already being changed/);
    });
    const added = right.splitDown({ activate: false });
    expect(container.getPanes()).toContain(added);
    expect(container.getPresentedPane()).toBeNull();
    expect(workspaceElement.querySelector(".pane-presentation-slot")).toBeNull();
  });

  it("serializes only the original split tree and active pane", () => {
    const before = container.serialize();
    presentation = container.presentPane(middle);
    expect(container.serialize()).toEqual(before);
    presentation.dispose();
    expect(container.serialize()).toEqual(before);
  });

  it("releases the presentation while transferring the exact live pane to another container", async () => {
    const PaneContainer = require("../src/pane-container");
    const transferPaneLayout = require("../src/pane-window-transfer");
    const center = lumine.workspace.getCenter();
    const target = new PaneContainer(center.params);
    center.addPaneContainer(target);
    jasmine.attachToDOM(target.getElement());
    const editor = lumine.workspace.buildTextEditor();
    middle.activateItem(editor);
    const paneElement = middle.getElement();
    const editorElement = editor.getElement();
    presentation = container.presentPane(middle);
    try {
      await transferPaneLayout(lumine.workspace, container, target, [middle]);
      expect(presentation.disposed).toBeTrue();
      expect(container.getPresentedPane()).toBeNull();
      expect(target.getActivePane()).toBe(middle);
      expect(middle.getContainer()).toBe(target);
      expect(middle.getElement()).toBe(paneElement);
      expect(middle.getActiveItem()).toBe(editor);
      expect(editor.getElement()).toBe(editorElement);
      expect(paneElement.getLayoutElement()).toBe(paneElement);
      expect(presentation.slot.isConnected).toBeFalse();
    } finally {
      target.destroy();
      center.removePaneContainer(target);
    }
  });

  it("retains an embedded frame's browsing context through entry and restoration", async () => {
    const item = copyableElement();
    const frame = document.createElement("iframe");
    let loads = 0;
    const loaded = new Promise((resolve) => {
      frame.addEventListener("load", () => {
        loads++;
        resolve();
      });
    });
    frame.srcdoc = '<input value="A live frame">';
    item.appendChild(frame);
    middle.activateItem(item);
    await loaded;
    const runtime = frame.contentWindow;
    const state = { result: "retained output" };
    runtime.presentationState = state;

    presentation = container.presentPane(middle);
    presentation.dispose();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(frame.contentWindow).toBe(runtime);
    expect(frame.contentWindow.presentationState).toBe(state);
    expect(frame.contentDocument.querySelector("input").value).toBe("A live frame");
    expect(loads).toBe(1);
  });

  describe("directional navigation", () => {
    let leftDock, rightDock, bottomDock;

    beforeEach(() => {
      leftDock = lumine.workspace.getLeftDock();
      rightDock = lumine.workspace.getRightDock();
      bottomDock = lumine.workspace.getBottomDock();
      leftDock.show();
      rightDock.show();
      bottomDock.show();
      presentation = container.presentPane(middle);
    });

    it("exposes the presented pane as the center's only visible pane", () => {
      const visible = lumine.workspace.getVisiblePanes();
      expect(visible).toContain(middle);
      expect(visible).not.toContain(left);
      expect(visible).not.toContain(right);
      expect(visible).toContain(leftDock.getActivePane());
    });

    for (const [direction, dockName] of [
      ["left", "getLeftDock"],
      ["right", "getRightDock"],
      ["down", "getBottomDock"],
    ]) {
      it(`navigates ${direction} directly to the visible dock`, () => {
        const target = lumine.workspace[dockName]().getActivePane();
        expect(workspaceElement.nearestVisiblePaneInDirection(direction, middle)).toBe(
          target.getElement(),
        );
        target.activate();
        expect(container.getPresentedPane()).toBe(middle);
      });
    }

    for (const [direction, dockName] of [
      ["right", "getLeftDock"],
      ["left", "getRightDock"],
      ["up", "getBottomDock"],
    ]) {
      it(`returns from ${dockName} to the presented center pane`, () => {
        const source = lumine.workspace[dockName]().getActivePane();
        expect(workspaceElement.nearestVisiblePaneInDirection(direction, source)).toBe(
          middle.getElement(),
        );
      });
    }

    it("has no hidden sibling target when the dock is closed", () => {
      leftDock.hide();
      expect(workspaceElement.nearestVisiblePaneInDirection("left", middle)).toBeUndefined();
    });
  });
});
