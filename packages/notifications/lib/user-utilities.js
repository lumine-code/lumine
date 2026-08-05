/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/main/docs/suggestions.md
 */
const os = require("os");
const semver = require("semver");
const { BufferedProcess } = require("atom");

/*
A collection of methods for retrieving information about the user's system for
bug report purposes.
*/

module.exports = {
  /*
  Section: System Information
  */

  getPlatform() {
    return os.platform();
  },

  // OS version strings lifted from https://github.com/lee-dohm/bug-report
  getOSVersion() {
    return new Promise((resolve, _reject) => {
      switch (this.getPlatform()) {
        case "darwin":
          return resolve(this.macVersionText());
        case "win32":
          return resolve(this.winVersionText());
        case "linux":
          return resolve(this.linuxVersionText());
        default:
          return resolve(`${os.platform()} ${os.release()}`);
      }
    });
  },

  macVersionText() {
    return this.macVersionInfo().then(function (info) {
      if (!info.ProductName || !info.ProductVersion) {
        return "Unknown macOS version";
      }
      return `${info.ProductName} ${info.ProductVersion}`;
    });
  },

  macVersionInfo() {
    return new Promise(function (resolve, _reject) {
      let stdout = "";
      const plistBuddy = new BufferedProcess({
        command: "/usr/libexec/PlistBuddy",
        args: [
          "-c",
          "Print ProductVersion",
          "-c",
          "Print ProductName",
          "/System/Library/CoreServices/SystemVersion.plist",
        ],
        stdout(output) {
          return (stdout += output);
        },
        exit() {
          const [ProductVersion, ProductName] = Array.from(stdout.trim().split("\n"));
          return resolve({ ProductVersion, ProductName });
        },
      });

      return plistBuddy.onWillThrowError(function ({ handle }) {
        handle();
        return resolve({});
      });
    });
  },

  linuxVersionText() {
    return this.linuxVersionInfo().then(function (info) {
      if (info.DistroName && info.DistroVersion) {
        return `${info.DistroName} ${info.DistroVersion}`;
      } else {
        return `${os.platform()} ${os.release()}`;
      }
    });
  },

  linuxVersionInfo() {
    return new Promise(function (resolve, _reject) {
      let stdout = "";

      const lsbRelease = new BufferedProcess({
        command: "lsb_release",
        args: ["-ds"],
        stdout(output) {
          return (stdout += output);
        },
        exit(_exitCode) {
          const [DistroName, DistroVersion] = Array.from(stdout.trim().split(" "));
          return resolve({ DistroName, DistroVersion });
        },
      });

      return lsbRelease.onWillThrowError(function ({ handle }) {
        handle();
        return resolve({});
      });
    });
  },

  winVersionText() {
    return new Promise(function (resolve, _reject) {
      const data = [];
      const systemInfo = new BufferedProcess({
        command: "systeminfo",
        stdout(oneLine) {
          return data.push(oneLine);
        },
        exit() {
          let res;
          let info = data.join("\n");
          res = /OS.Name.\s+(.*)$/im.exec(info);
          info = res ? res[1] : "Unknown Windows version";
          return resolve(info);
        },
      });

      return systemInfo.onWillThrowError(function ({ handle }) {
        handle();
        return resolve("Unknown Windows version");
      });
    });
  },

  /*
  Section: Installed Packages
  */

  getNonCorePackages() {
    return new Promise(function (resolve, _reject) {
      const packages = atom.packages
        .getAvailablePackages()
        .filter((pack) => !atom.packages.isBundledPackage(pack.name));
      return resolve(
        packages.map((pack) => {
          const version = pack.metadata != null ? pack.metadata.version : undefined;
          return `${pack.name} ${version} ${pack.tier === "dev" ? "(dev)" : ""}`;
        }),
      );
    });
  },

  getPackageVersion(packageName) {
    const pack = atom.packages.getLoadedPackage(packageName);
    return pack != null ? pack.metadata.version : undefined;
  },

  // The version of `packageName` that ships with this build, or undefined when
  // the package is not bundled. It has to come from the bundled copy's own
  // manifest — the bundled tier is derived from each dependency's manifest,
  // which is also where the shipped version lives. Asking for the shadowed
  // copy matters — when a local install wins the name, the bundled one is the
  // loser of that scan.
  getPackageVersionShippedWithLumine(packageName) {
    const bundled = atom.packages
      .getAvailablePackages({ includeShadowed: true })
      .find((pack) => pack.name === packageName && pack.tier === "bundled");
    return bundled != null ? bundled.metadata.version : undefined;
  },

  // Community packages install from their own Git origin rather than a registry,
  // so there is no single endpoint to ask "what is the latest version?" — the
  // Install tab's Updates view answers that per package, against the origin
  // recorded at install time. This check therefore only has an opinion about a
  // bundled package that has been shadowed by an older local copy.
  checkPackageUpToDate(packageName) {
    const installedVersion = this.getPackageVersion(packageName);
    const versionShippedWithLumine = this.getPackageVersionShippedWithLumine(packageName);
    const isCore = versionShippedWithLumine != null;

    // A core package is out of date if the version which is being used is lower
    // than the version which normally ships with the version of Lumine which is
    // running. This will happen when there's a locally installed version of the
    // package with a lower version than Lumine's. Anything unparseable on either
    // side means no opinion rather than a thrown error.
    const comparable =
      semver.valid(installedVersion) != null && semver.valid(versionShippedWithLumine) != null;
    const upToDate = comparable ? semver.gte(installedVersion, versionShippedWithLumine) : true;

    return { isCore, upToDate, installedVersion, versionShippedWithLumine };
  },
};
