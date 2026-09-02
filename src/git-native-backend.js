const REQUIRED_GIT_UTILS_MAJOR = 10;
const REQUIRED_LIBGIT2_VERSION = "1.9.6";

const REQUIRED_EXPORTS = [
  "versions",
  "configure",
  "snapshot",
  "diff",
  "history",
  "commit",
  "blame",
  "describe",
  "branchesContaining",
  "readObjects",
  "readConfig",
  "fileMode",
  "submodulePaths",
  "lineDiff",
  "mutate",
];

function initializationError(message, cause) {
  const error = new Error(message);
  error.name = "GitNativeInitializationError";
  error.code = "ERR_GIT_NATIVE_INIT";
  error.operation = "initialize";
  error.retriable = false;
  if (cause) error.cause = cause;
  return error;
}

function validateNativeBackend(nativeBackend) {
  if (!nativeBackend || typeof nativeBackend !== "object") {
    throw initializationError("@lumine-code/git-utils did not export an object");
  }

  for (const name of REQUIRED_EXPORTS) {
    if (typeof nativeBackend[name] !== "function") {
      throw initializationError(`@lumine-code/git-utils is missing the ${name}() export`);
    }
  }

  let versions;
  try {
    versions = nativeBackend.versions();
  } catch (cause) {
    throw initializationError("Unable to read @lumine-code/git-utils versions", cause);
  }

  const gitUtilsMajor = Number.parseInt(String(versions?.gitUtils || "").split(".")[0], 10);
  if (gitUtilsMajor !== REQUIRED_GIT_UTILS_MAJOR) {
    throw initializationError(
      `Lumine requires @lumine-code/git-utils ${REQUIRED_GIT_UTILS_MAJOR}.x; loaded ${versions?.gitUtils || "unknown"}`,
    );
  }
  if (versions?.libgit2 !== REQUIRED_LIBGIT2_VERSION) {
    throw initializationError(
      `Lumine requires libgit2 ${REQUIRED_LIBGIT2_VERSION}; loaded ${versions?.libgit2 || "unknown"}`,
    );
  }

  return Object.freeze({ nativeBackend, versions: Object.freeze({ ...versions }) });
}

function loadNativeBackend() {
  try {
    return validateNativeBackend(require("@lumine-code/git-utils"));
  } catch (error) {
    if (error?.code === "ERR_GIT_NATIVE_INIT") throw error;
    throw initializationError("Unable to load @lumine-code/git-utils", error);
  }
}

function configureNativeBackend(loaded, { trustAllRepositories }) {
  return loaded.nativeBackend.configure({
    validateOwnership: trustAllRepositories !== true,
  });
}

module.exports = {
  REQUIRED_GIT_UTILS_MAJOR,
  REQUIRED_LIBGIT2_VERSION,
  configureNativeBackend,
  loadNativeBackend,
  validateNativeBackend,
};
