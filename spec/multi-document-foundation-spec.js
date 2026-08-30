const ElementRegistry = require("../src/element-registry");
const StyleManager = require("../src/style-manager");
const ViewRegistry = require("../src/view-registry");
const { activeElementFor, documentFor, isElement, windowFor } = require("../src/dom-context");
const { loadScript } = require("../src/dom-context");
const path = require("path");
const { WindowSurface, WindowSurfaceManager } = require("../src/window-surface");

describe("the multi-document workspace foundation", () => {
  let frame, otherWindow, otherDocument;

  beforeEach(() => {
    frame = document.createElement("iframe");
    document.body.appendChild(frame);
    otherWindow = frame.contentWindow;
    otherDocument = frame.contentDocument;
  });

  afterEach(() => frame.remove());

  it("derives DOM constructors and context from an element's own realm", () => {
    const element = otherDocument.createElement("div");
    expect(documentFor(element)).toBe(otherDocument);
    expect(windowFor(element)).toBe(otherWindow);
    expect(isElement(element)).toBe(true);
    expect(activeElementFor(element)).toBe(otherDocument.body);
  });

  it("defines a distinct custom-element constructor in each Window", () => {
    const registry = new ElementRegistry();
    registry.define(
      "test-surface-element",
      ({ HTMLElement }) => class TestSurfaceElement extends HTMLElement {},
    );
    registry.addWindow(window);
    registry.addWindow(otherWindow);

    const primaryConstructor = window.customElements.get("test-surface-element");
    const otherConstructor = otherWindow.customElements.get("test-surface-element");
    expect(primaryConstructor).toBeDefined();
    expect(otherConstructor).toBeDefined();
    expect(otherConstructor).not.toBe(primaryConstructor);
    expect(otherDocument.createElement("test-surface-element") instanceof otherConstructor).toBe(
      true,
    );
    registry.destroy();
  });

  it("installs every core custom element in the secondary Window's realm", () => {
    const registration = lumine.elements.addWindow(otherWindow);
    for (const name of [
      "lumine-pane-container",
      "lumine-pane-axis",
      "lumine-pane",
      "lumine-pane-resize-handle",
      "lumine-panel-container",
      "lumine-styles",
      "lumine-text-editor",
      "lumine-workspace",
    ]) {
      const Constructor = otherWindow.customElements.get(name);
      expect(Constructor).toBeDefined();
      expect(otherDocument.createElement(name) instanceof otherWindow.HTMLElement).toBe(true);
    }
    const workspace = otherDocument.createElement("lumine-workspace");
    expect(() => otherDocument.body.appendChild(workspace)).not.toThrow();
    registration.dispose();
  });

  it("mounts and updates styles using elements from the target Document", () => {
    const styles = new StyleManager();
    styles.initialize({ configDirPath: "" });
    const source = styles.addStyleSheet(".surface { color: red; }", {
      sourcePath: "surface.css",
    });
    const mount = styles.mount(otherDocument);
    const mounted = otherDocument.head.querySelector('style[source-path="surface.css"]');
    expect(mounted.ownerDocument).toBe(otherDocument);
    expect(mounted.textContent).toContain("red");

    const update = styles.addStyleSheet(".surface { color: blue; }", {
      sourcePath: "surface.css",
    });
    expect(mounted.textContent).toContain("blue");

    update.dispose();
    expect(otherDocument.head.querySelector('style[source-path="surface.css"]')).toBeNull();
    source.dispose();
    mount.dispose();
  });

  it("recognizes views created in another Window", () => {
    const views = new ViewRegistry({});
    const element = otherDocument.createElement("div");
    expect(views.getView(element)).toBe(element);
  });

  it("recognizes wrapped views adopted from another Window", () => {
    const views = new ViewRegistry({});
    const element = document.createElement("div");
    otherDocument.adoptNode(element);

    expect(element.ownerDocument).toBe(otherDocument);
    expect(element instanceof otherWindow.Element).toBe(false);
    expect(isElement(element)).toBe(true);
    expect(views.getView({ element })).toBe(element);
  });

  it("tracks the active surface independently of the logical workspace", () => {
    const manager = new WindowSurfaceManager();
    const primary = manager.add(
      new WindowSurface({ id: "primary", kind: "primary", window, document }),
    );
    const detached = manager.add(
      new WindowSurface({
        id: "detached",
        kind: "detached",
        window: otherWindow,
        document: otherDocument,
      }),
    );
    expect(manager.getPrimary()).toBe(primary);
    expect(manager.surfaceFor(otherDocument.body)).toBe(detached);

    otherWindow.dispatchEvent(new otherWindow.Event("focus"));
    expect(manager.getActive()).toBe(detached);

    manager.activate(primary);
    const input = otherDocument.createElement("input");
    otherDocument.body.appendChild(input);
    input.focus();
    expect(manager.getActive()).toBe(detached);
    manager.destroy();
  });

  it("loads and caches a UMD-style script in the target Window only", async () => {
    const source = path.join(__dirname, "fixtures", "realm-script.js");
    const first = await loadScript(otherDocument, source, { global: "__realmScriptLoads" });
    const second = await loadScript(otherDocument, source, { global: "__realmScriptLoads" });
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(otherWindow.__realmScriptLoads).toBe(1);
    expect(window.__realmScriptLoads).toBeUndefined();
  });
});
