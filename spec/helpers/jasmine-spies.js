const FindParentDir = require("../../src/find-parent-dir");
const fs = require("@lumine-code/fs-plus");
const path = require("path");
const _ = require("@lumine-code/underscore-plus");
const TextEditorElement = require("../../src/text-editor-element");
const TextEditor = require("../../src/text-editor");
const clipboardBridge = require("../../src/clipboard-bridge");
const getWindowLoadSettings = require("../../src/get-window-load-settings");

const { testPaths } = getWindowLoadSettings();
let specPackagePath = FindParentDir.sync(testPaths[0], "package.json");

// CI provisions packages that a spec activates into a private LUMINE_HOME.
// Older specs still spell those dependencies as sibling checkout paths (for
// example, `../../language-javascript`). In a single-package checkout that
// path does not exist, even though the package is available by name through
// the test home. Keep the compatibility seam in the spec helper rather than
// making PackageManager reinterpret arbitrary missing production paths.
const testPackageNames = new Set(
  (process.env.LUMINE_TEST_PACKAGES || "").split(/\s+/).filter(Boolean),
);

let specPackageName;
if (specPackagePath) {
  const packageMetadata = require(path.join(specPackagePath, "package.json"));
  specPackageName = packageMetadata.name;
}

let specDirectory = FindParentDir.sync(testPaths[0], "fixtures");
let specProjectPath;
if (specDirectory) {
  specProjectPath = path.join(specDirectory, "fixtures");
} else {
  // A fresh, empty directory — never the shared OS tmpdir, which accumulates
  // git checkouts (npm clones git dependencies there) until repository
  // discovery hits its limit and posts a notification into unrelated specs.
  const os = require("os");
  specProjectPath = require("fs").mkdtempSync(path.join(os.tmpdir(), "lumine-spec-project-"));
}

exports.register = (jasmineEnv) => {
  jasmineEnv.beforeEach(function () {
    // Do not clobber recent project history
    spyOn(Object.getPrototypeOf(lumine.history), "saveState").and.returnValue(Promise.resolve());

    lumine.project.setPaths([specProjectPath]);

    // The package under test is not installed into the scratch LUMINE_HOME, so
    // its name is not in the package index and `activatePackage("<name>")`
    // would fail. Substitute the checkout's path whenever its name is
    // resolved. `resolveAvailablePackage` is the seam every name passes
    // through — `loadPackage` and the public `resolvePackagePath` both call
    // it, so faking anything shallower leaves `activatePackage` unfixed.
    const resolveAvailablePackage = lumine.packages.resolveAvailablePackage.bind(lumine.packages);
    spyOn(lumine.packages, "resolveAvailablePackage").and.callFake(function (nameOrPath) {
      let resolvedNameOrPath = nameOrPath;
      if (typeof nameOrPath === "string" && !fs.isDirectorySync(nameOrPath)) {
        const packageName = path.basename(nameOrPath);
        const isProvisioned = testPackageNames.has(packageName);
        const isBundled = lumine.packages.isBundledPackage?.(packageName) === true;
        if (isProvisioned || isBundled) resolvedNameOrPath = packageName;
      }

      if (specPackageName && resolvedNameOrPath === specPackageName) {
        return resolveAvailablePackage(specPackagePath);
      }
      return resolveAvailablePackage(resolvedNameOrPath);
    });

    // Prevent specs from modifying Lumine's menus.
    spyOn(lumine.menu, "sendToBrowserProcess");

    // reset config before each spec
    lumine.config.set("core.destroyEmptyPanes", false);
    lumine.config.set("editor.fontFamily", "Courier");
    lumine.config.set("editor.fontSize", 16);
    lumine.config.set("editor.autoIndent", false);
    lumine.config.set("core.disabledPackages", [
      "package-that-throws-an-exception",
      "package-with-broken-package-json",
      "package-with-broken-keymap",
    ]);

    // advanceClock(1000);
    // window.setTimeout.calls.reset();

    // make editor display updates synchronous
    TextEditorElement.prototype.setUpdatedSynchronously(true);

    spyOn(TextEditor.prototype, "shouldPromptToSave").and.returnValue(false);

    // Keep a spec run off the real clipboard. The bridge is the seam rather
    // than {Clipboard} itself, so every spec still exercises the metadata and
    // line-ending logic that sits above it.
    let clipboardContent = "initial clipboard content";
    spyOn(clipboardBridge, "writeText").and.callFake((text) => (clipboardContent = text));
    spyOn(clipboardBridge, "readText").and.callFake(() => clipboardContent);
  });
};

jasmine.unspy = function (object, methodName) {
  object[methodName].and.callThrough();
};
