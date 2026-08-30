const _ = require("@lumine-code/underscore-plus");
const { Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
let Tooltip = null;

/**
 * @public
 * @status essential
 *
 * Associates tooltips with HTML elements.
 *
 * You can get the `TooltipManager` via `lumine.tooltips`.
 *
 * ## Examples
 *
 * The essence of displaying a tooltip
 *
 * ```js
 * // display it
 * const disposable = lumine.tooltips.add(div, {title: 'This is a tooltip'})
 *
 * // remove it
 * disposable.dispose()
 * ```
 *
 * In practice there are usually multiple tooltips. So we add them to a
 * CompositeDisposable
 *
 * ```js
 * const {CompositeDisposable} = require('lumine')
 * const subscriptions = new CompositeDisposable()
 *
 * const div1 = document.createElement('div')
 * const div2 = document.createElement('div')
 * subscriptions.add(lumine.tooltips.add(div1, {title: 'This is a tooltip'}))
 * subscriptions.add(lumine.tooltips.add(div2, {title: 'Another tooltip'}))
 *
 * // remove them all
 * subscriptions.dispose()
 * ```
 *
 * You can display a key binding in the tooltip as well with the
 * `keyBindingCommand` option.
 *
 * ```js
 * disposable = lumine.tooltips.add(this.caseOptionButton, {
 *   title: 'Match Case',
 *   keyBindingCommand: 'search-panel:toggle-case-option',
 *   keyBindingTarget: this.findEditor.element
 * })
 * ```
 *
 * To display several tooltip entries together, use `addComposite`.
 *
 * ```js
 * disposable = lumine.tooltips.addComposite(this.modeIndicator, [
 *   {title: 'Column selection'},
 *   {
 *     title: 'Toggle sticky mode',
 *     keyBindingExtra: 'LMB',
 *     keyBindingCommand: 'column-selection:sticky'
 *   },
 *   {
 *     title: 'Toggle picker mode',
 *     keyBindingExtra: 'RMB',
 *     keyBindingCommand: 'column-selection:picker'
 *   }
 * ])
 * ```
 */
module.exports = class TooltipManager {
  constructor({ keymapManager, viewRegistry }) {
    this.defaults = {
      trigger: "hover",
      container: "body",
      html: true,
      placement: "auto top",
      viewportPadding: 2,
    };

    this.hoverDefaults = {
      delay: { show: 1000, hide: 100 },
    };

    this.keymapManager = keymapManager;
    this.viewRegistry = viewRegistry;
    this.tooltips = new Map();
  }

  /**
   * @public
   * @status essential
   *
   * Add a tooltip to the given element.
   *
   * @param target - An `HTMLElement`
   * @param options - An object with one or more of the following options:
   * @param options.title - A `String` or `Function` to use for the text in the tip. If a function is passed, `this` will be set to the `target` element. This option is mutually exclusive with the `item` option.
   * @param options.html - A `Boolean` affecting the interpretation of the `title` option. If `true` (the default), the `title` string will be interpreted as HTML. Otherwise it will be interpreted as plain text.
   * @param options.item - A view (object with an `.element` property) or a DOM element containing custom content for the tooltip. This option is mutually exclusive with the `title` option.
   * @param options.class - A `String` with a class to apply to the tooltip element to enable custom styling.
   * @param options.placement - A `String` or `Function` returning a string to indicate the position of the tooltip relative to `element`. Can be `'top'`, `'bottom'`, `'left'`, `'right'`, or `'auto'`. When `'auto'` is specified, it will dynamically reorient the tooltip. For example, if placement is `'auto left'`, the tooltip will display to the left when possible, otherwise it will display right. When a function is used to determine the placement, it is called with the tooltip DOM node as its first argument and the triggering element DOM node as its second. The `this` context is set to the tooltip instance.
   * @param options.trigger - A `String` indicating how the tooltip should be displayed. Choose from one of the following options:
   * @param options.trigger.'hover' - Show the tooltip when the mouse hovers over the element. This is the default.
   * @param options.trigger.'click' - Show the tooltip when the element is clicked. The tooltip will be hidden after clicking the element again or anywhere else outside of the tooltip itself.
   * @param options.trigger.'focus' - Show the tooltip when the element is focused.
   * @param options.trigger.'manual' - Show the tooltip immediately and only hide it when the returned disposable is disposed.
   * @param options.delay - An object specifying the show and hide delay in milliseconds. Defaults to `{show: 1000, hide: 100}` if the `trigger` is `hover` and otherwise defaults to `0` for both values.
   * @param options.keyBindingCommand - A `String` containing a command name. If you specify this option and a key binding exists that matches the command, it will be appended to the title or rendered alone if no title is specified.
   * @param options.keyBindingTarget - An `HTMLElement` on which to look up the key binding. If this option is not supplied, the first of all matching key bindings for the given command will be rendered.
   * @param options.keyBindingExtra - A `String` rendered as an additional key binding before the command's resolved binding. Use this for interactions that are not represented in the keymap, such as `LMB` or `RMB`. The value accepts `+` separators and `cmdorctrl`, which is resolved for the current platform (for example, `cmdorctrl+RMB`).
   * @returns {Disposable} on which `.dispose()` can be called to remove the tooltip.
   */
  add(target, options) {
    if (target.jquery) {
      const disposable = new CompositeDisposable();
      for (let i = 0; i < target.length; i++) {
        disposable.add(this.add(target[i], options));
      }
      return disposable;
    }

    return this.addTooltip(target, this.getTooltipOptions(options));
  }

  /**
   * @public
   * @status essential
   *
   * Add several tooltip entries that are displayed together.
   *
   * @param target - An `HTMLElement`
   * @param entries - An `Array` of option objects accepted by {@link #add}. Entries are rendered on separate lines. Display options, such as `placement` and `delay`, are taken from the first entry.
   * @returns {Disposable} on which `.dispose()` can be called to remove the composite tooltip.
   */
  addComposite(target, entries) {
    if (target.jquery) {
      const disposable = new CompositeDisposable();
      for (let i = 0; i < target.length; i++) {
        disposable.add(this.addComposite(target[i], entries));
      }
      return disposable;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("`entries` must be a non-empty array of tooltip options.");
    }
    if (entries.some((entry) => entry.item != null)) {
      throw new Error("Composite tooltips do not support the `item` option.");
    }

    const options = entries.map((entry) => this.getTooltipOptions(entry));
    const titles = options.map((option) => ({
      title: option.title,
      hasKeyBinding: option.keyBindingCommand != null || option.keyBindingExtra != null,
    }));
    const compositeOptions = options[0];
    compositeOptions.title = function () {
      const items = titles
        .map(({ title, hasKeyBinding }) => {
          const content = typeof title === "function" ? title.call(this) : title;
          const className = hasKeyBinding
            ? "tooltip-composite-item has-key-binding"
            : "tooltip-composite-item";
          return content && `<div class="${className}">${content}</div>`;
        })
        .filter(Boolean)
        .join("");
      return items && `<div class="tooltip-composite">${items}</div>`;
    };

    return this.addTooltip(target, compositeOptions);
  }

  getTooltipOptions(options) {
    if (Tooltip == null) {
      Tooltip = require("./tooltip");
    }

    options = { ...options };
    const { keyBindingCommand, keyBindingExtra, keyBindingTarget } = options;

    if (keyBindingCommand != null || keyBindingExtra != null) {
      const keymapManager = this.keymapManager;
      const baseTitle = options.title;
      options.title = function () {
        const base = typeof baseTitle === "function" ? baseTitle.call(this) : baseTitle;
        const keyBindings = [
          keyBindingExtra != null && getKeyBindingExtraLabel(keyBindingExtra),
          keyBindingCommand != null &&
            getKeyBinding(keymapManager, keyBindingCommand, keyBindingTarget),
        ].filter(Boolean);
        const keyBindingGroup = keyBindings.length
          ? `<span class="key-bindings">${keyBindings.join(" ")}</span>`
          : null;
        return [base, keyBindingGroup].filter(Boolean).join(" ");
      };
    }

    delete options.selector;
    options = _.defaults(options, this.defaults);
    if (options.trigger === "hover") {
      options = _.defaults(options, this.hoverDefaults);
    }

    return options;
  }

  addTooltip(target, options) {
    const tooltip = new Tooltip(target, options, this.viewRegistry);

    if (!this.tooltips.has(target)) {
      this.tooltips.set(target, []);
    }
    this.tooltips.get(target).push(tooltip);

    const hideTooltip = function () {
      tooltip.leave({ currentTarget: target });
      tooltip.hide();
    };

    // note: adding a listener here adds a new listener for every tooltip element that's registered.  Adding unnecessary listeners is bad for performance.  It would be better to add/remove listeners when tooltips are actually created in the dom.
    window.addEventListener("resize", hideTooltip);

    const disposable = new Disposable(() => {
      window.removeEventListener("resize", hideTooltip);

      hideTooltip();
      tooltip.destroy();

      if (this.tooltips.has(target)) {
        const tooltipsForTarget = this.tooltips.get(target);
        const index = tooltipsForTarget.indexOf(tooltip);
        if (index !== -1) {
          tooltipsForTarget.splice(index, 1);
        }
        if (tooltipsForTarget.length === 0) {
          this.tooltips.delete(target);
        }
      }
    });

    return disposable;
  }

  /**
   * @public
   * @status extended
   *
   * Find the tooltips that have been applied to the given element.
   *
   * @param target - The `HTMLElement` to find tooltips on.
   * @returns {Array} of `Tooltip` objects that match the `target`.
   */
  findTooltips(target) {
    if (this.tooltips.has(target)) {
      return this.tooltips.get(target).slice();
    } else {
      return [];
    }
  }
};

function getKeyBinding(keymapManager, command, target) {
  const bindings = keymapManager.findKeyBindings({ command, target });
  if (bindings && bindings.length) {
    return getKeyBindingLabel(_.humanizeKeystroke(bindings[0].keystrokes));
  }
}

function getKeyBindingLabel(label) {
  return `<span class="keystroke">${label}</span>`;
}

function getKeyBindingExtraLabel(label) {
  const keystroke = label
    .replace(/\+/g, "-")
    .replace(/\b(cmdorctrl|cmd|ctrl|alt|option|shift)\b/gi, (modifier) => modifier.toLowerCase());
  return getKeyBindingLabel(_.humanizeKeystroke(keystroke));
}
