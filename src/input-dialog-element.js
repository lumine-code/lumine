"use strict";

class InputDialogElement extends HTMLElement {
  connectedCallback() {
    this.model?.didAttachElement();
  }

  disconnectedCallback() {
    this.model?.didDetachElement();
  }

  getModel() {
    return this.model ?? null;
  }

  setModel(model) {
    if (this.model === model) return;
    if (this.isConnected) this.model?.didDetachElement();
    this.model = model;
    if (this.isConnected) this.model?.didAttachElement();
  }
}

if (!window.customElements.get("lumine-input-dialog")) {
  window.customElements.define("lumine-input-dialog", InputDialogElement);
}

module.exports = InputDialogElement;
