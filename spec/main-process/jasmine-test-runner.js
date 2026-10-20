const Jasmine = require("jasmine");
const path = require("path");
const fs = require("@lumine-code/fs-plus");
const assert = require("./assert");
const { spawn } = require("node:child_process");
const { parse } = require("@babel/parser");

// Spawning windows and waiting for the application to settle takes seconds, so
// jasmine's default 5s ceiling is too low for these specs.
const DEFAULT_TIMEOUT = 30 * 1000;

function partitionSpecFiles(files) {
  const nodeFiles = [];
  const jasmineFiles = [];
  for (const file of files) {
    const pending = [parse(fs.readFileSync(file, "utf8"), { sourceType: "unambiguous" })];
    let nodeTest = false;
    while (pending.length && !nodeTest) {
      const node = pending.pop();
      nodeTest =
        ((node.type === "ImportDeclaration" || node.type === "ImportExpression") &&
          node.source?.value === "node:test") ||
        (node.type === "CallExpression" &&
          node.callee?.name === "require" &&
          node.arguments[0]?.value === "node:test");
      for (const value of Object.values(node)) {
        if (Array.isArray(value))
          pending.push(...value.filter((item) => item && typeof item === "object"));
        else if (value && typeof value === "object") pending.push(value);
      }
    }
    (nodeTest ? nodeFiles : jasmineFiles).push(file);
  }
  return { nodeFiles, jasmineFiles };
}

function runNodeSpecs(files, { stdio = "inherit" } = {}) {
  if (files.length === 0) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    // A runner started from a Node test must not inherit that test child's
    // reporting protocol and silently bypass its own command-line test run.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
      env,
      stdio,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

// Runs the main-process specs.
//
// The renderer has its own runner under `spec/runners/`; this one is far
// simpler because there is no editor environment to build, only Node.
module.exports = async function (testPaths) {
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

  try {
    if (specFiles.length === 0) throw new Error("No main-process spec files found.");
    const { nodeFiles, jasmineFiles } = partitionSpecFiles(specFiles);
    // node:test registers its own asynchronous runner when a file is imported.
    // Importing those files into Jasmine used to overlap both runners, race their
    // process-wide environment changes, and mask Node failures with Jasmine's exit.
    const nodeStatus = await runNodeSpecs(nodeFiles);
    if (nodeStatus !== 0) return process.exit(nodeStatus);
    if (jasmineFiles.length === 0) return process.exit(0);
    const runner = new Jasmine();
    // Resolve the exit code here rather than letting jasmine call `process.exit`,
    // so the reporter's output is flushed first.
    runner.exitOnCompletion = false;
    // `loadConfig` is async from jasmine 7, and `execute` must not start before
    // it has settled or the run uses the defaults instead of this config.
    await runner.loadConfig({
      // Jasmine matches `spec_files` as globs, and a Windows path full of
      // backslashes matches nothing.
      spec_files: jasmineFiles.map((specFile) => specFile.split(path.sep).join("/")),
      env: {
        random: false,
        stopSpecOnExpectationFailure: false,
      },
    });
    runner.jasmine.DEFAULT_TIMEOUT_INTERVAL = DEFAULT_TIMEOUT;

    const result = await runner.execute();
    process.exit(result.overallStatus === "passed" ? 0 : 1);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

module.exports.partitionSpecFiles = partitionSpecFiles;
module.exports.runNodeSpecs = runNodeSpecs;
