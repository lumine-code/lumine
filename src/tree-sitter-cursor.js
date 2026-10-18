const { Node, TreeCursor } = require("web-tree-sitter");

const installed = Symbol.for("lumine.tree-sitter.managed-cursors");

// web-tree-sitter 0.27.1's cursor finalizer calls the Wasm destructor without
// marshaling the cursor into its shared transfer buffer. Keep the raw cursor
// alive until its public wrapper is collected, then use the public delete()
// method, which marshals the right cursor and unregisters the unsafe finalizer.
// No runtime source, Wasm memory layout or vendor file is modified here.
if (!Node.prototype[installed]) {
  const walk = Node.prototype.walk;
  const deleteCursor = TreeCursor.prototype.delete;
  const resetTo = TreeCursor.prototype.resetTo;
  const owners = new WeakMap();
  const dispose = (state) => {
    if (state.closed) return;
    state.closed = true;
    deleteCursor.call(state.cursor);
  };
  const finalizer = new FinalizationRegistry(dispose);

  function own(cursor) {
    const state = { cursor, closed: false };
    const close = () => {
      finalizer.unregister(state);
      dispose(state);
    };
    const wrapper = new Proxy(cursor, {
      get(target, key) {
        if (key === "delete") return close;
        if (state.closed) throw new Error("Tree-sitter cursor is disposed");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" && key !== "constructor" ? value.bind(target) : value;
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

  // The upstream copy path also relies on the shared transfer buffer rather
  // than marshaling its receiver first. resetTo() copies the complete cursor
  // state through the supported API, including a subtree cursor's root.
  TreeCursor.prototype.copy = function () {
    const owner = owners.get(this);
    if (owner?.closed) throw new Error("Tree-sitter cursor is disposed");
    const source = owner?.cursor ?? this;
    const copy = own(walk.call(source.tree.rootNode));
    try {
      resetTo.call(owners.get(copy).cursor, source);
      return copy;
    } catch (error) {
      copy.delete();
      throw error;
    }
  };

  Object.defineProperty(Node.prototype, installed, { value: true });
}
