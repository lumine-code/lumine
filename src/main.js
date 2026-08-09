const startTime = Date.now();
const StartupTime = require("./startup-time");
StartupTime.setStartTime();

const path = require("path");
const fs = require("@lumine-code/fs-plus");
const CSON = require("@lumine-code/season");
const { app, Menu, protocol } = require("electron");
const parseCommandLineOptions = require("./parse-command-line-options");
const { getAppArguments } = parseCommandLineOptions;

// Lumine installs its own application menu during initialization. Suppress
// Electron's default menu before `ready` so it is never built in the meantime.
Menu.setApplicationMenu(null);

// Declare the `lumine://` scheme privileged before the app is ready, so packages
// can load fonts and use fetch/XHR against lumine:// URLs from the file://
// renderer (otherwise Chromium blocks them as cross-origin/CORS violations).
protocol.registerSchemesAsPrivileged([
  {
    scheme: "lumine",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// Parse only enough to select the source tree. Full validation and help output
// happen in start.js, but using the same lightweight parser avoids constructing
// a second yargs instance on every launch.
const args = parseCommandLineOptions(
  getAppArguments(process.argv, { defaultApp: process.defaultApp, appPath: app.getAppPath() }),
);

function isLumineRepoPath(repoPath) {
  let packageJsonPath = path.join(repoPath, "package.json");
  if (fs.statSyncNoException(packageJsonPath)) {
    try {
      let packageJson = CSON.readFileSync(packageJsonPath);
      return packageJson.name === "lumine";
    } catch {
      return false;
    }
  }

  return false;
}

let resourcePath;
let devResourcePath;

if (args["resource-path"]) {
  resourcePath = args["resource-path"];
  devResourcePath = resourcePath;
} else {
  const stableResourcePath = path.dirname(__dirname);
  const defaultRepositoryPath = path.join(
    // Setting the path for the app
    app.getPath("home"),
    "github",
    "lumine",
  );

  if (process.env.LUMINE_RESOURCE_PATH) {
    devResourcePath = process.env.LUMINE_RESOURCE_PATH;
  } else if (isLumineRepoPath(process.cwd())) {
    devResourcePath = process.cwd();
  } else if (fs.statSyncNoException(defaultRepositoryPath)) {
    devResourcePath = defaultRepositoryPath;
  } else {
    devResourcePath = stableResourcePath;
  }

  if (args.dev || args.test || process.env.LUMINE_DEV_MODE === "1") {
    resourcePath = devResourcePath;
  } else {
    resourcePath = stableResourcePath;
  }
}

const start = require(path.join(resourcePath, "src", "start"));
start(resourcePath, devResourcePath, startTime);
