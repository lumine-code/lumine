// Provisions the packages a spec suite activates but the editor no longer
// bundles.
//
//   node script/install-spec-packages.js --package <dir> --home <dir>
//                                        [--ref master] [--github-env <path>]
//
// A package names its spec-time neighbours in a top-level `specPackages` array
// in its manifest — packages its specs activate by name that are installed on
// demand rather than bundled. This clones each one into <home>/packages/<name>
// and installs its dependencies, so a spec run started with LUMINE_HOME=<home>
// and LUMINE_TEST_PACKAGES="<names>" finds them: the test bootstrap
// (spec/helpers/build-lumine-environment.js) links each named package from
// $LUMINE_HOME/packages into the scratch config dir it builds per run.
//
// A package without the field is a strict no-op, so any CI can run this
// unconditionally. With --github-env (a GITHUB_ENV-format file; the flag is
// not named --env-file because node consumes that option itself, wherever it
// appears in argv), LUMINE_HOME and LUMINE_TEST_PACKAGES are appended for the
// later spec step — only after every package provisioned, so a failure exports
// nothing.
//
// Known gap: no electron-rebuild pass. None of the packages provisioned today
// ship native modules; the first one that does needs a rebuild step here.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ATTEMPTS = 3;

// The name becomes a clone URL and a path segment, so nothing outside the
// ecosystem's package-name alphabet may pass.
const NAME = /^[a-z0-9][a-z0-9-]*$/;

const FLAGS = {
  "--package": "package",
  "--home": "home",
  "--ref": "ref",
  "--github-env": "envFile",
};

function parseArguments(argv) {
  const options = { ref: "master" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = FLAGS[argv[index]];
    if (!key || argv[index + 1] == null) {
      console.error(`error: unknown or valueless argument ${argv[index]}`);
      return null;
    }
    options[key] = argv[index + 1];
  }
  if (!options.package || !options.home) {
    console.error("error: --package and --home are required");
    return null;
  }
  return options;
}

function withAttempts(label, action) {
  let failure = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    failure = action();
    if (failure == null) return null;
    if (attempt < ATTEMPTS)
      console.warn(`warning: ${label} failed (attempt ${attempt}): ${failure}`);
  }
  return failure;
}

function clone(name, ref, target) {
  return withAttempts(`clone ${name}`, () => {
    fs.rmSync(target, { recursive: true, force: true });
    const url = `https://github.com/lumine-code/${name}.git`;
    const result = spawnSync(
      "git",
      ["clone", "--depth", "1", "--quiet", "--branch", ref, url, target],
      { stdio: "inherit" },
    );
    if (result.error) return result.error.message;
    return result.status === 0 ? null : `git exited ${result.status}`;
  });
}

// Not --ignore-scripts: the allow-scripts gate governs, and a git-pinned
// dependency may emit its entry point from its prepare script.
function install(name, directory) {
  const lockfile = fs.existsSync(path.join(directory, "package-lock.json"));
  const args = lockfile
    ? ["ci", "--omit=dev", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"];
  return withAttempts(`install ${name}`, () => {
    // A single shell command string: shell mode is what makes the npm.cmd shim
    // spawnable on Windows, and the arguments are fixed flags with nothing to
    // quote.
    const result = spawnSync(["npm", ...args].join(" "), {
      cwd: directory,
      stdio: "inherit",
      shell: true,
    });
    if (result.error) return result.error.message;
    return result.status === 0 ? null : `npm exited ${result.status}`;
  });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    process.exitCode = 1;
    return;
  }

  const packageDirectory = path.resolve(options.package);
  const home = path.resolve(options.home);
  const manifestPath = path.join(packageDirectory, "package.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`error: no package.json in ${packageDirectory}`);
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const names = manifest.specPackages || [];
  if (names.length === 0) {
    console.log("no spec packages declared");
    return;
  }

  for (const name of names) {
    if (!NAME.test(name)) {
      console.error(`error: invalid spec package name ${JSON.stringify(name)}`);
      process.exitCode = 1;
      return;
    }
  }

  const packagesDirectory = path.join(home, "packages");
  fs.mkdirSync(packagesDirectory, { recursive: true });

  for (const name of names) {
    const target = path.join(packagesDirectory, name);
    if (fs.existsSync(target)) {
      console.log(`spec package ${name} already present`);
      continue;
    }

    const cloneFailure = clone(name, options.ref, target);
    if (cloneFailure != null) {
      console.error(`error: clone ${name}: ${cloneFailure}`);
      process.exitCode = 1;
      return;
    }

    const cloned = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    if (Object.keys(cloned.dependencies || {}).length > 0) {
      const installFailure = install(name, target);
      if (installFailure != null) {
        console.error(`error: install ${name}: ${installFailure}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  console.log(`spec packages: ${names.join(" ")} -> ${packagesDirectory}`);
  if (options.envFile) {
    fs.appendFileSync(
      options.envFile,
      `LUMINE_HOME=${home}\nLUMINE_TEST_PACKAGES=${names.join(" ")}\n`,
    );
  }
}

main();
