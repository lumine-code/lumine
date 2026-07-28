"use strict";

// Action-set normalization, the built-in verb table, and `ActionResult`
// application.
//
// Every verb a modal exposes is an Action object rather than a named callback,
// because only an object can also carry the label the help view shows, the
// default keystroke the kernel registers, the availability predicate, and the
// multi-item flag. `confirm` / `confirmSecondary` / `confirmEmpty` on a
// ViewSpec are shorthands normalized into this set.

const BUILT_INS = [
  { name: "confirm", label: "Confirm", when: "always", builtin: true },
  { name: "confirm-secondary", label: "Confirm (secondary)", when: "item", builtin: true },
  { name: "cancel", label: "Cancel", when: "always", builtin: true },
  { name: "cancel-all", label: "Close all", when: "always", builtin: true },
  { name: "back", label: "Back", when: "always", builtin: true },
  { name: "help", label: "Help", when: "always", builtin: true },
  { name: "query-from-selection", label: "Use selection as query", when: "always", builtin: true },
];

function normalizeAction(action) {
  if (!action || typeof action.name !== "string") {
    throw new TypeError("modals: every action needs a `name`");
  }
  return {
    name: action.name,
    label: action.label ?? action.name,
    keystroke: action.keystroke,
    when: action.when ?? "item",
    multi: !!action.multi,
    hidden: !!action.hidden,
    keepOpen: !!action.keepOpen,
    busy: action.busy ?? "indicate",
    builtin: !!action.builtin,
    run: action.run,
  };
}

// Merges spec shorthands and the caller's actions over the built-in table.
// Later definitions of the same name win, so a consumer can replace `confirm`.
function normalizeActions(spec) {
  const byName = new Map();
  for (const action of BUILT_INS) byName.set(action.name, normalizeAction(action));

  const declared = Array.isArray(spec.actions)
    ? spec.actions
    : spec.actions && Array.isArray(spec.actions.actions)
      ? spec.actions.actions
      : [];

  if (typeof spec.confirm === "function") {
    byName.set(
      "confirm",
      normalizeAction({ name: "confirm", label: "Confirm", when: "always", run: spec.confirm }),
    );
  }
  if (typeof spec.confirmSecondary === "function") {
    byName.set(
      "confirm-secondary",
      normalizeAction({
        name: "confirm-secondary",
        label: "Confirm (secondary)",
        when: "item",
        run: spec.confirmSecondary,
      }),
    );
  }
  if (typeof spec.confirmEmpty === "function") {
    byName.set(
      "confirm-empty",
      normalizeAction({
        name: "confirm-empty",
        label: "Confirm",
        when: "empty",
        run: spec.confirmEmpty,
      }),
    );
  }

  for (const action of declared) {
    byName.set(action.name, normalizeAction(action));
  }

  const overrides = spec.actions && !Array.isArray(spec.actions) ? spec.actions.override : null;
  if (overrides) {
    for (const name of Object.keys(overrides)) {
      const base = byName.get(name);
      if (!base) continue;
      byName.set(name, { ...base, run: overrides[name](base.run) });
    }
  }

  return Array.from(byName.values());
}

function isAvailable(action, ctx) {
  if (typeof action.when === "function") return !!action.when(ctx);
  switch (action.when) {
    case "always":
      return true;
    case "empty":
      return ctx.item == null;
    case "item":
    default:
      return ctx.item != null;
  }
}

module.exports = { BUILT_INS, normalizeAction, normalizeActions, isAvailable };
