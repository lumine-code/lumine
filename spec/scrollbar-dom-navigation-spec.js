const path = require("node:path");
const fs = require("node:fs");
const { ipcRenderer } = require("electron");
const { DOMScrollbarManager } = require("../src/overlay-scrollbar");

describe("DOM scrollbar navigation", () => {
  let element, content, controller, binding, originalKeys;

  beforeEach(() => {
    spyOn(window.performance, "now").and.callFake(() => Date.now());
    element = document.createElement("div");
    element.tabIndex = -1;
    element.dataset.scrollbarKind = "panel";
    element.style.cssText = "position:fixed;left:-1000px;width:240px;height:140px;overflow:auto";
    content = document.createElement("div");
    content.style.cssText = "width:700px;height:1500px;line-height:20px";
    element.append(content);
    jasmine.attachToDOM(element);
    originalKeys = lumine.keymaps.add(
      "scrollbar-dom-navigation-core-spec",
      lumine.keymaps.readKeymap(
        path.join(lumine.application.getResourcePath(), "keymaps", "base.json"),
      ),
    );
    binding = lumine.scrollbars.bindNavigation(element);
    controller = lumine.scrollbars.documents.get(document).controllers.get(element);
    for (let pass = 0; pass < 3; pass++) controller.write(controller.read());
    controller.activity.clear();
  });

  afterEach(() => {
    binding.dispose();
    originalKeys.dispose();
    controller.dispose();
    element.remove();
  });

  function revealed() {
    return controller.activity.active;
  }

  it("owns line, page, edge and horizontal commands with boundary activity", async () => {
    for (const command of ["core:move-up", "core:page-up", "core:move-to-top"]) {
      await lumine.commands.dispatch(element, command);
      expect(element.scrollTop).toBe(0);
      expect(revealed()).toBeTrue();
      controller.activity.clear();
    }
    await lumine.commands.dispatch(element, "core:move-down");
    const line = element.scrollTop;
    expect(line).toBeGreaterThan(0);
    await lumine.commands.dispatch(element, "core:page-down");
    expect(element.scrollTop).toBeGreaterThan(line);
    await lumine.commands.dispatch(element, "core:move-to-bottom");
    expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
    await lumine.commands.dispatch(element, "core:move-right");
    expect(element.scrollLeft).toBeGreaterThan(0);
    await lumine.commands.dispatch(element, "core:move-left");
    expect(element.scrollLeft).toBe(0);
  });

  it("leaves controls, editable descendants and custom selection widgets to their handlers", () => {
    for (const tag of ["input", "textarea", "select", "button", "a", "summary"]) {
      const control = document.createElement(tag);
      content.append(control);
      expect(lumine.commands.canDispatch(control, "core:page-down")).toBeFalse();
      control.remove();
    }
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const child = document.createElement("span");
    editable.append(child);
    content.append(editable);
    expect(lumine.commands.canDispatch(child, "core:page-down")).toBeFalse();
    editable.remove();
    for (const role of [
      "listbox",
      "tree",
      "grid",
      "menu",
      "button",
      "checkbox",
      "slider",
      "tab",
      "switch checkbox",
    ]) {
      const widget = document.createElement("div");
      widget.setAttribute("role", role);
      content.append(widget);
      expect(lumine.commands.canDispatch(widget, "core:page-down")).toBeFalse();
      widget.remove();
    }
    expect(revealed()).toBeFalse();
  });

  it("does not claim a nested managed scrollport or change text selection", async () => {
    const inner = document.createElement("div");
    inner.style.cssText = "width:100px;height:60px;overflow:auto";
    inner.textContent = "read-only text";
    content.append(inner);
    const nested = lumine.scrollbars.attach(inner, { layout: "gutter" });
    try {
      expect(lumine.commands.canDispatch(inner, "core:page-down")).toBeFalse();
      const range = document.createRange();
      range.selectNodeContents(inner);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      const selected = window.getSelection().toString();
      await lumine.commands.dispatch(element, "core:page-down");
      expect(window.getSelection().toString()).toBe(selected);
    } finally {
      window.getSelection().removeAllRanges();
      nested.dispose();
    }
  });

  it("keeps the first navigation intent after adoption before the destination layout scan", async () => {
    content.style.width = "100px";
    for (let pass = 0; pass < 3; pass++) controller.write(controller.read());
    const inner = document.createElement("div");
    inner.style.cssText = "width:100px;height:60px;overflow:auto";
    content.append(inner);
    const nested = lumine.scrollbars.attach(inner, { layout: "gutter" });
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-1000px;top:0;width:500px;height:300px";
    jasmine.attachToDOM(frame);
    const targetDocument = frame.contentDocument;
    const targetWindow = frame.contentWindow;
    spyOn(targetWindow.performance, "now").and.callFake(() => Date.now());
    spyOn(targetWindow, "setTimeout").and.callFake((callback, delay) =>
      window.setTimeout(callback, delay),
    );
    spyOn(targetWindow, "clearTimeout").and.callFake((id) => window.clearTimeout(id));
    const style = targetDocument.createElement("style");
    style.textContent = fs.readFileSync(
      path.join(lumine.application.getResourcePath(), "static", "core-ui", "scrollbars.css"),
      "utf8",
    );
    targetDocument.head.append(style);
    const reads = [],
      writes = [];
    const schedule = (queue) => (callback) => {
      const request = { callback, disposed: false };
      queue.push(request);
      return { dispose: () => (request.disposed = true) };
    };
    const destination = new DOMScrollbarManager({
      document: targetDocument,
      scheduleRead: schedule(reads),
      scheduleWrite: schedule(writes),
    });
    lumine.scrollbars.documents.set(targetDocument, destination);
    try {
      targetDocument.adoptNode(element);
      targetDocument.body.append(element);
      element.style.left = "0px";
      expect(destination.controllers.has(element)).toBeFalse();
      expect(lumine.commands.canDispatch(inner, "core:page-down")).toBeFalse();
      const dimensions = ["clientWidth", "clientHeight", "scrollWidth", "scrollHeight"].map(
        (property) => spyOnProperty(element, property, "get").and.callThrough(),
      );
      await lumine.commands.dispatch(element, "core:move-down");
      const adopted = destination.controllers.get(element);
      expect(adopted).toBeDefined();
      expect(dimensions.every((measurement) => measurement.calls.count() === 0)).toBeTrue();
      expect(element.scrollTop).toBeGreaterThan(0);
      if (!adopted) return;
      for (let pass = 0; pass < 8; pass++) {
        await Promise.resolve();
        for (const queue of [reads, writes])
          for (const request of queue.splice(0)) if (!request.disposed) request.callback();
      }
      expect(adopted.activity?.active).toBeTrue();
      expect(adopted.layer.classList.contains("is-revealed")).toBeTrue();
      advanceClock(700);
      expect(adopted.activity.active).toBeFalse();
      lumine.scrollbars.releaseDocument(targetDocument);
      expect(lumine.commands.canDispatch(element, "core:page-down")).toBeFalse();
      expect(element.hasAttribute("data-lumine-scroll-navigation")).toBeFalse();
    } finally {
      nested.dispose();
      lumine.scrollbars.releaseDocument(targetDocument);
      frame.remove();
    }
  });

  it("leaves inert documents unavailable until their content belongs to a window", () => {
    const inert = document.implementation.createHTMLDocument("inert scrollport");
    const port = inert.createElement("div");
    inert.body.append(port);
    const registration = lumine.scrollbars.bindNavigation(port);
    try {
      expect(lumine.commands.canDispatch(port, "core:page-down")).toBeFalse();
    } finally {
      registration.dispose();
    }
  });

  it("keeps wheel, restoration and content changes outside the navigation deadline", async () => {
    await lumine.commands.dispatch(element, "core:move-down");
    advanceClock(600);
    element.scrollTop = 400;
    element.dispatchEvent(new Event("scroll"));
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
    content.append(document.createElement("span"));
    expect(revealed()).toBeTrue();
    advanceClock(100);
    expect(revealed()).toBeFalse();
    element.scrollTop = 500;
    element.dispatchEvent(new Event("scroll"));
    expect(revealed()).toBeFalse();
  });

  it("removes only its own commands and bindings on disposal", () => {
    expect(lumine.commands.canDispatch(element, "core:page-down")).toBeTrue();
    expect(() => lumine.scrollbars.bindNavigation(element)).toThrow();
    binding.dispose();
    expect(lumine.commands.canDispatch(element, "core:page-down")).toBeFalse();
    expect(element.hasAttribute("data-lumine-scroll-navigation")).toBeFalse();
    binding = lumine.scrollbars.bindNavigation(element);
    expect(lumine.commands.canDispatch(element, "core:page-down")).toBeTrue();
  });

  it("shares keymaps across view owners and keeps the surviving owner's bindings", () => {
    const count = () =>
      lumine.keymaps.getKeyBindings().filter((key) => key.source === "core-scrollbar-navigation")
        .length;
    const before = count();
    expect(before).toBeGreaterThan(0);
    const other = document.createElement("div");
    jasmine.attachToDOM(other);
    const registration = lumine.scrollbars.bindNavigation(other);
    try {
      expect(count()).toBe(before);
      binding.dispose();
      expect(count()).toBe(before);
      expect(lumine.commands.canDispatch(other, "core:page-down")).toBeTrue();
    } finally {
      registration.dispose();
      lumine.scrollbars.documents.get(document)?.controllers.get(other)?.dispose();
      other.remove();
    }
  });

  it("disables navigation in a hidden view and accepts it immediately after showing", async () => {
    const wrapper = document.createElement("div");
    element.before(wrapper);
    wrapper.append(element);
    wrapper.hidden = true;
    expect(lumine.commands.canDispatch(element, "core:move-down")).toBeFalse();
    wrapper.hidden = false;
    await lumine.commands.dispatch(element, "core:move-down");
    expect(element.scrollTop).toBeGreaterThan(0);
    wrapper.before(element);
    wrapper.remove();
  });

  jasmine.itWithDocumentFocus(
    "routes actual keys on read-only native content without hijacking a button",
    async () => {
      jasmine.useRealClock();
      const native = document.createElement("div");
      native.className = "native-key-bindings";
      native.tabIndex = 0;
      content.append(native);
      const input = async (keyCode, modifiers = []) => {
        for (const type of ["keyDown", "char", "keyUp"])
          await ipcRenderer.invoke("lumine:window", "sendInputEvent", { type, keyCode, modifiers });
      };
      native.focus({ preventScroll: true });
      await input("Down");
      expect(element.scrollTop).toBeGreaterThan(0);
      expect(revealed()).toBeTrue();
      await input("Home");
      expect(element.scrollTop).toBe(0);
      controller.activity.clear();
      const activityChanged = spyOn(controller.activity, "onChange").and.callThrough();
      await input("Up");
      // The viewport does not move at the boundary. Record the activation even
      // if the transient chrome has expired by the time the test observes it.
      await conditionPromise(
        () => activityChanged.calls.allArgs().some(([active]) => active),
        "ArrowUp at the scroll boundary to reveal the scrollbar",
      );
      expect(element.scrollTop).toBe(0);
      await input(" ");
      expect(element.scrollTop).toBeGreaterThan(0);
      await input(" ", ["shift"]);
      expect(element.scrollTop).toBe(0);
      const button = document.createElement("button");
      const clicked = jasmine.createSpy("click");
      button.textContent = "Action";
      button.addEventListener("click", clicked);
      content.prepend(button);
      button.focus({ preventScroll: true });
      expect(document.activeElement).toBe(button);
      controller.activity.clear();
      await input(" ");
      await window.waitForFrames(() => clicked.calls.count() === 1, {
        description: "native Space activation to reach the focused button",
      });
      expect(clicked).toHaveBeenCalledTimes(1);
      expect(revealed()).toBeFalse();
      const custom = document.createElement("div");
      custom.setAttribute("role", "button");
      custom.tabIndex = 0;
      const activated = jasmine.createSpy("ARIA action");
      custom.addEventListener("keydown", (event) => {
        if (event.key === " ") {
          event.preventDefault();
          activated();
        }
      });
      content.prepend(custom);
      custom.focus({ preventScroll: true });
      await input(" ");
      expect(activated).toHaveBeenCalledTimes(1);
      expect(revealed()).toBeFalse();
    },
  );
});
