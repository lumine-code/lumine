// Shared by pane commands and guarded buffer saves so cancellation remains
// distinguishable from a failed filesystem write.
class SaveCancelledError extends Error {
  name = "SaveCancelledError";
}

class SaveConflictedError extends Error {
  name = "SaveConflictedError";
}

function isSaveCancellationError(error) {
  return error instanceof SaveCancelledError || error instanceof SaveConflictedError;
}

module.exports = { SaveCancelledError, SaveConflictedError, isSaveCancellationError };
