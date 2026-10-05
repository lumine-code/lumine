const childProcess = require("child_process");
const path = require("path");

function assertAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

async function openApplication(executablePath, args = [], options = {}) {
  assertAbsolutePath(executablePath, "executablePath");
  if (
    !Array.isArray(args) ||
    !Array.from(args).every((arg) => typeof arg === "string" && !arg.includes("\0"))
  ) {
    throw new TypeError("args must be an array of strings without null bytes");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Application options must be an object");
  }
  if (Object.keys(options).some((key) => key !== "cwd")) {
    throw new TypeError("Unsupported application option");
  }
  if (options.cwd !== undefined) assertAbsolutePath(options.cwd, "cwd");

  return new Promise((resolve, reject) => {
    // Launch directly from the main process. The foreground process on Windows
    // can give the new application foreground eligibility, and no intermediate
    // command shell needs to interpret paths or arguments.
    const child = childProcess.spawn(executablePath, args, {
      cwd: options.cwd,
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onSpawn = () => {
      cleanup();
      // Applications keep their own lifetime after the editor closes. Waiting
      // for spawn first preserves startup errors instead of reporting success.
      child.unref();
      resolve(child.pid);
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

module.exports = { openApplication };
