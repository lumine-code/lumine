// External modules must be imported within each function. As the context
// (eg renderer or main process) is different depending on where these functions
// are being called.

// The channel is the alphabetic part of a semver prerelease, so `1.2.3-rc.1`,
// `1.2.3-rc1` and `1.2.3-dev-a1b2c3d` all read as their channel and a plain
// `1.2.3` reads as stable. Both the dotted and undotted prerelease spellings
// are accepted: release tags are written `vX.Y.Z-rc.N`, which is the form npm
// and GitHub tooling produce, and the undotted form is what earlier builds
// used.
function getReleaseChannel(version) {
  const match = version?.match(/^\d+\.\d+\.\d+(?:-([a-z]+)[.-]?(?:\d+|\w{4,})?)?$/);
  if (!match) {
    return "unrecognized";
  } else if (match[1]) {
    return match[1];
  }

  return "stable";
}

function getAppName() {
  const { app } = require("electron");

  if (process.type === "renderer") {
    return lumine.application.getName();
  }

  const releaseChannel = getReleaseChannel(app.getVersion());
  const appNameParts = [app.getName()];

  if (releaseChannel !== "stable") {
    appNameParts.push(releaseChannel.charAt(0).toUpperCase() + releaseChannel.slice(1));
  }

  return appNameParts.join(" ");
}

function getConfigFilePath(opts = {}) {
  const fs = require("fs");
  const path = require("path");

  let configFilePath = ["config.json", "config.jsonc"]
    .map((file) => path.join(process.env.LUMINE_HOME, file))
    .find((f) => fs.existsSync(f));

  if (configFilePath) {
    return configFilePath;
  } else {
    if (opts.returnPlaceholder) {
      // This is only used when `./src/main-process/lumine-application.js` initializes
      // the `ConfigFile` instance. Since it must provide a path, even if it turns
      // out the path doesn't exist. By default if the path doesn't exist then
      // `null` is returned.
      return path.join(process.env.LUMINE_HOME, "config.json");
    } else {
      return null;
    }
  }
}

module.exports = {
  getReleaseChannel,
  getAppName,
  getConfigFilePath,
};
