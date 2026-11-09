const runtime = require("../src/overlay-scrollbar");
const fs = require("node:fs");
const path = require("node:path");
const stylesheet = fs.readFileSync(
  path.join(__dirname, "../static/core-ui/scrollbars.css"),
  "utf8",
);

async function createRoutingFixture(Runtime = runtime, { deferWrites = false } = {}) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:1000px;height:800px;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  const style = doc.createElement("style");
  style.textContent = stylesheet;
  doc.head.appendChild(style);
  const pending = [];
  const pendingWrites = [];
  const manager = new Runtime.DOMScrollbarManager({
    document: doc,
    scheduleRead(callback) {
      const request = { callback, disposed: false };
      pending.push(request);
      return { dispose: () => (request.disposed = true) };
    },
    scheduleWrite(callback) {
      const request = { callback, disposed: false };
      if (deferWrites) pendingWrites.push(request);
      else callback();
      return { dispose: () => (request.disposed = true) };
    },
  });
  const controllers = [];
  const hovered = new Set();
  const watched = new WeakSet();
  function watchHover(element) {
    if (watched.has(element)) return;
    watched.add(element);
    const matches = element.matches.bind(element);
    element.matches = (selector) =>
      selector === ":hover" ? hovered.has(element) : matches(selector);
  }
  function node(parent = doc.body, style = "") {
    const element = doc.createElement("div");
    element.style.cssText = style;
    parent.appendChild(element);
    return element;
  }
  function port({ owner, parent, autoOwner = false } = {}) {
    if (!autoOwner) owner ||= node(doc.body, "position:relative;width:260px");
    const element = node(
      parent || owner,
      "position:relative;width:100px;height:60px;overflow:auto",
    );
    const content = node(element, "width:200px;height:300px");
    const controller = manager.attach(element, {
      kind: "panel",
      policy: "hover",
      ...(autoOwner ? {} : { focusOwner: owner }),
    });
    controllers.push(controller);
    if (owner) watchHover(owner);
    watchHover(controller.layer);
    return { owner, element, content, controller };
  }
  function drainWrites() {
    for (const request of pendingWrites.splice(0)) if (!request.disposed) request.callback();
  }
  async function flush({ writes = true } = {}) {
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve();
      const batch = pending.splice(0);
      for (const request of batch) if (!request.disposed) request.callback();
      if (writes) drainWrites();
    }
  }
  function pointer(target, type, relatedTarget = doc.body) {
    target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, relatedTarget }));
  }
  function scroll(target) {
    target.dispatchEvent(new win.Event("scroll"));
  }
  function destroy() {
    manager.dispose();
    frame.remove();
  }
  await flush();
  return {
    frame,
    document: doc,
    window: win,
    manager,
    controllers,
    hovered,
    node,
    port,
    flush,
    drainWrites,
    pointer,
    scroll,
    destroy,
  };
}

module.exports = { createRoutingFixture };

describe("Scrollbar event routing", () => {
  const fixtures = [];
  async function fixture(options) {
    const result = await createRoutingFixture(runtime, options);
    fixtures.push(result);
    return result;
  }
  afterEach(() => {
    for (const current of fixtures.splice(0)) current.destroy();
  });
  function visibilitySpies(fixture) {
    return fixture.controllers.map((controller) =>
      spyOn(controller, "syncVisibility").and.callThrough(),
    );
  }

  it("visits only the hovered owner among many unrelated scrollports", async () => {
    const current = await fixture();
    const ports = Array.from({ length: 40 }, () => current.port());
    await current.flush();
    const calls = visibilitySpies(current);
    current.pointer(ports[17].content, "pointerover");
    expect(calls[17]).toHaveBeenCalledTimes(1);
    for (const [index, call] of calls.entries())
      if (index !== 17) expect(call).not.toHaveBeenCalled();
  });

  it("shares hover across an owner's ports and ignores transitions inside that owner", async () => {
    const current = await fixture();
    const first = current.port();
    const second = current.port({ owner: first.owner });
    const unrelated = current.port();
    await current.flush();
    current.hovered.add(first.owner);
    const calls = visibilitySpies(current);
    current.pointer(first.content, "pointerover");
    expect(calls[0]).toHaveBeenCalledTimes(1);
    expect(calls[1]).toHaveBeenCalledTimes(1);
    expect(calls[2]).not.toHaveBeenCalled();
    for (const call of calls) call.calls.reset();
    current.pointer(first.content, "pointerout", second.content);
    current.pointer(second.content, "pointerover", first.content);
    expect(first.controller.layer.classList.contains("is-revealed")).toBeTrue();
    expect(second.controller.layer.classList.contains("is-revealed")).toBeTrue();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(unrelated.controller.activity.active).toBeFalse();
  });

  it("routes a portal rail even when its hover owner is outside the portal subtree", async () => {
    const current = await fixture();
    const owner = current.node();
    const port = current.port({ owner, parent: current.document.body });
    current.port();
    await current.flush();
    expect(owner.contains(port.controller.layer)).toBeFalse();
    const calls = visibilitySpies(current);
    current.hovered.add(port.controller.layer);
    current.pointer(port.controller.vertical.thumb, "pointerover");
    expect(calls[0]).toHaveBeenCalledTimes(1);
    expect(calls[1]).not.toHaveBeenCalled();
    expect(port.controller.layer.classList.contains("is-revealed")).toBeTrue();
  });

  it("updates an own position once and invalidates only descendant portal geometry", async () => {
    const current = await fixture();
    const outer = current.port();
    const inner = current.port({ parent: outer.content });
    const unrelated = current.port();
    await current.flush();
    const position = current.controllers.map((controller) =>
      spyOn(controller, "syncPosition").and.callThrough(),
    );
    const invalidate = spyOn(current.manager, "invalidate").and.callThrough();
    current.scroll(outer.element);
    expect(position[0]).toHaveBeenCalledTimes(1);
    expect(position[1]).not.toHaveBeenCalled();
    expect(position[2]).not.toHaveBeenCalled();
    expect(invalidate.calls.allArgs().map(([controller]) => controller)).toEqual([
      inner.controller,
    ]);
    expect(invalidate).not.toHaveBeenCalledWith(unrelated.controller);
  });

  it("routes unmanaged ancestor and document scrolls to their actual dependents", async () => {
    const current = await fixture();
    const ancestor = current.node(current.document.body, "position:relative");
    const inside = current.port({ parent: ancestor });
    const outside = current.port();
    await current.flush();
    const invalidate = spyOn(current.manager, "invalidate").and.callThrough();
    current.scroll(ancestor);
    expect(invalidate.calls.allArgs().map(([controller]) => controller)).toEqual([
      inside.controller,
    ]);
    invalidate.calls.reset();
    current.scroll(current.document);
    expect(new Set(invalidate.calls.allArgs().map(([controller]) => controller))).toEqual(
      new Set([inside.controller, outside.controller]),
    );
  });

  it("reindexes the semantic owner and ancestors after a same-document reparent", async () => {
    const current = await fixture();
    function pane() {
      const ancestor = current.node();
      const owner = current.document.createElement("lumine-pane");
      ancestor.appendChild(owner);
      const items = current.node(owner);
      items.className = "item-views";
      return { ancestor, owner, item: current.node(items) };
    }
    const old = pane();
    const next = pane();
    const port = current.port({ parent: old.item, autoOwner: true });
    await current.flush();
    expect(port.controller.owner).toBe(old.owner);
    next.item.appendChild(port.element);
    await current.flush();
    expect(port.controller.owner).toBe(next.owner);
    const visibility = spyOn(port.controller, "syncVisibility").and.callThrough();
    const invalidate = spyOn(current.manager, "invalidate").and.callThrough();
    current.pointer(old.item, "pointerover");
    expect(visibility).not.toHaveBeenCalled();
    current.pointer(next.item, "pointerover");
    expect(visibility).toHaveBeenCalledTimes(1);
    current.scroll(old.ancestor);
    expect(invalidate).not.toHaveBeenCalled();
    current.scroll(next.ancestor);
    expect(invalidate).toHaveBeenCalledOnceWith(port.controller);
  });

  it("retires old-document routes when a scrollport is adopted", async () => {
    const first = await fixture();
    const second = await fixture();
    const old = first.port();
    const oldTarget = first.node(old.owner);
    await first.flush();
    const oldVisibility = spyOn(old.controller, "syncVisibility").and.callThrough();
    const newOwner = second.node();
    newOwner.appendChild(second.document.adoptNode(old.element));
    const replacement = second.manager.attach(old.element, { kind: "panel", focusOwner: newOwner });
    await first.flush();
    await second.flush();
    expect(first.manager.controllers.has(old.element)).toBeFalse();
    expect(old.controller.destroyed).toBeTrue();
    oldVisibility.calls.reset();
    const visibility = spyOn(replacement, "syncVisibility").and.callThrough();
    first.pointer(oldTarget, "pointerover");
    expect(oldVisibility).not.toHaveBeenCalled();
    second.pointer(old.content, "pointerover");
    expect(visibility).toHaveBeenCalledTimes(1);
  });

  it("retires routes on removal and unregisters the manager's document listeners", async () => {
    const current = await fixture();
    const port = current.port();
    const target = current.node(port.owner);
    await current.flush();
    const visibility = spyOn(port.controller, "syncVisibility").and.callThrough();
    port.element.remove();
    await current.flush();
    expect(current.manager.controllers.has(port.element)).toBeFalse();
    visibility.calls.reset();
    current.pointer(target, "pointerover");
    expect(visibility).not.toHaveBeenCalled();
    const route = spyOn(current.manager, "syncVisibility").and.callThrough();
    current.manager.dispose();
    current.pointer(target, "pointerover");
    expect(route).not.toHaveBeenCalled();
  });

  it("does not measure or scan unrelated elements during event dispatch", async () => {
    const current = await fixture();
    const port = current.port();
    for (let index = 0; index < 20; index++) current.port();
    await current.flush();
    const style = spyOn(current.window, "getComputedStyle").and.callThrough();
    const read = spyOn(port.controller, "read").and.callThrough();
    const scan = spyOn(current.manager, "scan").and.callThrough();
    const contains = spyOn(port.element, "contains").and.callThrough();
    current.pointer(port.content, "pointerover");
    current.scroll(port.element);
    expect(style).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(contains.calls.count()).toBeLessThanOrEqual(2);
  });

  it("updates hover routing when a surface is hidden or becomes persistent", async () => {
    const current = await fixture();
    const port = current.port();
    await current.flush();
    const visibility = spyOn(port.controller, "syncVisibility").and.callThrough();
    port.element.hidden = true;
    await current.flush();
    visibility.calls.reset();
    current.pointer(port.content, "pointerover");
    expect(visibility).not.toHaveBeenCalled();
    port.element.hidden = false;
    current.manager.attach(port.element, { policy: "always" });
    await current.flush();
    visibility.calls.reset();
    current.pointer(port.content, "pointerover");
    expect(visibility).not.toHaveBeenCalled();
    current.manager.attach(port.element, { policy: "hover" });
    await current.flush();
    visibility.calls.reset();
    current.pointer(port.content, "pointerover");
    expect(visibility).toHaveBeenCalledTimes(1);
  });

  it("clears dependencies when destroyed between the first read and write", async () => {
    const current = await fixture({ deferWrites: true });
    const ancestor = current.node();
    const port = current.port({ parent: ancestor });
    await current.flush({ writes: false });
    expect(port.controller.geometry).toBeUndefined();
    expect(current.manager.scrollDependents.get(ancestor).has(port.controller)).toBeTrue();
    port.controller.destroy();
    const invalidate = spyOn(current.manager, "invalidate").and.callThrough();
    current.scroll(ancestor);
    expect(invalidate).not.toHaveBeenCalled();
    current.drainWrites();
    expect(port.controller.geometry).toBeUndefined();
    expect(port.controller.layer.isConnected).toBeFalse();
    for (const index of [current.manager.scrollDependents, current.manager.visibilityTargets])
      for (const group of index.values()) expect(group.has(port.controller)).toBeFalse();
  });

  it("indexes an unmanaged ancestor before the first scheduled geometry write", async () => {
    const current = await fixture({ deferWrites: true });
    const ancestor = current.node(
      current.document.body,
      "position:relative;height:100px;overflow:hidden",
    );
    const port = current.port({ parent: ancestor });
    current.node(ancestor, "height:500px");
    const read = spyOn(port.controller, "read").and.callThrough();
    await current.flush({ writes: false });
    const firstSnapshot = read.calls.mostRecent().returnValue;
    expect(port.controller.geometry).toBeUndefined();
    const invalidate = spyOn(current.manager, "invalidate").and.callThrough();
    ancestor.scrollTop = 30;
    current.scroll(ancestor);
    expect(invalidate).toHaveBeenCalledWith(port.controller);
    current.drainWrites();
    expect(port.controller.geometry).toBeUndefined();
    await current.flush();
    expect(port.controller.geometry).toBeDefined();
    expect(port.controller.geometry).not.toBe(firstSnapshot);
  });

  it("updates scroll dependencies during a reparent read before publishing its new portal geometry", async () => {
    const current = await fixture({ deferWrites: true });
    const oldAncestor = current.node();
    const nextAncestor = current.node(
      current.document.body,
      "position:relative;height:100px;overflow:hidden",
    );
    const port = current.port({ parent: oldAncestor });
    await current.flush();
    const previous = port.controller.geometry;
    nextAncestor.appendChild(port.element);
    current.node(nextAncestor, "height:500px");
    const read = spyOn(port.controller, "read").and.callThrough();
    await current.flush({ writes: false });
    const stale = read.calls.mostRecent().returnValue;
    const invalidate = spyOn(current.manager, "invalidate").and.callThrough();
    nextAncestor.scrollTop = 30;
    current.scroll(nextAncestor);
    expect(invalidate).toHaveBeenCalledWith(port.controller);
    current.drainWrites();
    expect(port.controller.geometry).toBe(previous);
    await current.flush();
    expect(port.controller.geometry).not.toBe(previous);
    expect(port.controller.geometry).not.toBe(stale);
  });
});
