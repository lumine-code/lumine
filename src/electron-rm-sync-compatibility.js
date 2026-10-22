"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, URL } = require("node:url");
const { inspect } = require("node:util");

const INSTALLED = Symbol.for("lumine.windowsElectron.safeRmSync");
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
let waitArray;

function wait(milliseconds) {
  if (milliseconds <= 0) return;
  try {
    waitArray ??= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitArray, 0, 0, milliseconds);
    return;
  } catch {
    // A renderer can prohibit Atomics.wait. rmSync is already synchronous;
    // retain its bounded retry delay in that context as well.
  }
  const end = process.hrtime.bigint() + BigInt(milliseconds) * 1000000n;
  while (process.hrtime.bigint() < end) {
    /* synchronous retry backoff */
  }
}

function invalidType(name, expected, value) {
  const property = name.startsWith("options.") ? "property" : "argument";
  let received;
  if (value === null) received = "null";
  else if (value === undefined) received = "undefined";
  else if (typeof value === "object")
    received = `an instance of ${value.constructor?.name || "Object"}`;
  else received = `type ${typeof value} (${inspect(value)})`;
  const error = new TypeError(
    `The "${name}" ${property} must be of type ${expected}. Received ${received}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function optionsForRemoval(options) {
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  )
    throw invalidType("options", "object", options);
  const result = { force: false, recursive: false, maxRetries: 0, retryDelay: 100, ...options };
  for (const name of ["force", "recursive"])
    if (typeof result[name] !== "boolean")
      throw invalidType(`options.${name}`, "boolean", result[name]);
  for (const [name, maximum] of [
    ["maxRetries", 0xffffffff],
    ["retryDelay", 0x7fffffff],
  ]) {
    const value = result[name];
    if (typeof value !== "number") throw invalidType(`options.${name}`, "number", value);
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      const range = Number.isInteger(value) ? `>= 0 && <= ${maximum}` : "an integer";
      const error = new RangeError(
        `The value of "options.${name}" is out of range. It must be ${range}. Received ${inspect(value)}`,
      );
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
  }
  return result;
}

function directoryError(target) {
  const info = {
    code: "EISDIR",
    message: "is a directory",
    path: target,
    syscall: "rm",
    errno: 21,
  };
  const error = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${target}`);
  Object.defineProperty(error, "name", { value: "SystemError", configurable: true });
  Object.assign(error, {
    code: "ERR_FS_EISDIR",
    info,
    path: String(target),
    syscall: "rm",
    errno: 21,
  });
  return error;
}

function withoutTrailingSeparators(location, windows, paths) {
  const buffer = Buffer.isBuffer(location);
  const text = buffer ? location.toString("utf8") : location;
  const root = paths.parse(text).root;
  const minimum = buffer ? Buffer.byteLength(root) : root.length;
  let end = location.length;
  while (end > minimum) {
    const code = buffer ? location[end - 1] : location.charCodeAt(end - 1);
    if (code !== 47 && !(windows && code === 92)) break;
    end--;
  }
  return end === location.length ? location : location.slice(0, end);
}

// Electron 45's Windows native rmSync recursion follows directory junctions.
// Both fs and original-fs share that binding. Use only lstat, leaf unlink and
// non-recursive rmdir; never resolve a link or hand a tree back to rmSync.
function createSafeRmSync({
  fs: filesystem = fs,
  platform = process.platform,
  sleep = wait,
  resolvePath,
} = {}) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  return function rmSync(target, options) {
    const settings = optionsForRemoval(options);
    const location = target instanceof URL ? fileURLToPath(target) : target;
    // lstat validates native path types/null bytes and preserves their errors.
    let initial;
    try {
      initial = filesystem.lstatSync(location);
    } catch (error) {
      if (settings.force && error.code === "ENOENT") return;
      throw error;
    }
    if (initial.isDirectory() && !initial.isSymbolicLink() && !settings.recursive)
      throw directoryError(target);

    function unlinkLink(entry) {
      try {
        filesystem.unlinkSync(entry);
      } catch (error) {
        if (!windows || !["EPERM", "EISDIR"].includes(error.code)) throw error;
        try {
          filesystem.rmdirSync(entry);
        } catch (directoryFailure) {
          if (directoryFailure.code === "ENOENT") return;
          if (directoryFailure.code === "ENOTDIR") throw error;
          throw directoryFailure;
        }
      }
    }

    function remove(entry, root = false) {
      let retry = 0;
      let repairedPermissions = false;
      for (;;) {
        try {
          const stat = filesystem.lstatSync(entry);
          if (stat.isSymbolicLink()) {
            unlinkLink(entry);
            return;
          }
          if (stat.isDirectory()) {
            if (!settings.recursive) throw directoryError(root ? target : entry);
            const names = filesystem.readdirSync(entry, {
              encoding: Buffer.isBuffer(entry) ? "buffer" : "utf8",
            });
            for (const name of names) {
              const child = Buffer.isBuffer(entry)
                ? Buffer.concat([entry, Buffer.from(paths.sep), name])
                : paths.join(entry, name);
              remove(child);
            }
            filesystem.rmdirSync(entry);
          } else {
            filesystem.unlinkSync(entry);
          }
          return;
        } catch (error) {
          if (error.code === "ENOENT" && (!root || settings.force)) return;
          if (windows && error.code === "EPERM") {
            // Windows' read-only attribute can prevent unlink/rmdir. Recheck
            // first: chmod on a link would modify the user's target.
            let current;
            try {
              current = filesystem.lstatSync(entry);
            } catch (statError) {
              if (statError.code !== "ENOENT") throw statError;
            }
            if (
              current &&
              !current.isSymbolicLink() &&
              !repairedPermissions &&
              !(current.mode & 0o200)
            ) {
              repairedPermissions = true;
              filesystem.chmodSync(entry, (current.mode & 0o777) | 0o200);
              // Attribute repair is independent of maxRetries, like native rm.
              continue;
            }
          }
          if (!settings.recursive || !RETRYABLE.has(error.code) || retry >= settings.maxRetries)
            throw error;
          sleep(++retry * settings.retryDelay);
        }
      }
    }
    // A trailing separator can make lstat/unlink follow or reject the final
    // link on some hosts. Validation above retains the caller's path errors;
    // traversal addresses the entry itself without changing filesystem roots.
    let traversal = location;
    if (windows) {
      // C: addresses the drive's current directory, but join('C:', child)
      // addresses its root. Resolve once using Node's per-drive cwd handling
      // before constructing descendants. This never follows filesystem links.
      const absolute = (resolvePath || paths.resolve)(
        Buffer.isBuffer(location) ? location.toString("utf8") : location,
      );
      traversal = Buffer.isBuffer(location) ? Buffer.from(absolute) : absolute;
    }
    remove(withoutTrailingSeparators(traversal, windows, paths), true);
  };
}

function isApplicable({ platform = process.platform, electron = process.versions.electron } = {}) {
  return platform === "win32" && typeof electron === "string" && electron.length > 0;
}

function install() {
  if (!isApplicable()) return false;
  if (fs.rmSync[INSTALLED]) return true;
  // Mutation addresses real files, including an archive file itself. Keep
  // Electron's virtual-ASAR reads on fs intact and use physical leaf APIs here.
  // eslint-disable-next-line n/no-missing-require -- Built into Electron, absent in standalone Node.
  const replacement = createSafeRmSync({ fs: require("original-fs") });
  Object.defineProperty(replacement, INSTALLED, { value: true });
  fs.rmSync = replacement;
  require("node:module").syncBuiltinESMExports();
  return true;
}

module.exports = { install, isApplicable, createSafeRmSync };
install();
