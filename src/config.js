const _ = require("@lumine-code/underscore-plus");
const { Emitter } = require("@lumine-code/event-kit");
const {
  getValueAtKeyPath,
  setValueAtKeyPath,
  deleteValueAtKeyPath,
  pushKeyPath,
  splitKeyPath,
} = require("./key-path");
const Color = require("./color");
const SelectorStore = require("@lumine-code/selector-store");
const ScopeDescriptor = require("./scope-descriptor");

const schemaEnforcers = {};
const SCOPE_RESOLUTIONS = new Set(["base", "grammar", "syntax"]);

/**
 * @public
 * @status essential
 *
 * Used to access all of Lumine's configuration details.
 *
 * An instance of this class is always available as the `lumine.config` global.
 *
 * ## Getting and setting config settings.
 *
 * ```js
 * // Note that with no value set, ::get returns the setting's default value.
 * lumine.config.get('my-package.myKey') // -> 'defaultValue'
 *
 * lumine.config.set('my-package.myKey', 'value')
 * lumine.config.get('my-package.myKey') // -> 'value'
 *
 * // Change only this window until it reloads, without saving to config.json.
 * lumine.config.set('my-package.myKey', 'temporary', { local: true })
 * lumine.config.unset('my-package.myKey', { local: true })
 * ```
 *
 * You may want to watch for changes. Use {@link #observe} to catch changes to the setting.
 *
 * ```js
 * lumine.config.set('my-package.myKey', 'value')
 * lumine.config.observe('my-package.myKey', (newValue) => {
 *   // `observe` calls immediately and every time the value is changed
 *   console.log('My configuration changed:', newValue)
 * })
 * ```
 *
 * If you want a notification only when the value changes, use {@link #onDidChange}.
 *
 * ```js
 * lumine.config.onDidChange('my-package.myKey', ({ newValue, oldValue }) => {
 *   console.log('My configuration changed:', newValue, oldValue)
 * })
 * ```
 *
 * ### Value Coercion
 *
 * Config settings each have a type specified by way of a
 * [schema](https://json-schema.org). For example we might want an integer setting that only
 * allows integers greater than `0`:
 *
 * ```js
 * // When no value has been set, `::get` returns the setting's default value
 * lumine.config.get('my-package.anInt') // -> 12
 *
 * // The string will be coerced to the integer 123
 * lumine.config.set('my-package.anInt', '123')
 * lumine.config.get('my-package.anInt') // -> 123
 *
 * // The string will be coerced to an integer, but it must be greater than 0, so is set to 1
 * lumine.config.set('my-package.anInt', '-20')
 * lumine.config.get('my-package.anInt') // -> 1
 * ```
 *
 * ## Defining settings for your package
 *
 * Declare a `configSchema` in your package's `package.json`:
 *
 * ```json
 * {
 *   "name": "my-package",
 *   "configSchema": {
 *     "someInt": {
 *       "title": "Some Int",
 *       "description": "How many of the thing to do.",
 *       "type": "integer",
 *       "minimum": 1,
 *       "default": 23
 *     }
 *   }
 * }
 * ```
 *
 * The schema is read before the package activates, so its settings appear in
 * the settings view and its defaults apply whether or not the package has been
 * loaded yet. Export a `config` object from the package's main module only when
 * the schema cannot be written down ahead of time and has to be built at
 * runtime.
 *
 * See the [package tutorial](https://lumine-code.github.io/docs.html#developing-for-lumine/developing-a-package) for
 * more info.
 *
 * ## Config Schemas
 *
 * We use [json schema](https://json-schema.org) which allows you to define your value's
 * default, the type it should be, etc. Every example below is the value of the
 * `configSchema` key. A simple one, providing an `enableThing` and a
 * `thingVolume`:
 *
 * ```json
 * {
 *   "enableThing": {
 *     "type": "boolean",
 *     "default": false
 *   },
 *   "thingVolume": {
 *     "type": "integer",
 *     "minimum": 1,
 *     "maximum": 11,
 *     "default": 5
 *   }
 * }
 * ```
 *
 * The type keyword allows for type coercion and validation. If a `thingVolume` is
 * set to a string `'10'`, it will be coerced into an integer.
 *
 * ```js
 * lumine.config.set('my-package.thingVolume', '10')
 * lumine.config.get('my-package.thingVolume') // -> 10
 *
 * // It respects the min / max
 * lumine.config.set('my-package.thingVolume', '400')
 * lumine.config.get('my-package.thingVolume') // -> 11
 *
 * // If it cannot be coerced, the value will not be set
 * lumine.config.set('my-package.thingVolume', 'cats')
 * lumine.config.get('my-package.thingVolume') // -> 11
 * ```
 *
 * ### Supported Types
 *
 * The `type` keyword can be a string with any one of the following. You can also
 * chain them by specifying multiple in an array. For example
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": ["boolean", "integer"],
 *     "default": 5
 *   }
 * }
 * ```
 *
 * ```js
 * lumine.config.set('my-package.someSetting', 'true')
 * lumine.config.get('my-package.someSetting') // -> true
 *
 * lumine.config.set('my-package.someSetting', '12')
 * lumine.config.get('my-package.someSetting') // -> 12
 * ```
 *
 * #### string
 *
 * Values must be a string.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "string",
 *     "default": "hello"
 *   }
 * }
 * ```
 *
 * #### integer
 *
 * Values will be coerced into integer. Supports the (optional) `minimum` and
 * `maximum` keys.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "integer",
 *     "minimum": 1,
 *     "maximum": 11,
 *     "default": 5
 *   }
 * }
 * ```
 *
 * #### number
 *
 * Values will be coerced into a number, including real numbers. Supports the
 * (optional) `minimum` and `maximum` keys.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "number",
 *     "minimum": 1.5,
 *     "maximum": 11.5,
 *     "default": 5.3
 *   }
 * }
 * ```
 *
 * #### boolean
 *
 * Values will be coerced into a Boolean. `'true'` and `'false'` will be coerced into
 * a boolean. Numbers, arrays, objects, and anything else will not be coerced.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "boolean",
 *     "default": false
 *   }
 * }
 * ```
 *
 * #### array
 *
 * Value must be an Array. The types of the values can be specified by a
 * subschema in the `items` key. An item that does not conform to that subschema
 * is dropped rather than rejecting the whole array. Supports the (optional)
 * `minItems` and `maxItems` keys, which bound the length of the array that
 * survives; a value outside those bounds is rejected and the setting keeps its
 * previous value.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "array",
 *     "items": {
 *       "type": "integer",
 *       "minimum": 1.5,
 *       "maximum": 11.5
 *     },
 *     "minItems": 1,
 *     "maxItems": 3,
 *     "default": [1, 2, 3]
 *   }
 * }
 * ```
 *
 * #### color
 *
 * Values will be coerced into a {@link Color} with `red`, `green`, `blue`, and `alpha`
 * properties that all have numeric values. `red`, `green`, `blue` will be in
 * the range 0 to 255 and `value` will be in the range 0 to 1. Values can be any
 * valid CSS color format such as `#abc`, `#abcdef`, `white`,
 * `rgb(50, 100, 150)`, and `rgba(25, 75, 125, .75)`.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "color",
 *     "default": "white"
 *   }
 * }
 * ```
 *
 * #### object / Grouping other types
 *
 * A config setting with the type `object` allows grouping a set of config
 * settings. The group will be visually separated and has its own group headline.
 * The sub options must be listed under a `properties` key.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "object",
 *     "properties": {
 *       "myChildIntOption": {
 *         "type": "integer",
 *         "minimum": 1.5,
 *         "maximum": 11.5
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ### Other Supported Keys
 *
 * #### enum
 *
 * All types support an `enum` key, which lets you specify all the values the
 * setting can take. `enum` may be an array of allowed values (of the specified
 * type), or an array of objects with `value` and `description` properties, where
 * the `value` is an allowed value, and the `description` is a descriptive string
 * used in the settings view.
 *
 * In this example, the setting must be one of the 4 integers:
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "integer",
 *     "enum": [2, 4, 6, 8],
 *     "default": 4
 *   }
 * }
 * ```
 *
 * In this example, the setting must be either 'foo' or 'bar', which are
 * presented using the provided descriptions in the settings pane:
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "string",
 *     "enum": [
 *       { "value": "foo", "description": "Foo mode. You want this." },
 *       { "value": "bar", "description": "Bar mode. Nobody wants that!" }
 *     ],
 *     "default": "foo"
 *   }
 * }
 * ```
 *
 * If you only have a few elements, you can display your enum as a list of
 * radio buttons in the settings view rather than a select list. To do so,
 * specify `radio: true` as a sibling property to the `enum` array.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "string",
 *     "enum": [
 *       { "value": "foo", "description": "Foo mode. You want this." },
 *       { "value": "bar", "description": "Bar mode. Nobody wants that!" }
 *     ],
 *     "radio": true,
 *     "default": "foo"
 *   }
 * }
 * ```
 *
 * Usage:
 *
 * ```js
 * lumine.config.set('my-package.someSetting', '2')
 * lumine.config.get('my-package.someSetting') // -> 2
 *
 * // a value outside the enum is rejected, and the setting keeps what it had
 * lumine.config.set('my-package.someSetting', '3')
 * lumine.config.get('my-package.someSetting') // -> 2
 *
 * // a value inside it is coerced to the declared type and set
 * lumine.config.set('my-package.someSetting', '4')
 * lumine.config.get('my-package.someSetting') // -> 4
 * ```
 *
 * #### title and description
 *
 * The settings view will use the `title` and `description` keys to display your
 * config setting in a readable way. By default the settings view humanizes your
 * config key, so `someSetting` becomes `Some Setting`. In some cases, this is
 * confusing for users, and a more descriptive title is useful.
 *
 * Descriptions will be displayed below the title in the settings view.
 *
 * For a group of config settings the humanized key or the title and the
 * description are used for the group headline.
 *
 * ```json
 * {
 *   "someSetting": {
 *     "title": "Setting Magnitude",
 *     "description": "This will affect the blah and the other blah",
 *     "type": "integer",
 *     "default": 4
 *   }
 * }
 * ```
 *
 * __Note__: You should strive to be so clear in your naming of the setting that
 * you do not need to specify a title or description!
 *
 * Descriptions allow a subset of
 * [Markdown formatting](https://help.github.com/articles/github-flavored-markdown/).
 * Specifically, you may use the following in configuration setting descriptions:
 *
 * * **bold** - `**bold**`
 * * *italics* - `*italics*`
 * * [links](https://lumine-code.github.io) - `[links](https://lumine-code.github.io)`
 * * `code spans` - `` `code spans` ``
 * * line breaks - `line breaks<br/>`
 * * ~~strikethrough~~ - `~~strikethrough~~`
 *
 * #### order
 *
 * The settings view displays your settings in the order the schema declares
 * them, so arranging the schema is all this normally takes.
 *
 * An explicit `order` key still takes precedence where one is present, but
 * prefer not to use it: a setting without `order` sorts after every setting
 * that has one, so adding `order` to part of a schema reorders the rest of it
 * too.
 *
 * ## Manipulating values outside your configuration schema
 *
 * It is possible to manipulate(`get`, `set`, `observe` etc) values that do not
 * appear in your configuration schema. For example, if the config schema of the
 * package 'some-package' is
 *
 * ```json
 * {
 *   "someSetting": {
 *     "type": "boolean",
 *     "default": false
 *   }
 * }
 * ```
 *
 * You can still do the following
 *
 * ```js
 * const otherSetting = lumine.config.get('some-package.otherSetting')
 * lumine.config.set('some-package.stillAnotherSetting', otherSetting * 5)
 * ```
 *
 * In other words, if a function asks for a `key-path`, that path doesn't have to
 * be described in the config schema for the package or any package. However, as
 * highlighted in the best practices section, you are advised against doing the
 * above.
 *
 * ## Best practices
 *
 * * Don't depend on (or write to) configuration keys outside of your keypath.
 */
class Config {
  static addSchemaEnforcer(typeName, enforcerFunction) {
    if (schemaEnforcers[typeName] == null) {
      schemaEnforcers[typeName] = [];
    }
    return schemaEnforcers[typeName].push(enforcerFunction);
  }

  static addSchemaEnforcers(filters) {
    for (let typeName in filters) {
      const functions = filters[typeName];
      for (let name in functions) {
        const enforcerFunction = functions[name];
        this.addSchemaEnforcer(typeName, enforcerFunction);
      }
    }
  }

  static executeSchemaEnforcers(keyPath, value, schema) {
    let error = null;
    let types = schema.type;
    if (!Array.isArray(types)) {
      types = [types];
    }
    for (let type of types) {
      try {
        const enforcerFunctions = schemaEnforcers[type].concat(schemaEnforcers["*"]);
        for (let enforcer of enforcerFunctions) {
          // At some point in one's life, one must call upon an enforcer.
          value = enforcer.call(this, keyPath, value, schema);
        }
        error = null;
        break;
      } catch (e) {
        error = e;
      }
    }

    if (error != null) {
      throw error;
    }
    return value;
  }

  // Created during initialization, available as `lumine.config`
  constructor(params = {}) {
    this.clear();
    this.initialize(params);
  }

  initialize({ saveCallback, mainSource }) {
    if (saveCallback) {
      this.saveCallback = saveCallback;
    }
    if (mainSource) this.mainSource = mainSource;
  }

  clear() {
    this.emitter = new Emitter();
    this.schema = {
      type: "object",
      properties: {},
    };

    this.defaultSettings = {};
    this.settings = {};
    this.localSettings = {};
    this.projectSettings = {};
    this.projectFile = null;

    this.scopedSettingsStore = new SelectorStore();
    this.localScopedSettingsStore = new SelectorStore();
    this.resolvedScopedSettingsStore = null;

    this.settingsLoaded = false;
    this.transactDepth = 0;
    this.pendingOperations = [];
    this.pendingChangeRecords = [];
    this.requestSave = _.debounce(() => this.save(), 1);
  }

  /**
   * @category Config Subscription
   */

  /**
   * @public
   * @status essential
   *
   * Add a listener for changes to a given key path. This is different
   * than {@link #onDidChange} in that it will immediately call your callback with the
   * current value of the config entry.
   *
   * ### Examples
   *
   * You might want to be notified when the theme mode changes. We'll watch
   * `theme.mode` for changes
   *
   * ```js
   * lumine.config.observe('theme.mode', (value) => {
   *   // do stuff with value
   * })
   * ```
   *
   * @param {String} keyPath - The configuration key to observe.
   * @param {Object} [options] - Observation options.
   * @param {ScopeDescriptor} [options.scope] - A path from the root of the
   *   syntax tree to a token. Get one by calling
   *   `editor.getLastCursor().getScopeDescriptor()`. See {@link #get} and
   *   [the scopes docs](https://lumine-code.github.io/docs.html#customizing-lumine/language-settings)
   *   for examples.
   * @param {Function} callback - Called when the value changes.
   * @param {*} callback.value - The new value.
   * @returns {Disposable} A disposable on which `.dispose()` can be called to unsubscribe.
   */
  observe(...args) {
    let callback, keyPath, options, scopeDescriptor;
    if (args.length === 2) {
      [keyPath, callback] = args;
    } else if (args.length === 3 && _.isString(args[0]) && _.isObject(args[1])) {
      [keyPath, options, callback] = args;
      if (options.scopeSelector != null) {
        throw new TypeError("Config::observe reads with 'scope', not 'scopeSelector'");
      }
      scopeDescriptor = options.scope;
    } else {
      console.error(
        "An unsupported form of Config::observe is being used. See https://lumine-code.github.io/api/#class-config for details",
      );
      return;
    }

    if (scopeDescriptor != null) {
      return this.observeScopedKeyPath(scopeDescriptor, keyPath, options, callback);
    } else {
      return this.observeKeyPath(keyPath, options ?? {}, callback);
    }
  }

  /**
   * @public
   * @status essential
   *
   * Add a listener for changes to a given key path. If `keyPath` is
   * not specified, your callback will be called on changes to any key.
   *
   * @param {String} [keyPath] - The key to observe. Required when `options.scope`
   *   is specified.
   * @param {Object} [options] - Observation options.
   * @param {ScopeDescriptor} [options.scope] - A path from the root of the
   *   syntax tree to a token. Get one by calling
   *   `editor.getLastCursor().getScopeDescriptor()`. See {@link #get} and
   *   [the scopes docs](https://lumine-code.github.io/docs.html#customizing-lumine/language-settings)
   *   for examples.
   * @param {Function} callback - Called when the value changes.
   * @param {Object} callback.event - The change event.
   * @param {*} callback.event.newValue - The new value.
   * @param {*} callback.event.oldValue - The previous value.
   * @returns {Disposable} A disposable on which `.dispose()` can be called to unsubscribe.
   */
  onDidChange(...args) {
    let callback, keyPath, scopeDescriptor;
    let options = {};
    if (args.length === 1) {
      [callback] = args;
    } else if (args.length === 2) {
      [keyPath, callback] = args;
    } else {
      [keyPath, options, callback] = args;
      if (options.scopeSelector != null) {
        throw new TypeError("Config::onDidChange reads with 'scope', not 'scopeSelector'");
      }
      scopeDescriptor = options.scope;
    }

    if (scopeDescriptor != null) {
      return this.onDidChangeScopedKeyPath(scopeDescriptor, keyPath, options, callback);
    } else {
      return this.onDidChangeKeyPath(keyPath, {}, callback);
    }
  }

  /**
   * Observe configuration mutations at any source or selector. The event can
   * be filtered with `affectsConfiguration`, including for scoped consumers.
   */
  onDidChangeConfiguration(callback) {
    return this.emitter.on("did-change-configuration", callback);
  }

  /**
   * @category Managing Settings
   */

  /**
   * @public
   * @status essential
   *
   * Retrieves the setting for the given key.
   *
   * ### Examples
   *
   * You might want to know what theme mode is enabled, so check `theme.mode`
   *
   * ```js
   * lumine.config.get('theme.mode')
   * ```
   *
   * With scope descriptors you can get settings within a specific editor
   * scope. For example, you might want to know `editor.tabLength` for ruby
   * files.
   *
   * ```js
   * lumine.config.get('editor.tabLength', { scope: ['source.ruby'] }) // => 2
   * ```
   *
   * This setting in ruby files might be different than the global tabLength setting
   *
   * ```js
   * lumine.config.get('editor.tabLength') // => 4
   * lumine.config.get('editor.tabLength', { scope: ['source.ruby'] }) // => 2
   * ```
   *
   * You can get the language scope descriptor via
   * {@link TextEditor#getRootScopeDescriptor}. This will get the setting specifically
   * for the editor's language.
   *
   * ```js
   * lumine.config.get('editor.tabLength', { scope: editor.getRootScopeDescriptor() }) // => 2
   * ```
   *
   * Additionally, you can get the setting at the specific cursor position.
   *
   * ```js
   * const scopeDescriptor = editor.getLastCursor().getScopeDescriptor()
   * lumine.config.get('editor.tabLength', { scope: scopeDescriptor }) // => 2
   * ```
   *
   * @param {String} keyPath - The key to retrieve.
   * @param {Object} [options] - Lookup options.
   * @param {Array<String>} [options.sources] - If provided, use only values
   *   associated with these sources during {@link #set}.
   * @param {Array<String>} [options.excludeSources] - If provided, exclude
   *   values associated with these sources during {@link #set}.
   * @param {ScopeDescriptor} [options.scope] - A path from the root of the
   *   syntax tree to a token. Get one by calling
   *   `editor.getLastCursor().getScopeDescriptor()`. See
   *   [the scopes docs](https://lumine-code.github.io/docs.html#customizing-lumine/language-settings)
   *   for more information.
   * @returns {*} The resolved value, including this window's local user
   *   overrides, in the type specified by the configuration schema.
   */
  get(...args) {
    let keyPath, options, scope;
    if (args.length > 1) {
      if (typeof args[0] === "string" || args[0] == null) {
        [keyPath, options] = args;
        if (options.scopeSelector != null) {
          throw new TypeError("Config::get reads with 'scope', not 'scopeSelector'");
        }
        ({ scope } = options);
      }
    } else {
      [keyPath] = args;
    }

    if (scope != null) {
      const value = this.getRawScopedValue(scope, keyPath, options);
      const globalValue = this.getRawValue(keyPath, options);
      if (value != null) {
        if (isPlainObject(value) && isPlainObject(globalValue)) {
          return this.deepDefaults(value, globalValue);
        }
        return value;
      }
      return globalValue;
    } else {
      return this.getRawValue(keyPath, options);
    }
  }

  /**
   * @public
   * @status extended
   *
   * Get all of the values for the given key-path, along with their
   * associated scope selector.
   *
   * @param keyPath - The `String` name of the key to retrieve
   * @param {Object} [options] - see the `options` argument to {@link #get}
   * @param options.scopeDescriptor - The {@link ScopeDescriptor} with which the value is associated
   * @param options.value - The value for the key-path
   * @returns {Array} of `Objects` with the following keys:
   */
  getAll(keyPath, options) {
    let globalValue, result, scope;
    if (options != null) {
      if (options.scopeSelector != null) {
        throw new TypeError("Config::getAll reads with 'scope', not 'scopeSelector'");
      }
      ({ scope } = options);
    }

    if (scope != null) {
      const scopeDescriptor = ScopeDescriptor.fromObject(scope);
      result = this.getScopedSettingsStore(options).getAll(
        scopeDescriptor.getScopeChain(),
        keyPath,
        options,
      );
    } else {
      result = [];
    }

    globalValue = this.getRawValue(keyPath, options);
    if (globalValue != null) {
      result.push({ scopeSelector: "*", value: globalValue });
    }

    return result;
  }

  /**
   * @public
   * @status essential
   *
   * Sets the value for a configuration setting.
   *
   * This value is stored in Lumine's configuration file unless `local` is true.
   * Local values replace user values in this renderer until it reloads. Project
   * and scope precedence remains unchanged, and synchronized file changes do
   * not remove local values. An ordinary write removes the local override at
   * the same selector and key path before updating the user value.
   *
   * ### Examples
   *
   * You might want to change the themes programmatically:
   *
   * ```js
   * lumine.config.set('theme.dark', ['one-night-ui', 'one-night-syntax'])
   * ```
   *
   * You can also set scoped settings. For example, you might want change the
   * `editor.tabLength` only for ruby files.
   *
   * ```js
   * lumine.config.get('editor.tabLength') // => 4
   * lumine.config.get('editor.tabLength', { scope: ['source.ruby'] }) // => 4
   * lumine.config.get('editor.tabLength', { scope: ['source.js'] }) // => 4
   *
   * // Set ruby to 2
   * lumine.config.set('editor.tabLength', 2, { scopeSelector: '.source.ruby' }) // => true
   *
   * // Notice it's only set to 2 in the case of ruby
   * lumine.config.get('editor.tabLength') // => 4
   * lumine.config.get('editor.tabLength', { scope: ['source.ruby'] }) // => 2
   * lumine.config.get('editor.tabLength', { scope: ['source.js'] }) // => 4
   * ```
   *
   * @param {String} keyPath - The configuration key.
   * @param {*} value - The setting value. Passing `undefined` reverts it to the
   *   default value, or removes the override when `local` is true.
   * @param {Object} [options] - Write options.
   * @param {Boolean} [options.local=false] - Keep the value in this window only.
   * @param {String} [options.scopeSelector] - A scope such as `.source.ruby`.
   *   See [the scopes docs](https://lumine-code.github.io/docs.html#customizing-lumine/language-settings)
   *   for more information.
   * @param {String} [options.source] - The associated source file. Defaults to
   *   the user's configuration file.
   * @returns {Boolean} `true` if the value was set; `false` if it could not be
   *   coerced to the type specified by the setting's schema or the schema
   *   declares `allowLocal: false` for a requested local write.
   */
  set(...args) {
    let [keyPath, value, options = {}] = args;

    if (options.scope != null) {
      throw new TypeError("Config::set writes with 'scopeSelector', not 'scope'");
    }

    // We should never use the scoped store to set global settings, since they are kept directly
    // in the config object.
    const scopeSelector = options.scopeSelector !== "*" ? options.scopeSelector : undefined;
    let source = options.source;
    const shouldSave = options.save != null ? options.save : true;

    this.validateLocalSource(options);
    if (source && !scopeSelector && source !== this.projectFile && source !== this.mainSource) {
      throw new Error("::set with a 'source' and no 'scopeSelector' is not yet implemented!");
    }

    if (!source) source = this.mainSource;

    if (options.local && value !== undefined && !this.allowsLocalValue(keyPath, value))
      return false;

    if (value !== undefined) {
      try {
        value = this.makeValueConformToSchema(keyPath, value);
      } catch {
        return false;
      }
    }

    if (!this.settingsLoaded) {
      const queuedValue = this.deepClone(value);
      const queuedOptions = { ...options };
      this.pendingOperations.push(() => this.set(keyPath, queuedValue, queuedOptions));
    }

    this.transact(() => {
      if (options.local) {
        this.setRawLocalValue(keyPath, value, scopeSelector);
      } else {
        if (source === this.mainSource) this.removeLocalValue(keyPath, scopeSelector);
        if (scopeSelector != null) this.setRawScopedValue(keyPath, value, source, scopeSelector);
        else this.setRawValue(keyPath, value, { source });
      }
    });

    if (!options.local && source === this.mainSource && shouldSave && this.settingsLoaded) {
      this.requestSave();
    }
    return true;
  }

  /**
   * @public
   * @status essential
   *
   * Restore the setting at `keyPath` to its default value. With `local: true`,
   * remove only the selected local override and inherit the current user value.
   *
   * @param keyPath - The `String` name of the key.
   * @param {Object} [options]
   * @param {Boolean} [options.local=false] - Remove only this window's override,
   *   revealing the current user value. An absent override is a no-op.
   * @param {String} [options.scopeSelector] - See {@link #set}
   * @param {String} [options.source] - See {@link #set}
   */
  unset(keyPath, options) {
    if (options?.scope != null) {
      throw new TypeError("Config::unset writes with 'scopeSelector', not 'scope'");
    }
    this.validateLocalSource(options ?? {});
    if (!this.settingsLoaded) {
      const queuedOptions = { ...options };
      this.pendingOperations.push(() => this.unset(keyPath, queuedOptions));
    }
    let { scopeSelector, source } = options != null ? options : {};
    if (scopeSelector === "*") scopeSelector = undefined;
    if (source == null) {
      source = this.mainSource;
    }

    if (options?.local) return this.removeLocalValue(keyPath, scopeSelector);
    return this.transact(() => this.unsetUserValue(keyPath, { scopeSelector, source }));
  }

  /** @private */
  unsetUserValue(keyPath, { scopeSelector, source }) {
    if (source === this.mainSource) this.removeLocalValue(keyPath, scopeSelector);

    if (scopeSelector != null) {
      if (keyPath != null) {
        let settings = this.scopedSettingsStore.propertiesForSourceAndSelector(
          source,
          scopeSelector,
        );
        if (getValueAtKeyPath(settings, keyPath) != null) {
          this.scopedSettingsStore.removePropertiesForSourceAndSelector(source, scopeSelector);
          setValueAtKeyPath(settings, keyPath, undefined);
          settings = withoutEmptyObjects(settings);
          if (settings != null) {
            this.setRawScopedValue(null, settings, source, scopeSelector);
          } else {
            this.emitChangeEvent({ keyPath, scopeSelector, source });
          }

          const configIsReady = source === this.mainSource && this.settingsLoaded;
          if (configIsReady) {
            return this.requestSave();
          }
        }
      } else {
        this.scopedSettingsStore.removePropertiesForSourceAndSelector(source, scopeSelector);
        return this.emitChangeEvent({ keyPath: null, scopeSelector, source });
      }
    } else {
      for (scopeSelector in this.getScopedSettingsStore().propertiesForSource(source)) {
        this.unset(keyPath, { scopeSelector, source });
      }
      if (keyPath != null && source === this.mainSource) {
        return this.set(keyPath, getValueAtKeyPath(this.defaultSettings, keyPath));
      }
    }
  }

  /**
   * @public
   * @status extended
   *
   * Get an `Array` of all of the `source` `Strings` with which
   * settings have been added via {@link #set}.
   */
  getSources() {
    return _.uniq(_.pluck(this.getScopedSettingsStore().propertySets, "source")).sort();
  }

  /** Return every selector currently contributed by user, project, schema or package settings. */
  getScopeSelectors() {
    return _.uniq(
      this.getScopedSettingsStore()
        .propertySets.map((propertySet) => propertySet.selector.toString())
        .filter((selector) => selector && selector !== "*"),
    ).sort();
  }

  validateScopeSelector(selector) {
    if (typeof selector !== "string" || selector.trim() === "") {
      throw new TypeError("A scope selector must be a non-empty string");
    }
    return [...normalizedSelectorStrings(selector)];
  }

  /** @private */
  validateLocalSource(options) {
    if (Object.hasOwn(options, "local") && typeof options.local !== "boolean") {
      throw new TypeError("The local configuration option must be a boolean");
    }
    if (options.local && options.source != null && options.source !== this.mainSource) {
      throw new TypeError("Local configuration belongs to the user's configuration source");
    }
  }

  /** @private */
  allowsLocalValue(keyPath, value) {
    let schema = this.schema;
    if (schema.allowLocal === false) return false;
    for (const key of splitKeyPath(keyPath)) {
      schema = schema?.properties?.[key] ?? schema?.additionalProperties;
      if (schema?.allowLocal === false) return false;
    }
    if (isPlainObject(value)) {
      return Object.entries(value).every(([key, child]) =>
        this.allowsLocalValue(pushKeyPath(keyPath, key), child),
      );
    }
    return true;
  }

  /** @private */
  setRawLocalValue(keyPath, value, scopeSelector) {
    if (value === undefined) return this.removeLocalValue(keyPath, scopeSelector);
    if (scopeSelector != null) {
      const settings = this.localScopedSettingsStore.propertiesForSourceAndSelector(
        this.mainSource,
        scopeSelector,
      );
      const properties = keyPath == null ? this.deepClone(value) : this.deepClone(settings);
      if (keyPath != null) setValueAtKeyPath(properties, keyPath, this.deepClone(value));
      this.localScopedSettingsStore.removePropertiesForSourceAndSelector(
        this.mainSource,
        scopeSelector,
      );
      this.localScopedSettingsStore.addProperties(
        this.mainSource,
        { [scopeSelector]: properties },
        {
          priority: this.priorityForSource(this.mainSource),
        },
      );
    } else if (keyPath == null) {
      this.localSettings = this.deepClone(value);
    } else {
      setValueAtKeyPath(this.localSettings, keyPath, this.deepClone(value));
    }
    this.emitChangeEvent({
      keyPath,
      scopeSelector: scopeSelector ?? null,
      source: this.mainSource,
      local: true,
    });
  }

  /** @private */
  removeLocalValue(keyPath, scopeSelector) {
    if (scopeSelector != null) {
      const settings = this.localScopedSettingsStore.propertiesForSourceAndSelector(
        this.mainSource,
        scopeSelector,
      );
      if (keyPath != null && getValueAtKeyPath(settings, keyPath) === undefined) return;
      if (keyPath == null && Object.keys(settings).length === 0) return;
      this.localScopedSettingsStore.removePropertiesForSourceAndSelector(
        this.mainSource,
        scopeSelector,
      );
      if (keyPath != null) {
        deleteValueAtKeyPath(settings, keyPath);
        const remaining = withoutEmptyObjects(settings);
        if (remaining != null)
          this.localScopedSettingsStore.addProperties(
            this.mainSource,
            { [scopeSelector]: remaining },
            {
              priority: this.priorityForSource(this.mainSource),
            },
          );
      }
    } else {
      if (keyPath != null && getValueAtKeyPath(this.localSettings, keyPath) === undefined) return;
      if (keyPath == null && Object.keys(this.localSettings).length === 0) return;
      if (keyPath == null) this.localSettings = {};
      else {
        deleteValueAtKeyPath(this.localSettings, keyPath);
        this.localSettings = withoutEmptyObjects(this.localSettings) ?? {};
      }
    }
    this.emitChangeEvent({
      keyPath,
      scopeSelector: scopeSelector ?? null,
      source: this.mainSource,
      local: true,
    });
  }

  /** @private */
  getScopedSettingsStore(options = {}) {
    const includeLocal = options.includeLocal !== false;
    const omitted = options.withoutOverride;
    if ((!includeLocal || this.localScopedSettingsStore.propertySets.length === 0) && !omitted)
      return this.scopedSettingsStore;
    if (includeLocal && !omitted && this.resolvedScopedSettingsStore)
      return this.resolvedScopedSettingsStore;
    const store = new SelectorStore();
    const localProperties = includeLocal
      ? this.deepClone(this.localScopedSettingsStore.propertiesForSource(this.mainSource))
      : {};
    const omittedSelectors =
      omitted?.scopeSelector != null ? normalizedSelectorStrings(omitted.scopeSelector) : new Set();
    if (omitted?.local) {
      for (const selector of omittedSelectors) {
        if (localProperties[selector])
          deleteStoredValue(localProperties[selector], omitted.keyPath);
      }
    }
    const localSets = new Map(
      this.localScopedSettingsStore.propertySets.map((propertySet) => [
        propertySet.selector.toString(),
        propertySet,
      ]),
    );
    store.propertySets = this.scopedSettingsStore.propertySets.map((propertySet) => {
      const selector = propertySet.selector.toString();
      let properties = propertySet.properties;
      let selectorObject = propertySet.selector;
      if (
        omitted &&
        !omitted.local &&
        propertySet.source === omitted.source &&
        omittedSelectors.has(selector)
      ) {
        properties = this.deepClone(properties);
        deleteStoredValue(properties, omitted.keyPath);
      }
      if (
        propertySet.source === this.mainSource &&
        localProperties[selector] &&
        Object.keys(localProperties[selector]).length
      ) {
        properties = this.deepDefaults(this.deepClone(localProperties[selector]), properties);
        selectorObject = localSets.get(selector).selector;
        delete localProperties[selector];
      }
      return new propertySet.constructor(propertySet.source, selectorObject, properties);
    });
    for (const [selector, properties] of Object.entries(localProperties)) {
      if (Object.keys(properties).length) {
        const propertySet = localSets.get(selector);
        store.propertySets.push(
          new propertySet.constructor(this.mainSource, propertySet.selector, properties),
        );
      }
    }
    store.propertySets.sort((left, right) => left.compare(right));
    if (includeLocal && !omitted) this.resolvedScopedSettingsStore = store;
    return store;
  }

  /**
   * @public
   * @status extended
   *
   * Inspect the stored layers for a key at an exact selector. Complex
   * selectors describe several possible scope chains, so only their exact
   * entries are reported; simple chains also receive inherited/effective
   * values.
   *
   * The selected target is the user file by default, or this window when
   * `local` is true. `overrideValue` and `hasOverride` describe that target's
   * exact declaration. `inheritedValue` removes that declaration while retaining
   * normal project precedence. `editableValue` and `editableInheritedValue`
   * exclude project values, and exclude all local values for the user-file
   * target. `localValue` and `hasLocalOverride` describe the exact local
   * declaration independently of the selected target. `effectiveValue` always
   * describes actual runtime resolution, including projects and locals; it is
   * undefined for a complex selector whose match cannot be inferred.
   *
   * @param {String} keyPath - The configuration key to inspect.
   * @param {Object} [options] - Storage target options.
   * @param {Boolean} [options.local=false] - Inspect this window's declaration.
   * @param {String} [options.scopeSelector] - An exact selector; omitted or `*`
   *   selects the base declaration.
   * @param {String} [options.source] - The stored source, defaulting to the user
   *   file. Local inspection only accepts the user source.
   * @returns {Object} Stored and resolved values: `overrideValue`, `hasOverride`,
   *   `inheritedValue`, `editableValue`, `editableInheritedValue`, `localValue`,
   *   `hasLocalOverride`, `effectiveValue`, `baseValue`, `valuesBySource`,
   *   `projectValue`, `variableByMatch`, `keyPath`, `scopeSelector`, and `schema`.
   *   `allowLocal` is false when the key or a parent schema forbids local writes.
   */
  inspect(keyPath, options = {}) {
    if (options.scope != null) {
      throw new TypeError("Config::inspect identifies storage with 'scopeSelector', not 'scope'");
    }
    this.validateLocalSource(options);
    const { local = false, source = this.mainSource } = options;
    const scopeSelector = options.scopeSelector === "*" ? undefined : options.scopeSelector;
    const baseValue = this.get(keyPath);
    const valuesBySource = {};
    if (scopeSelector != null) {
      for (const entrySource of _.uniq(_.pluck(this.scopedSettingsStore.propertySets, "source"))) {
        const properties = this.scopedSettingsStore.propertiesForSourceAndSelector(
          entrySource,
          scopeSelector,
        );
        const value = getValueAtKeyPath(properties, keyPath);
        if (value !== undefined) valuesBySource[entrySource] = this.deepClone(value);
      }
    } else {
      const userValue = getValueAtKeyPath(this.settings, keyPath);
      if (userValue !== undefined) valuesBySource[this.mainSource] = this.deepClone(userValue);
      const projectValue = getValueAtKeyPath(this.projectSettings, keyPath);
      if (this.projectFile != null && projectValue !== undefined)
        valuesBySource[this.projectFile] = this.deepClone(projectValue);
    }

    const localProperties =
      scopeSelector != null
        ? this.localScopedSettingsStore.propertiesForSourceAndSelector(
            this.mainSource,
            scopeSelector,
          )
        : this.localSettings;
    const localValue = this.deepClone(getValueAtKeyPath(localProperties, keyPath));
    const overrideValue = local ? localValue : valuesBySource[source];
    const scopes = scopesForSimpleSelector(scopeSelector);
    let inheritedValue;
    let effectiveValue;
    const readOptions = { includeLocal: local, scope: scopes ?? undefined };
    const withoutOverride = { keyPath, scopeSelector, source, local };
    const editableOptions = {
      ...readOptions,
      excludeSources: this.projectFile != null ? [this.projectFile] : [],
    };
    let editableValue = this.get(keyPath, editableOptions);
    let editableInheritedValue = this.get(keyPath, { ...editableOptions, withoutOverride });
    if (scopeSelector != null && !scopes) {
      editableInheritedValue = local
        ? this.deepDefaults(this.deepClone(valuesBySource[this.mainSource]), editableInheritedValue)
        : editableInheritedValue;
      editableValue =
        overrideValue === undefined
          ? editableInheritedValue
          : this.deepDefaults(this.deepClone(overrideValue), editableInheritedValue);
    } else {
      effectiveValue = this.get(keyPath, scopes ? { scope: scopes } : {});
      inheritedValue = this.get(keyPath, { ...readOptions, withoutOverride });
    }

    return {
      keyPath,
      schema: this.getSchema(keyPath),
      scopeSelector: scopeSelector ?? null,
      baseValue,
      overrideValue,
      hasOverride: overrideValue !== undefined,
      valuesBySource,
      inheritedValue,
      effectiveValue,
      editableValue,
      editableInheritedValue,
      localValue,
      hasLocalOverride: localValue !== undefined,
      allowLocal: this.allowsLocalValue(keyPath),
      variableByMatch: scopeSelector != null && !scopes,
      projectValue: this.projectFile != null ? valuesBySource[this.projectFile] : undefined,
    };
  }

  getScopedValueWithoutExactSource(keyPath, scopes, scopeSelector, source) {
    return this.get(keyPath, {
      scope: scopes,
      withoutOverride: { keyPath, scopeSelector, source, local: false },
    });
  }

  /**
   * @public
   * @status extended
   *
   * Retrieve the schema for a specific key path. The schema will tell
   * you what type the keyPath expects, and other metadata about the config
   * option.
   *
   * @param keyPath - The `String` name of the key.
   * @returns {Object|null} A schema such as `{type: 'integer', default: 23, minimum: 1}`, or `null` when the key path has no accessible schema.
   */
  getSchema(keyPath) {
    const keys = splitKeyPath(keyPath);
    let { schema } = this;
    for (let key of keys) {
      let childSchema;
      if (schema.type === "object") {
        childSchema = schema.properties != null ? schema.properties[key] : undefined;
        if (childSchema == null) {
          if (isPlainObject(schema.additionalProperties)) {
            childSchema = schema.additionalProperties;
          } else if (schema.additionalProperties === false) {
            return null;
          } else {
            return { type: "any" };
          }
        }
      } else {
        return null;
      }
      schema = childSchema;
    }
    return schema;
  }

  getUserConfigPath() {
    return this.mainSource;
  }

  /**
   * @public
   * @status extended
   *
   * Suppress calls to handler functions registered with {@link #onDidChange}
   * and {@link #observe} for the duration of `callback`. After `callback` executes,
   * handlers will be called once if the value for their key-path has changed.
   *
   * @param {Function} callback - to execute while suppressing calls to handlers.
   */
  transact(callback) {
    this.beginTransaction();
    try {
      return callback();
    } finally {
      this.endTransaction();
    }
  }

  /**
   * @category Internal methods used by core
   */

  /**
   * Suppress calls to handler functions registered with {@link #onDidChange}
   * and {@link #observe} for the duration of the `Promise` returned by `callback`.
   * After the `Promise` is either resolved or rejected, handlers will be called
   * once if the value for their key-path has changed.
   *
   * @param {Function} callback - that returns a `Promise`, which will be executed while suppressing calls to handlers.
   * @returns {Promise} that is either resolved or rejected according to the `{Promise}` returned by `callback`. If `callback` throws an error, a rejected `Promise` will be returned instead.
   * @private
   */
  transactAsync(callback) {
    let endTransaction;
    this.beginTransaction();
    try {
      endTransaction =
        (fn) =>
        (...args) => {
          this.endTransaction();
          return fn(...args);
        };
      const result = callback();
      return new Promise((resolve, reject) => {
        return result.then(endTransaction(resolve)).catch(endTransaction(reject));
      });
    } catch (error) {
      this.endTransaction();
      return Promise.reject(error);
    }
  }

  beginTransaction() {
    this.transactDepth++;
  }

  endTransaction() {
    this.transactDepth--;
    this.emitChangeEvent();
  }

  pushAtKeyPath(keyPath, value) {
    const left = this.get(keyPath);
    const arrayValue = left == null ? [] : left;
    const result = arrayValue.push(value);
    this.set(keyPath, arrayValue);
    return result;
  }

  unshiftAtKeyPath(keyPath, value) {
    const left = this.get(keyPath);
    const arrayValue = left == null ? [] : left;
    const result = arrayValue.unshift(value);
    this.set(keyPath, arrayValue);
    return result;
  }

  removeAtKeyPath(keyPath, value) {
    const left = this.get(keyPath);
    const arrayValue = left == null ? [] : left;
    const result = _.remove(arrayValue, value);
    this.set(keyPath, arrayValue);
    return result;
  }

  setSchema(keyPath, schema) {
    if (!isPlainObject(schema)) {
      throw new Error(`Error loading schema for ${keyPath}: schemas can only be objects!`);
    }

    if (schema.type == null) {
      throw new Error(
        `Error loading schema for ${keyPath}: schema objects must have a type attribute`,
      );
    }

    validateScopeResolutionMetadata(keyPath, schema);

    let rootSchema = this.schema;
    if (keyPath) {
      for (let key of splitKeyPath(keyPath)) {
        rootSchema.type = "object";
        if (rootSchema.properties == null) {
          rootSchema.properties = {};
        }
        const { properties } = rootSchema;
        if (properties[key] == null) {
          properties[key] = {};
        }
        rootSchema = properties[key];
      }
    }

    Object.assign(rootSchema, schema);
    this.transact(() => {
      this.setDefaults(keyPath, this.extractDefaultsFromSchema(schema));
      this.setScopedDefaultsFromSchema(keyPath, schema);
      this.resetSettingsForSchemaChange();
    });
  }

  unsetSchema(keyPath) {
    const keys = splitKeyPath(keyPath);
    if (keys.length === 0) throw new Error("Cannot remove the root configuration schema");
    let parent = this.schema;
    for (const key of keys.slice(0, -1)) {
      parent = parent.properties?.[key];
      if (!parent) return false;
    }
    const leaf = keys.at(-1);
    if (!parent.properties || !Object.hasOwn(parent.properties, leaf)) return false;

    delete parent.properties[leaf];
    deleteValueAtKeyPath(this.defaultSettings, keyPath);

    const scopedDefaults = this.scopedSettingsStore.propertiesForSource("schema-default");
    this.scopedSettingsStore.removePropertiesForSource("schema-default");
    for (const [selector, settings] of Object.entries(scopedDefaults)) {
      deleteValueAtKeyPath(settings, keyPath);
      const remaining = withoutEmptyObjects(settings);
      if (remaining != null) {
        this.scopedSettingsStore.addProperties(
          "schema-default",
          { [selector]: remaining },
          {
            priority: this.priorityForSource("schema-default"),
          },
        );
      }
    }

    this.resetSettingsForSchemaChange();
    this.emitChangeEvent({ keyPath, scopeSelector: null, source: "schema-default" });
    return true;
  }

  save() {
    if (this.saveCallback) {
      let allSettings = { "*": this.settings };
      allSettings = Object.assign(
        allSettings,
        this.scopedSettingsStore.propertiesForSource(this.mainSource),
      );
      allSettings = sortObject(allSettings);
      this.saveCallback(allSettings);
    }
  }

  /**
   * @category Private methods managing global settings
   */

  resetUserSettings(newSettings, options = {}) {
    this._resetSettings(newSettings, options);
  }

  _resetSettings(newSettings, options = {}) {
    const source = options.source;
    newSettings = Object.assign({}, newSettings);
    if (newSettings.global != null) {
      newSettings["*"] = newSettings.global;
      delete newSettings.global;
    }

    if (newSettings["*"] != null) {
      const scopedSettings = newSettings;
      newSettings = newSettings["*"];
      delete scopedSettings["*"];
      this.resetScopedSettings(scopedSettings, { source });
    }

    const result = this.transact(() => {
      this._clearUnscopedSettingsForSource(source);
      this.emitChangeEvent({
        keyPath: null,
        scopeSelector: null,
        source: source ?? this.mainSource,
      });
      this.settingsLoaded = true;
      for (let key in newSettings) {
        const value = newSettings[key];
        const conformedValue = this.makeValueConformToSchema(key, value, {
          suppressException: true,
        });
        this.setRawValue(key, conformedValue, { source });
      }
      if (this.pendingOperations.length) {
        for (let op of this.pendingOperations) {
          op();
        }
        this.pendingOperations = [];
      }
    });
    return result;
  }

  _clearUnscopedSettingsForSource(source) {
    if (source === this.projectFile) {
      this.projectSettings = {};
    } else {
      this.settings = {};
    }
  }

  resetProjectSettings(newSettings, projectFile) {
    // Sets the scope and source of all project settings to `path`.
    newSettings = Object.assign({}, newSettings);
    const oldProjectFile = this.projectFile;
    this.projectFile = projectFile;
    if (this.projectFile != null) {
      this._resetSettings(newSettings, { source: this.projectFile });
    } else if (oldProjectFile != null) {
      this.scopedSettingsStore.removePropertiesForSource(oldProjectFile);
      this.projectSettings = {};
      this.emitChangeEvent({ keyPath: null, scopeSelector: null, source: oldProjectFile });
    }
  }

  clearProjectSettings() {
    this.resetProjectSettings({}, null);
  }

  getRawValue(keyPath, options = {}) {
    let { excludeSources, sources } = options;
    let value;
    // If `excludeSources` is missing or does not exclude the main source…
    if (!excludeSources || !excludeSources.includes(this.mainSource)) {
      let userSettings = this.settings;
      let localSettings = this.localSettings;
      const omitted = options.withoutOverride;
      if (omitted && omitted.scopeSelector == null && omitted.source === this.mainSource) {
        if (omitted.local) {
          localSettings = this.deepClone(localSettings);
          deleteStoredValue(localSettings, omitted.keyPath);
        } else {
          userSettings = this.deepClone(userSettings);
          deleteStoredValue(userSettings, omitted.keyPath);
        }
      }
      value = getValueAtKeyPath(userSettings, keyPath);
      if (options.includeLocal !== false) {
        const localValue = getValueAtKeyPath(localSettings, keyPath);
        if (localValue !== undefined) {
          value =
            isPlainObject(localValue) && isPlainObject(value)
              ? this.deepDefaults(this.deepClone(localValue), value)
              : localValue;
        }
      }
      // we should prefer the project specific setting as long as…
      if (
        this.projectFile != null &&
        // `excludeSources` is missing or does not include the project-specific
        // source, and…
        (!excludeSources || !excludeSources.includes(this.projectFile)) &&
        // `sources` is missing or includes the project-specific source.
        (!sources || sources.includes(this.projectFile))
      ) {
        let projectSettings = this.projectSettings;
        if (
          omitted &&
          !omitted.local &&
          omitted.scopeSelector == null &&
          omitted.source === this.projectFile
        ) {
          projectSettings = this.deepClone(projectSettings);
          deleteStoredValue(projectSettings, omitted.keyPath);
        }
        let projectValue = getValueAtKeyPath(projectSettings, keyPath);
        if (projectValue === undefined) {
          // There is no project-specific override for this key path. `value`
          // stays as `value` and we pretend this never happened.
        } else if (isPlainObject(value) && isPlainObject(projectValue)) {
          // This key path returned an object, so we need to merge the contents
          // of the two objects into a third composite object. First we clone
          // the project object so as not to modify it…
          projectValue = this.deepClone(projectValue);
          // …then we copy over the regular value's properties, preferring the
          // project-specific value wherever there is overlap.
          this.deepDefaults(projectValue, value);
          value = projectValue;
        } else {
          // This is a single value, so we prefer the project version.
          value = projectValue;
        }
      }
    }

    let defaultValue;
    if (!options.sources || options.sources.length === 0) {
      defaultValue = getValueAtKeyPath(this.defaultSettings, keyPath);
    }

    if (value != null) {
      value = this.deepClone(value);
      if (isPlainObject(value) && isPlainObject(defaultValue)) {
        this.deepDefaults(value, defaultValue);
      }
      return value;
    } else {
      return this.deepClone(defaultValue);
    }
  }

  setRawValue(keyPath, value, options = {}) {
    const source = options.source ? options.source : undefined;
    const settingsToChange = source === this.projectFile ? "projectSettings" : "settings";
    const defaultValue = getValueAtKeyPath(this.defaultSettings, keyPath);

    if (_.isEqual(defaultValue, value)) {
      if (keyPath != null) {
        deleteValueAtKeyPath(this[settingsToChange], keyPath);
      } else {
        this[settingsToChange] = null;
      }
    } else {
      if (keyPath != null) {
        setValueAtKeyPath(this[settingsToChange], keyPath, value);
      } else {
        this[settingsToChange] = value;
      }
    }
    return this.emitChangeEvent({
      keyPath,
      scopeSelector: null,
      source: source ?? this.mainSource,
    });
  }

  observeKeyPath(keyPath, options, callback) {
    callback(this.get(keyPath, options));
    return this.onDidChangeKeyPath(keyPath, options, (event) => callback(event.newValue));
  }

  onDidChangeKeyPath(keyPath, options, callback) {
    let oldValue = this.get(keyPath, options);
    return this.emitter.on("did-change", () => {
      const newValue = this.get(keyPath, options);
      if (!_.isEqual(oldValue, newValue)) {
        const event = { oldValue, newValue };
        oldValue = newValue;
        return callback(event);
      }
    });
  }

  isSubKeyPath(keyPath, subKeyPath) {
    if (keyPath == null || subKeyPath == null) {
      return false;
    }
    const pathSubTokens = splitKeyPath(subKeyPath);
    const pathTokens = splitKeyPath(keyPath).slice(0, pathSubTokens.length);
    return _.isEqual(pathTokens, pathSubTokens);
  }

  setRawDefault(keyPath, value) {
    setValueAtKeyPath(this.defaultSettings, keyPath, value);
    return this.emitChangeEvent({
      keyPath,
      scopeSelector: null,
      source: "schema-default",
    });
  }

  setDefaults(keyPath, defaults) {
    if (defaults != null && isPlainObject(defaults)) {
      const keys = splitKeyPath(keyPath);
      this.transact(() => {
        const result = [];
        for (let key in defaults) {
          const childValue = defaults[key];
          if (!Object.hasOwn(defaults, key)) {
            continue;
          }
          result.push(this.setDefaults(keys.concat([key]).join("."), childValue));
        }
        return result;
      });
    } else {
      try {
        defaults = this.makeValueConformToSchema(keyPath, defaults);
        this.setRawDefault(keyPath, defaults);
      } catch {
        console.warn(
          `'${keyPath}' could not set the default. Attempted default: ${JSON.stringify(
            defaults,
          )}; Schema: ${JSON.stringify(this.getSchema(keyPath))}`,
        );
      }
    }
  }

  deepClone(object) {
    if (object instanceof Color) {
      return object.clone();
    } else if (Array.isArray(object)) {
      return object.map((value) => this.deepClone(value));
    } else if (isPlainObject(object)) {
      return _.mapObject(object, (key, value) => [key, this.deepClone(value)]);
    } else {
      return object;
    }
  }

  deepDefaults(target) {
    let result = target;
    let i = 0;
    while (++i < arguments.length) {
      const object = arguments[i];
      if (isPlainObject(result) && isPlainObject(object)) {
        for (let key of Object.keys(object)) {
          result[key] = this.deepDefaults(result[key], object[key]);
        }
      } else {
        if (result == null) {
          result = this.deepClone(object);
        }
      }
    }
    return result;
  }

  // `schema` will look something like this
  //
  // ```json
  // {
  //   "type": "string",
  //   "default": "ok",
  //   "scopes": {
  //     ".source.js": { "default": "omg" }
  //   }
  // }
  // ```
  setScopedDefaultsFromSchema(keyPath, schema) {
    this.resolvedScopedSettingsStore = null;
    if (schema.scopes != null && isPlainObject(schema.scopes)) {
      const scopedDefaults = {};
      for (let scope in schema.scopes) {
        const scopeSchema = schema.scopes[scope];
        if (!Object.hasOwn(scopeSchema, "default")) {
          continue;
        }
        scopedDefaults[scope] = {};
        setValueAtKeyPath(scopedDefaults[scope], keyPath, scopeSchema.default);
      }
      this.scopedSettingsStore.addProperties("schema-default", scopedDefaults);
    }

    if (schema.type === "object" && schema.properties != null && isPlainObject(schema.properties)) {
      const keys = splitKeyPath(keyPath);
      for (let key in schema.properties) {
        const childValue = schema.properties[key];
        if (!Object.hasOwn(schema.properties, key)) {
          continue;
        }
        this.setScopedDefaultsFromSchema(keys.concat([key]).join("."), childValue);
      }
    }
  }

  extractDefaultsFromSchema(schema) {
    if (schema.default != null) {
      return schema.default;
    } else if (
      schema.type === "object" &&
      schema.properties != null &&
      isPlainObject(schema.properties)
    ) {
      const defaults = {};
      const properties = schema.properties || {};
      for (let key in properties) {
        const value = properties[key];
        const childDefault = this.extractDefaultsFromSchema(value);
        if (childDefault !== undefined) defaults[key] = childDefault;
      }
      return Object.keys(defaults).length ? defaults : undefined;
    }
  }

  makeValueConformToSchema(keyPath, value, options) {
    if (options != null ? options.suppressException : undefined) {
      try {
        return this.makeValueConformToSchema(keyPath, value);
      } catch {
        return undefined;
      }
    } else {
      let schema;
      if ((schema = this.getSchema(keyPath)) == null) {
        if (schema === false) {
          throw new Error(`Illegal key path ${keyPath}`);
        }
      }
      return this.constructor.executeSchemaEnforcers(keyPath, value, schema);
    }
  }

  // When the schema is changed / added, there may be values set in the config
  // that do not conform to the schema. This will reset make them conform.
  resetSettingsForSchemaChange(source) {
    if (source == null) {
      source = this.mainSource;
    }
    return this.transact(() => {
      this.settings = this.makeValueConformToSchema(null, this.settings, {
        suppressException: true,
      });
      this.localSettings =
        this.makeValueConformToSchema(null, this.localSettings, { suppressException: true }) ?? {};
      const localSelectors = this.localScopedSettingsStore.propertiesForSource(this.mainSource);
      this.localScopedSettingsStore.removePropertiesForSource(this.mainSource);
      for (const [selector, values] of Object.entries(localSelectors)) {
        const conformed = this.makeValueConformToSchema(null, values, { suppressException: true });
        if (conformed != null)
          this.localScopedSettingsStore.addProperties(
            this.mainSource,
            { [selector]: conformed },
            {
              priority: this.priorityForSource(this.mainSource),
            },
          );
      }
      const selectorsAndSettings = this.scopedSettingsStore.propertiesForSource(source);
      this.scopedSettingsStore.removePropertiesForSource(source);
      for (let scopeSelector in selectorsAndSettings) {
        let settings = selectorsAndSettings[scopeSelector];
        settings = this.makeValueConformToSchema(null, settings, {
          suppressException: true,
        });
        this.setRawScopedValue(null, settings, source, scopeSelector);
      }
    });
  }

  /**
   * @category Private Scoped Settings
   */

  priorityForSource(source) {
    switch (source) {
      case this.mainSource:
        return 1000;
      case this.projectFile:
        return 2000;
      default:
        return 0;
    }
  }

  emitChangeEvent(change) {
    if (change) this.resolvedScopedSettingsStore = null;
    if (change) this.pendingChangeRecords.push(change);
    if (this.transactDepth > 0 || this.pendingChangeRecords.length === 0) return;

    const changes = this.pendingChangeRecords;
    this.pendingChangeRecords = [];
    const event = Object.freeze({
      changes: Object.freeze(changes.map((record) => Object.freeze(Object.assign({}, record)))),
      affectsConfiguration: (keyPath, options = {}) => {
        if (options.scopeSelector != null) {
          throw new TypeError("Configuration change checks read with 'scope', not 'scopeSelector'");
        }
        if (options.scope != null) ScopeDescriptor.fromObject(options.scope);
        return changes.some((record) => {
          if (
            record.keyPath != null &&
            keyPath != null &&
            !this.isSubKeyPath(record.keyPath, keyPath) &&
            !this.isSubKeyPath(keyPath, record.keyPath)
          ) {
            return false;
          }
          // A base change can affect every scope. Scoped changes conservatively
          // invalidate every observer of the key; consumers then read their
          // own effective value and avoid false negatives for complex selectors.
          return true;
        });
      },
    });

    try {
      return this.emitter.emit("did-change");
    } finally {
      this.emitter.emit("did-change-configuration", event);
    }
  }

  resetScopedSettings(newScopedSettings, options = {}) {
    const source = options.source == null ? this.mainSource : options.source;
    const priority = this.priorityForSource(source);
    this.scopedSettingsStore.removePropertiesForSource(source);

    for (let scopeSelector in newScopedSettings) {
      let settings = newScopedSettings[scopeSelector];
      settings = this.makeValueConformToSchema(null, settings, {
        suppressException: true,
      });
      const validatedSettings = {};
      validatedSettings[scopeSelector] = withoutEmptyObjects(settings);
      if (validatedSettings[scopeSelector] != null) {
        this.scopedSettingsStore.addProperties(source, validatedSettings, {
          priority,
        });
      }
    }

    return this.emitChangeEvent({ keyPath: null, scopeSelector: null, source });
  }

  setRawScopedValue(keyPath, value, source, selector, _options) {
    let settings = this.scopedSettingsStore.propertiesForSourceAndSelector(source, selector);
    if (keyPath != null) {
      setValueAtKeyPath(settings, keyPath, value);
    } else {
      settings = value;
    }

    this.scopedSettingsStore.removePropertiesForSourceAndSelector(source, selector);
    const settingsBySelector = {};
    settingsBySelector[selector] = withoutEmptyObjects(settings);
    if (settingsBySelector[selector] != null) {
      this.scopedSettingsStore.addProperties(source, settingsBySelector, {
        priority: this.priorityForSource(source),
      });
    }
    return this.emitChangeEvent({ keyPath, scopeSelector: selector, source });
  }

  getRawScopedValue(scopeDescriptor, keyPath, options) {
    scopeDescriptor = ScopeDescriptor.fromObject(scopeDescriptor);
    const result = this.getScopedSettingsStore(options).getPropertyValue(
      scopeDescriptor.getScopeChain(),
      keyPath,
      options,
    );

    return result;
  }

  observeScopedKeyPath(scope, keyPath, options, callback) {
    const scopedOptions = Object.assign({}, options, { scope });
    callback(this.get(keyPath, scopedOptions));
    return this.onDidChangeScopedKeyPath(scope, keyPath, options, (event) =>
      callback(event.newValue),
    );
  }

  onDidChangeScopedKeyPath(scope, keyPath, options, callback) {
    const scopedOptions = Object.assign({}, options, { scope });
    let oldValue = this.get(keyPath, scopedOptions);
    return this.emitter.on("did-change", () => {
      const newValue = this.get(keyPath, scopedOptions);
      if (!_.isEqual(oldValue, newValue)) {
        const event = { oldValue, newValue };
        oldValue = newValue;
        callback(event);
      }
    });
  }
}

function validateScopeResolutionMetadata(keyPath, schema) {
  if (Object.hasOwn(schema, "allowLocal") && typeof schema.allowLocal !== "boolean") {
    throw new Error(
      `Error loading schema for ${keyPath || "<root>"}: allowLocal must be a boolean`,
    );
  }
  if (Object.hasOwn(schema, "scopeResolution") && !SCOPE_RESOLUTIONS.has(schema.scopeResolution)) {
    throw new Error(
      `Error loading schema for ${keyPath || "<root>"}: scopeResolution must be ` +
        '"base", "grammar", or "syntax"',
    );
  }
  for (const [name, childSchema] of Object.entries(schema.properties || {})) {
    validateScopeResolutionMetadata(keyPath ? `${keyPath}.${name}` : name, childSchema);
  }
  if (isPlainObject(schema.items)) {
    validateScopeResolutionMetadata(`${keyPath}[]`, schema.items);
  }
}

function deleteStoredValue(settings, keyPath) {
  if (!settings) return;
  if (keyPath == null) {
    for (const key of Object.keys(settings)) delete settings[key];
  } else deleteValueAtKeyPath(settings, keyPath);
}

// Base schema enforcers. These will coerce raw input into the specified type,
// and will throw an error when the value cannot be coerced. Throwing the error
// will indicate that the value should not be set.
//
// Enforcers are run from most specific to least. For a schema with type
// `integer`, all the enforcers for the `integer` type will be run first, in
// order of specification. Then the `*` enforcers will be run, in order of
// specification.
Config.addSchemaEnforcers({
  any: {
    coerce(keyPath, value, _schema) {
      return value;
    },
  },

  integer: {
    coerce(keyPath, value, _schema) {
      value = parseInt(value);
      if (isNaN(value) || !isFinite(value)) {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(value)} cannot be coerced into an int`,
        );
      }
      return value;
    },
  },

  number: {
    coerce(keyPath, value, _schema) {
      value = parseFloat(value);
      if (isNaN(value) || !isFinite(value)) {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(
            value,
          )} cannot be coerced into a number`,
        );
      }
      return value;
    },
  },

  boolean: {
    coerce(keyPath, value, _schema) {
      switch (typeof value) {
        case "string":
          if (value.toLowerCase() === "true") {
            return true;
          } else if (value.toLowerCase() === "false") {
            return false;
          } else {
            throw new Error(
              `Validation failed at ${keyPath}, ${JSON.stringify(
                value,
              )} must be a boolean or the string 'true' or 'false'`,
            );
          }
        case "boolean":
          return value;
        default:
          throw new Error(
            `Validation failed at ${keyPath}, ${JSON.stringify(
              value,
            )} must be a boolean or the string 'true' or 'false'`,
          );
      }
    },
  },

  string: {
    validate(keyPath, value, _schema) {
      if (typeof value !== "string") {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(value)} must be a string`,
        );
      }
      return value;
    },

    validateMaximumLength(keyPath, value, schema) {
      if (typeof schema.maximumLength === "number" && value.length > schema.maximumLength) {
        return value.slice(0, schema.maximumLength);
      } else {
        return value;
      }
    },
  },

  null: {
    // null sort of isnt supported. It will just unset in this case
    coerce(keyPath, value, _schema) {
      if (![undefined, null].includes(value)) {
        throw new Error(`Validation failed at ${keyPath}, ${JSON.stringify(value)} must be null`);
      }
      return value;
    },
  },

  object: {
    coerce(keyPath, value, schema) {
      if (!isPlainObject(value)) {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(value)} must be an object`,
        );
      }
      if (schema.properties == null) {
        return value;
      }

      let defaultChildSchema = null;
      let allowsAdditionalProperties = true;
      if (isPlainObject(schema.additionalProperties)) {
        defaultChildSchema = schema.additionalProperties;
      }
      if (schema.additionalProperties === false) {
        allowsAdditionalProperties = false;
      }

      const newValue = {};
      for (let prop in value) {
        const propValue = value[prop];
        const childSchema =
          schema.properties[prop] != null ? schema.properties[prop] : defaultChildSchema;
        if (childSchema != null) {
          try {
            newValue[prop] = this.executeSchemaEnforcers(
              pushKeyPath(keyPath, prop),
              propValue,
              childSchema,
            );
          } catch (error) {
            console.warn(`Error setting item in object: ${error.message}`);
          }
        } else if (allowsAdditionalProperties) {
          // Just pass through un-schema'd values
          newValue[prop] = propValue;
        } else {
          console.warn(`Illegal object key: ${keyPath}.${prop}`);
        }
      }

      return newValue;
    },
  },

  array: {
    coerce(keyPath, value, schema) {
      if (!Array.isArray(value)) {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(value)} must be an array`,
        );
      }
      const itemSchema = schema.items;
      if (itemSchema != null) {
        const newValue = [];
        for (let item of value) {
          try {
            newValue.push(this.executeSchemaEnforcers(keyPath, item, itemSchema));
          } catch (error) {
            console.warn(`Error setting item in array: ${error.message}`);
          }
        }
        return newValue;
      } else {
        return value;
      }
    },

    // Runs after `coerce`, so the length being bounded is the one the setting
    // would actually take: an item the subschema rejected is already gone.
    // Unlike `minimum`/`maximum` on a number this rejects rather than clamps —
    // there is no answer to which of the surplus items the user meant to keep.
    validateItemCount(keyPath, value, schema) {
      const { minItems, maxItems } = schema;
      if (typeof minItems === "number" && value.length < minItems) {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(
            value,
          )} must have at least ${minItems} item(s)`,
        );
      }
      if (typeof maxItems === "number" && value.length > maxItems) {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(
            value,
          )} must have at most ${maxItems} item(s)`,
        );
      }
      return value;
    },
  },

  color: {
    coerce(keyPath, value, _schema) {
      const color = Color.parse(value);
      if (color == null) {
        throw new Error(
          `Validation failed at ${keyPath}, ${JSON.stringify(
            value,
          )} cannot be coerced into a color`,
        );
      }
      return color;
    },
  },

  "*": {
    coerceMinimumAndMaximum(keyPath, value, schema) {
      if (typeof value !== "number") {
        return value;
      }
      if (schema.minimum != null && typeof schema.minimum === "number") {
        value = Math.max(value, schema.minimum);
      }
      if (schema.maximum != null && typeof schema.maximum === "number") {
        value = Math.min(value, schema.maximum);
      }
      return value;
    },

    validateEnum(keyPath, value, schema) {
      let possibleValues = schema.enum;

      if (Array.isArray(possibleValues)) {
        possibleValues = possibleValues.map((value) => {
          if (Object.hasOwn(value, "value")) {
            return value.value;
          } else {
            return value;
          }
        });
      }

      if (possibleValues == null || !Array.isArray(possibleValues) || !possibleValues.length) {
        return value;
      }

      for (let possibleValue of possibleValues) {
        // Using `isEqual` for possibility of placing enums on array and object schemas
        if (_.isEqual(possibleValue, value)) {
          return value;
        }
      }

      throw new Error(
        `Validation failed at ${keyPath}, ${JSON.stringify(
          value,
        )} is not one of ${JSON.stringify(possibleValues)}`,
      );
    },
  },
});

function scopesForSimpleSelector(selector) {
  if (typeof selector !== "string" || selector.trim() === "") return null;
  if (/[,:[\]#>+~]/.test(selector)) return null;
  const components = selector.trim().split(/\s+/);
  if (!components.every((component) => /^\.[A-Za-z0-9_.-]+$/.test(component))) return null;
  return components;
}

function normalizedSelectorStrings(selector) {
  const store = new SelectorStore();
  store.addProperties("normalize", { [selector]: {} });
  return new Set(store.propertySets.map((propertySet) => propertySet.selector.toString()));
}

let isPlainObject = (value) =>
  _.isObject(value) &&
  !Array.isArray(value) &&
  !_.isFunction(value) &&
  !_.isString(value) &&
  !(value instanceof Color);

let sortObject = (value) => {
  if (!isPlainObject(value)) {
    return value;
  }
  const result = {};
  for (let key of Object.keys(value).sort()) {
    result[key] = sortObject(value[key]);
  }
  return result;
};

const withoutEmptyObjects = (object) => {
  let resultObject;
  if (isPlainObject(object)) {
    for (let key in object) {
      const value = object[key];
      const newValue = withoutEmptyObjects(value);
      if (newValue != null) {
        if (resultObject == null) {
          resultObject = {};
        }
        resultObject[key] = newValue;
      }
    }
  } else {
    resultObject = object;
  }
  return resultObject;
};

module.exports = Config;
