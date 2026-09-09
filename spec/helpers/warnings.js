const _ = require("@lumine-code/underscore-plus");
const Grim = require("@lumine-code/grim");

exports.warnIfLeakingPathSubscriptions = async function (specName = "") {
  const client = globalThis.lumine?.fileWatchClient;
  if (!client || client.isClosed) return;
  // Owners suppress callbacks synchronously. Settle their queued releases before
  // checking only this environment, never another window or main configuration.
  await client.settlePendingTeardown();
  const handles = [...client.handles.values()].filter((handle) => !handle.isDisposed);
  if (handles.length) {
    console.error(
      `WARNING: Leaking file watchers${specName ? ` in ${specName}` : ""}:`,
      handles.map((handle) => handle.path),
    );
  }
  await client.disposeAll();
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
