"use strict";

// Native package-management commands for the Lumine CLI.
//
// These replace the external `ppm` binary. Everything runs headlessly in the
// main process (no editor window) using `git`, `npm`, and the filesystem, then
// exits. The behavior mirrors how the Settings view installs packages: a
// GitHub package is cloned, its production dependencies are installed, and it
// is copied into `~/.lumine/packages` with an `apmInstallSource` record so it
// can be updated later.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const CSON = require("@lumine-code/season");
const { resolvePackageSource } = require("./package-source");
const PackageInstallationService = require("./package-installation-service");

function packagesDirectory() {
  return path.join(process.env.LUMINE_HOME, "packages");
}

function devPackagesDirectory() {
  return path.join(process.env.LUMINE_HOME, "packages-dev");
}

function gitCommand() {
  return "git";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function symlinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

// On Windows a .cmd/.bat (e.g. npm.cmd) must be spawned through a shell — Node
// >= 18.20 / 20.12 rejects them with EINVAL otherwise (CVE-2024-27980). git is
// an .exe, so it keeps its direct spawn and its URL/ref args are never shell
// interpreted.
function spawnOptions(command, options, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return { ...options, shell: true };
  }
  return options;
}

// Runs a child process synchronously, streaming its output to the user. Throws
// on a non-zero exit code.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...spawnOptions(command, options) });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(`Could not find the \`${command}\` command on your PATH.`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed with exit code ${result.status}.`);
  }
  return result;
}

// Runs a child process synchronously and returns its captured stdout.
function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...spawnOptions(command, options) });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed with exit code ${result.status}.`);
  }
  return result.stdout;
}

// Delete a package directory or a link to one. A link is unlinked outright: it
// points at a working copy that belongs to the user, and removing the entry
// must never look through it.
function removePath(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      // Windows refuses `unlink` on some directory reparse points; removing the
      // reparse point as a directory leaves what it points at alone.
      if (error.code !== "EPERM" && error.code !== "EISDIR") throw error;
      fs.rmdirSync(target);
    }
    return;
  }

  fs.rmSync(target, { recursive: true, force: true });
}

function readMetadata(packagePath) {
  const metadataPath = ["package.json", "package.jsonc"]
    .map((filename) => path.join(packagePath, filename))
    .find((candidate) => fs.existsSync(candidate));
  if (!metadataPath) {
    return null;
  }
  return { path: metadataPath, metadata: CSON.readFileSync(metadataPath) };
}

async function install(source) {
  if (!source) {
    throw new Error("Specify a package to install, e.g. `lumine --install owner/repo`.");
  }
  console.log(`Installing ${source}…`);
  const service = new PackageInstallationService({
    packagesDirectory: packagesDirectory(),
    gitCommand: gitCommand(),
    npmCommand: npmCommand(),
    run: async (command, args, options) => {
      run(command, args, options);
      return { stdout: "" };
    },
    capture: async (command, args, options) => ({
      stdout: capture(command, args, options),
    }),
    resolveSource: (value) =>
      resolvePackageSource(value, async (cloneUrl, options, patterns) =>
        capture(gitCommand(), ["ls-remote", ...options, cloneUrl, ...patterns]),
      ),
    lumineVersion: require("../package.json").version.split("-")[0],
  });
  const installed = await service.install({ installSource: source, name: source });
  console.log(`Installed ${installed.packageName} to ${installed.target}`);
}

// Every package directory under `directory`, described by what its manifest
// says rather than by what the directory is called. A directory whose manifest
// declares no name falls back to the directory name.
function listDirectory(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => {
      const packagePath = path.join(directory, entry.name);
      let metadata = null;
      try {
        const read = readMetadata(packagePath);
        metadata = read ? read.metadata : null;
      } catch {
        // An unreadable manifest still leaves a directory worth listing.
      }
      const name = metadata && metadata.name ? metadata.name : entry.name;
      return {
        name,
        dirname: entry.name,
        path: packagePath,
        version: metadata && metadata.version,
      };
    })
    .sort((a, b) => a.dirname.localeCompare(b.dirname));
}

function uninstall(nameOrPath) {
  if (!nameOrPath) {
    throw new Error("Specify a package to uninstall, e.g. `lumine --uninstall my-package`.");
  }

  const directory = packagesDirectory();
  const installed = listDirectory(directory);
  const resolved = path.resolve(nameOrPath);
  const matches = installed.filter(
    (pack) => pack.name === nameOrPath || pack.dirname === nameOrPath || pack.path === resolved,
  );

  if (matches.length === 0) {
    throw new Error(`'${nameOrPath}' is not installed in ${directory}.`);
  }

  if (matches.length > 1) {
    const dirnames = matches.map((pack) => pack.dirname).join(", ");
    throw new Error(
      `More than one directory in ${directory} provides '${nameOrPath}': ${dirnames}. ` +
        "Pass the directory to uninstall a specific copy.",
    );
  }

  removePath(matches[0].path);
  console.log(`Uninstalled ${matches[0].name} from ${matches[0].path}`);
}

// A package is described as `name@version`, plus the directory it lives in when
// that is called something else.
function describePackage(pack) {
  const version = pack.version ? `@${pack.version}` : "";
  const dirname = pack.dirname === pack.name ? "" : ` (in ${pack.dirname})`;
  return `${pack.name}${version}${dirname}`;
}

function list() {
  // Highest priority first, matching how the editor resolves a name.
  const sections = [
    { title: "Development Packages", directory: devPackagesDirectory() },
    { title: "Installed Packages", directory: packagesDirectory() },
  ];

  const claimed = new Set();
  let printedAny = false;
  for (const { title, directory } of sections) {
    const packages = listDirectory(directory);
    if (packages.length === 0) {
      continue;
    }
    printedAny = true;
    console.log(`${title} (${packages.length})`);
    for (const pack of packages) {
      const shadowed = claimed.has(pack.name) ? " — shadowed" : "";
      claimed.add(pack.name);
      console.log(`└── ${describePackage(pack)}${shadowed}`);
    }
    console.log("");
  }

  if (!printedAny) {
    console.log("No packages installed.");
  }
}

function link(target, { dev } = {}) {
  if (!target) {
    throw new Error("Specify a package directory to link, e.g. `lumine --link .`.");
  }

  const packagePath = path.resolve(target);
  if (!fs.existsSync(packagePath)) {
    throw new Error(`No such directory: ${packagePath}`);
  }

  const read = readMetadata(packagePath);
  const name = (read && read.metadata && read.metadata.name) || path.basename(packagePath);
  const linkDirectory = dev ? devPackagesDirectory() : packagesDirectory();
  const linkPath = path.join(linkDirectory, name);

  fs.mkdirSync(linkDirectory, { recursive: true });
  removePath(linkPath);
  fs.symlinkSync(packagePath, linkPath, symlinkType());

  console.log(`Linked ${packagePath} -> ${linkPath}`);
}

function unlink(target, { dev } = {}) {
  if (!target) {
    throw new Error("Specify a package name or directory to unlink, e.g. `lumine --unlink .`.");
  }

  // Accept a package name, the name of the link, or a path to either the link
  // or the checkout it points at.
  const resolved = path.resolve(target);
  const read = fs.existsSync(resolved) ? safeReadMetadata(resolved) : null;
  const targetName = read && read.metadata && read.metadata.name;
  const directories = dev
    ? [devPackagesDirectory()]
    : [devPackagesDirectory(), packagesDirectory()];

  let unlinked = false;
  for (const directory of directories) {
    for (const pack of listDirectory(directory)) {
      const matches =
        pack.name === target ||
        pack.dirname === target ||
        pack.path === resolved ||
        (targetName != null && pack.name === targetName);
      if (!matches) continue;
      if (!fs.lstatSync(pack.path).isSymbolicLink()) continue;
      removePath(pack.path);
      console.log(`Unlinked ${pack.path}`);
      unlinked = true;
    }
  }

  if (!unlinked) {
    throw new Error(`No linked package named '${target}' was found.`);
  }
}

function safeReadMetadata(packagePath) {
  try {
    return readMetadata(packagePath);
  } catch {
    return null;
  }
}

const COMMANDS = { install, uninstall, list, link, unlink };

// Runs a parsed package command. `command` is `{ name, arg, dev }`. Returns a
// process exit code.
async function runPackageCommand(command) {
  const handler = COMMANDS[command.name];
  if (!handler) {
    process.stderr.write(`Unknown package command: ${command.name}\n`);
    return 1;
  }

  try {
    await handler(command.arg, { dev: command.dev });
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    return 1;
  }
}

module.exports = { runPackageCommand, spawnOptions };
