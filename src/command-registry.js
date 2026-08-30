"use strict";

const { Emitter, Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const { calculateSpecificity, validateSelector } = require("./css-selectors");
const _ = require("@lumine-code/underscore-plus");
const { customEventFor, eventPhaseFor, windowFor } = require("./dom-context");

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
  constructor({ surfaceManager = null } = {}) {
    this.handleCommandEvent = this.handleCommandEvent.bind(this);
    this.surfaceManager = surfaceManager;
    this.rootNodes = new Set();
    this.registeredCommandsByRoot = new Map();
    this.clear();
  }

  clear() {
    for (const [rootNode, commandNames] of this.registeredCommandsByRoot) {
      for (const commandName of commandNames) {
        rootNode.removeEventListener(commandName, this.handleCommandEvent, true);
      }
      commandNames.clear();
    }
    this.registeredCommands = {};
    this.selectorBasedListenersByCommandName = {};
    this.inlineListenersByCommandName = {};
    this.emitter = new Emitter();
  }

  attach(rootNode) {
    if (!rootNode?.addEventListener || !rootNode?.removeEventListener) {
      throw new TypeError("A command root must be a DOM EventTarget");
    }
    if (this.rootNodes.has(rootNode)) return new Disposable();
    this.rootNodes.add(rootNode);
    this.registeredCommandsByRoot.set(rootNode, new Set());
    for (const command in this.selectorBasedListenersByCommandName) {
      this.commandRegistered(command);
    }

    for (const command in this.inlineListenersByCommandName) {
      this.commandRegistered(command);
    }
    return new Disposable(() => this.detach(rootNode));
  }

  detach(rootNode) {
    if (!this.rootNodes.delete(rootNode)) return false;
    const commandNames = this.registeredCommandsByRoot.get(rootNode);
    if (commandNames) {
      for (const commandName of commandNames) {
        rootNode.removeEventListener(commandName, this.handleCommandEvent, true);
      }
    }
    this.registeredCommandsByRoot.delete(rootNode);
    return true;
  }

  destroy() {
    for (const rootNode of Array.from(this.rootNodes)) this.detach(rootNode);
  }

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

    return new Disposable(() => {
      listenersForCommand.splice(listenersForCommand.indexOf(selectorListener), 1);
      if (listenersForCommand.length === 0) {
        delete this.selectorBasedListenersByCommandName[commandName];
      }
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

    return new Disposable(() => {
      listenersForElement.splice(listenersForElement.indexOf(inlineListener), 1);
      if (listenersForElement.length === 0) {
        listenersForCommand.delete(element);
      }
    });
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
    let currentTarget = target;
    while (true) {
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

      const targetWindow = windowFor(target);
      if (currentTarget === targetWindow) {
        break;
      }
      currentTarget = currentTarget.parentNode || targetWindow;
    }

    return commands;
  }

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
   * @param target - The DOM node at which to start bubbling the command event.
   * @param {String} commandName - indicating the name of the command to dispatch.
   * @param detail - Any value that will be assigned to the event's `.detail` property. Pass an object with multiple properties if you need multiple command arguments.
   */
  dispatch(target, commandName, detail) {
    const event = customEventFor(target, commandName, { bubbles: true, detail });
    Object.defineProperty(event, "target", { value: target });
    return this.handleCommandEvent(event);
  }

  /**
   * @public
   * @status public
   *
   * Invoke the given callback before dispatching a command event.
   *
   * @param {Function} callback - to be called before dispatching each command
   * @param callback.event - The Event that will be dispatched
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
   * @param callback.event - The Event that was dispatched
   */
  onDidDispatch(callback) {
    return this.emitter.on("did-dispatch", callback);
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
  }

  handleCommandEvent(event) {
    const surface = this.surfaceManager?.surfaceFor(event.target);
    if (surface) this.surfaceManager.activate(surface);
    let propagationStopped = false;
    let immediatePropagationStopped = false;
    let matched = [];
    let currentTarget = event.target;

    const targetWindow = windowFor(event.target);
    if (!targetWindow) throw new TypeError("A command target must belong to a live Window");
    const dispatchedEvent = customEventFor(event.target, event.type, {
      bubbles: true,
      detail: event.detail,
    });
    Object.defineProperty(dispatchedEvent, "eventPhase", {
      value: eventPhaseFor(event.target, "BUBBLING_PHASE"),
    });
    Object.defineProperty(dispatchedEvent, "currentTarget", {
      get() {
        return currentTarget;
      },
    });
    Object.defineProperty(dispatchedEvent, "target", { value: currentTarget });
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

    this.emitter.emit("will-dispatch", dispatchedEvent);

    while (true) {
      const commandInlineListeners = this.inlineListenersByCommandName[event.type]
        ? this.inlineListenersByCommandName[event.type].get(currentTarget)
        : null;
      let listeners = commandInlineListeners || [];
      if (currentTarget.webkitMatchesSelector != null) {
        const selectorBasedListeners = (this.selectorBasedListenersByCommandName[event.type] || [])
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
        matched.push(listener.didDispatch.call(currentTarget, dispatchedEvent));
      }

      if (currentTarget === targetWindow) {
        break;
      }
      if (propagationStopped) {
        break;
      }
      currentTarget = currentTarget.parentNode || targetWindow;
    }

    this.emitter.emit("did-dispatch", dispatchedEvent);

    return matched.length > 0 ? Promise.all(matched) : null;
  }

  commandRegistered(commandName) {
    for (const rootNode of this.rootNodes) {
      const registeredCommands = this.registeredCommandsByRoot.get(rootNode);
      if (!registeredCommands.has(commandName)) {
        rootNode.addEventListener(commandName, this.handleCommandEvent, { capture: true });
        registeredCommands.add(commandName);
      }
    }
    this.registeredCommands[commandName] = true;
  }
};

// type Listener = {
//   descriptor: CommandDescriptor,
//   extractDidDispatch: (e: CustomEvent) => void,
// };
class SelectorBasedListener {
  constructor(selector, commandName, listener) {
    this.selector = selector;
    this.didDispatch = extractDidDispatch(listener);
    this.descriptor = extractDescriptor(commandName, listener);
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
    this.descriptor = extractDescriptor(commandName, listener);
  }
}

// type CommandDescriptor = {
//   name: string,
//   displayName: string,
// };
function extractDescriptor(name, listener) {
  return Object.assign(_.omit(listener, "didDispatch"), {
    name,
    displayName: listener.displayName ? listener.displayName : _.humanizeEventName(name),
  });
}

function extractDidDispatch(listener) {
  return typeof listener === "function" ? listener : listener.didDispatch;
}
