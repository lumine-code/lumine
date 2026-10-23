const timers = require("node:timers");

const timeout = timers.setTimeout(() => {}, 0);
const immediate = timers.setImmediate(() => {});
const Timeout = timeout.constructor;
const Immediate = immediate.constructor;
timers.clearTimeout(timeout);
timers.clearImmediate(immediate);

const ids = new WeakMap();
let nextId = 1;

// Jasmine formats both sides even for a passing toBe assertion. Node timer
// handles can carry an opaque V8 async-context frame under an enumerable
// symbol; traversing that value aborts Electron instead of throwing JS.
// Treat handles as identities, without inspecting their private fields.
module.exports = function formatNodeTimer(value) {
  const kind =
    value instanceof Timeout ? "Timeout" : value instanceof Immediate ? "Immediate" : null;
  if (!kind) return undefined;
  if (!ids.has(value)) ids.set(value, nextId++);
  return `Node ${kind} #${ids.get(value)}`;
};
