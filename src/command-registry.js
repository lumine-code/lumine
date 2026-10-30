"use strict";

const { Emitter, Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const { calculateSpecificity, validateSelector } = require("./css-selectors");
const _ = require("@lumine-code/underscore-plus");

let SequenceCount = 0;

/**
 * @public
 * @status public
 *
 * Associates listener functions with commands in a
 * context-sensitive way using CSS selectors. You can access a global instance of
 * this class via `lumine.commands`, and commands registered there will be
 * presented in the command palette.
 *
 * The global command registry facilitates a style of event handling known as
 * *event delegation* that was popularized by jQuery. Lumine commands are expressed
 * as custom DOM events that can be invoked on the currently focused element via
 * a key binding or manually via the command palette. Rather than binding
 * listeners for command events directly to DOM nodes, you instead register
 * command event listeners globally on `lumine.commands` and constrain them to
 * specific kinds of elements with CSS selectors.
 *
 * Command names must follow the `namespace:action` pattern, where `namespace`
 * will typically be the name of your package, and `action` describes the
 * behavior of your command. If either part consists of multiple words, these
 * must be separated by hyphens. E.g. `awesome-package:turn-it-up-to-eleven`.
 * All words should be lowercased.
 *
 * As the event bubbles upward through the DOM, all registered event listeners
 * with matching selectors are invoked in order of specificity. In the event of a
 * specificity tie, the most recently registered listener is invoked first. This
 * mirrors the "cascade" semantics of CSS. Event listeners are invoked in the
 * context of the current DOM node, meaning `this` always points at
 * `event.currentTarget`. As is normally the case with DOM events,
 * `stopPropagation` and `stopImmediatePropagation` can be used to terminate the
 * bubbling process and prevent invocation of additional listeners.
 *
 * ## Example
 *
 * Here is a command that inserts the current date in an editor:
 *
 * ```js
 * lumine.commands.add('lumine-text-editor', {
 *   'user:insert-date'(event) {
 *     const editor = this.getModel()
 *     editor.insertText(new Date().toLocaleString())
 *   }
 * })
 * ```
 */
module.exports = class CommandRegistry {
  constructor({ keymapManager = null } = {}) {
    this.handleCommandEvent = this.handleCommandEvent.bind(this);
    this.keymapManager = keymapManager;
    this.rootNode = null;
    this.rootNodes = new Set();
    this.changeEmitter = new Emitter();
    this.clear();
  }

  clear() {
    for (const root of this.rootNodes) {
      for (const name in this.registeredCommands) {
        root.removeEventListener(name, this.handleCommandEvent, true);
      }
    }
    this.emitter?.dispose();
    this.registeredCommands = {};
    this.selectorBasedListenersByCommandName = {};
    this.inlineListenersByCommandName = {};
    this.emitter = new Emitter();
    this.changeEmitter.emit("did-change");
  }

  attach(rootNode) {
    if (this.rootNodes.has(rootNode)) return new Disposable();
    this.rootNodes.add(rootNode);
    this.rootNode ??= rootNode;
    const commands = new Set([
      ...Object.keys(this.selectorBasedListenersByCommandName),
      ...Object.keys(this.inlineListenersByCommandName),
    ]);
    for (const command of commands) {
      rootNode.addEventListener(command, this.handleCommandEvent, { capture: true });
      this.registeredCommands[command] = true;
    }
    return new Disposable(() => this.detach(rootNode));
  }

  detach(rootNode) {
    if (!this.rootNodes.delete(rootNode)) return;
    for (const name in this.registeredCommands) {
      rootNode.removeEventListener(name, this.handleCommandEvent, true);
    }
    if (this.rootNode === rootNode) this.rootNode = this.rootNodes.values().next().value ?? null;
  }

  destroy() {
    for (const root of [...this.rootNodes]) this.detach(root);
    this.changeEmitter.dispose();
  }

  /**
   * @category Registering Commands
   */

  /**
   * @public
   * @status public
   *
   * Add one or more command listeners associated with a selector.
   *
   * ## Registering one command
   *
   *   The function (`listener` itself if it is a function, or the `didDispatch`
   *   method if `listener` is an object) will be called with `this` referencing
   *   the matching DOM node and the following argument:
   *
   *   Additionally, `listener` may have additional properties which are returned
   *   to those who query using `lumine.commands.findCommands`, as well as several
   *   meaningful metadata properties:
   *
   * ## Registering multiple commands
   *
   * Pass an object mapping command names such as `user:insert-date` to listener
   * functions as `commandName`.
   *
   * @param {String|Element} target - A CSS selector or DOM element. Selectors
   *   associate the command with all matching elements; the `,` combinator is
   *   not supported.
   * @param {String|Object} commandName - A command name such as
   *   `user:insert-date`, or a map of command names to listeners.
   * @param {Function|Object} [listener] - A function, or an object whose
   *   `didDispatch` property handles the command.
   * @param {Event} listener.event - The dispatched DOM event. Call
   *   `stopPropagation()` or `stopImmediatePropagation()` to stop bubbling.
   * @param {String} [listener.displayName] - Overrides the generated display name.
   * @param {String} [listener.description] - Detailed command information.
   * @param {Boolean} [listener.hiddenInCommandPalette] - Hide the command from
   *   the bundled command palette by default.
   * @param {Boolean|String} [listener.modal] - Declares that the command opens a
   *   modal, optionally naming its breadcrumb label.
   * @param {Function} [listener.isAvailable] - A synchronous, side-effect-free predicate returning a Boolean. It receives `{target, currentTarget, detail, context}` with `this` set to the matching node. It runs only after the registration scope matches, for availability queries and immediately before invoking this handler. Omit it when the scope alone is sufficient.
   * @param {Function|Boolean|String} [listener.checked] - Persistent choice state, or a synchronous, side-effect-free function receiving the same context as `isAvailable`. Return a Boolean, or `mixed` for a checkbox. Menus and command presentations share this state.
   * @param {String} [listener.type=checkbox] - Use `radio` for an exclusive choice or `checkbox` for an independent choice when `checked` is supplied.
   * @param {Boolean} [throwOnInvalidSelector=true] - Throw when `target` is an
   *   invalid selector.
   * @returns {Disposable} on which `.dispose()` can be called to remove the added command handler(s).
   */
  add(target, commandName, listener, throwOnInvalidSelector = true) {
    if (typeof commandName === "object") {
      const commands = commandName;
      throwOnInvalidSelector = listener;
      const disposable = new CompositeDisposable();
      for (commandName in commands) {
        listener = commands[commandName];
        disposable.add(this.add(target, commandName, listener, throwOnInvalidSelector));
      }
      return disposable;
    }

    if (listener == null) {
      throw new Error("Cannot register a command with a null listener.");
    }

    // type Listener = ((e: CustomEvent) => void) | {
    //   displayName?: string,
    //   description?: string,
    //   didDispatch(e: CustomEvent): void,
    // }
    if (typeof listener !== "function" && typeof listener.didDispatch !== "function") {
      throw new Error(
        "Listener must be a callback function or an object with a didDispatch method.",
      );
    }
    if (listener.isAvailable != null && typeof listener.isAvailable !== "function") {
      throw new TypeError("Command isAvailable must be a synchronous predicate function.");
    }
    if (
      listener.checked != null &&
      !["function", "boolean"].includes(typeof listener.checked) &&
      listener.checked !== "mixed"
    ) {
      throw new TypeError(
        "Command checked must be a Boolean, 'mixed', or a synchronous state function.",
      );
    }
    if (
      listener.checked != null &&
      listener.type != null &&
      !["checkbox", "radio"].includes(listener.type)
    ) {
      throw new TypeError("Command choice type must be 'checkbox' or 'radio'.");
    }

    if (typeof target === "string") {
      if (throwOnInvalidSelector) {
        validateSelector(target);
      }
      return this.addSelectorBasedListener(target, commandName, listener);
    } else {
      return this.addInlineListener(target, commandName, listener);
    }
  }

  addSelectorBasedListener(selector, commandName, listener) {
    if (this.selectorBasedListenersByCommandName[commandName] == null) {
      this.selectorBasedListenersByCommandName[commandName] = [];
    }
    const listenersForCommand = this.selectorBasedListenersByCommandName[commandName];
    const selectorListener = new SelectorBasedListener(selector, commandName, listener);
    listenersForCommand.push(selectorListener);

    this.commandRegistered(commandName);
    this.changeEmitter.emit("did-change");

    return new Disposable(() => {
      listenersForCommand.splice(listenersForCommand.indexOf(selectorListener), 1);
      if (this.selectorBasedListenersByCommandName[commandName] !== listenersForCommand) return;
      if (listenersForCommand.length === 0) {
        delete this.selectorBasedListenersByCommandName[commandName];
      }
      this.changeEmitter.emit("did-change");
    });
  }

  addInlineListener(element, commandName, listener) {
    if (this.inlineListenersByCommandName[commandName] == null) {
      this.inlineListenersByCommandName[commandName] = new WeakMap();
    }

    const listenersForCommand = this.inlineListenersByCommandName[commandName];
    let listenersForElement = listenersForCommand.get(element);
    if (!listenersForElement) {
      listenersForElement = [];
      listenersForCommand.set(element, listenersForElement);
    }
    const inlineListener = new InlineListener(commandName, listener);
    listenersForElement.push(inlineListener);

    this.commandRegistered(commandName);
    this.changeEmitter.emit("did-change");

    return new Disposable(() => {
      listenersForElement.splice(listenersForElement.indexOf(inlineListener), 1);
      if (listenersForElement.length === 0) {
        listenersForCommand.delete(element);
      }
      if (this.inlineListenersByCommandName[commandName] === listenersForCommand)
        this.changeEmitter.emit("did-change");
    });
  }

  /**
   * @category Accessing Commands
   */

  /**
   * @public
   * @status public
   *
   * Determine whether an enabled handler matches a target or its ancestors.
   * Registration scope is checked before its optional `isAvailable` predicate.
   * Handlers are never invoked. This follows the same route as command dispatch,
   * including detached targets and the target's own window.
   *
   * @param {Node|Window} target - The target from which the command would be dispatched.
   * @param {String} commandName - The command to look up.
   * @param {*} [detail] - The arguments that would be supplied to dispatch.
   * @returns {Boolean} Whether dispatch can reach an enabled handler.
   */
  canDispatch(target, commandName, detail) {
    if (!target || typeof commandName !== "string" || !commandName) return false;
    const inlineListeners = Object.hasOwn(this.inlineListenersByCommandName, commandName)
      ? this.inlineListenersByCommandName[commandName]
      : null;
    const selectorListeners = Object.hasOwn(this.selectorBasedListenersByCommandName, commandName)
      ? this.selectorBasedListenersByCommandName[commandName]
      : null;
    if (!inlineListeners && !selectorListeners?.length) return false;

    let query;
    const available = (listener, currentTarget) =>
      !listener.isAvailable ||
      isListenerAvailable(
        listener,
        currentTarget,
        (query ??= createAvailabilityQuery(this, target, commandName, detail)),
      );
    for (const currentTarget of commandTargetPath(target)) {
      if (
        inlineListeners?.get(currentTarget)?.some((listener) => available(listener, currentTarget))
      )
        return true;
      if (
        selectorListeners?.some(
          (listener) => listener.matchesTarget(currentTarget) && available(listener, currentTarget),
        )
      )
        return true;
    }
    return false;
  }

  /**
   * @public
   * @status public
   *
   * Find all registered commands matching a query.
   *
   *  * `name` The name of the command. For example, `user:insert-date`.
   *  * `displayName` The display name of the command. For example,
   *    `User: Insert Date`.
   * Additional metadata may also be present in the returned descriptor:
   *  * `description` a `String` describing the function of the command in more
   *    detail than the title
   *  * `tags` an `Array` of `Strings` that describe keywords related to the
   *    command
   *  Any additional nonstandard metadata provided when the command was `add`ed
   *  may also be present in the returned descriptor.
   *
   * @param {Object} params - Query parameters.
   * @param {Element} params.target - The hypothetical command target.
   * @returns {Array<Object>} Command descriptors containing the documented keys.
   */
  findCommands({ target }) {
    const commandNames = new Set();
    const commands = [];
    for (const currentTarget of commandTargetPath(target)) {
      let listeners;
      for (const name in this.inlineListenersByCommandName) {
        listeners = this.inlineListenersByCommandName[name];
        if (listeners.has(currentTarget) && !commandNames.has(name)) {
          commandNames.add(name);
          const targetListeners = listeners.get(currentTarget);
          commands.push(...targetListeners.map((listener) => listener.descriptor));
        }
      }

      for (const commandName in this.selectorBasedListenersByCommandName) {
        listeners = this.selectorBasedListenersByCommandName[commandName];
        for (const listener of listeners) {
          if (listener.matchesTarget(currentTarget)) {
            if (!commandNames.has(commandName)) {
              commandNames.add(commandName);
              commands.push(listener.descriptor);
            }
          }
        }
      }
    }

    return commands;
  }

  /**
   * @public
   * @status experimental
   *
   * Read persistent choice state from the nearest scoped command registration.
   * This never dispatches the command or loads its implementation. A matching
   * handler without state shadows an ancestor's state as it does its label.
   *
   * @param {String} commandName - Command whose state should be read.
   * @param {Object} options
   * @param {Node|Window} options.target - Dispatch target.
   * @param {*} [options.detail] - Arguments that would be passed to the command.
   * @returns {Object|null} Frozen `{type, checked}` or null for an ordinary command.
   */
  getCommandState(commandName, { target, detail } = {}) {
    if (!target || typeof commandName !== "string") return null;
    const inline = Object.hasOwn(this.inlineListenersByCommandName, commandName)
      ? this.inlineListenersByCommandName[commandName]
      : null;
    const selectors = Object.hasOwn(this.selectorBasedListenersByCommandName, commandName)
      ? this.selectorBasedListenersByCommandName[commandName]
      : null;
    for (const currentTarget of commandTargetPath(target)) {
      let listener = inline?.get(currentTarget)?.at(-1);
      if (!listener) {
        for (const candidate of selectors ?? []) {
          if (
            candidate.matchesTarget(currentTarget) &&
            (!listener || candidate.compare(listener) > 0)
          )
            listener = candidate;
        }
      }
      if (!listener) continue;
      const descriptor = listener.descriptor;
      if (descriptor.checked == null) return null;
      const type = descriptor.type === "radio" ? "radio" : "checkbox";
      try {
        const query = createAvailabilityQuery(this, target, commandName, detail);
        const checked =
          typeof descriptor.checked === "function"
            ? descriptor.checked.call(
                currentTarget,
                Object.freeze({
                  target,
                  currentTarget,
                  detail: query.detail,
                  get context() {
                    return query.context;
                  },
                }),
              )
            : descriptor.checked;
        if (typeof checked !== "boolean" && !(type === "checkbox" && checked === "mixed")) {
          if (typeof checked?.then === "function") Promise.resolve(checked).catch(() => {});
          throw new TypeError(
            "Command checked must return a Boolean, or 'mixed' for a checkbox, synchronously.",
          );
        }
        return Object.freeze({ type, checked });
      } catch (error) {
        if (!listener.reportedStateError) {
          listener.reportedStateError = true;
          console.error(`Unable to evaluate command '${commandName}' choice state`, error);
        }
        return Object.freeze({ type, checked: false });
      }
    }
    return null;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the display metadata and effective keybindings for one command at a
   * target. This is the shared presentation used by command pickers and modal
   * action lists.
   *
   * @param {String} commandName - Command to describe.
   * @param {Object} options
   * @param {Element} [options.target] - Element from which the command would be dispatched.
   * @param {Element} [options.bindingTarget=options.target] - Element where displayed keybindings resolve.
   * @param {*} [options.detail] - Arguments used to evaluate the command's availability.
   * @returns {Object|null} The scoped command descriptor with `keystrokes` and Boolean `enabled`, or null when no registration matches the scope.
   */
  getCommandPresentation(commandName, { target, bindingTarget = target, detail }) {
    const descriptor = this.findCommands({ target }).find(({ name }) => name === commandName);
    if (!descriptor) return null;

    const seen = new Set();
    const keystrokes = [];
    if (this.keymapManager) {
      for (const binding of this.keymapManager.findKeyBindings({
        command: commandName,
        target: bindingTarget,
      })) {
        if (seen.has(binding.keystrokes)) continue;
        seen.add(binding.keystrokes);
        keystrokes.push(binding.keystrokes);
      }
    }
    return Object.freeze({
      ...presentationMetadata(descriptor),
      ...this.getCommandState(commandName, { target, detail }),
      enabled: this.canDispatch(target, commandName, detail),
      keystrokes: Object.freeze(keystrokes),
    });
  }

  /**
   * @public
   * @status experimental
   *
   * Return presentation metadata for every effective command at a target.
   * Metadata and keybindings are each scanned once; availability uses the
   * indexed registrations of each command. Disabled commands remain visible.
   *
   * @param {Object} options
   * @param {Element} [options.target] - Element from which commands would be dispatched.
   * @param {Element} [options.bindingTarget=options.target] - Element where displayed keybindings resolve.
   * @returns {Array<Object>} One frozen descriptor per scoped command, each with Boolean `enabled` and frozen `keystrokes`.
   */
  getCommandPresentations({ target, bindingTarget = target }) {
    const keystrokesByCommand = new Map();
    if (this.keymapManager) {
      for (const binding of this.keymapManager.findKeyBindings({
        target: bindingTarget,
      })) {
        let state = keystrokesByCommand.get(binding.command);
        if (!state) {
          state = { seen: new Set(), keystrokes: [] };
          keystrokesByCommand.set(binding.command, state);
        }
        if (state.seen.has(binding.keystrokes)) continue;
        state.seen.add(binding.keystrokes);
        state.keystrokes.push(binding.keystrokes);
      }
    }

    const seenCommands = new Set();
    const presentations = [];
    for (const descriptor of this.findCommands({ target })) {
      if (seenCommands.has(descriptor.name)) continue;
      seenCommands.add(descriptor.name);
      const keystrokes = Object.freeze([
        ...(keystrokesByCommand.get(descriptor.name)?.keystrokes ?? []),
      ]);
      presentations.push(
        Object.freeze({
          ...presentationMetadata(descriptor),
          ...this.getCommandState(descriptor.name, { target }),
          enabled: this.canDispatch(target, descriptor.name),
          keystrokes,
        }),
      );
    }
    return Object.freeze(presentations);
  }

  /**
   * @category Dispatching Commands
   */

  /**
   * @public
   * @status public
   *
   * Simulate the dispatch of a command on a DOM node.
   *
   * This is useful for passing arguments to a command, as keymaps currently do not
   * support arguments; for example, add a new command with no arguments that
   * dispatches another command with arguments, and map the new command to a key binding.
   *
   * This can be useful for testing when you want to simulate the invocation of a
   * command on a detached DOM node. Otherwise, the DOM node in question needs to
   * be attached to the document so the event bubbles up to the root node to be
   * processed.
   *
   * @param {Node} target - The DOM node at which to start bubbling the command event.
   * @param {String} commandName - indicating the name of the command to dispatch.
   * @param {*} [detail] - Any value that will be assigned to the event's `.detail` property. Pass an object with multiple properties if you need multiple command arguments.
   * @returns {Promise<Array<*>>|null} Resolves to the listener results after all enabled matching handlers finish, or `null` when none is available. Rejected handler promises reject the returned promise; synchronous handler errors are thrown.
   */
  dispatch(target, commandName, detail) {
    const event = new CustomEvent(commandName, { bubbles: true, detail });
    Object.defineProperty(event, "target", { value: target });
    return this.handleCommandEvent(event);
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status public
   *
   * Invoke the given callback before dispatching a command event.
   *
   * @param {Function} callback - to be called before dispatching each command
   * @param {CustomEvent} callback.event - The Event that will be dispatched
   * @returns {Disposable} Removes the event subscription.
   */
  onWillDispatch(callback) {
    return this.emitter.on("will-dispatch", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback after dispatching a command event.
   *
   * @param {Function} callback - to be called after dispatching each command
   * @param {CustomEvent} callback.event - The Event that was dispatched
   * @returns {Disposable} Removes the event subscription.
   */
  onDidDispatch(callback) {
    return this.emitter.on("did-dispatch", callback);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the callback when command registrations are added, removed, cleared
   * or restored, or their availability is invalidated. Unlike dispatch subscriptions, this subscription survives
   * `clear()` and is disposed when the registry is destroyed.
   *
   * @param {Function} callback - Called after registrations change.
   * @param {Object} [callback.change] - A local availability change; absent for a global change.
   * @param {Node} [callback.change.target] - Only command targets within this subtree are affected.
   * @returns {Disposable} Removes the event subscription.
   */
  onDidChange(callback) {
    return this.changeEmitter.on("did-change", callback);
  }

  /**
   * @public
   * @status public
   *
   * Notify command surfaces that state used by `isAvailable` or `checked` changed.
   * Predicates are evaluated afresh on every query; this asks live presentations
   * such as the native application menu to refresh without a focus change.
   * @param {Object} [options] - Optional scope of a local state change.
   * @param {Node} [options.target] - The changed command subtree. Omit for domain-wide changes.
   * @returns {void}
   */
  invalidateAvailability({ target } = {}) {
    this.changeEmitter.emit("did-change", target ? Object.freeze({ target }) : undefined);
  }

  getSnapshot() {
    const snapshot = {};
    for (const commandName in this.selectorBasedListenersByCommandName) {
      const listeners = this.selectorBasedListenersByCommandName[commandName];
      snapshot[commandName] = listeners.slice();
    }
    return snapshot;
  }

  restoreSnapshot(snapshot) {
    this.selectorBasedListenersByCommandName = {};
    for (const commandName in snapshot) {
      const listeners = snapshot[commandName];
      this.selectorBasedListenersByCommandName[commandName] = listeners.slice();
    }
    this.changeEmitter.emit("did-change");
  }

  handleCommandEvent(event) {
    const targetWindow = commandTargetWindow(event.target);
    let propagationStopped = false;
    let immediatePropagationStopped = false;
    let matched = [];
    let hasChoiceState = false;
    let currentTarget = event.target;
    const scheduleChoiceRefresh = () => {
      if (hasChoiceState) {
        Promise.allSettled(matched).then(() =>
          this.invalidateAvailability({ target: event.target }),
        );
      }
    };

    const dispatchedEvent = new CustomEvent(event.type, {
      bubbles: true,
      detail: event.detail,
    });
    Object.defineProperty(dispatchedEvent, "eventPhase", {
      value: Event.BUBBLING_PHASE,
    });
    Object.defineProperty(dispatchedEvent, "currentTarget", {
      get() {
        return currentTarget;
      },
    });
    Object.defineProperty(dispatchedEvent, "target", { value: currentTarget });
    if (this.resolveContext)
      Object.defineProperty(dispatchedEvent, "context", {
        value: this.resolveContext(event),
      });
    Object.defineProperty(dispatchedEvent, "preventDefault", {
      value() {
        return event.preventDefault();
      },
    });
    Object.defineProperty(dispatchedEvent, "stopPropagation", {
      value() {
        event.stopPropagation();
        propagationStopped = true;
      },
    });
    Object.defineProperty(dispatchedEvent, "stopImmediatePropagation", {
      value() {
        event.stopImmediatePropagation();
        propagationStopped = true;
        immediatePropagationStopped = true;
      },
    });
    Object.defineProperty(dispatchedEvent, "abortKeyBinding", {
      value() {
        propagationStopped = true;
        immediatePropagationStopped = true;
        if (typeof event.abortKeyBinding === "function") {
          event.abortKeyBinding();
        }
      },
    });

    for (const key of Object.keys(event)) {
      if (!(key in dispatchedEvent)) {
        dispatchedEvent[key] = event[key];
      }
    }

    const dispatchToListeners = () => {
      this.emitter.emit("will-dispatch", dispatchedEvent);
      let availability;
      let disabledMatch = false;

      for (currentTarget of commandTargetPath(event.target, targetWindow)) {
        const commandInlineListeners = this.inlineListenersByCommandName[event.type]
          ? this.inlineListenersByCommandName[event.type].get(currentTarget)
          : null;
        let listeners = commandInlineListeners || [];
        if (currentTarget.webkitMatchesSelector != null) {
          const selectorBasedListeners = (
            this.selectorBasedListenersByCommandName[event.type] || []
          )
            .filter((listener) => listener.matchesTarget(currentTarget))
            .sort((a, b) => a.compare(b));
          listeners = selectorBasedListeners.concat(listeners);
        }

        // Call inline listeners first in reverse registration order,
        // and selector-based listeners by specificity and reverse
        // registration order.
        for (let i = listeners.length - 1; i >= 0; i--) {
          const listener = listeners[i];
          if (immediatePropagationStopped) {
            break;
          }
          if (
            listener.isAvailable &&
            !isListenerAvailable(
              listener,
              currentTarget,
              (availability ??= createAvailabilityQuery(
                this,
                event.target,
                event.type,
                event.detail,
                () => dispatchedEvent.context,
              )),
            )
          ) {
            disabledMatch = true;
            continue;
          }
          hasChoiceState ||= listener.descriptor.checked != null;
          try {
            matched.push(listener.didDispatch.call(currentTarget, dispatchedEvent));
          } catch (error) {
            scheduleChoiceRefresh();
            throw error;
          }
        }

        if (propagationStopped) {
          break;
        }
      }

      this.emitter.emit("did-dispatch", dispatchedEvent);
      if (matched.length === 0) {
        if (disabledMatch) event.abortKeyBinding?.();
        return null;
      }
      const result = Promise.all(matched);
      // Ordinary editing commands do not rebuild command surfaces. A choice
      // command refreshes after all matched handlers settle, including failures.
      scheduleChoiceRefresh();
      // Native DOM dispatch ignores a listener's return value. Observe the
      // rejection here while returning the original Promise to programmatic
      // callers, which can still await and handle the same failure.
      result.catch(() => {});
      return result;
    };

    return dispatchToListeners();
  }

  commandRegistered(commandName) {
    if (this.rootNodes.size && !this.registeredCommands[commandName]) {
      for (const root of this.rootNodes) {
        root.addEventListener(commandName, this.handleCommandEvent, { capture: true });
      }
      return (this.registeredCommands[commandName] = true);
    }
  }
};

// Commands bubble through the target's document, then its own window. Detached
// targets follow the same route without crossing into the registry's window.
function* commandTargetPath(target, targetWindow = commandTargetWindow(target)) {
  if (!target) return;
  let currentTarget = target;
  while (true) {
    yield currentTarget;
    if (currentTarget === targetWindow) return;
    currentTarget = currentTarget.parentNode || targetWindow;
  }
}

function commandTargetWindow(target) {
  return (
    target?.ownerDocument?.defaultView ??
    target?.defaultView ??
    (target?.window === target ? target : window)
  );
}

// type Listener = {
//   descriptor: CommandDescriptor,
//   extractDidDispatch: (e: CustomEvent) => void,
// };
class SelectorBasedListener {
  constructor(selector, commandName, listener) {
    this.selector = selector;
    this.didDispatch = extractDidDispatch(listener);
    this.isAvailable = listener.isAvailable;
    this.metadata = extractMetadata(listener);
    this.descriptor = descriptorFromMetadata(commandName, this.metadata);
    this.specificity = calculateSpecificity(this.selector);
    this.sequenceNumber = SequenceCount++;
  }

  compare(other) {
    return this.specificity - other.specificity || this.sequenceNumber - other.sequenceNumber;
  }

  matchesTarget(target) {
    return target.webkitMatchesSelector && target.webkitMatchesSelector(this.selector);
  }
}

class InlineListener {
  constructor(commandName, listener) {
    this.didDispatch = extractDidDispatch(listener);
    this.isAvailable = listener.isAvailable;
    this.descriptor = extractDescriptor(commandName, listener);
  }
}

// type CommandDescriptor = {
//   name: string,
//   displayName: string,
// };
function extractDescriptor(name, listener) {
  return descriptorFromMetadata(name, extractMetadata(listener));
}

function presentationMetadata(descriptor) {
  return _.omit(
    descriptor,
    "checked",
    ...(["checkbox", "radio"].includes(descriptor.type) ? ["type"] : []),
  );
}

function descriptorFromMetadata(name, metadata) {
  return Object.assign({}, metadata, {
    name,
    displayName: metadata.displayName ? metadata.displayName : _.humanizeEventName(name),
  });
}

function extractMetadata(listener) {
  return _.omit(listener, "didDispatch", "isAvailable", "name");
}

function createAvailabilityQuery(registry, target, commandName, detail, resolveContext) {
  const event = Object.freeze({ target, type: commandName, detail: detail ?? null });
  let resolved = false;
  let context;
  let error;
  return {
    target,
    detail: event.detail,
    get context() {
      if (!resolved) {
        resolved = true;
        try {
          context = resolveContext ? resolveContext() : registry.resolveContext?.(event);
        } catch (failure) {
          error = failure;
        }
      }
      if (error) throw error;
      return context;
    },
  };
}

function isListenerAvailable(listener, currentTarget, query) {
  if (!listener.isAvailable) return true;
  try {
    const result = listener.isAvailable.call(
      currentTarget,
      Object.freeze({
        target: query.target,
        currentTarget,
        detail: query.detail,
        get context() {
          return query.context;
        },
      }),
    );
    if (typeof result !== "boolean") {
      if (typeof result?.then === "function") Promise.resolve(result).catch(() => {});
      throw new TypeError("Command isAvailable must return a Boolean synchronously.");
    }
    return result;
  } catch (error) {
    if (!listener.reportedAvailabilityError) {
      listener.reportedAvailabilityError = true;
      console.error(`Unable to evaluate command '${listener.descriptor.name}' availability`, error);
    }
    return false;
  }
}

function extractDidDispatch(listener) {
  return typeof listener === "function" ? listener : listener.didDispatch;
}
