const { watchPath, stopAllWatchers } = require("../../src/path-watcher");
const _ = require("@lumine-code/underscore-plus");
const Grim = require("@lumine-code/grim");

exports.warnIfLeakingPathSubscriptions = async function () {
  // Watcher teardown is asynchronous: owners dispose via
  // `watcherPromise.then(w => w.dispose())` (see Project.destroyed), and a
  // watcher that is still arming cannot be disposed until its start settles.
  // Wait for in-flight transitions so only watchers that are genuinely left
  // running get reported.
  await watchPath.settlePendingTeardown();
  const watchers = watchPath.printWatchers();
  if (watchers && watchers.trim().length > 0) {
    console.error("WARNING: Leaking path watchers:\n" + watchers);
  }
  return stopAllWatchers();
};

exports.ensureNoDeprecatedFunctionCalls = function () {
  const deprecations = _.clone(Grim.getDeprecations());
  Grim.clearDeprecations();
  if (deprecations.length > 0) {
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = function (error, stack) {
      const output = [];
      for (let deprecation of Array.from(deprecations)) {
        output.push(`${deprecation.originName} is deprecated. ${deprecation.message}`);
        output.push(_.multiplyString("-", output[output.length - 1].length));
        for (stack of Array.from(deprecation.getStacks())) {
          for (let { functionName, location } of Array.from(stack)) {
            output.push(`${functionName} -- ${location}`);
          }
        }
        output.push("");
      }
      return output.join("\n");
    };

    const error = new Error(
      `Deprecated function(s) ${deprecations.map(({ originName }) => originName).join(", ")}) were called.`,
    );
    error.stack;
    Error.prepareStackTrace = originalPrepareStackTrace;
    throw error;
  }
};
