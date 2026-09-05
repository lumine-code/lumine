// Child-process bootstrap for the git-host worker, forked by git-host.js under
// ELECTRON_RUN_AS_NODE. Unlike watcher-task-bootstrap.js this installs NO DOM /
// window / navigator shims: the git worker requires only `git` and DOM-free
// service modules. It sets up the compile cache (so source modules
// load identically to the renderer), forwards console output to the renderer
// for diagnostics, and then loads the worker.

const compileCachePath = process.env.LUMINE_COMPILE_CACHE_PATH;
const CompileCache = require("./compile-cache");
if (compileCachePath) CompileCache.setCacheDirectory(compileCachePath);
CompileCache.install(`${process.resourcesPath}`, require);

// Forward console output to the renderer instead of the detached child stdio.
for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    try {
      process.send({ event: `console:${level}`, args });
    } catch {
      original(...args);
    }
  };
}

process.on("uncaughtException", (error) => {
  const exit = () => process.exit(1); // eslint-disable-line n/no-process-exit
  try {
    if (process.connected) {
      process.send({ event: "console:error", args: [error.message, error.stack] }, exit);
    } else {
      exit();
    }
  } catch {
    exit();
  }
});

require("./git-host-worker");
