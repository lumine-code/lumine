const { Emitter } = require("@lumine-code/event-kit");

function viewItem({
  singleton = false,
  element = document.createElement("div"),
  uri = "test://item",
} = {}) {
  const emitter = new Emitter();
  let revision = 0;
  const item = {
    element,
    getTitle: () => "Test View",
    getURI: () => uri,
    getPaneItemRevision: () => revision,
    isSingleton: () => singleton,
    copy: () => viewItem({ uri }),
    onDidChangeURI: (callback) => emitter.on("uri", callback),
    onDidDestroy: (callback) => emitter.on("destroy", callback),
    isDestroyed: () => item.destroyed === true,
    destroy: jasmine.createSpy("destroy").and.callFake(() => {
      item.destroyed = true;
      emitter.emit("destroy");
    }),
    navigate(nextURI) {
      uri = nextURI;
      revision++;
      emitter.emit("uri");
    },
  };
  return item;
}

describe("workspace pane item operations", () => {
  let workspace, sourcePane, targetPane, item;

  beforeEach(() => {
    workspace = lumine.workspace;
    const root = workspace.getElement();
    root.style.width = "800px";
    root.style.height = "500px";
    jasmine.attachToDOM(root);
    sourcePane = workspace.getCenter().getActivePane();
    item = viewItem();
    sourcePane.activateItem(item, { activatePane: true });
    targetPane = sourcePane.splitRight({ activate: false });
  });

  it("requires the center item contract before changing pane state", () => {
    const invalid = { element: document.createElement("div") };
    const additions = jasmine.createSpy("additions");
    const subscription = sourcePane.onDidAddItem(additions);
    expect(() => sourcePane.addItem(invalid)).toThrowError(/copy/);
    expect(sourcePane.getItems()).toEqual([item]);
    expect(additions).not.toHaveBeenCalled();
    subscription.dispose();
  });

  it("copies view state into a fresh item without deduplicating its URI", async () => {
    const result = await workspace.copyPaneItem(item, { targetPane });
    expect(result.pane).toBe(targetPane);
    expect(result.item).not.toBe(item);
    expect(result.item.getURI()).toBe(item.getURI());
    expect(result.item.element).not.toBe(item.element);
    expect(workspace.paneForItem(item)).toBe(sourcePane);
    expect(workspace.paneForItem(result.item)).toBe(targetPane);
    expect(workspace.getActivePane()).toBe(targetPane);
  });

  it("preserves the destination preview while making a successful copy permanent", async () => {
    const preview = viewItem({ uri: "test://preview" });
    targetPane.addItem(preview, { pending: true });
    sourcePane.setPendingItem(item);
    const result = await workspace.copyPaneItem(item, { targetPane });
    expect(sourcePane.getPendingItem()).toBeNull();
    expect(targetPane.getPendingItem()).toBe(preview);
    expect(targetPane.getItems()).toContain(preview);
    expect(preview.destroy).not.toHaveBeenCalled();
    expect(targetPane.getActiveItem()).toBe(result.item);
  });

  for (const direction of ["up", "down", "left", "right"]) {
    it(`moves a sole singleton into a new ${direction} split while preserving the explicit split`, async () => {
      lumine.config.set("core.destroyEmptyPanes", true);
      item.isSingleton = () => true;
      targetPane.destroy();
      const result = await workspace.movePaneItem(item, { sourcePane, splitDirection: direction });
      expect(workspace.getCenter().getPanes().length).toBe(2);
      expect(sourcePane.isDestroyed()).toBe(false);
      expect(sourcePane.getItems()).toEqual([]);
      expect(result.item).toBe(item);
      expect(result.pane.getActiveItem()).toBe(item);
    });
  }

  for (const destination of ["existing", "split"]) {
    it(`refuses singleton copying to ${destination} without touching preview, layout or focus`, async () => {
      item.isSingleton = () => true;
      sourcePane.setPendingItem(item);
      const panes = workspace.getPanes();
      const options = destination === "split" ? { splitDirection: "down" } : { targetPane };
      await expectAsync(workspace.copyPaneItem(item, options)).toBeRejectedWith(
        jasmine.objectContaining({ code: "SINGLETON" }),
      );
      expect(workspace.getPanes()).toEqual(panes);
      expect(workspace.getActivePane()).toBe(sourcePane);
      expect(sourcePane.getPendingItem()).toBe(item);
    });
  }

  for (const invalid of ["source", "owned", "shared-root", "missing", "destroyed"]) {
    it(`rejects a ${invalid} copy result before creating a split`, async () => {
      const owned = viewItem();
      targetPane.addItem(owned);
      let result = viewItem();
      if (invalid === "source") result = item;
      if (invalid === "owned") result = owned;
      if (invalid === "shared-root") result.element = item.element;
      if (invalid === "missing") result = undefined;
      if (invalid === "destroyed") result.destroy();
      item.copy = () => result;
      sourcePane.setPendingItem(item);
      const panes = workspace.getPanes();
      await expectAsync(workspace.copyPaneItem(item, { splitDirection: "down" })).toBeRejected();
      expect(workspace.getPanes()).toEqual(panes);
      expect(workspace.paneForItem(item)).toBe(sourcePane);
      expect(sourcePane.getPendingItem()).toBe(item);
      expect(workspace.paneForItem(owned)).toBe(targetPane);
      expect(item.destroy).not.toHaveBeenCalled();
      expect(owned.destroy).not.toHaveBeenCalled();
    });
  }

  it("aborts immediately and disposes a provider result that arrives after cancellation", async () => {
    let finish;
    const copy = viewItem();
    item.copy = ({ signal }) => {
      item.copySignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const controller = new AbortController();
    const operation = workspace.copyPaneItem(item, {
      splitDirection: "down",
      signal: controller.signal,
    });
    controller.abort();
    await expectAsync(operation).toBeRejectedWith(jasmine.objectContaining({ code: "ABORT_ERR" }));
    expect(item.copySignal.aborted).toBe(true);
    finish(copy);
    await Promise.resolve();
    expect(copy.destroy).toHaveBeenCalled();
    expect(workspace.getCenter().getPanes().length).toBe(2);
  });

  it("cancels URI A to B to A navigation even though the URI string returns", async () => {
    let finish;
    item.copy = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const operation = workspace.copyPaneItem(item, { splitDirection: "down" });
    item.navigate("test://other");
    item.navigate("test://item");
    await expectAsync(operation).toBeRejectedWith(jasmine.objectContaining({ code: "ABORT_ERR" }));
    finish(viewItem());
    await Promise.resolve();
    expect(workspace.getCenter().getPanes().length).toBe(2);
  });

  it("observes cancellation that occurs synchronously inside a copy factory", async () => {
    let finish;
    item.copy = () => {
      item.navigate("test://replaced");
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const operation = workspace.copyPaneItem(item, { splitDirection: "down" });
    await expectAsync(operation).toBeRejectedWith(jasmine.objectContaining({ code: "ABORT_ERR" }));
    finish(viewItem());
    await Promise.resolve();
    expect(workspace.getCenter().getPanes().length).toBe(2);
  });

  it("does not steal focus when an asynchronous copy finishes after navigation elsewhere", async () => {
    let finish;
    item.copy = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const operation = workspace.copyPaneItem(item, { splitDirection: "down" });
    targetPane.activate();
    finish(viewItem());
    const result = await operation;
    expect(workspace.getActivePane()).toBe(targetPane);
    expect(workspace.paneForItem(result.item)).toBe(result.pane);
  });

  it("preserves the user's selected destination item after an asynchronous copy", async () => {
    let finish;
    item.copy = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const operation = workspace.copyPaneItem(item, { targetPane });
    const selected = viewItem({ uri: "test://selected" });
    targetPane.activateItem(selected, { activatePane: true });
    finish(viewItem());
    const result = await operation;
    expect(targetPane.getActiveItem()).toBe(selected);
    expect(targetPane.getItems()).toContain(result.item);
    expect(workspace.getActivePane()).toBe(targetPane);
  });

  it("terminates provider preview navigation after committing without cancelling its own copy", async () => {
    sourcePane.setPendingItem(item);
    item.terminatePendingState = jasmine
      .createSpy("terminatePendingState")
      .and.callFake(() => item.navigate(item.getURI()));
    const result = await workspace.copyPaneItem(item, { splitDirection: "down" });
    expect(result.pane.getActiveItem()).toBe(result.item);
    expect(item.terminatePendingState).toHaveBeenCalled();
    expect(sourcePane.getPendingItem()).toBeNull();
  });

  it("targets the containing pane item when dispatch comes from an embedded editor", async () => {
    const embedded = workspace.buildTextEditor({ mini: true });
    item.element.appendChild(embedded.getElement());
    targetPane.activate();
    await lumine.commands.dispatch(embedded.getElement(), "pane:move-active-item-right");
    expect(workspace.paneForItem(item)).toBe(targetPane);
    expect(workspace.paneForItem(embedded)).toBeUndefined();
    embedded.destroy();
  });

  it("dispatches split from the workspace when the native menu has no pane target", async () => {
    await lumine.commands.dispatch(workspace.getElement(), "pane:split-down-and-copy-active-item");
    expect(workspace.getCenter().getPanes().length).toBe(3);
    expect(workspace.getActivePaneItem()).not.toBe(item);
  });

  it("selects a permitted directional destination past a forbidden dock", async () => {
    const bottom = workspace.getBottomDock();
    bottom.show();
    const allowed = sourcePane.splitDown({ activate: false });
    const element = workspace.getElement();
    spyOn(element, "boundingBoxForPaneView").and.callFake((view) => {
      const pane = view.getModel();
      const y = pane === sourcePane ? 0 : pane === bottom.getActivePane() ? 1 : 2;
      return {
        left: { x: 0, y },
        right: { x: 1, y },
        top: { x: 0, y },
        bottom: { x: 0, y: y + 1 },
      };
    });
    await lumine.commands.dispatch(item.element, "pane:move-active-item-down");
    expect(workspace.paneForItem(item)).toBe(allowed);
  });

  it("keeps an iframe document alive across move, axis wrapping and collapse", async () => {
    const frame = document.createElement("iframe");
    frame.srcdoc = '<input id="state" value="initial">';
    const loaded = new Promise((resolve) =>
      frame.addEventListener("load", resolve, { once: true }),
    );
    item.element.appendChild(frame);
    await loaded;
    const contentDocument = frame.contentDocument;
    contentDocument.getElementById("state").value = "retained";
    const loads = jasmine.createSpy("loads");
    frame.addEventListener("load", loads);
    await workspace.movePaneItem(item, { targetPane });
    expect(frame.contentDocument).toBe(contentDocument);
    const split = targetPane.splitDown({ activate: false });
    expect(frame.contentDocument).toBe(contentDocument);
    split.destroy();
    expect(frame.contentDocument).toBe(contentDocument);
    expect(contentDocument.getElementById("state").value).toBe("retained");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(loads).not.toHaveBeenCalled();
  });
});
