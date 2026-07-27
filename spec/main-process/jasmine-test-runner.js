const Jasmine = require("jasmine");
const path = require("path");
const fs = require("@lumine-code/fs-plus");
const assert = require("./assert");

// Spawning windows and waiting for the application to settle takes seconds, so
// jasmine's default 5s ceiling is too low for these specs.
const DEFAULT_TIMEOUT = 30 * 1000;

// Runs the main-process specs.
//
// The renderer has its own runner under `spec/runners/`; this one is far
// simpler because there is no editor environment to build, only Node.
module.exports = function (testPaths) {
  global.assert = assert;

  const specFiles = [];
  for (const testPath of testPaths) {
    if (fs.isDirectorySync(testPath)) {
      for (const testFilePath of fs.listTreeSync(testPath)) {
        if (/\.test\.js$/.test(testFilePath)) {
          specFiles.push(testFilePath);
        }
      }
    } else {
      specFiles.push(testPath);
    }
  }

  const runner = new Jasmine();
  // Resolve the exit code here rather than letting jasmine call `process.exit`,
  // so the reporter's output is flushed first.
  runner.exitOnCompletion = false;
  runner.loadConfig({
    // Jasmine matches `spec_files` as globs, and a Windows path full of
    // backslashes matches nothing.
    spec_files: specFiles.map((specFile) => specFile.split(path.sep).join("/")),
    env: {
      random: false,
      stopSpecOnExpectationFailure: false,
    },
  });
  runner.jasmine.DEFAULT_TIMEOUT_INTERVAL = DEFAULT_TIMEOUT;

  runner
    .execute()
    .then((result) => {
      process.exit(result.overallStatus === "passed" ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
};
