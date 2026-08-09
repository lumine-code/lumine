"use strict";

const { app } = require("electron");
const parseCommandLineOptions = require("./parse-command-line-options");

module.exports = function parseCommandLine(processArgs) {
  const version = app.getVersion();
  let args = parseCommandLineOptions(processArgs);

  if (args.version) {
    process.stdout.write(
      `Lumine  : ${version}\nElectron: ${process.versions.electron}\n` +
        `Chrome  : ${process.versions.chrome}\nNode    : ${process.versions.node}\n`,
    );
    process.exit(0);
    return;
  }

  if (args["package"]) {
    process.stderr.write(
      "The `--package`/`-p` option has been replaced. Use `lumine --install owner/repo`, " +
        "`--uninstall <name>`, `--list`, `--link <path>` or `--unlink <path>`.\n",
    );
    process.exit(1);
    return;
  }

  if (args.help) {
    showHelp(version);
    process.exit(0);
    return;
  }

  // If --uri-handler is set, then we parse NOTHING else
  if (args["uri-handler"]) {
    args = {
      uriHandler: true,
      "uri-handler": true,
      _: args._.filter((str) => str.startsWith("lumine://")).slice(0, 1),
    };
  }

  const addToLastWindow = args.add;
  const safeMode = args.safe;
  const test = args.test;
  const mainProcess = args["main-process"];
  const timeout = args.timeout;
  const newWindow = args["new-window"];
  const useCrashReporter = args.crashdump;
  let executedFrom;
  if (args["executed-from"] && args["executed-from"].toString()) {
    executedFrom = args["executed-from"].toString();
  } else {
    executedFrom = process.cwd();
  }

  if (newWindow && addToLastWindow) {
    process.stderr.write(
      "Only one of the --add and --new-window options may be specified at the same time.\n\n",
    );
    showHelp(version, process.stderr);

    // Exiting the main process with a nonzero exit code on macOS causes the app open to fail with the mysterious
    // message "LSOpenURLsWithRole() failed for the application /Applications/Lumine Dev.app with error -10810."
    process.exit(0);
  }

  let pidToKillWhenClosed = null;
  if (args["wait"]) {
    pidToKillWhenClosed = args["pid"];
  }

  const logFile = args["log-file"];
  const userDataDir = args["user-data-dir"];
  const profileStartup = args["profile-startup"];
  const clearWindowState = args["clear-window-state"];
  let pathsToOpen = [];
  let urlsToOpen = [];
  let devMode = args.dev;

  for (const path of args._) {
    if (typeof path !== "string") {
      // Sometimes non-strings (such as numbers or boolean true) get into args._
      // In the next block, .startsWith() only works on strings. So, skip non-string arguments.
      continue;
    }
    if (path.startsWith("lumine://")) {
      urlsToOpen.push(path);
    } else {
      pathsToOpen.push(path);
    }
  }

  if (args["resource-path"] || test || process.env.LUMINE_DEV_MODE === "1") {
    devMode = true;
  }

  if (args["path-environment"]) {
    // On Yosemite the $PATH is not inherited by the "open" command, so we have to
    // explicitly pass it by command line, see http://git.io/YC8_Ew.
    process.env.PATH = args["path-environment"];
  }

  // Headless package-management commands. When present, `start.js` runs the
  // command and exits without opening an editor window. `--dev` links/unlinks
  // packages under `packages-dev` instead of `packages`.
  let packageCommand = null;
  const linkToDev = Boolean(args.dev);
  if (typeof args["install"] === "string") {
    packageCommand = { name: "install", arg: args["install"], dev: linkToDev };
  } else if (typeof args["uninstall"] === "string") {
    packageCommand = { name: "uninstall", arg: args["uninstall"], dev: linkToDev };
  } else if (args["list"]) {
    packageCommand = { name: "list", arg: null, dev: linkToDev };
  } else if (typeof args["link"] === "string") {
    packageCommand = { name: "link", arg: args["link"], dev: linkToDev };
  } else if (typeof args["unlink"] === "string") {
    packageCommand = { name: "unlink", arg: args["unlink"], dev: linkToDev };
  }

  return {
    packageCommand,
    pathsToOpen,
    urlsToOpen,
    executedFrom,
    test,
    version,
    pidToKillWhenClosed,
    devMode,
    safeMode,
    newWindow,
    logFile,
    userDataDir,
    profileStartup,
    timeout,
    clearWindowState,
    addToLastWindow,
    mainProcess,
    useCrashReporter,
    env: process.env,
  };
};

function showHelp(version, stream = process.stdout) {
  stream.write(`Lumine Editor v${version}

Usage:
  lumine
  lumine [options] [path ...]
  lumine file[:line[:column]]

Options:
  -d, --dev                   Run in development mode.
  -f, --foreground            Keep the main process in the foreground.
  -h, --help                  Print this usage message.
  -l, --log-file <path>       Log all output to file when running tests.
  -n, --new-window            Open a new window.
      --profile-startup       Create a profile of startup execution.
      --crashdump             Generate crash dumps in ~/.lumine/crashdumps.
  -r, --resource-path <path>  Use this Lumine source directory in dev mode.
      --safe                  Do not load user or development packages.
  -t, --test                  Run the specified specs.
  -m, --main-process          Run specs in the main process.
      --timeout <minutes>     Set the test timeout.
  -w, --wait                  Wait for the opened window to close.
  -a, --add                   Add paths to the last used window.
      --user-data-dir <path>  Override Electron's user-data directory.
      --clear-window-state    Delete saved Lumine environment state.
  -v, --version               Print version information.

Package management:
      --install <repository>  Install a package.
      --uninstall <name>      Uninstall a package.
      --list                  List installed packages.
      --link <path>           Link a local package; add --dev for packages-dev.
      --unlink <path|name>    Remove a package link.

Environment variables:
  LUMINE_RESOURCE_PATH  Source tree used in development mode.
  LUMINE_DEV_MODE       Set to 1 to force development mode.
  LUMINE_HOME           Configuration root; defaults to ~/.lumine.
`);
}
