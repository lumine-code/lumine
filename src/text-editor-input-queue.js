const pending = new WeakMap();

// Input events must reach package advice in order, after earlier asynchronous
// edits have published. Otherwise Enter followed by typing/backspace operates
// on the old cursor and cancels the still-preparing newline.
module.exports = function dispatchEditorInput(editor, operation) {
  const previous = pending.get(editor);
  const invoke = () => (editor.isDestroyed() ? undefined : operation());
  const result = previous ? previous.then(invoke, invoke) : invoke();
  if (!result?.then) return result;
  const task = Promise.resolve(result).finally(() => {
    if (pending.get(editor) === task) pending.delete(editor);
  });
  pending.set(editor, task);
  task.catch(() => {});
  return task;
};
