const lifecycleAggregates = new WeakSet();
const reportedErrors = new WeakSet();

function appendLifecycleError(failures, error) {
  if (error && typeof error === "object" && lifecycleAggregates.has(error)) {
    for (const failure of error.errors) appendLifecycleError(failures, failure);
  } else {
    failures.push(error);
  }
}

function captureLifecycleError(failures, callback) {
  try {
    return callback();
  } catch (error) {
    appendLifecycleError(failures, error);
  }
}

async function awaitLifecycleCleanup(failures, callback) {
  try {
    return await callback();
  } catch (error) {
    appendLifecycleError(failures, error);
  }
}

function combineLifecycleErrors(failures, message) {
  if (failures.length === 1) return failures[0];
  const error = new AggregateError(failures, message, { cause: failures[0] });
  lifecycleAggregates.add(error);
  return error;
}

function throwLifecycleErrors(failures, message) {
  if (failures.length > 0) throw combineLifecycleErrors(failures, message);
}

function markLifecycleErrorReported(error) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    reportedErrors.add(error);
  }
}

function isLifecycleErrorReported(error) {
  return !!(
    error &&
    (typeof error === "object" || typeof error === "function") &&
    reportedErrors.has(error)
  );
}

module.exports = {
  appendLifecycleError,
  awaitLifecycleCleanup,
  captureLifecycleError,
  combineLifecycleErrors,
  isLifecycleErrorReported,
  markLifecycleErrorReported,
  throwLifecycleErrors,
};
