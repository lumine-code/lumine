"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// Electron locates the WER crash helper by the packaged executable's basename.
// Rename it before code signing and before installers consume the app folder.
module.exports = async function packageWindowsCrashHelper({
  electronPlatformName,
  appOutDir,
  packager,
}) {
  if (electronPlatformName !== "win32") return;
  const name = packager.appInfo.productFilename;
  await fs.rename(
    path.join(appOutDir, "electron_wer.dll"),
    path.join(appOutDir, `${name}_wer.dll`),
  );
};
