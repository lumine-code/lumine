const { Disposable } = require("@lumine-code/event-kit");

/**
 * @public
 * @status extended
 *
 * Manages the deserializers used for serialized state
 *
 * An instance of this class is always available as the `lumine.deserializers`
 * global.
 *
 * ## Examples
 *
 * ```js
 * class MyPackageView {
 *   static deserialize(state) {
 *     return new MyPackageView(state)
 *   }
 *
 *   constructor(state) {
 *     this.state = state
 *   }
 *
 *   serialize() {
 *     return { deserializer: 'MyPackageView', ...this.state }
 *   }
 * }
 *
 * lumine.deserializers.add(MyPackageView)
 * ```
 *
 * Serialized state has to carry the `deserializer` key: it is the name
 * {@link #deserialize} looks the class up by, and state without it is dropped with a
 * warning rather than restored.
 */
module.exports = class DeserializerManager {
  constructor(lumineEnvironment) {
    this.lumineEnvironment = lumineEnvironment;
    this.deserializers = {};
  }

  /**
   * @public
   * @status public
   *
   * Register the given class(es) as deserializers.
   *
   * @param deserializers - One or more deserializers to register. A deserializer can be any object with a `.name` property and a `.deserialize()` method. A common approach is to register a *constructor* as the deserializer for its instances by adding a `.deserialize()` class method. When your method is called, it will be passed serialized state as the first argument and the {@link Environment} object as the second argument, which is useful if you wish to avoid referencing the `lumine` global.
   */
  add(...deserializers) {
    for (let i = 0; i < deserializers.length; i++) {
      let deserializer = deserializers[i];
      this.deserializers[deserializer.name] = deserializer;
    }

    return new Disposable(() => {
      for (let j = 0; j < deserializers.length; j++) {
        let deserializer = deserializers[j];
        delete this.deserializers[deserializer.name];
      }
    });
  }

  getDeserializerCount() {
    return Object.keys(this.deserializers).length;
  }

  /**
   * @public
   * @status public
   *
   * Deserialize the state and params.
   *
   * @param state - The state `Object` to deserialize.
   */
  deserialize(state) {
    if (state == null) {
      return;
    }

    const deserializer = this.get(state);
    if (deserializer) {
      let stateVersion = (typeof state.get === "function" && state.get("version")) || state.version;

      if (deserializer.version != null && deserializer.version !== stateVersion) {
        return;
      }
      return deserializer.deserialize(state, this.lumineEnvironment);
    } else {
      return console.warn("No deserializer found for", state);
    }
  }

  // Get the deserializer for the state.
  //
  // * `state` The state `Object` being deserialized.
  get(state) {
    if (state == null) {
      return;
    }

    let stateDeserializer =
      (typeof state.get === "function" && state.get("deserializer")) || state.deserializer;

    return this.deserializers[stateDeserializer];
  }

  clear() {
    this.deserializers = {};
  }
};
