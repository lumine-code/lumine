const fs = require("node:fs");
const path = require("node:path");
const { createScrollbarRuntime } = require("../src/overlay-scrollbar");
const hostDocument = document;
const frameCSS = fs.readFileSync(path.join(__dirname, "../static/core-ui/scrollbars.css"), "utf8");

describe("DOM overlay scrollbar end inset", () => {
  let frame, document, window, manager, element, content, controller, authoredStyle;

  afterEach(() => {
    manager?.dispose();
    frame?.remove();
  });

  async function scrollport({
    layout = "overlay",
    width = 900,
    height = 1000,
    padding = "",
    css = "",
    display = "block",
  } = {}) {
    frame = hostDocument.createElement("iframe");
    frame.style.cssText = "position:absolute;left:20px;top:20px;width:340px;height:220px";
    jasmine.attachToDOM(frame);
    document = frame.contentDocument;
    window = frame.contentWindow;
    document.body.dataset.scrollbarLayout = "gutter";
    // Use the same browser-only factory and stylesheet as isolated outputs.
    // About:blank inherits the editor's CSP, which forbids inline scripts.
    const coreStyle = document.createElement("style");
    coreStyle.textContent = frameCSS;
    document.head.appendChild(coreStyle);
    authoredStyle = document.createElement("style");
    authoredStyle.textContent = `
      * { box-sizing: border-box; }
      html, body { margin: 0; }
      #fixture { position: absolute; left: 10px; top: 10px; width: 300px; height: 180px; }
      #port { width: 100%; height: 100%; overflow: auto; }
      ${css}
    `;
    document.head.appendChild(authoredStyle);
    const fixture = document.createElement("section");
    fixture.id = "fixture";
    element = document.createElement("div");
    element.id = "port";
    element.dataset.scrollbarLayout = layout;
    element.style.display = display;
    if (padding) element.style.paddingBottom = padding;
    content = document.createElement("article");
    content.style.cssText = `width:${width}px;height:${height}px;flex-shrink:0`;
    element.appendChild(content);
    fixture.appendChild(element);
    document.body.appendChild(fixture);
    manager = new (createScrollbarRuntime().DOMScrollbarManager)({ document });
    controller = manager.attach(element, { policy: "always" });
    return fixture;
  }

  async function settle(condition = () => true) {
    let stableFrames = 0;
    await waitForFrames(
      () => {
        const geometry = controller.publicGeometry;
        const stable =
          geometry &&
          geometry.viewportWidth === element.clientWidth &&
          geometry.viewportHeight === element.clientHeight &&
          geometry.scrollWidth === element.scrollWidth &&
          geometry.scrollHeight === element.scrollHeight &&
          !manager.pending &&
          !manager.writeRequest &&
          manager.dirty.size === 0 &&
          condition(geometry);
        stableFrames = stable ? stableFrames + 1 : 0;
        return stableFrames >= 2;
      },
      { frames: 120, description: "settled end-inset geometry" },
    );
    return controller.publicGeometry;
  }

  function expectLastContentAboveRail() {
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    const lastBottom = content.getBoundingClientRect().bottom;
    const trackTop = controller.horizontal.element.getBoundingClientRect().top;
    expect(lastBottom).toBeLessThanOrEqual(trackTop + 0.5);
  }

  it("adds physical end space in the standalone frame without changing the viewport or children", async () => {
    const fixture = await scrollport();
    const geometry = await settle((value) => value.scrollEndInset === 10);
    expect(geometry.scrollHeight).toBe(1010);
    expect(geometry.viewportWidth).toBe(300);
    expect(geometry.viewportHeight).toBe(180);
    expect(element.getBoundingClientRect().height).toBe(180);
    expect(element.parentElement).toBe(fixture);
    expect([...element.children]).toEqual([content]);
    expect(controller.layer.parentElement).toBe(fixture);
    expect(window.getComputedStyle(element).paddingBottom).toBe("10px");
    expectLastContentAboveRail();
  });

  for (const height of [20, 175, 180]) {
    it(`keeps ${height}px-high horizontally overflowing content above its rail`, async () => {
      await scrollport({ height });
      const geometry = await settle((value) => value.scrollEndInset === 10);
      expect(geometry.canScrollVertically).toBe(height + 10 > 180);
      expect(geometry.viewportHeight).toBe(180);
      expectLastContentAboveRail();
    });
  }

  it("leaves vertical-only content alone and removes only its own reserve when horizontal overflow ends", async () => {
    await scrollport({ width: 240, padding: "6px" });
    let geometry = await settle((value) => value.scrollEndInset === 0);
    expect(geometry.canScrollVertically).toBeTrue();
    expect(element.style.paddingBottom).toBe("6px");
    expect(element.style.getPropertyPriority("padding-bottom")).toBe("");
    content.style.width = "900px";
    await settle((value) => value.scrollEndInset === 10);
    expect(window.getComputedStyle(element).paddingBottom).toBe("16px");
    expectLastContentAboveRail();
    content.style.width = "240px";
    geometry = await settle((value) => value.scrollEndInset === 0);
    expect(geometry.canScrollHorizontally).toBeFalse();
    expect(element.style.paddingBottom).toBe("6px");
    expect(element.style.getPropertyPriority("padding-bottom")).toBe("");
  });

  it("uses the native horizontal gutter once across overlay and gutter transitions", async () => {
    await scrollport({ padding: "4px" });
    await settle((value) => value.scrollEndInset === 10);
    element.dataset.scrollbarLayout = "gutter";
    let geometry = await settle((value) => value.layout === "gutter" && value.scrollEndInset === 0);
    expect(element.style.paddingBottom).toBe("4px");
    expect(element.offsetHeight - element.clientHeight).toBe(geometry.horizontalSize);
    expect(geometry.scrollHeight).toBe(1004);
    expectLastContentAboveRail();
    element.dataset.scrollbarLayout = "overlay";
    geometry = await settle((value) => value.layout === "overlay" && value.scrollEndInset === 10);
    expect(element.offsetHeight).toBe(element.clientHeight);
    expect(geometry.scrollHeight).toBe(1014);
    expectLastContentAboveRail();
  });

  it("preserves stylesheet padding, including important priority, across disposal", async () => {
    await scrollport({ css: "#port { padding-bottom: 7px !important; }" });
    await settle((value) => value.scrollEndInset === 10);
    expect(window.getComputedStyle(element).paddingBottom).toBe("17px");
    expectLastContentAboveRail();
    controller.dispose();
    expect(element.style.paddingBottom).toBe("");
    expect(window.getComputedStyle(element).paddingBottom).toBe("7px");
  });

  it("does not rediscover disposed chrome through its own padding restoration mutations", async () => {
    await scrollport({ padding: "5px" });
    await settle((value) => value.scrollEndInset === 10);
    controller.dispose();
    let frames = 0;
    await waitForFrames(() => ++frames >= 5, { frames: 20 });
    expect(manager.controllers.has(element)).toBeFalse();
    expect(element.style.paddingBottom).toBe("5px");
    expect(element.style.scrollPaddingBottom).toBe("");
    expect(element.classList.contains("lumine-scrollport")).toBeFalse();
  });

  it("remeasures inherited authored padding after a same-document move with unchanged dimensions", async () => {
    const fixture = await scrollport({
      css: ".before #port { padding-bottom: 5px; scroll-padding-bottom: 7px; } .after #port { padding-bottom: 20px; scroll-padding-bottom: 9px; }",
    });
    fixture.className = "before";
    await settle(() => window.getComputedStyle(element).paddingBottom === "15px");
    const destination = document.createElement("section");
    destination.className = "after";
    destination.style.cssText =
      fixture.style.cssText || "position:absolute;left:10px;top:10px;width:300px;height:180px";
    document.body.appendChild(destination);
    destination.appendChild(element);
    await settle(() => window.getComputedStyle(element).paddingBottom === "30px");
    expect(window.getComputedStyle(element).scrollPaddingBottom).toBe("19px");
    expectLastContentAboveRail();
    controller.dispose();
    expect(element.style.paddingBottom).toBe("");
    expect(window.getComputedStyle(element).paddingBottom).toBe("20px");
  });

  for (const priority of ["", "important"]) {
    it(`restores the original authored inline padding with ${priority || "normal"} priority`, async () => {
      await scrollport({ width: 240 });
      element.style.setProperty("padding-bottom", "calc(3px + 5px)", priority);
      await settle((value) => value.scrollEndInset === 0);
      const original = element.style.getPropertyValue("padding-bottom");
      content.style.width = "900px";
      await settle((value) => value.scrollEndInset === 10);
      expect(window.getComputedStyle(element).paddingBottom).toBe("18px");
      controller.dispose();
      expect(element.style.getPropertyValue("padding-bottom")).toBe(original);
      expect(element.style.getPropertyPriority("padding-bottom")).toBe(priority);
    });
  }

  it("adopts a later authored inline change rather than restoring stale padding", async () => {
    await scrollport({ padding: "3px" });
    await settle((value) => value.scrollEndInset === 10);
    element.style.setProperty("padding-bottom", "11px", "important");
    await settle(() => window.getComputedStyle(element).paddingBottom === "21px");
    content.style.width = "240px";
    await settle((value) => value.scrollEndInset === 0);
    expect(element.style.paddingBottom).toBe("11px");
    expect(element.style.getPropertyPriority("padding-bottom")).toBe("important");
  });

  it("reinstates compensation when the author resets padding to its original value", async () => {
    await scrollport({ padding: "6px" });
    await settle((value) => value.scrollEndInset === 10);
    element.style.paddingBottom = "6px";
    await settle(() => window.getComputedStyle(element).paddingBottom === "16px");
    manager.refresh();
    await settle(() => window.getComputedStyle(element).paddingBottom === "16px");
    expectLastContentAboveRail();
    controller.dispose();
    expect(element.style.paddingBottom).toBe("6px");
    expect(element.style.getPropertyPriority("padding-bottom")).toBe("");
  });

  it("keeps native nearest-row reveal clear of the rail before reaching the end", async () => {
    await scrollport();
    const precedingRows = document.createElement("div");
    precedingRows.style.height = "960px";
    const row = document.createElement("div");
    row.style.cssText = "height:20px;width:100px";
    content.append(precedingRows, row);
    await settle((value) => value.scrollEndInset === 10);
    element.scrollTop = 790;
    row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      controller.horizontal.element.getBoundingClientRect().top + 0.5,
    );
    expect(element.scrollTop).toBeLessThan(element.scrollHeight - element.clientHeight);
  });

  it("adds to authored scroll-padding and restores its original value and priority", async () => {
    await scrollport({ width: 240 });
    element.style.setProperty("scroll-padding-bottom", "7px", "important");
    await settle((value) => value.scrollEndInset === 0);
    expect(window.getComputedStyle(element).scrollPaddingBottom).toBe("7px");
    content.style.width = "900px";
    await settle((value) => value.scrollEndInset === 10);
    expect(window.getComputedStyle(element).scrollPaddingBottom).toBe("17px");
    content.style.width = "240px";
    await settle((value) => value.scrollEndInset === 0);
    expect(element.style.getPropertyValue("scroll-padding-bottom")).toBe("7px");
    expect(element.style.getPropertyPriority("scroll-padding-bottom")).toBe("important");
    content.style.width = "900px";
    await settle((value) => value.scrollEndInset === 10);
    controller.dispose();
    expect(element.style.getPropertyValue("scroll-padding-bottom")).toBe("7px");
    expect(element.style.getPropertyPriority("scroll-padding-bottom")).toBe("important");
  });

  for (const { value, ratio, fixed, priority } of [
    { value: "20%", ratio: 0.2, fixed: 0, priority: "" },
    { value: "calc(10% + 4px)", ratio: 0.1, fixed: 4, priority: "important" },
  ]) {
    it(`preserves ${value} scroll-padding semantics during native nearest reveal`, async () => {
      await scrollport({ width: 240 });
      element.style.setProperty("scroll-padding-bottom", value, priority);
      const original = element.style.getPropertyValue("scroll-padding-bottom");
      const precedingRows = document.createElement("div");
      precedingRows.style.height = "800px";
      const row = document.createElement("div");
      row.style.cssText = "height:20px;width:100px";
      content.append(precedingRows, row);
      await settle((geometry) => geometry.scrollEndInset === 0);
      content.style.width = "900px";
      const geometry = await settle((snapshot) => snapshot.scrollEndInset === 10);
      element.scrollTop = 650;
      row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const reserved = element.clientHeight * ratio + fixed + geometry.scrollEndInset;
      expect(row.getBoundingClientRect().bottom).toBeCloseTo(
        element.getBoundingClientRect().bottom - reserved,
        0,
      );
      content.style.width = "240px";
      await settle((snapshot) => snapshot.scrollEndInset === 0);
      expect(element.style.getPropertyValue("scroll-padding-bottom")).toBe(original);
      expect(element.style.getPropertyPriority("scroll-padding-bottom")).toBe(priority);
      content.style.width = "900px";
      await settle((snapshot) => snapshot.scrollEndInset === 10);
      controller.dispose();
      expect(element.style.getPropertyValue("scroll-padding-bottom")).toBe(original);
      expect(element.style.getPropertyPriority("scroll-padding-bottom")).toBe(priority);
    });
  }

  it("re-evaluates dynamic class padding and rail thickness without accumulating reserve", async () => {
    await scrollport({
      css: "#port { padding-bottom: 4px; } #port.roomy { padding-bottom: 13px; }",
    });
    await settle((value) => value.scrollEndInset === 10);
    element.classList.add("roomy");
    await settle(() => window.getComputedStyle(element).paddingBottom === "23px");
    document.documentElement.style.setProperty("--scrollbar-size", "16px");
    manager.refresh();
    const geometry = await settle((value) => value.scrollEndInset === 16);
    expect(window.getComputedStyle(element).paddingBottom).toBe("29px");
    expect(geometry.horizontalSize).toBe(16);
    expectLastContentAboveRail();
    manager.refresh();
    await settle((value) => value.scrollEndInset === 16);
    expect(window.getComputedStyle(element).paddingBottom).toBe("29px");
    controller.dispose();
    expect(window.getComputedStyle(element).paddingBottom).toBe("13px");
  });

  it("recomputes percentage padding after a containing-block resize and removes reserve when width fits", async () => {
    const fixture = await scrollport({ css: "#port { padding-bottom: 5%; }", width: 420 });
    await settle((value) => value.scrollEndInset === 10);
    expect(window.getComputedStyle(element).paddingBottom).toBe("25px");
    fixture.style.width = "400px";
    await settle(
      (value) =>
        value.viewportWidth === 400 && window.getComputedStyle(element).paddingBottom === "30px",
    );
    expectLastContentAboveRail();
    fixture.style.width = "500px";
    await settle((value) => value.viewportWidth === 500 && value.scrollEndInset === 0);
    expect(window.getComputedStyle(element).paddingBottom).toBe("25px");
    expect(element.style.paddingBottom).toBe("");
  });

  for (const display of ["flex", "grid"]) {
    it(`reserves space for ${display} children without inserting a spacer or reparenting`, async () => {
      const fixture = await scrollport({ display });
      if (display === "flex") element.style.flexDirection = "column";
      await settle((value) => value.scrollEndInset === 10);
      expect([...element.children]).toEqual([content]);
      expect(element.parentElement).toBe(fixture);
      expect(content.parentElement).toBe(element);
      expectLastContentAboveRail();
    });
  }

  it("lets virtual sizers extend their owned extent using the shared end inset", async () => {
    await scrollport();
    element.style.position = "relative";
    content.style.position = "absolute";
    content.style.left = "0";
    content.style.top = "0";
    const lastRow = document.createElement("div");
    lastRow.style.cssText = "position:absolute;top:980px;height:20px;width:100px";
    content.appendChild(lastRow);
    controller.callbacks.add(({ scrollEndInset }) => {
      content.style.height = `${1000 + scrollEndInset}px`;
    });
    let geometry = await settle(
      (value) => value.scrollEndInset === 10 && value.scrollHeight === 1010,
    );
    expect([...element.children]).toEqual([content]);
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    expect(lastRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      controller.horizontal.element.getBoundingClientRect().top + 0.5,
    );
    expect(geometry.scrollHeight).toBe(1010);
    content.style.width = "240px";
    geometry = await settle((value) => value.scrollEndInset === 0 && value.scrollHeight === 1000);
    expect(content.style.height).toBe("1000px");
    expect(geometry.canScrollHorizontally).toBeFalse();
  });

  it("does not read layout or publish geometry on ordinary scroll events after settling", async () => {
    await scrollport();
    await settle((value) => value.scrollEndInset === 10);
    const changed = jasmine.createSpy("geometry changed");
    controller.callbacks.add(changed);
    const read = spyOn(controller, "read").and.callThrough();
    const prepareRead = spyOn(controller, "prepareRead").and.callThrough();
    const scan = spyOn(manager, "scan").and.callThrough();
    element.scrollTop = 200;
    for (let index = 0; index < 1000; index++) element.dispatchEvent(new window.Event("scroll"));
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(prepareRead).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("preserves the native end offset across repeated authored-style baseline probes", async () => {
    await scrollport();
    await settle((value) => value.scrollEndInset === 10);
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    const endOffset = element.scrollTop;
    for (let attempt = 0; attempt < 3; attempt++) {
      manager.refresh();
      await settle((value) => value.scrollEndInset === 10);
      expect(element.scrollTop).toBe(endOffset);
      expect(controller.vertical.metrics.position).toBe(endOffset);
      expect(content.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        controller.horizontal.element.getBoundingClientRect().top + 0.5,
      );
    }
  });

  it("keeps an existing bottom anchor when horizontal overflow appears or its rail grows", async () => {
    await scrollport({ width: 240 });
    await settle((value) => value.scrollEndInset === 0);
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    content.style.width = "900px";
    await settle((value) => value.scrollEndInset === 10);
    expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
    expect(content.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      controller.horizontal.element.getBoundingClientRect().top + 0.5,
    );
    element.style.setProperty("--scrollbar-size", "20px");
    await settle((value) => value.scrollEndInset === 20);
    expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
    expect(content.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      controller.horizontal.element.getBoundingClientRect().top + 0.5,
    );
  });

  it("does not pull an offset back when input moves away before stable publication", async () => {
    await scrollport();
    await settle((value) => value.scrollEndInset === 10);
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    const write = controller.write.bind(controller);
    let moved = false;
    spyOn(controller, "write").and.callFake((snapshot) => {
      if (
        !moved &&
        controller.paddingScrollPosition &&
        controller.endStyles.get("padding-bottom").managed
      ) {
        // An authored/input update can run between a queued read and write.
        // This is the stable write after the probe has re-added its reserve.
        moved = true;
        element.scrollTop = 200;
      }
      write(snapshot);
    });
    manager.refresh();
    await settle((value) => value.scrollEndInset === 10);
    expect(moved).toBeTrue();
    expect(element.scrollTop).toBe(200);
    expect(controller.vertical.metrics.position).toBe(200);
  });

  it("preserves authored inline padding changed between the baseline read and queued write", async () => {
    await scrollport();
    await settle((value) => value.scrollEndInset === 10);
    const write = controller.write.bind(controller);
    let authoredChange = false;
    spyOn(controller, "write").and.callFake((snapshot) => {
      if (
        !authoredChange &&
        controller.paddingScrollPosition &&
        !controller.endStyles.get("padding-bottom").managed
      ) {
        authoredChange = true;
        element.style.setProperty("padding-bottom", "11px", "important");
      }
      write(snapshot);
    });
    manager.refresh();
    await settle(() => window.getComputedStyle(element).paddingBottom === "21px");
    expect(authoredChange).toBeTrue();
    expectLastContentAboveRail();
    controller.dispose();
    expect(element.style.paddingBottom).toBe("11px");
    expect(element.style.getPropertyPriority("padding-bottom")).toBe("important");
  });
});
