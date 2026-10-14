// Shared by pane commands and guarded buffer saves so cancellation remains
// distinguishable from a failed filesystem write.
class SaveCancelledError extends Error {
  name = "SaveCancelledError";
}

class SaveConflictedError extends Error {
  name = "SaveConflictedError";
}

/**
 * @public
 * @status public
 *
 * Determine whether a save stopped because the user cancelled it.
 *
 * @param {*} error - The error returned by a save operation.
 * @returns {Boolean} Whether the error represents save cancellation.
 */
function isSaveCancellationError(error) {
  return error instanceof SaveCancelledError || error instanceof SaveConflictedError;
}

module.exports = { SaveCancelledError, SaveConflictedError, isSaveCancellationError };
