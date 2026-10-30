const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");

const baselineDirectory = process.env.LUMINE_OVERLAY_BENCHMARK_BASELINE;
const baseline = !!baselineDirectory;
const sourceDirectory = path.join(__dirname, "..", "src");
const coreRequire = createRequire(path.join(sourceDirectory, "scrollbar-manager.js"));
const sourceHashes = Object.fromEntries(
  ["overlay-scrollbar", "scrollbar-manager"].map((name) => [
    name,
    createHash("sha256")
      .update(fs.readFileSync(path.join(baselineDirectory || sourceDirectory, `${name}.js`)))
      .digest("hex"),
  ]),
);
let runtime;

// A local frozen source snapshot uses the same Electron, DOM, core scheduler,
// services and fixtures as production. No alternate scrollbar implementation.
function loadFrozen(name) {
  const filename = path.join(baselineDirectory, `${name}.js`);
  const source = fs.readFileSync(filename, "utf8");
  const exported = { exports: {} };
  const compile = vm.runInThisContext(
    `(function(exports, require, module, __filename, __dirname) {\n${source}\n})`,
    { filename },
  );
  compile(
    exported.exports,
    (request) => (request === "./overlay-scrollbar" ? runtime : coreRequire(request)),
    exported,
    filename,
    sourceDirectory,
  );
  return exported.exports;
}

runtime = baseline ? loadFrozen("overlay-scrollbar") : require("../src/overlay-scrollbar");
const ScrollbarManager = baseline
  ? loadFrozen("scrollbar-manager")
  : require("../src/scrollbar-manager");
const results = [];
const chromeStyle = fs.readFileSync(
  path.join(__dirname, "..", "static", "core-ui", "scrollbars.css"),
  "utf8",
);

function record(scenario, counts) {
  const value = { scenario, ...counts };
  results.push(value);
  console.log(`OVERLAY_SCROLLBAR_BENCHMARK ${JSON.stringify({ baseline, ...value })}`);
}

describe("Overlay scrollbar work budgets", () => {
  let frame, document, manager, dom, widgets;

  const flush = () =>
    new Promise((resolve) => lumine.views.readDocument(() => lumine.views.updateDocument(resolve)));
  async function settle() {
    for (let index = 0; index < 3; index++) {
      await flush();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await flush();
  }

  beforeEach(() => {
    jasmine.useRealClock();
    widgets = [];
    frame = window.document.createElement("iframe");
    frame.style.cssText = "width:600px;height:400px;border:0";
    jasmine.attachToDOM(frame);
    document = frame.contentDocument;
    document.body.style.margin = "0";
    const style = document.createElement("style");
    style.textContent = chromeStyle + "\n.marker { background: red; min-height: 1px; }";
    document.head.appendChild(style);
    manager = new ScrollbarManager({ views: lumine.views, themes: lumine.themes });
    dom = manager.forDocument(document);
  });

  afterEach(() => {
    for (const widget of widgets) widget.destroy();
    manager.destroy();
    frame.remove();
  });

  afterAll(() => {
    const output = process.env.LUMINE_OVERLAY_BENCHMARK_OUTPUT;
    if (output)
      fs.writeFileSync(
        output,
        JSON.stringify(
          {
            baseline,
            source: baselineDirectory || sourceDirectory,
            sourceHashes,
            electron: process.versions.electron,
            results,
          },
          null,
          2,
        ) + "\n",
      );
  });

  function fixture({ overflow = "auto" } = {}) {
    const host = document.createElement("div");
    host.style.cssText = "position:relative;width:400px;height:180px";
    const element = document.createElement("div");
    element.style.cssText = `width:100%;height:100%;overflow:${overflow}`;
    const content = document.createElement("div");
    content.style.cssText = "width:1200px;height:20000px";
    element.appendChild(content);
    host.appendChild(element);
    document.body.appendChild(host);
    return { host, element, content };
  }

  async function bindMap(element) {
    // This integration benchmark runs against the flat workspace sources,
    // including the optional scrollmap package absent from a core-only install.
    await lumine.packages.activatePackage(path.join(__dirname, "..", "..", "marker"));
    const pack = await lumine.packages.activatePackage(
      path.join(__dirname, "..", "..", "scrollmap"),
    );
    const style = document.createElement("style");
    style.textContent = fs.readFileSync(path.join(pack.path, "styles", "main.css"), "utf8");
    document.head.appendChild(style);
    for (const name of ["getGeometry", "getVerticalTrack", "observe"]) {
      const original = lumine.scrollbars[name].bind(lumine.scrollbars);
      spyOn(lumine.scrollbars, name).and.callFake((target, ...args) =>
        target.ownerDocument === document
          ? manager[name](target, ...args)
          : original(target, ...args),
      );
    }
    const Widget = pack.mainModule.provideScrollmapWidget();
    const widget = new Widget({ scrollElement: element });
    widgets.push(widget);
    widget.setItems([{ prc: 5, end: 15 }, { prc: 50 }]);
    return widget;
  }

  it("handles 1000 scroll events without discovery, geometry reads or marker paints", async () => {
    const { element } = fixture();
    const controller = manager.attach(element);
    const callback = jasmine.createSpy("geometry publication");
    const observation = manager.observe(element, callback);
    const widget = await bindMap(element);
    await settle();
    callback.calls.reset();
    const scan = spyOn(dom, "scan").and.callThrough();
    const read = spyOn(controller, "read").and.callThrough();
    const draw = spyOn(widget.canvas, "draw").and.callThrough();
    const start = performance.now();
    for (let index = 0; index < 1000; index++) {
      element.scrollTop = (index * 17) % 19000;
      element.dispatchEvent(new frame.contentWindow.Event("scroll"));
    }
    const dispatchMs = performance.now() - start;
    await settle();
    const counts = {
      events: 1000,
      discoveryScans: scan.calls.count(),
      geometryReads: read.calls.count(),
      markerPaints: draw.calls.count(),
      geometryNotifications: callback.calls.count(),
      dispatchMs,
    };
    record("scroll", counts);
    expect(counts.discoveryScans).toBe(0);
    expect(counts.geometryReads).toBe(0);
    expect(counts.markerPaints).toBe(0);
    expect(counts.geometryNotifications).toBe(0);
    expect(controller.vertical.metrics.position).toBe(element.scrollTop);
    observation.dispose();
  });

  it("does not notify maps or invalidate layout for unchanged cached getters", async () => {
    const { element } = fixture();
    const controller = manager.attach(element);
    const callback = jasmine.createSpy("geometry publication");
    const observation = manager.observe(element, callback);
    await settle();
    callback.calls.reset();
    const invalidate = spyOn(dom, "invalidate").and.callThrough();
    const read = spyOn(controller, "read").and.callThrough();
    for (let index = 0; index < 1000; index++) {
      manager.getVerticalTrack(element);
      manager.getGeometry(element);
    }
    await settle();
    record("cached-getters", {
      calls: 1000,
      invalidations: invalidate.calls.count(),
      geometryReads: read.calls.count(),
      geometryNotifications: callback.calls.count(),
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    for (let index = 0; index < 1000; index++) controller.refresh();
    await settle();
    record("unchanged-invalidation", {
      requests: 1000,
      geometryReads: read.calls.count(),
      geometryNotifications: callback.calls.count(),
    });
    expect(read.calls.count()).toBe(1);
    expect(callback).not.toHaveBeenCalled();
    expect(Object.keys(manager.getGeometry(element))).not.toContain("parent");
    expect(Object.keys(manager.getGeometry(element))).not.toContain("clip");
    observation.dispose();
  });

  it("prunes 5000 token nodes before discovery visits their subtree", async () => {
    const editor = document.createElement("lumine-text-editor");
    const tokens = document.createDocumentFragment();
    for (let index = 0; index < 5000; index++) {
      const token = document.createElement("div");
      token.dataset.overlayBenchmarkToken = "";
      tokens.appendChild(token);
    }
    editor.appendChild(tokens);
    document.body.appendChild(editor);
    await settle();
    const closest = spyOn(frame.contentWindow.Element.prototype, "closest").and.callThrough();
    const styles = spyOn(frame.contentWindow, "getComputedStyle").and.callThrough();
    const start = performance.now();
    dom.scan(document.body);
    const discoveryMs = performance.now() - start;
    const tokenVisits = closest.calls
      .all()
      .filter((call) => call.object.hasAttribute("data-overlay-benchmark-token")).length;
    const tokenStyles = styles.calls
      .allArgs()
      .filter(([element]) => element.hasAttribute("data-overlay-benchmark-token")).length;
    record("token-discovery", { tokens: 5000, tokenVisits, tokenStyles, discoveryMs });
    if (!baseline) expect(tokenVisits).toBe(0);
    expect(tokenStyles).toBe(0);
    expect(dom.controllers.has(editor)).toBe(false);
  });

  it("batches descendant mutations without reobserving unchanged direct children", async () => {
    const { element, content } = fixture();
    const controller = manager.attach(element);
    await settle();
    const rebind = spyOn(controller, "observeChildren").and.callThrough();
    const read = spyOn(controller, "read").and.callThrough();
    for (let index = 0; index < 100; index++) content.appendChild(document.createElement("span"));
    await settle();
    record("descendant-mutations", {
      records: 100,
      observerRebinds: rebind.calls.count(),
      geometryReads: read.calls.count(),
    });
    if (!baseline) {
      expect(rebind).not.toHaveBeenCalled();
      expect(read.calls.count()).toBe(1);
    }
  });

  it("discovers class-driven overflow and refreshes an existing track's policy", async () => {
    const { element } = fixture({ overflow: "visible" });
    element.dataset.scrollbar = "hover";
    const style = document.createElement("style");
    style.textContent = ".benchmark-scrollable { overflow: auto !important; }";
    document.head.appendChild(style);
    await settle();
    expect(dom.controllers.has(element)).toBe(false);
    element.classList.add("benchmark-scrollable");
    await settle();
    const controller = dom.controllers.get(element);
    if (!baseline) expect(controller.layer.classList.contains("is-persistent")).toBe(false);
    element.dataset.scrollbar = "always";
    await settle();
    const persistent = !!controller?.layer.classList.contains("is-persistent");
    record("attribute-discovery", { discovered: !!controller, persistent });
    if (!baseline) {
      expect(controller).toBeDefined();
      expect(persistent).toBe(true);
      element.classList.add("another-class");
      element.dataset.scrollbar = "none";
      await settle();
      expect(controller.destroyed).toBe(true);
      expect(dom.controllers.has(element)).toBe(false);
    }
  });

  it("remounts a same-size surface after a same-document move", async () => {
    const { host, element } = fixture();
    const controller = manager.attach(element);
    await settle();
    const next = host.cloneNode(false);
    document.body.appendChild(next);
    next.appendChild(element);
    await settle();
    const remounted = controller.layer.parentNode === next;
    record("same-document-move", {
      remounted,
      width: controller.geometry.viewportWidth,
      height: controller.geometry.viewportHeight,
    });
    if (!baseline) expect(remounted).toBe(true);
  });

  it("refreshes overflow when text changes inside a fixed-size child", async () => {
    const { element, content } = fixture();
    content.style.width = "400px";
    content.style.whiteSpace = "nowrap";
    const text = document.createTextNode("short");
    content.appendChild(text);
    manager.attach(element);
    await settle();
    const before = manager.getGeometry(element).scrollWidth;
    text.data = "W".repeat(5000);
    await settle();
    const after = manager.getGeometry(element).scrollWidth;
    record("fixed-child-text", { before, after, refreshed: after > before });
    if (!baseline) expect(after).toBeGreaterThan(before);
  });

  it("keeps observing a surface after its controller retires in the same document", async () => {
    const { host, element, content } = fixture();
    const first = manager.attach(element);
    const release = spyOn(first.callbacks, "delete").and.callThrough();
    const callback = jasmine.createSpy("replacement geometry");
    const observation = manager.observe(element, callback);
    await settle();
    element.remove();
    await settle();
    expect(first.destroyed).toBe(true);
    host.appendChild(element);
    await settle();
    const next = dom.controllers.get(element);
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
    callback.calls.reset();
    content.style.height = "21000px";
    next.refresh();
    await settle();
    const notified = callback.calls.allArgs().some(([geometry]) => geometry.scrollHeight === 21000);
    record("same-document-controller-replacement", {
      notified,
      geometryNotifications: callback.calls.count(),
      retiredEdgeReleased: release.calls.count() > 0,
    });
    if (!baseline) {
      expect(notified).toBe(true);
      expect(release).toHaveBeenCalled();
    }
    observation.dispose();
  });

  it("jumps synchronously even when authored scrolling is smooth", async () => {
    const { element } = fixture();
    element.style.scrollBehavior = "smooth";
    const controller = manager.attach(element);
    await settle();
    const bounds = controller.vertical.element.getBoundingClientRect();
    controller.vertical.element.dispatchEvent(
      new frame.contentWindow.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: bounds.left + 5,
        clientY: bounds.top + bounds.height / 2,
      }),
    );
    const immediateOffset = element.scrollTop;
    const wantedOffset = controller.vertical.metrics.position;
    record("smooth-authored-track-jump", { immediateOffset, wantedOffset });
    if (!baseline) {
      expect(immediateOffset).toBeGreaterThan(0);
      expect(Math.abs(immediateOffset - wantedOffset)).toBeLessThan(1);
    }
    controller.vertical.endDrag();
  });
});
