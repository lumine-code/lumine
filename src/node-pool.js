module.exports = class NodePool {
  constructor() {
    this.elementsByType = {};
    this.textNodes = [];
  }

  getElement(type, className, style) {
    let element;
    const elementsByDepth = this.elementsByType[type];
    if (elementsByDepth) {
      while (elementsByDepth.length > 0) {
        const elements = elementsByDepth[elementsByDepth.length - 1];
        if (elements && elements.length > 0) {
          element = elements.pop();
          if (elements.length === 0) elementsByDepth.pop();
          break;
        } else {
          elementsByDepth.pop();
        }
      }
    }

    if (element) {
      element.className = className || "";
      // Inspect property names without allocating Typed OM values. Keep
      // declarations that will be reused, so equal widths do not need a
      // clear/set pair that dirties layout during every row replacement.
      if (style) {
        for (let i = element.style.length - 1; i >= 0; i--) {
          const key = element.style.item(i);
          if (style[key] == null) element.style.removeProperty(key);
        }
        this.applyStyle(element, style);
      } else if (element.style.length) {
        element.style.cssText = "";
      }
      for (const key in element.dataset) delete element.dataset[key];
      while (element.firstChild) element.firstChild.remove();
      return element;
    } else {
      const newElement = document.createElement(type);
      if (className) newElement.className = className;
      if (style) this.applyStyle(newElement, style);
      return newElement;
    }
  }

  applyStyle(element, style) {
    for (const key in style) {
      if (key.startsWith("--")) element.style.setProperty(key, style[key]);
      else element.style[key] = style[key];
    }
  }

  getTextNode(text) {
    if (this.textNodes.length > 0) {
      const node = this.textNodes.pop();
      node.textContent = text;
      return node;
    } else {
      return document.createTextNode(text);
    }
  }

  release(node, depth = 0) {
    const { nodeName } = node;
    if (nodeName === "#text") {
      this.textNodes.push(node);
    } else {
      let elementsByDepth = this.elementsByType[nodeName];
      if (!elementsByDepth) {
        elementsByDepth = [];
        this.elementsByType[nodeName] = elementsByDepth;
      }

      let elements = elementsByDepth[depth];
      if (!elements) {
        elements = [];
        elementsByDepth[depth] = elements;
      }

      elements.push(node);
      for (let i = 0; i < node.childNodes.length; i++) {
        this.release(node.childNodes[i], depth + 1);
      }
    }
  }
};
