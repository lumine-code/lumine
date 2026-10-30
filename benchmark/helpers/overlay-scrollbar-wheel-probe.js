// Evaluated only in an isolated normal editor by test-overlay-scrollbar-wheel.js.
// These are native input fixtures, never website screenshots or saved documents.
(async () => {
  let root, inner, outer, controller, editor, decoration;
  let ownerCalls, ancestorCalls, railTrusted, ownerTrusted;
  const frames = async () => {
    for (let index = 0; index < 3; index++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  };
  const cleanup = async () => {
    controller?.dispose();
    decoration?.destroy();
    editor?.destroy();
    root?.remove();
    controller = decoration = editor = root = null;
    inner = outer = null;
    await frames();
  };
  const state = () => ({
    innerX: inner.scrollLeft,
    innerY: inner.scrollTop,
    outerX: outer?.scrollLeft || 0,
    outerY: editor ? editor.getElement().getScrollTop() : outer.scrollTop,
    ownerCalls,
    ancestorCalls,
    railTrusted,
    ownerTrusted,
  });
  globalThis.overlayWheelProbe = {
    async setup(options) {
      await cleanup();
      root = document.createElement("div");
      inner = document.createElement("div");
      inner.style.cssText =
        "position:absolute;left:20px;top:20px;width:280px;height:180px;overflow:auto;font:16px/20px monospace;";
      if (options.rtl) inner.style.direction = "rtl";
      if (options.contain) inner.style.overscrollBehavior = "contain";
      const content = document.createElement("div");
      content.style.cssText = "width:1200px;height:1400px";
      content.textContent = "Native wheel input fixture";
      inner.appendChild(content);
      if (options.editor) {
        root.style.cssText = "position:relative;width:400px;height:230px";
        root.appendChild(inner);
        editor = lumine.workspace.buildTextEditor();
        editor.setText(Array.from({ length: 250 }, (_, row) => `Source row ${row}`).join("\n"));
        await lumine.workspace.open(editor);
        editor.setCursorBufferPosition([3, 0]);
        const marker = editor.markBufferPosition([3, 0]);
        decoration = editor.decorateMarker(marker, {
          type: "block",
          position: "after",
          item: root,
        });
        const deadline = performance.now() + 5000;
        while (!root.isConnected || !root.getBoundingClientRect().height) {
          if (performance.now() > deadline)
            throw new Error(
              `The real editor block did not mount: ${JSON.stringify({ connected: root.isConnected, editor: editor.getElement().outerHTML.slice(0, 1000) })}`,
            );
          await frames();
        }
      } else {
        root.style.cssText =
          "position:fixed;left:40px;top:110px;width:420px;height:330px;z-index:2147483000;background:var(--base-background-color)";
        outer = document.createElement("div");
        outer.dataset.scrollbar = "none";
        outer.style.cssText = "position:relative;width:400px;height:300px;overflow:auto";
        const space = document.createElement("div");
        space.style.cssText = "position:relative;width:1000px;height:1200px";
        space.appendChild(inner);
        outer.appendChild(space);
        root.appendChild(outer);
        document.body.appendChild(root);
      }
      inner.addEventListener("wheel", (event) => {
        ownerCalls++;
        ownerTrusted.push(event.isTrusted);
        if (options.authored === "cancel") event.preventDefault();
        if (options.authored === "stop" || (options.editor && !options.chaining))
          event.stopPropagation();
        if (options.editor && options.chaining) {
          const canMove =
            event.deltaY < 0
              ? inner.scrollTop > 0
              : inner.scrollTop < inner.scrollHeight - inner.clientHeight;
          if (canMove) event.stopPropagation();
        }
      });
      (outer || root).addEventListener("wheel", (event) => {
        ancestorCalls++;
        if (options.authored === "host") {
          outer.scrollTop += event.deltaY;
          event.preventDefault();
        }
      });
      controller = lumine.scrollbars.attach(inner, {
        layout: options.layout || "gutter",
        policy: "always",
      });
      controller.layer.addEventListener("wheel", (event) => railTrusted.push(event.isTrusted), {
        capture: true,
      });
      await frames();
      this.options = options;
      return this.reset("content");
    },
    async reset(hit) {
      const options = this.options;
      if (editor) editor.getElement().setScrollTop(0);
      else outer.scrollTo({ left: 0, top: 0, behavior: "instant" });
      inner.scrollTo({
        top: options.boundary ? inner.scrollHeight : 200,
        left: options.rtl ? -200 : 200,
        behavior: "instant",
      });
      controller.refresh();
      await frames();
      ownerCalls = ancestorCalls = 0;
      railTrusted = [];
      ownerTrusted = [];
      const horizontal = options.horizontal;
      const track = horizontal ? controller.horizontal.element : controller.vertical.element;
      const thumb = horizontal ? controller.horizontal.thumb : controller.vertical.thumb;
      const trackBounds = track.getBoundingClientRect();
      const thumbBounds = thumb.getBoundingClientRect();
      const bounds = inner.getBoundingClientRect();
      let point = { x: bounds.left + 50, y: bounds.top + 50 };
      if (hit === "thumb")
        point = {
          x: thumbBounds.left + thumbBounds.width / 2,
          y: thumbBounds.top + thumbBounds.height / 2,
        };
      if (hit === "track") {
        point = horizontal
          ? { x: trackBounds.left + 2, y: trackBounds.top + trackBounds.height / 2 }
          : { x: trackBounds.left + trackBounds.width / 2, y: trackBounds.top + 2 };
        if (
          point.x >= thumbBounds.left &&
          point.x <= thumbBounds.right &&
          point.y >= thumbBounds.top &&
          point.y <= thumbBounds.bottom
        )
          point = horizontal
            ? { x: trackBounds.right - 2, y: point.y }
            : { x: point.x, y: trackBounds.bottom - 2 };
      }
      const target = document.elementFromPoint(point.x, point.y);
      if (hit !== "content" && target !== track && target !== thumb)
        throw new Error(
          `The ${options.name} ${hit} fixture is not the actual pointer target: ${JSON.stringify({ point, track: trackBounds.toJSON(), thumb: thumbBounds.toJSON(), target: target?.outerHTML?.slice(0, 250) })}`,
        );
      return { point, state: state() };
    },
    state,
    cleanup,
  };
  return true;
})();
