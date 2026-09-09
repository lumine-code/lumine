const { ensureNoDeprecatedFunctionCalls, warnIfLeakingPathSubscriptions } = require("./warnings");

exports.register = (jasmineEnv) => {
  let currentSpec = "";
  jasmineEnv.addReporter({
    specStarted: (result) => {
      currentSpec = result.fullName;
    },
  });
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
};
