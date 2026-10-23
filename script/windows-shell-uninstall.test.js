"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runNativeFixture } = require("./native-process-fixture");

const root = path.resolve(__dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function shellRemovalMacro() {
  const source = fs.readFileSync(path.join(root, "resources/win/installer.nsh"), "utf8");
  const macro = source.match(
    /^!macro RemoveLumineShellEntry ROOT_KEY COMMAND_SUBKEY ARG\r?\n[\s\S]*?^!macroend\b/m,
  )?.[0];
  assert.ok(macro, "The real uninstaller shell-entry macro must be present.");
  // This is an execution boundary, not a behavioral oracle: an unexpected
  // instruction or registry operand must fail before a fixture can run it.
  for (const raw of macro.split(/\r?\n/).slice(1, -1)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    if (/^ReadRegStr\b/.test(line)) {
      assert.match(line, /^ReadRegStr \$\w+ HKCU "\$\{ROOT_KEY\}\\\$\{COMMAND_SUBKEY\}" ""$/);
    } else if (/^DeleteRegKey\b/.test(line)) {
      assert.match(line, /^DeleteRegKey HKCU "\$\{ROOT_KEY\}"$/);
    } else {
      assert.match(line, /^(?:ClearErrors|\$\{(?:if|orIf|endIf)\}(?:\s.*)?)$/);
    }
  }
  return macro;
}

function nsisLiteral(value) {
  assert.doesNotMatch(value, /[\0\r\n]/);
  return `"${value.replaceAll("$", "$$").replaceAll('"', '$\\"')}"`;
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test(
  "NSIS removes only shell entries owned by the uninstalling installation",
  {
    skip: process.platform !== "win32",
    timeout: 180000,
  },
  async (t) => {
    const temporaryBase = fs.realpathSync.native(os.tmpdir());
    const directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporaryBase, "lumine-shell-uninstall-")),
    );
    let pendingNative;
    const executeNative = (...args) => {
      pendingNative = runNativeFixture(...args);
      return pendingNative;
    };
    const fixtureRoot = `Software\\LumineTests\\ShellUninstall-${randomUUID()}`;
    const registry = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    assert.match(fixtureRoot, /^Software\\LumineTests\\ShellUninstall-[a-f0-9-]+$/);
    const fixtureKey = (suffix = "") => `HKCU\\${fixtureRoot}${suffix ? `\\${suffix}` : ""}`;
    const query = (suffix = "", value) =>
      execute(registry, [
        "query",
        fixtureKey(suffix),
        ...(value === undefined ? [] : value === "" ? ["/ve"] : ["/v", value]),
        "/reg:32",
      ]);
    const readValue = (suffix, value) => {
      const result = query(suffix, value);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const match = result.stdout.match(/\bREG_SZ(?:[ \t]+(.*))?\r?$/m);
      assert.ok(match, result.stdout);
      return (match[1] || "").trimEnd();
    };
    t.after(async () => {
      // Cancellation may start this hook while the body still awaits its child.
      await Promise.allSettled(pendingNative ? [pendingNative] : []);
      try {
        execute(registry, ["delete", fixtureKey(), "/f", "/reg:32"]);
        assert.equal(query().status, 1, "The exact isolated registry fixture must be gone.");
      } finally {
        assert.equal(path.dirname(directory), temporaryBase);
        assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
        assert.equal(fs.realpathSync.native(directory), directory);
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
    assert.equal(query().status, 1, "Never reuse an existing registry fixture.");
    assert.ok(!process.env.ELECTRON_BUILDER_NSIS_DIR, "Use the checksum-managed NSIS toolset.");
    const { getMakeNsisPath } = require("app-builder-lib/out/toolsets/windows");
    // The same default toolset as the actual builder configuration. Its official
    // archive checksum and cache/download handling belong to electron-builder.
    const compiler = await getMakeNsisPath("0.0.0");
    t.signal.throwIfAborted();
    const macro = shellRemovalMacro();
    const executableName = "Lumine.exe";
    const installDirectory = path.join(directory, "Install With Spaces %1 %V");
    const app = path.join(installDirectory, executableName);
    const command = (file, argument = "%1") => `"${file}" "${argument}"`;
    const matching = command(app);
    const cases = [
      { name: "file-match", value: matching, remove: true },
      { name: "directory-match", value: matching, remove: true },
      { name: "background-match", argument: "%V", value: command(app, "%V"), remove: true },
      { name: "application-match", subkey: "shell\\open\\command", value: matching, remove: true },
      {
        name: "case-insensitive",
        value: matching.replace(/[a-z]/g, (letter) => letter.toUpperCase()),
        remove: true,
      },
      { name: "empty-command", value: "", remove: true },
      { name: "missing-command", missingCommand: true, remove: true },
      { name: "missing-default-value", missingDefault: true, remove: true },
      { name: "missing-root", missingRoot: true, remove: true },
      {
        name: "other-installation",
        value: command(path.join(directory, "Other Install", executableName)),
      },
      {
        name: "foreign-executable",
        value: command(path.join(directory, "Foreign App", "other.exe")),
      },
      { name: "foreign-arguments", value: `"${app}" --new-window "%1"` },
      { name: "other-placeholder", value: command(app, "%V") },
      { name: "unquoted-executable", value: `${app} "%1"` },
    ];
    const executable = path.join(directory, "shell-entry-harness.exe");
    const script = path.join(directory, "shell-entry-harness.nsi");
    const body = [];
    for (const fixture of cases) {
      const key = `${fixtureRoot}\\${fixture.name}`;
      const subkey = fixture.subkey || "command";
      if (!fixture.missingRoot) {
        body.push(
          `WriteRegStr HKCU ${nsisLiteral(key)} "fixture-marker" ${nsisLiteral(fixture.name)}`,
        );
        if (fixture.missingDefault) {
          body.push(
            `WriteRegStr HKCU ${nsisLiteral(`${key}\\${subkey}`)} "other-value" "retained until cleanup"`,
          );
        } else if (!fixture.missingCommand) {
          body.push(
            `WriteRegStr HKCU ${nsisLiteral(`${key}\\${subkey}`)} "" ${nsisLiteral(fixture.value)}`,
          );
        }
      }
      body.push(
        `!insertmacro RemoveLumineShellEntry ${nsisLiteral(key)} ${nsisLiteral(subkey)} ${nsisLiteral(fixture.argument || "%1")}`,
      );
    }
    fs.writeFileSync(
      script,
      [
        "Unicode true",
        '!include "LogicLib.nsh"',
        `!define APP_EXECUTABLE_FILENAME ${nsisLiteral(executableName)}`,
        'Name "Lumine shell ownership regression"',
        `OutFile ${nsisLiteral(executable)}`,
        "RequestExecutionLevel user",
        "SilentInstall silent",
        "AutoCloseWindow true",
        macro,
        "Section",
        "SetRegView 32",
        `StrCpy $INSTDIR ${nsisLiteral(installDirectory)}`,
        ...body,
        `WriteRegStr HKCU ${nsisLiteral(fixtureRoot)} "harness-completed" "yes"`,
        "SetErrorLevel 0",
        "SectionEnd",
        "",
      ].join("\n"),
    );
    const built = await executeNative(compiler.path, ["/V2", script], {
      env: { ...process.env, ...compiler.env },
      timeout: 60000,
      signal: t.signal,
      diagnostic: (message) => t.diagnostic(message),
      label: "NSIS ownership harness compilation",
    });
    assert.equal(built.signal, null, built.stderr);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    t.diagnostic(
      `macro SHA256 ${hash(macro)}; compiler SHA256 ${hash(fs.readFileSync(compiler.path))}; harness SHA256 ${hash(fs.readFileSync(executable))}`,
    );
    const ran = await executeNative(executable, ["/S"], {
      timeout: 30000,
      signal: t.signal,
      diagnostic: (message) => t.diagnostic(message),
      label: "NSIS ownership harness execution",
    });
    assert.equal(ran.signal, null, ran.stderr);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.equal(readValue("", "harness-completed"), "yes");
    for (const fixture of cases) {
      await t.test(fixture.name, () => {
        if (fixture.remove) {
          assert.equal(
            query(fixture.name).status,
            1,
            "The complete broken/owned registration must be removed.",
          );
        } else {
          assert.equal(readValue(fixture.name, "fixture-marker"), fixture.name);
          assert.equal(
            readValue(`${fixture.name}\\${fixture.subkey || "command"}`, ""),
            fixture.value,
          );
        }
      });
    }
  },
);
