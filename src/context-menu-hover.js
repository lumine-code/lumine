const { Disposable } = require("@lumine-code/event-kit");

const attribute = "data-context-menu-hover";
const owners = new WeakMap();

// :hover normally includes the entire ancestor path. Retain the same path
// while a context menu owns the pointer, without changing row selection.
module.exports = function retainContextMenuHover(target) {
  const elements = [];
  let element = target?.nodeType === 1 ? target : target?.parentElement;
  while (element) {
    let ownership = owners.get(element);
    if (!ownership) {
      ownership = { count: 0, previous: element.getAttribute(attribute) };
      owners.set(element, ownership);
      element.setAttribute(attribute, "");
    }
    ownership.count++;
    elements.push(element);
    element = element.parentElement;
  }

  return new Disposable(() => {
    for (const current of elements) {
      const ownership = owners.get(current);
      if (--ownership.count > 0) continue;
      if (ownership.previous === null) current.removeAttribute(attribute);
      else current.setAttribute(attribute, ownership.previous);
      owners.delete(current);
    }
  });
};
