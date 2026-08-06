const { ensureNoDeprecatedFunctionCalls, warnIfLeakingPathSubscriptions } = require("./warnings");

exports.register = (jasmineEnv) => {
  jasmineEnv.afterEach((done) => {
    ensureNoDeprecatedFunctionCalls();

    atom
      .reset()
      .then(() => {
        if (!window.debugContent) {
          document.getElementById("jasmine-content").innerHTML = "";
        }
        return warnIfLeakingPathSubscriptions();
      })
      .then(() => done(), done.fail);
  });
};
