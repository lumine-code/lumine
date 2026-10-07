const Pane = require("../src/pane");
const PaneContainer = require("../src/pane-container");
const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("pane text editor sizing", () => {
  let workspaceElement, originalStyle, editors, subscriptions, containers;

  beforeEach(() => {
    jasmine.useRealClock();
    editors = [];
    subscriptions = [];
    containers = [];
    workspaceElement = lumine.workspace.getElement();
    originalStyle = workspaceElement.style.cssText;
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "360px";
    jasmine.attachToDOM(workspaceElement);
  });

  afterEach(() => {
    for (const subscription of subscriptions) subscription.dispose();
    for (const editor of editors) editor.destroy();
    for (const container of containers) container.destroy();
    workspaceElement.style.cssText = originalStyle;
  });

  function buildEditor(params) {
    const editor = lumine.workspace.buildTextEditor(params);
    editor.setText(Array.from({ length: 240 }, (_, row) => `line ${row + 1}`).join("\n"));
    editor.update({ smoothScrolling: false });
    editors.push(editor);
    return editor;
  }

  function createContainer(location = "center") {
    const container = new PaneContainer({
      location,
      config: lumine.config,
      applicationDelegate: lumine.applicationDelegate,
      notificationManager: lumine.notifications,
      deserializerManager: lumine.deserializers,
      viewRegistry: lumine.views,
    });
    containers.push(container);
    const element = container.getElement();
    element.style.width = "800px";
    element.style.height = "360px";
    jasmine.attachToDOM(element);
    return container;
  }

  async function expectWheelScroll(editor) {
    await conditionPromise(() => {
      // Flush measurements even when an occluded test window pauses frames.
      lumine.views.performDocumentUpdate();
      const element = editor.getElement();
      const component = element.component;
      const client = component.refs.clientContainer;
      return (
        element.isConnected &&
        component.hasInitialMeasurements &&
        client.offsetHeight > 0 &&
        component.getClientContainerHeight() === client.offsetHeight
      );
    }, "pane editor measurements");

    const element = editor.getElement();
    const component = element.component;
    editor.update({ smoothScrolling: false });
    expect(component.getScrollContainerClientHeight()).toBeLessThan(component.getContentHeight());
    expect(component.getMaxScrollTop()).toBeGreaterThan(0);
    const initialScrollTop = element.getScrollTop();
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }),
    );
    expect(element.getScrollTop()).toBeGreaterThan(initialScrollTop);
    expect(component.renderedScrollTop).toBeGreaterThan(initialScrollTop);
  }

  it("scrolls a built untitled editor opened as an existing model", async () => {
    const editor = buildEditor();
    expect(editor.getAutoHeight()).toBe(true);
    expect(await lumine.workspace.open(editor)).toBe(editor);
    expect(editor.getPath()).toBeUndefined();
    await expectWheelScroll(editor);
  });

  it("scrolls a text editor returned by a custom URI opener", async () => {
    const editor = buildEditor();
    subscriptions.push(
      lumine.workspace.addOpener((uri) => {
        if (uri === "pane-sizing://generated") return editor;
      }),
    );
    expect(await lumine.workspace.open("pane-sizing://generated")).toBe(editor);
    await expectWheelScroll(editor);
  });

  it("scrolls an editor added directly to a pane before observers see it", async () => {
    const editor = buildEditor();
    const pane = lumine.workspace.getActivePane();
    const observedAutoHeight = [];
    subscriptions.push(
      pane.onDidAddItem(({ item }) => observedAutoHeight.push(item.getAutoHeight())),
    );
    pane.addItem(editor);
    expect(observedAutoHeight).toEqual([false]);
    await expectWheelScroll(editor);
  });

  it("scrolls a built editor supplied when constructing a split pane", async () => {
    const editor = buildEditor();
    const pane = lumine.workspace.getActivePane().splitRight({ items: [editor] });
    expect(pane.getActiveItem()).toBe(editor);
    await expectWheelScroll(editor);
  });

  it("scrolls an editor copied from a detached editor when opened in a pane", async () => {
    const source = buildEditor();
    const copy = source.copy();
    editors.push(copy);
    copy.update({ smoothScrolling: false });
    expect(source.getAutoHeight()).toBe(true);
    await lumine.workspace.open(copy);
    await expectWheelScroll(copy);
    expect(source.getAutoHeight()).toBe(true);
  });

  it("scrolls a direct text editor in a dock's pane container", async () => {
    const editor = buildEditor();
    const container = createContainer("bottom");
    container.getActivePane().addItem(editor);
    await expectWheelScroll(editor);
  });

  it("scrolls a restored pane editor whose saved sizing option was unspecified", async () => {
    const source = buildEditor();
    const editorState = source.serialize();
    const bufferState = source.getBuffer().serialize();
    source.destroy();
    const buffer = await TextBuffer.deserialize(bufferState);
    const deserializers = {
      deserialize(state) {
        const editor = TextEditor.deserialize(state, {
          assert: lumine.assert.bind(lumine),
          project: { bufferForIdSync: () => buffer },
        });
        editors.push(editor);
        return editor;
      },
    };
    const pane = Pane.deserialize(
      { items: [editorState], activeItemIndex: 0 },
      {
        deserializers,
        applicationDelegate: lumine.applicationDelegate,
        config: lumine.config,
        notifications: lumine.notifications,
        views: lumine.views,
      },
    );
    const container = createContainer();
    container.setRoot(pane);
    const editor = pane.getActiveItem();
    expect(editor.getText()).toContain("line 240");
    await expectWheelScroll(editor);
  });

  for (const autoHeight of [true, false]) {
    it(`preserves an explicitly ${autoHeight ? "content" : "viewport"}-sized pane editor`, () => {
      const editor = buildEditor({ autoHeight });
      lumine.workspace.getActivePane().addItem(editor);
      expect(editor.getAutoHeight()).toBe(autoHeight);
    });
  }

  it("keeps mini editors content-sized when they are added directly", () => {
    const editor = buildEditor({ mini: true });
    lumine.workspace.getActivePane().addItem(editor);
    expect(editor.isMini()).toBe(true);
    expect(editor.getAutoHeight()).toBe(true);
  });

  it("keeps an editor embedded within a composite pane item content-sized", () => {
    const editor = buildEditor();
    const item = document.createElement("div");
    item.appendChild(editor.getElement());
    lumine.workspace.getActivePane().addItem(item);
    expect(editor.getAutoHeight()).toBe(true);
    expect(editor.getElement().parentNode).toBe(item);
  });
});
