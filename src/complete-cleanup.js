function completeCleanup(actions, message, initialFailures = []) {
  const failures = [...initialFailures];
  const collectError = (error) => failures.push(error);
  for (const action of actions) {
    try {
      action(collectError);
    } catch (error) {
      collectError(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, message, { cause: failures[0] });
  }
}

module.exports = completeCleanup;
