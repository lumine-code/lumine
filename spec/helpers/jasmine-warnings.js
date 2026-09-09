const { ensureNoDeprecatedFunctionCalls, warnIfLeakingPathSubscriptions } = require("./warnings");

exports.register = (jasmineEnv) => {
  let currentSpec = "";
  const reporter = {
    specStarted: (result) => {
      currentSpec = result.fullName;
    },
  };
  jasmineEnv.afterEach((done) => {
    ensureNoDeprecatedFunctionCalls();

    lumine
      .reset()
      .then(() => {
        if (!window.debugContent) {
          document.getElementById("jasmine-content").innerHTML = "";
        }
        return warnIfLeakingPathSubscriptions(currentSpec);
      })
      .then(() => done(), done.fail);
  });
  return reporter;
};
