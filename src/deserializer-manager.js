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
    this.registrationsByName = new Map();
  }

  /**
   * @public
   * @status public
   *
   * Register the given class(es) as deserializers.
   *
   * @param {...(Object|Function)} deserializers - One or more deserializers to register. A deserializer can be any object with a `.name` property and a `.deserialize()` method. A common approach is to register a *constructor* as the deserializer for its instances by adding a `.deserialize()` class method. When your method is called, it will be passed serialized state as the first argument and the {@link Environment} object as the second argument, which is useful if you wish to avoid referencing the `lumine` global.
   * @returns {Disposable} Removes these registrations and restores any previous deserializer with the same name.
   */
  add(...deserializers) {
    const registrations = [];
    for (let i = 0; i < deserializers.length; i++) {
      const deserializer = deserializers[i];
      const registration = { deserializer };
      let stack = this.registrationsByName.get(deserializer.name);
      if (!stack) {
        stack = [];
        this.registrationsByName.set(deserializer.name, stack);
      }
      stack.push(registration);
      registrations.push(registration);
      this.deserializers[deserializer.name] = deserializer;
    }

    return new Disposable(() => {
      for (const registration of registrations) {
        const { deserializer } = registration;
        const stack = this.registrationsByName.get(deserializer.name);
        if (!stack) continue;
        const index = stack.indexOf(registration);
        if (index !== -1) stack.splice(index, 1);
        if (stack.length === 0) {
          this.registrationsByName.delete(deserializer.name);
          delete this.deserializers[deserializer.name];
        } else {
          this.deserializers[deserializer.name] = stack.at(-1).deserializer;
        }
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
   * Deserialize serialized state with its registered deserializer.
   *
   * @param {Object} state - The state `Object` to deserialize.
   * @returns {*} The deserializer result, or `undefined` when state is absent, unknown, or has an incompatible version.
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
    this.registrationsByName.clear();
  }
};
