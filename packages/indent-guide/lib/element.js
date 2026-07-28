class GuideElement extends HTMLElement {}
customElements.define("indent-guide", GuideElement);

// Cache for DOM references per editor
const editorCache = new WeakMap();

function getEditorCache(editorElement) {
  let cache = editorCache.get(editorElement);
  if (!cache) {
    cache = { container: null, guideElements: [] };
    editorCache.set(editorElement, cache);
  }
  // The highlights layer may not exist yet on the first update, and the
  // container is removed from the DOM on deactivation, so (re)create it
  // whenever it is missing or detached instead of caching a dead reference.
  if (!cache.container || !cache.container.isConnected) {
    cache.container = null;
    cache.guideElements = [];
    const highlights = editorElement.querySelector(".scroll-view .lines > .highlights");
    if (highlights) {
      const container = document.createElement("div");
      container.className = "indent-guide-layer";
      container.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
      // Keep guides above selections but inside the highlights stacking
      // context, below line tiles and block decorations such as inline results.
      highlights.appendChild(container);
      cache.container = container;
    }
  }
  return cache;
}

function styleGuide(element, point, length, stack, active, editor) {
  // Batch classList operations
  element.classList.toggle("indent-guide-stack", stack);
  element.classList.toggle("indent-guide-active", active);

  if (editor.isFoldedAtBufferRow(Math.max(point.row - 1, 0))) {
    element.style.height = "0px";
    return;
  }

  const startRow = editor.screenRowForBufferRow(point.row);
  const endRow = editor.screenRowForBufferRow(point.row + length);
  const indentSize = editor.getTabLength();
  const charWidth = editor.getDefaultCharWidth();
  const left = point.column * indentSize * charWidth;
  const top = editor.component.pixelPositionBeforeBlocksForRow(startRow);
  const endTop = editor.component.pixelPositionBeforeBlocksForRow(endRow);
  const height = endTop - top;

  // Batch style assignments for single reflow
  element.style.cssText = `left:${left}px;top:${top}px;height:${height}px;display:block`;
  element.setAttribute("depth", point.column);
}

function createElementsForGuides(editorElement, fns) {
  const cache = getEditorCache(editorElement);
  if (!cache.container) {
    return;
  }

  const elements = cache.guideElements;
  const existNum = elements.length;
  const neededNum = fns.length;
  let count = 0;

  // Recycle existing elements
  const recycleNum = Math.min(neededNum, existNum);
  for (let i = 0; i < recycleNum; i++) {
    fns[count++](elements[i]);
  }

  // Remove excess elements
  for (let i = existNum - 1; i >= recycleNum; i--) {
    elements[i].remove();
    elements.pop();
  }

  // Create new elements if needed
  for (let i = existNum; i < neededNum; i++) {
    const newNode = new GuideElement();
    newNode.classList.add("overlayer", "indent-guide");
    fns[count++](newNode);
    cache.container.appendChild(newNode);
    elements.push(newNode);
  }
}

module.exports = { styleGuide, createElementsForGuides };
