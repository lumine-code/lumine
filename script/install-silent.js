"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { productName, version } = require("../package.json");

const checkout = path.resolve(__dirname, "..");
const defaultInstaller = path.join(checkout, "dist", `${productName} Setup ${version}.exe`);

const inspectInstallation = String.raw`
$ErrorActionPreference = 'Stop'
$roots = @($env:LUMINE_INSTALL_CHECKOUT, $env:LUMINE_RESOURCE_PATH) | Where-Object { $_ }
$developmentExecutables = @($roots | ForEach-Object {
  Join-Path $_ 'node_modules\electron\dist\electron.exe'
})
$running = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Lumine.exe' OR Name = 'electron.exe'" | Where-Object {
  $_.Name -eq 'Lumine.exe' -or
    $_.ExecutablePath -in $developmentExecutables -or
    $_.ExecutablePath -match '[\\/]lumine[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$'
}
if ($running) { exit 2 }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $machineRegistries = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  ) | Where-Object { Test-Path -LiteralPath $_ }
  $machineInstall = $machineRegistries | ForEach-Object { Get-ItemProperty -Path "$_\*" } |
    Where-Object DisplayName -EQ 'Lumine'
  if ($machineInstall) { exit 3 }
}
exit 0
`;

function installSilently({
  platform = process.platform,
  env = process.env,
  run = spawnSync,
  installer = defaultInstaller,
} = {}) {
  if (platform !== "win32") throw new Error("Silent installation requires Windows.");
  const windowsDirectory = env.SystemRoot || env.WINDIR;
  if (!windowsDirectory) throw new Error("The Windows system directory is unavailable.");
  const powershell = path.win32.join(
    windowsDirectory,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const inspection = run(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", inspectInstallation],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...env, LUMINE_INSTALL_CHECKOUT: checkout },
    },
  );
  if (inspection.status === 2) throw new Error("Close Lumine before installing this build.");
  if (inspection.status === 3) {
    throw new Error("Run this command from an elevated shell to update an all-users installation.");
  }
  if (inspection.status !== 0 || inspection.error) {
    throw new Error("Unable to check the Lumine installation.", {
      cause:
        inspection.error ?? new Error(inspection.stderr?.trim() || "Process inspection failed"),
    });
  }
  if (!fs.statSync(installer, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Installer missing at ${installer}. Run npm run full first.`);
  }
  const result = run(installer, ["/S", "--require-closed"], {
    stdio: "inherit",
    windowsHide: true,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`The Lumine installer exited with code ${result.status}.`);
}

if (require.main === module) {
  try {
    installSilently();
  } catch (error) {
    console.error(error.message);
    if (error.cause) console.error(error.cause.message);
    process.exitCode = 1;
  }
}

module.exports = { installSilently };
