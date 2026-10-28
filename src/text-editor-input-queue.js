const pending = new WeakMap();
const prepared = require("./text-editor-prepared-indent");

// Input events must reach package advice in order, after earlier asynchronous
// edits have published. Otherwise Enter followed by typing/backspace operates
// on the old cursor and cancels the still-preparing newline.
function dispatchEditorInput(editor, operation) {
  if (prepared.activeInput(editor) != null) return operation();
  const version = prepared.notifyInput(editor);
  const previous = pending.get(editor);
  const invoke = () =>
    editor.isDestroyed?.() ? undefined : prepared.withInput(editor, version, operation);
  const result = previous ? previous.then(invoke, invoke) : invoke();
  if (!result?.then) return result;
  const task = Promise.resolve(result).finally(() => {
    if (pending.get(editor) === task) pending.delete(editor);
  });
  pending.set(editor, task);
  task.catch(() => {});
  return task;
}
dispatchEditorInput.pendingFor = (editor) =>
  prepared.activeInput(editor) == null ? pending.get(editor) : null;
module.exports = dispatchEditorInput;
