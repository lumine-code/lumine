const pending = new WeakMap();
const textInputs = new WeakMap();
const prepared = require("./text-editor-prepared-indent");

function isApplyingTextInput(editor) {
  return (
    textInputs.has(editor) &&
    (prepared.activeInput(editor) != null ||
      prepared.isPublishing(editor) ||
      editor.isApplyingAutomaticIndentation())
  );
}

function runTextInput(editor, input, operation) {
  if (textInputs.has(editor) || !editor.emitter.listenerCountForEventName("did-settle-text-input"))
    return operation();
  const buffer = editor.getBuffer();
  const beforeRevision = buffer.getTextRevision();
  const changes = [];
  let interrupted = false;
  textInputs.set(editor, {});
  const subscription = buffer.onDidChangeText((event) => {
    if (event.origin === "edit" && isApplyingTextInput(editor)) {
      for (const change of event.changes) changes.push(change);
    } else {
      interrupted = true;
    }
  });
  const cleanup = () => {
    textInputs.delete(editor);
    subscription.dispose();
  };
  const finish = (result) => {
    cleanup();
    if (!interrupted && !editor.isDestroyed() && changes.length) {
      editor.emitter.emit("did-settle-text-input", {
        ...input,
        beforeRevision,
        afterRevision: buffer.getTextRevision(),
        changes,
      });
    }
    return result;
  };
  const fail = (error) => {
    cleanup();
    throw error;
  };
  const settle = (result) => {
    const indentation = editor.autoIndentAtTransactionEndPromise;
    return indentation ? indentation.then(() => finish(result), fail) : finish(result);
  };
  let result;
  try {
    result = operation();
  } catch (error) {
    fail(error);
  }
  return result?.then ? Promise.resolve(result).then(settle, fail) : settle(result);
}

// Input events must reach package advice in order, after earlier asynchronous
// edits have published. Otherwise Enter followed by typing/backspace operates
// on the old cursor and cancels the still-preparing newline.
function dispatchEditorInput(editor, operation, input) {
  const invoke = () => {
    if (editor.isDestroyed?.()) return;
    return input ? runTextInput(editor, input, operation) : operation();
  };
  if (prepared.activeInput(editor) != null) return invoke();
  const version = prepared.notifyInput(editor);
  const previous = pending.get(editor);
  const dispatch = () => prepared.withInput(editor, version, invoke);
  // A cancelled preparation leaves newer cursor/text state in place. Keys
  // already waiting behind it must not be replayed against that new intent.
  const result = previous
    ? previous.then(
        (result) => (result === false ? false : dispatch()),
        () => false,
      )
    : dispatch();
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
dispatchEditorInput.isApplyingTextInput = isApplyingTextInput;
dispatchEditorInput.capturePublication = (editor) => {
  const input = textInputs.get(editor);
  const version = prepared.activeInput(editor);
  return (publish) =>
    input && input === textInputs.get(editor) && version != null
      ? prepared.withInput(editor, version, publish)
      : publish();
};
module.exports = dispatchEditorInput;
