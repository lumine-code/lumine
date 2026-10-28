const { ZERO_WIDTH_NBSP_CHARACTER } = require("./text-editor-component-helpers");

function buildPlan({ displayLayer, screenLine, textDecorations }) {
  const { lineText, tags } = screenLine;
  const plan = [{ kind: "open", className: null }];
  let column = 0,
    depth = 0,
    index = 0,
    active = null;
  let next = textDecorations?.[index];
  if (next?.column === 0) {
    active = next.className;
    next = textDecorations[++index];
  }
  const text = (value) => {
    if (!value) return;
    const last = plan.at(-1);
    if (last.kind === "text") last.value += value;
    else plan.push({ kind: "text", value });
  };
  const decorated = (value) => {
    if (active) plan.push({ kind: "open", className: String(active) });
    text(value);
    if (active) plan.push({ kind: "close" });
  };
  for (const tag of tags) {
    if (!tag) continue;
    if (displayLayer.isCloseTag(tag)) {
      plan.push({ kind: "close" });
      depth--;
    } else if (displayLayer.isOpenTag(tag)) {
      if (++depth > 256) return null;
      plan.push({ kind: "open", className: displayLayer.classNameForTag(tag) || "" });
    } else {
      if (depth >= 256 && (active || next)) return null;
      const end = column + tag;
      while (next && next.column <= end) {
        decorated(lineText.substring(column, next.column));
        column = next.column;
        active = next.className;
        next = textDecorations[++index];
      }
      if (column < end) {
        decorated(lineText.substring(column, end));
        column = end;
      }
    }
  }
  plan.push({ kind: "close" });
  if (!column) text(" ");
  if (lineText.endsWith(displayLayer.foldCharacter)) text(ZERO_WIDTH_NBSP_CHARACTER);
  return plan;
}

// Validate the previous owned tree before mutating anything. Package-added
// attributes/children, focused content and unsupported styles retain the
// ordinary replacement path; no invisible shadow DOM or CSS approximation.
function visit(element, plan, update, textNodes) {
  let parent = element,
    child = parent.firstChild;
  const stack = [];
  const finish = () => {
    if (!update) return child === null;
    while (child) {
      const next = child.nextSibling;
      child.remove();
      child = next;
    }
    return true;
  };
  for (const part of plan) {
    if (part.kind === "close") {
      if (!finish() || !stack.length) return false;
      [parent, child] = stack.pop();
    } else if (part.kind === "open") {
      let node = child;
      if (!node || node.nodeType !== 1 || node.nodeName !== "SPAN") {
        if (!update) return false;
        node = element.ownerDocument.createElement("span");
        parent.insertBefore(node, child);
      }
      if (!update) {
        if (
          node.getAttribute("class") !== part.className ||
          node.attributes.length !== (part.className === null ? 0 : 1)
        )
          return false;
      } else if (node.getAttribute("class") !== part.className) {
        if (part.className === null) node.removeAttribute("class");
        else node.setAttribute("class", part.className);
      }
      stack.push([parent, node.nextSibling]);
      parent = node;
      child = node.firstChild;
    } else {
      if (child?.nodeType === 3) {
        if (child.data !== part.value) {
          if (!update) return false;
          child.data = part.value;
        }
        textNodes?.push(child);
        child = child.nextSibling;
      } else {
        if (!update) return false;
        const node = element.ownerDocument.createTextNode(part.value);
        parent.insertBefore(node, child);
        textNodes?.push(node);
      }
    }
  }
  return !stack.length && finish();
}

module.exports = { buildPlan, visit };
