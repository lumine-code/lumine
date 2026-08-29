function copyDescriptors(target, source, excluded = new Set()) {
  for (const key of Reflect.ownKeys(source)) {
    if (excluded.has(key)) continue;
    Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
  }
}

function createRealmCustomElementClass(BaseClass, HTMLElement, initializeInstance) {
  class RealmCustomElement extends HTMLElement {
    constructor() {
      super();
      initializeInstance?.call(this);
    }
  }
  copyDescriptors(RealmCustomElement.prototype, BaseClass.prototype, new Set(["constructor"]));
  copyDescriptors(RealmCustomElement, BaseClass, new Set(["length", "name", "prototype"]));
  Object.defineProperty(RealmCustomElement, "name", { value: BaseClass.name });
  return RealmCustomElement;
}

function classFactory(BaseClass, initializeInstance) {
  return ({ HTMLElement }) =>
    HTMLElement === globalThis.HTMLElement
      ? BaseClass
      : createRealmCustomElementClass(BaseClass, HTMLElement, initializeInstance);
}

module.exports = { classFactory, createRealmCustomElementClass };
