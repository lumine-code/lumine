const { Node, TreeCursor } = require("web-tree-sitter");

const installed = Symbol.for("lumine.tree-sitter.managed-cursors");

// Keep retained methods attached to their cursor owner, make disposal
// idempotent and reject use after close. Cleanup must not call a failed runtime.
// The binding owns cursor copying and its native transfer-buffer/finalizer
// details; the wrapper only adds Lumine's ownership and failure policy.
if (!Node.prototype[installed]) {
  const walk = Node.prototype.walk;
  const deleteCursor = TreeCursor.prototype.delete;
  const copyCursor = TreeCursor.prototype.copy;
  const owners = new WeakMap();
  const dispose = (state) => {
    if (state.closed) return;
    state.closed = true;
    if (!require("./tree-sitter-runtime").failure) deleteCursor.call(state.cursor);
  };
  const finalizer = new FinalizationRegistry(dispose);

  function own(cursor) {
    const state = { cursor, closed: false };
    const methods = new Map();
    const close = () => {
      finalizer.unregister(state);
      dispose(state);
    };
    const wrapper = new Proxy(cursor, {
      get(target, key) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (descriptor && !descriptor.configurable) {
          if ("value" in descriptor && !descriptor.writable) return descriptor.value;
          if (!("value" in descriptor) && descriptor.get === undefined) return undefined;
        }
        if (key === "delete") return close;
        if (state.closed) throw new Error("Tree-sitter cursor is disposed");
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function" || key === "constructor") return value;
        let method = methods.get(value);
        if (!method) {
          method = (...args) => {
            // Retained methods keep their public owner alive, not just its raw
            // cursor. The finalizer's held state must never reference this map.
            if (owners.get(wrapper).closed) throw new Error("Tree-sitter cursor is disposed");
            return Reflect.apply(value, target, args);
          };
          methods.set(value, method);
        }
        return method;
      },
      set(target, key, value) {
        if (state.closed) throw new Error("Tree-sitter cursor is disposed");
        return Reflect.set(target, key, value, target);
      },
    });
    owners.set(wrapper, state);
    finalizer.register(wrapper, state, state);
    return wrapper;
  }

  Node.prototype.walk = function (...args) {
    return own(walk.apply(this, args));
  };

  TreeCursor.prototype.copy = function (...args) {
    const owner = owners.get(this);
    if (owner?.closed) throw new Error("Tree-sitter cursor is disposed");
    return own(Reflect.apply(copyCursor, owner?.cursor ?? this, args));
  };

  Object.defineProperty(Node.prototype, installed, { value: true });
}
