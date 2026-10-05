const PaneContainer = require("../src/pane-container");
const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { roundToPhysicalPixelBoundary } = require("../src/text-editor-component-helpers");
const { timeoutPromise } = require("./helpers/async-spec-helpers");

describe("text editor rendering after a split pane closes", () => {
  let container;

  beforeEach(() => {
    jasmine.useRealClock();
    container = new PaneContainer({
      location: "center",
      config: lumine.config,
      applicationDelegate: lumine.applicationDelegate,
      notificationManager: lumine.notifications,
      deserializerManager: lumine.deserializers,
      viewRegistry: lumine.views,
    });
    const element = container.getElement();
    element.style.width = "800px";
    element.style.height = "360px";
    jasmine.attachToDOM(element);
  });

  afterEach(() => {
    container.destroy();
  });

  it("ignores a queued visibility entry from the observer disconnected during pane collapse", async () => {
    const NativeIntersectionObserver = window.IntersectionObserver;
    const callbacks = new WeakMap();
    spyOn(window, "IntersectionObserver").and.callFake(function (callback, options) {
      const observer = new NativeIntersectionObserver(callback, options);
      callbacks.set(observer, callback);
      return observer;
    });

    const survivingPane = container.getActivePane();
    const editor = buildEditor(true);
    survivingPane.addItem(editor);
    const closingPane = survivingPane.splitRight();
    closingPane.addItem(buildEditor(false));
    await timeoutPromise(50);

    const element = editor.getElement();
    const component = element.component;
    editor.setCursorBufferPosition([80, 12]);
    element.setScrollTop(
      component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
        2 * component.getLineHeight(),
    );
    const disconnectedObserver = component.intersectionObserver;
    const deliverQueuedEntry = callbacks.get(disconnectedObserver);
    closingPane.activate();
    closingPane.destroy();
    expect(component.intersectionObserver).not.toBe(disconnectedObserver);
    expectPaintedViewport(editor);

    // disconnect() removes observation targets but does not clear queued
    // entries. A queued zero-intersection entry can arrive after the
    // replacement observer has shown the editor.
    deliverQueuedEntry(
      [{ target: element, intersectionRect: { width: 0, height: 0 }, isIntersecting: false }],
      disconnectedObserver,
    );

    const didScroll = jasmine.createSpy("didScroll");
    const subscription = element.onDidChangeScrollTop(didScroll);
    element.setScrollTop(element.getScrollTop() + 40 * component.getLineHeight());
    subscription.dispose();
    expect(didScroll).toHaveBeenCalled();
    expect(component.renderedScrollTop).toBe(
      roundToPhysicalPixelBoundary(component.getScrollTop()),
    );
    expectPaintedViewport(editor);

    // The replacement observer still owns real hide/reveal transitions.
    const activeObserver = component.intersectionObserver;
    const deliverActiveEntry = callbacks.get(activeObserver);
    element.style.display = "none";
    deliverActiveEntry(
      [{ target: element, intersectionRect: { width: 0, height: 0 }, isIntersecting: false }],
      activeObserver,
    );
    expect(component.visible).toBe(false);
    element.style.display = "";
    deliverActiveEntry(
      [
        {
          target: element,
          intersectionRect: element.getBoundingClientRect(),
          isIntersecting: true,
        },
      ],
      activeObserver,
    );
    expectPaintedViewport(editor);
  });

  for (const [splitMethod, orientation] of [
    ["splitRight", "horizontal"],
    ["splitDown", "vertical"],
  ]) {
    for (const survivorIndex of [0, 1]) {
      for (const softWrapped of [false, true]) {
        it(`keeps the ${survivorIndex === 0 ? "first" : "second"} editor painted after a ${orientation} split closes${softWrapped ? " with soft wrap" : ""}`, async () => {
          const firstPane = container.getActivePane();
          const firstEditor = buildEditor(softWrapped);
          firstPane.addItem(firstEditor);
          const secondPane = firstPane[splitMethod]();
          const secondEditor = buildEditor(softWrapped);
          secondPane.addItem(secondEditor);
          await timeoutPromise(50);

          const panes = [firstPane, secondPane];
          const editors = [firstEditor, secondEditor];
          const survivingPane = panes[survivorIndex];
          const editor = editors[survivorIndex];
          const element = editor.getElement();
          const component = element.component;

          survivingPane.activate();
          editor.setCursorBufferPosition([80, 12]);
          element.setScrollTop(
            component.pixelPositionBeforeBlocksForRow(editor.getCursorScreenPosition().row) -
              2 * component.getLineHeight(),
          );
          expect(element.getScrollTop()).toBeGreaterThan(0);
          expectPaintedViewport(editor);

          const closingPane = panes[1 - survivorIndex];
          closingPane.activate();
          closingPane.destroy();

          expect(container.getPanes()).toEqual([survivingPane]);
          expect(container.getRoot()).toBe(survivingPane);
          expectPaintedViewport(editor);

          // Include observer delivery and browser focus scrolling after the
          // synchronous detach/reparent/attach sequence has completed.
          await timeoutPromise(50);
          expectPaintedViewport(editor);

          element.setScrollTop(element.getScrollTop() + 8 * component.getLineHeight());
          expectPaintedViewport(editor);
        });
      }
    }
  }
});

function buildEditor(softWrapped) {
  const buffer = new TextBuffer({
    text: Array.from(
      { length: 240 },
      (_, row) => `line ${row + 1}: ${"rendered text ".repeat(12)}`,
    ).join("\n"),
  });
  const editor = new TextEditor({
    buffer,
    autoHeight: false,
    autoWidth: false,
    softWrapped,
    showLineNumbers: true,
  });
  editor.getElement().component.updatedSynchronously = true;
  return editor;
}

function expectPaintedViewport(editor) {
  const element = editor.getElement();
  const component = element.component;
  const viewport = component.refs.clientContainer.getBoundingClientRect();
  expect(element.isConnected).toBe(true);
  expect(component.attached).toBe(true);
  expect(component.visible).toBe(true);
  expect(component.getClientContainerWidth()).toBe(component.refs.clientContainer.offsetWidth);
  expect(component.getClientContainerHeight()).toBe(component.refs.clientContainer.offsetHeight);
  expect(viewport.width).toBeGreaterThan(0);
  expect(viewport.height).toBeGreaterThan(0);
  expect(element.getScrollTop()).toBeGreaterThan(0);

  const screenRow = Math.min(component.getFirstVisibleRow() + 1, editor.getLastScreenRow());
  const line = element.querySelector(`.line[data-screen-row="${screenRow}"]`);
  const lineNumber = element.querySelector(`.line-number[data-screen-row="${screenRow}"]`);
  expect(line).not.toBeNull();
  expect(lineNumber).not.toBeNull();
  if (line && lineNumber) {
    expect(line.textContent).toBe(editor.lineTextForScreenRow(screenRow));
    for (const node of [line, lineNumber]) {
      const rect = node.getBoundingClientRect();
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.bottom).toBeGreaterThan(viewport.top);
      expect(rect.top).toBeLessThan(viewport.bottom);
    }
  }
}
