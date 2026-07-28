"use strict";

// The `"input"` template: no list, just the validation line and the optional
// live value preview. An input view is exactly a list view with no `source`,
// so everything else (query editor, status, actions, stack) is unchanged.

class ModalInputTemplate {
  constructor(host, spec) {
    this.host = host;
    this.spec = spec;

    this.element = document.createElement("div");
    this.element.classList.add("modals-body", "modals-input-body");

    this.preview = document.createElement("div");
    this.preview.classList.add("modals-value-preview");
    this.preview.style.display = "none";
    this.element.appendChild(this.preview);
  }

  setMultiSelectable() {}

  update(state) {
    if (typeof this.spec.previewValue !== "function") {
      this.preview.style.display = "none";
      return;
    }
    let content = null;
    try {
      content = this.spec.previewValue(state.query.raw, state.session);
    } catch (error) {
      console.error("modals: previewValue threw", error);
    }
    if (content == null || content === "") {
      this.preview.style.display = "none";
      this.preview.replaceChildren();
      return;
    }
    this.preview.style.display = "";
    if (typeof content === "string") {
      this.preview.textContent = content;
    } else {
      this.preview.replaceChildren(content);
    }
  }

  getScrollTop() {
    return 0;
  }

  setScrollTop() {}

  getPageSize() {
    return 1;
  }

  destroy() {
    this.element.remove();
  }
}

module.exports = { ModalInputTemplate };
