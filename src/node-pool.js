module.exports = class NodePool {
  constructor(owner = globalThis.document) {
    this.owner = owner;
    this.elementsByType = {};
    this.textNodes = [];
  }

  get document() {
    return this.owner?.ownerDocument || this.owner;
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
      if (element.ownerDocument !== this.document) this.document.adoptNode(element);
      element.className = className || "";
      element.attributeStyleMap.forEach((value, key) => {
        if (style && style[key] != null) return;
        // CSS custom properties are not settable through bracket notation;
        // they need the removeProperty/setProperty API.
        if (key.startsWith("--")) element.style.removeProperty(key);
        else element.style[key] = "";
      });
      if (style) this.applyStyle(element, style);
      for (const key in element.dataset) delete element.dataset[key];
      while (element.firstChild) element.firstChild.remove();
      return element;
    } else {
      const newElement = this.document.createElement(type);
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
      if (node.ownerDocument !== this.document) this.document.adoptNode(node);
      node.textContent = text;
      return node;
    } else {
      return this.document.createTextNode(text);
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
