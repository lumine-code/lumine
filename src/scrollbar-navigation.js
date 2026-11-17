const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");

const ATTRIBUTE = "data-lumine-scroll-navigation";
const CONTROLS = [
  "input",
  "textarea",
  "select",
  "button",
  "a",
  "summary",
  "lumine-text-editor",
  "iframe",
  "webview",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  ...[
    "application",
    "button",
    "checkbox",
    "combobox",
    "grid",
    "link",
    "listbox",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "radiogroup",
    "scrollbar",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "tablist",
    "textbox",
    "toolbar",
    "tree",
    "treegrid",
    "treeitem",
  ].map((role) => `[role~='${role}']`),
];
const CONTROL_SELECTOR = CONTROLS.join(",");
const READONLY_FOCUS = `:focus:not(${[...CONTROLS, ...CONTROLS.map((selector) => `${selector} *`)].join(",")})`;

const COMMANDS = {
  "core:move-up": ["vertical", -1, "line"],
  "core:move-down": ["vertical", 1, "line"],
  "core:move-left": ["horizontal", -1, "line"],
  "core:move-right": ["horizontal", 1, "line"],
  "core:page-up": ["vertical", -1, "page"],
  "core:page-down": ["vertical", 1, "page"],
  "core:move-to-top": ["vertical", -1, "edge"],
  "core:move-to-bottom": ["vertical", 1, "edge"],
};

function ownsTarget(manager, element, target) {
  if (!element.ownerDocument.defaultView || !target?.closest || !element.contains(target))
    return false;
  for (let node = element; node; node = node.parentElement)
    if (node.hidden || node.inert || node.style?.display === "none") return false;
  if (target.isContentEditable || target.closest(CONTROL_SELECTOR)) return false;
  const controllers = manager.documents.get(element.ownerDocument)?.controllers;
  for (let node = target; node && node !== element; node = node.parentElement)
    if (
      controllers?.has(node) ||
      manager.navigationBindings.has(node) ||
      node.classList.contains("lumine-scrollport")
    )
      return false;
  return true;
}

function scroll(element, axis, direction, unit) {
  const vertical = axis === "vertical";
  const position = vertical ? "scrollTop" : "scrollLeft";
  const extent = vertical ? "scrollHeight" : "scrollWidth";
  const viewport = vertical ? "clientHeight" : "clientWidth";
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  const line = parseFloat(style.lineHeight) || 20;
  let next;
  if (unit === "edge") next = direction < 0 ? 0 : element[extent];
  else {
    const distance = unit === "page" ? Math.max(line, element[viewport] - line) : line;
    next = element[position] + direction * distance;
  }
  element.scrollTo({ [vertical ? "top" : "left"]: next, behavior: "instant" });
}

function createKeymap(keymaps) {
  const selector = `[${ATTRIBUTE}]`;
  const scopes = [`${selector}${READONLY_FOCUS}`, `${selector} ${READONLY_FOCUS}`];
  const scope = scopes.join(", ");
  const platformScope = (...platforms) =>
    platforms.flatMap((platform) => scopes.map((value) => `.${platform} ${value}`)).join(", ");
  const keys = {
    up: "core:move-up",
    down: "core:move-down",
    left: "core:move-left",
    right: "core:move-right",
    home: "core:move-to-top",
    end: "core:move-to-bottom",
    pageup: "core:page-up",
    pagedown: "core:page-down",
    space: "core:page-down",
    "shift-space": "core:page-up",
  };
  return keymaps.add("core-scrollbar-navigation", {
    [scope]: keys,
    [platformScope("platform-win32", "platform-linux")]: {
      "ctrl-home": "core:move-to-top",
      "ctrl-end": "core:move-to-bottom",
    },
    [platformScope("platform-darwin")]: {
      "cmd-up": "core:move-to-top",
      "cmd-down": "core:move-to-bottom",
    },
  });
}

function bindNavigation(manager, element, id) {
  const previous = element.getAttribute(ATTRIBUTE);
  element.setAttribute(ATTRIBUTE, id);
  const commands = Object.fromEntries(
    Object.entries(COMMANDS).map(([name, args]) => [
      name,
      {
        isAvailable: ({ target }) => ownsTarget(manager, element, target),
        didDispatch(event) {
          event.stopPropagation();
          // Adoption can precede the destination's scheduled layout scan.
          // Retire the old document's chrome before reading native positions.
          const controller = manager.documents.get(element.ownerDocument)?.controllers.get(element);
          if (!controller || controller.destroyed) manager.attach(element);
          scroll(element, ...args);
        },
      },
    ]),
  );
  const subscriptions = new CompositeDisposable(
    new Disposable(() => {
      if (element.getAttribute(ATTRIBUTE) === String(id)) {
        if (previous === null) element.removeAttribute(ATTRIBUTE);
        else element.setAttribute(ATTRIBUTE, previous);
      }
      manager.navigationBindings.delete(element);
      if (manager.navigationBindings.size === 0) {
        manager.navigationKeymap?.dispose();
        manager.navigationKeymap = null;
      }
    }),
  );
  try {
    subscriptions.add(
      manager.environment.commands.add(element, manager.navigationCommands(element, commands)),
    );
  } catch (error) {
    subscriptions.dispose();
    throw error;
  }
  return subscriptions;
}

module.exports = { bindNavigation, createKeymap };
