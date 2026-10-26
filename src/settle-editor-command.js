// Command boundaries report failures while programmatic editor APIs retain
// their return values/rejections. Mutations that committed before an observer
// threw must not be described as cancelled or rolled back.
function settleEditorCommand(work, notifications, commandName) {
  const report = (error) => {
    if (
      error?.name === "AbortError" ||
      error?.code === "ERR_STALE_EDIT" ||
      error?.code === "ERR_STALE_SEARCH"
    )
      return false;
    notifications.addError(
      error?.committed
        ? "The edit completed, but a change listener failed."
        : "Unable to complete the editor command.",
      {
        detail: `${commandName}: ${error?.message || error}`,
        dismissable: true,
      },
    );
    return false;
  };
  try {
    const result = work();
    if (Array.isArray(result) && result.some((item) => typeof item?.then === "function"))
      return Promise.all(result).catch(report);
    return typeof result?.then === "function" ? Promise.resolve(result).catch(report) : result;
  } catch (error) {
    return report(error);
  }
}
module.exports = settleEditorCommand;
