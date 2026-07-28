"use strict";

// Shared vocabulary for modal specs. Every migrated package's specs assert
// through these rather than reaching for `getModalPanels()` or the old view's
// internals, so the 40-odd rewrites share one idiom.

function activeSession() {
  return atom.modals.getActiveSession();
}

function modalElement() {
  const session = activeSession();
  return session ? session.element : null;
}

function isModalOpen() {
  return atom.modals.isOpen();
}

function queryText() {
  const session = activeSession();
  return session ? session.getQuery().raw : "";
}

function setQuery(text) {
  const session = activeSession();
  if (!session) throw new Error("modal-helpers: no modal is open");
  session.setQuery(text);
}

// Item labels as the user would read them, straight off the rendered rows.
function visibleLabels() {
  const element = modalElement();
  if (!element) return [];
  return Array.from(element.querySelectorAll("ol.list-group > li")).map((li) => {
    const primary = li.querySelector(".primary-text");
    return (primary ?? li).textContent;
  });
}

function visibleItems() {
  const session = activeSession();
  return session ? session.getVisibleItems() : [];
}

function focusedItem() {
  const session = activeSession();
  return session ? session.getFocusedItem() : null;
}

function focusedLabel() {
  const element = modalElement();
  if (!element) return null;
  const selected = element.querySelector("ol.list-group > li.selected");
  if (!selected) return null;
  const primary = selected.querySelector(".primary-text");
  return (primary ?? selected).textContent;
}

function statusText() {
  const element = modalElement();
  if (!element) return "";
  const status = element.querySelector(".modals-status");
  if (!status || status.style.display === "none") return "";
  return status.textContent;
}

function emptyMessageText() {
  const element = modalElement();
  if (!element) return "";
  const empty = element.querySelector(".empty-message");
  if (!empty || empty.style.display === "none") return "";
  return empty.textContent;
}

function dispatch(commandName) {
  const element = modalElement();
  if (!element) throw new Error("modal-helpers: no modal is open");
  return atom.commands.dispatch(element, commandName);
}

const confirm = () => dispatch("core:confirm");

// Focuses a specific row and confirms it, as if the user had arrowed to it.
// `target` is either the item itself or a predicate.
async function confirmItem(target) {
  const session = activeSession();
  if (!session) throw new Error("modal-helpers: no modal is open");
  const match = typeof target === "function" ? target : (item) => item === target;
  const index = session.getVisibleItems().findIndex(match);
  if (index < 0) throw new Error("modal-helpers: no visible item matched");
  session.focusIndex(index);
  confirm();
  await settle();
}
const cancel = () => dispatch("core:cancel");
const moveDown = () => dispatch("core:move-down");
const moveUp = () => dispatch("core:move-up");

// Drives the kernel's coalescing timers deterministically. All modal timing
// goes through `window.setTimeout`, so `advanceClock` reaches every hop.
function flush(ms = 0) {
  if (typeof advanceClock === "function") advanceClock(ms);
}

// Settles the active session: drains pending timers and microtasks, then waits
// on whatever source run is in flight. Loops because one hop is not always
// enough — a confirm handler that pushes resolves first, and only then does the
// child's own source start — and stops as soon as nothing changed.
async function settle(maxPasses = 4) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const session = activeSession();
    if (!session) return;
    const before = session.frames.length > 0 ? session.frame : null;
    const beforeRun = before ? before.run : null;

    flush(0);
    await Promise.resolve();

    // The session can close while we yield — an action that confirms, a blur —
    // and a closed session has no frames left to wait on.
    const current = activeSession();
    const run = current && current.frames.length > 0 ? current.frame.run : null;
    if (run) await run.whenSettled();
    flush(0);
    await Promise.resolve();

    const after = activeSession();
    const afterFrame = after && after.frames.length > 0 ? after.frame : null;
    if (
      after === session &&
      afterFrame === before &&
      (!afterFrame || afterFrame.run === beforeRun)
    ) {
      return;
    }
  }
}

module.exports = {
  activeSession,
  modalElement,
  isModalOpen,
  queryText,
  setQuery,
  visibleLabels,
  visibleItems,
  focusedItem,
  focusedLabel,
  statusText,
  emptyMessageText,
  dispatch,
  confirm,
  confirmItem,
  cancel,
  moveDown,
  moveUp,
  flush,
  settle,
};
