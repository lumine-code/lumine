describe("block decoration property lifecycle", () => {
  let editor, element, component, additionalEditors;

  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor({ autoHeight: false });
    editor.setText("line with content\n".repeat(30));
    element = component = null;
    additionalEditors = [];
  });

  afterEach(() => {
    editor.destroy();
    for (const model of additionalEditors) model.destroy();
    element?.remove();
  });

  function attach() {
    element = editor.getElement();
    element.style.width = "600px";
    element.style.height = "300px";
    jasmine.attachToDOM(element);
    component = element.getComponent();
    component.updateSync();
  }

  function item(height) {
    const element = document.createElement("div");
    element.style.height = `${height}px`;
    return element;
  }

  function decorate(
    properties,
    marker = editor.markBufferPosition([2, 0], { invalidate: "never" }),
  ) {
    return editor.decorateMarker(marker, properties);
  }

  function rowTop(row) {
    return component.pixelPositionAfterBlocksForRow(row);
  }

  function anotherEditor() {
    const model = lumine.workspace.buildTextEditor({ autoHeight: false });
    model.setText("replacement model\n".repeat(30));
    additionalEditors.push(model);
    return model;
  }

  it("moves a measured block between before and after without changing total height", () => {
    attach();
    const before = rowTop(2);
    const block = item(40);
    const decoration = decorate({ type: "block", position: "before", item: block });
    component.updateSync();
    const totalHeight = component.getScrollHeight();
    expect(rowTop(2)).toBe(before + 40);

    decoration.setProperties({ type: "block", position: "after", item: block });
    component.updateSync();

    expect(rowTop(2)).toBe(before);
    expect(component.getScrollHeight()).toBe(totalHeight);
    expect(component.lineTopIndex.followingBlockIds.has(decoration)).toBe(true);
  });

  it("transfers item measurement and resize ownership and ignores stale observer entries", () => {
    attach();
    const before = rowTop(2);
    const previous = item(40);
    const replacement = item(70);
    const decoration = decorate({ type: "block", position: "before", item: previous });
    component.updateSync();
    const observer = component.blockDecorationResizeObserver;
    spyOn(observer, "observe").and.callThrough();
    spyOn(observer, "unobserve").and.callThrough();

    decoration.setProperties({ type: "block", position: "before", item: replacement });
    component.updateSync();

    expect(rowTop(2)).toBe(before + 70);
    expect(observer.unobserve).toHaveBeenCalledWith(previous);
    expect(observer.observe).toHaveBeenCalledWith(replacement);
    expect(component.blockDecorationsByElement.has(previous)).toBe(false);
    expect(component.blockDecorationElements.has(previous)).toBe(false);
    expect(previous.isConnected).toBe(false);
    expect(replacement.isConnected).toBe(true);

    component.didResizeBlockDecorations([{ target: previous, contentRect: { height: 300 } }]);
    expect(component.blockDecorationsToMeasure.size).toBe(0);
    replacement.style.height = "90px";
    component.didResizeBlockDecorations([{ target: replacement, contentRect: { height: 90 } }]);
    component.updateSync();
    expect(rowTop(2)).toBe(before + 90);
  });

  it("registers blocks introduced through properties and removes them when the type changes", () => {
    attach();
    const before = rowTop(2);
    const block = item(40);
    const decoration = decorate({ type: "line", class: "property-lifecycle" });
    expect(component.blockDecorationStates.has(decoration)).toBe(false);

    decoration.setProperties({ type: "block", position: "before", item: block });
    component.updateSync();
    expect(rowTop(2)).toBe(before + 40);

    decoration.setProperties({ type: "line", class: "property-lifecycle" });
    component.updateSync();
    expect(rowTop(2)).toBe(before);
    expect(component.lineTopIndex.blockEndNodesById.has(decoration)).toBe(false);
    expect(component.blockDecorationElements.has(block)).toBe(false);

    decoration.setProperties({ type: "block", position: "before", item: block });
    component.updateSync();
    expect(rowTop(2)).toBe(before + 40);
    expect(component.blockDecorationStates.size).toBe(1);
  });

  it("registers initial type arrays before a model has a view", () => {
    const block = item(40);
    const decoration = decorate({
      type: ["block", "line"],
      class: "initial-block-type-array",
      position: "before",
      item: block,
    });

    attach();

    expect(rowTop(2)).toBe(2 * component.getLineHeight() + 40);
    expect(component.blockDecorationStates.has(decoration)).toBe(true);
    expect(component.heightsByBlockDecoration.get(decoration)).toBe(40);
  });

  it("restores the latest item and type after marker invalidation and undo", () => {
    attach();
    const layer = editor.addMarkerLayer({ maintainHistory: true });
    const marker = layer.markBufferRange(
      [
        [2, 0],
        [2, 4],
      ],
      { invalidate: "touch" },
    );
    const previous = item(40);
    const replacement = item(70);
    const decoration = decorate({ type: "block", position: "before", item: previous }, marker);
    component.updateSync();

    editor.getBuffer().insert([2, 1], "x");
    component.updateSync();
    expect(marker.isValid()).toBe(false);
    expect(component.lineTopIndex.blockEndNodesById.has(decoration)).toBe(false);
    decoration.setProperties({ type: "block", position: "after", item: replacement });

    editor.undo();
    component.updateSync();
    expect(marker.isValid()).toBe(true);
    expect(component.heightsByBlockDecoration.get(decoration)).toBe(70);
    expect(component.lineTopIndex.followingBlockIds.has(decoration)).toBe(true);
    expect(component.blockDecorationElements.has(previous)).toBe(false);
    expect(component.blockDecorationElements.has(replacement)).toBe(true);

    editor.getBuffer().insert([2, 1], "x");
    decoration.setProperties({ type: "line", class: "invalid-type-change" });
    editor.undo();
    component.updateSync();
    expect(marker.isValid()).toBe(true);
    expect(component.lineTopIndex.blockEndNodesById.has(decoration)).toBe(false);
    expect(component.blockDecorationElements.has(replacement)).toBe(false);
  });

  it("disposes per-decoration listeners and the observer when their owners retire", () => {
    attach();
    const first = decorate({ type: "block", item: item(40) });
    const second = decorate({ type: "block", item: item(30) });
    component.updateSync();
    const firstSubscriptions = component.blockDecorationStates.get(first).subscriptions;
    const secondSubscriptions = component.blockDecorationStates.get(second).subscriptions;
    spyOn(firstSubscriptions, "dispose").and.callThrough();
    spyOn(secondSubscriptions, "dispose").and.callThrough();
    spyOn(component.blockDecorationResizeObserver, "disconnect").and.callThrough();

    first.destroy();
    expect(firstSubscriptions.dispose).toHaveBeenCalledTimes(1);
    expect(component.blockDecorationStates.has(first)).toBe(false);
    expect(component.lineTopIndex.blockEndNodesById.has(first)).toBe(false);

    editor.destroy();
    expect(secondSubscriptions.dispose).toHaveBeenCalledTimes(1);
    expect(component.blockDecorationStates.size).toBe(0);
    expect(component.blockDecorationElements.size).toBe(0);
    expect(component.blockDecorationResizeObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(component.blockDecorationLifetime).toBeNull();
  });

  it("rebinds block ownership when the real editor element changes models", () => {
    attach();
    const oldItem = item(40);
    const previous = decorate({ type: "block", position: "before", item: oldItem });
    component.updateSync();
    const index = component.lineTopIndex;
    const nextModel = anotherEditor();
    const nextItem = item(70);
    const next = nextModel.decorateMarker(nextModel.markBufferPosition([2, 0]), {
      type: "block",
      position: "before",
      item: nextItem,
    });
    let stale;
    const removeAttribute = oldItem.removeAttribute.bind(oldItem);
    spyOn(oldItem, "removeAttribute").and.callFake((name) => {
      removeAttribute(name);
      if (name === "data-block-decoration-selected" && !stale) {
        stale = decorate({ type: "block", item: item(200) });
      }
    });

    element.setModel(nextModel);
    component.updateSync();
    const later = nextModel.decorateMarker(nextModel.markBufferPosition([4, 0]), {
      type: "block",
      position: "before",
      item: item(30),
    });
    component.updateSync();
    previous.getMarker().setHeadBufferPosition([3, 0]);
    editor.destroy();
    component.updateSync();

    expect(component.lineTopIndex).toBe(index);
    expect(component.blockDecorationOwner.model).toBe(nextModel);
    expect(component.blockDecorationStates.has(previous)).toBe(false);
    expect(component.blockDecorationStates.has(stale)).toBe(false);
    expect(component.blockDecorationStates.has(next)).toBe(true);
    expect(component.blockDecorationStates.has(later)).toBe(true);
    expect(rowTop(5)).toBe(5 * component.getLineHeight() + 100);
  });

  it("ignores an old destruction callback copied before a model replacement", () => {
    const nextModel = anotherEditor();
    const next = nextModel.decorateMarker(nextModel.markBufferPosition([2, 0]), {
      type: "block",
      item: item(40),
    });
    // Registered before the component's lifetime listener. Event delivery can
    // still hold that listener after setModel disposes its subscription.
    editor.onDidDestroy(() => element.setModel(nextModel));
    attach();

    editor.destroy();

    expect(element.getModel()).toBe(nextModel);
    expect(component.blockDecorationOwner.model).toBe(nextModel);
    expect(component.blockDecorationStates.has(next)).toBe(true);
    expect(component.lineTopIndex.blockEndNodesById.has(next)).toBe(true);
  });

  it("does not insert a replacement when selection cleanup invalidates its marker", () => {
    attach();
    const layer = editor.addMarkerLayer({ maintainHistory: true });
    const marker = layer.markBufferRange(
      [
        [2, 0],
        [2, 4],
      ],
      { invalidate: "touch" },
    );
    const previous = item(40);
    const replacement = item(70);
    const decoration = decorate({ type: "block", item: previous }, marker);
    component.updateSync();
    const removeAttribute = previous.removeAttribute.bind(previous);
    let invalidated = false;
    spyOn(previous, "removeAttribute").and.callFake((name) => {
      removeAttribute(name);
      if (name === "data-block-decoration-selected" && !invalidated) {
        invalidated = true;
        editor.getBuffer().insert([2, 1], "x");
      }
    });

    decoration.setProperties({ type: "block", item: replacement });
    component.updateSync();

    expect(marker.isValid()).toBe(false);
    expect(component.lineTopIndex.blockEndNodesById.has(decoration)).toBe(false);
    expect(component.blockDecorationElements.has(replacement)).toBe(false);
    editor.undo();
    component.updateSync();
    expect(component.heightsByBlockDecoration.get(decoration)).toBe(70);
  });
});
