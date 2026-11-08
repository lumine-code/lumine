"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runNativeFixture } = require("./native-process-fixture");
const { whatToBuild } = require("./electron-builder");
const { fixtureNsisCompiler } = require("./nsis-toolset-fixture");

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

const nsisVersion = "1.2.1";
const nsisArchive = "nsis-bundle-3.12.tar.gz";
const nsisURL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis@${nsisVersion}/${nsisArchive}`;
const nsisAPI = "https://api.github.com/repos/electron-userland/electron-builder-binaries/releases";
const fixtureArchive = Buffer.from("isolated transport test bytes");

function nsisRecoveryFixture(t, options = {}) {
  const temporaryBase = fs.realpathSync.native(os.tmpdir());
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(temporaryBase, "lumine-nsis-transport-")),
  );
  t.after(() => {
    assert.equal(path.dirname(directory), temporaryBase);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const error = Object.assign(new Error(`Response code 504 (Gateway Time-out) for ${nsisURL}`), {
    name: "HTTPError",
  });
  const compiler = { path: "verified compiler" };
  const calls = [];
  const requests = [];
  const metadata = {
    tag_name: `nsis@${nsisVersion}`,
    assets: [
      {
        id: 123,
        name: nsisArchive,
        size: fixtureArchive.length,
        browser_download_url: nsisURL.replace("nsis@", "nsis%40"),
      },
    ],
  };
  const settings = {
    resourcesDirectory: path.join(root, "resources"),
    directory,
    env: {},
    nsisChecksums: { [nsisVersion]: { [nsisArchive]: hash(fixtureArchive) } },
    getMakeNsisPath: async (...args) => {
      calls.push(args);
      if (args[0]?.url === `file://${path.join(directory, nsisArchive)}`) return compiler;
      if (calls.length === 1) throw error;
      assert.equal(calls.length, 2, "one recovery, never retry native assertions");
      return compiler;
    },
    fetch: async (url, request) => {
      requests.push({ url, request });
      if (requests.length === 1) return Response.json(metadata);
      assert.equal(requests.length, 2, "one exact official asset request");
      return new Response(fixtureArchive);
    },
    ...options,
  };
  return { settings, error, compiler, calls, requests, metadata, directory };
}

test("NSIS recovery keeps the pinned archive and delegates extraction to the builder", async (t) => {
  const fixture = nsisRecoveryFixture(t);
  const signal = new AbortController().signal;
  fixture.settings.signal = signal;
  assert.equal(await fixtureNsisCompiler(fixture.settings), fixture.compiler);
  assert.deepEqual(fixture.calls[0], [undefined, fixture.settings.resourcesDirectory]);
  assert.deepEqual(fixture.calls[1], [
    {
      url: `file://${path.join(fixture.directory, nsisArchive)}`,
      checksum: hash(fixtureArchive),
      version: nsisVersion,
    },
    fixture.settings.resourcesDirectory,
  ]);
  assert.deepEqual(fs.readFileSync(path.join(fixture.directory, nsisArchive)), fixtureArchive);
  assert.deepEqual(fixture.requests, [
    {
      url: `${nsisAPI}/tags/nsis%401.2.1`,
      request: { headers: { Accept: "application/vnd.github+json" }, signal, redirect: "error" },
    },
    {
      url: `${nsisAPI}/assets/123`,
      request: { headers: { Accept: "application/octet-stream" }, signal, redirect: "manual" },
    },
  ]);
});

test("NSIS recovery supplies its explicit token only to the shared official API boundary", async (t) => {
  const fixture = nsisRecoveryFixture(t, { env: { GITHUB_TOKEN: "fixture-token" } });
  assert.equal(await fixtureNsisCompiler(fixture.settings), fixture.compiler);
  assert.deepEqual(
    fixture.requests.map(({ request }) => request.headers),
    [
      { Accept: "application/vnd.github+json", Authorization: "Bearer fixture-token" },
      { Accept: "application/octet-stream", Authorization: "Bearer fixture-token" },
    ],
  );
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][0].version, nsisVersion);
});

test("an NSIS signed asset redirect has no credential and still needs the pinned checksum", async (t) => {
  const fixture = nsisRecoveryFixture(t, { env: { GITHUB_TOKEN: "fixture-token" } });
  const signedURL = "https://release-assets.githubusercontent.com/isolated-fixture?signature=test";
  fixture.settings.fetch = async (url, request) => {
    fixture.requests.push({ url, request });
    if (fixture.requests.length === 1) return Response.json(fixture.metadata);
    if (fixture.requests.length === 2) {
      return new Response(null, { status: 302, headers: { Location: signedURL } });
    }
    assert.equal(fixture.requests.length, 3);
    assert.equal(url, signedURL);
    assert.equal(request.headers, undefined);
    assert.equal(request.redirect, "error");
    return new Response(fixtureArchive);
  };
  assert.equal(await fixtureNsisCompiler(fixture.settings), fixture.compiler);
  assert.deepEqual(fs.readFileSync(path.join(fixture.directory, nsisArchive)), fixtureArchive);
  assert.equal(fixture.calls.length, 1);
});

test("an NSIS asset API rate limit remains a failure without a transport retry", async (t) => {
  const fixture = nsisRecoveryFixture(t, { env: { GITHUB_TOKEN: "fixture-token" } });
  fixture.settings.fetch = async (url, request) => {
    fixture.requests.push({ url, request });
    return fixture.requests.length === 1
      ? Response.json(fixture.metadata)
      : new Response(null, { status: 403 });
  };
  await assert.rejects(fixtureNsisCompiler(fixture.settings), /archive HTTP 403/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fs.readdirSync(fixture.directory), []);
});

test("an available NSIS compiler uses the original builder path once", async (t) => {
  const fixture = nsisRecoveryFixture(t);
  fixture.settings.getMakeNsisPath = async () => fixture.compiler;
  assert.equal(await fixtureNsisCompiler(fixture.settings), fixture.compiler);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fs.readdirSync(fixture.directory), []);
});

test("authenticated NSIS provisioning does not wait for a slow original browser download", async (t) => {
  const fixture = nsisRecoveryFixture(t, { env: { GITHUB_TOKEN: "fixture-token" } });
  const gate = Promise.withResolvers();
  let originalEntered = false;
  fixture.settings.getMakeNsisPath = async (...args) => {
    fixture.calls.push(args);
    if (args[0] == null) {
      originalEntered = true;
      return gate.promise;
    }
    return fixture.compiler;
  };
  const operation = fixtureNsisCompiler(fixture.settings);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(originalEntered, false, "API provisioning must not await the slow browser route");
    assert.equal(await operation, fixture.compiler);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0][0].version, nsisVersion);
    assert.equal(fixture.calls[0][0].checksum, hash(fixtureArchive));
    assert.equal(fixture.requests.length, 2);
  } finally {
    gate.resolve(fixture.compiler);
    await operation.catch(() => {});
  }
});

for (const selector of [undefined, null, "latest", nsisVersion]) {
  test(`authenticated provisioning retains the reviewed NSIS selector ${JSON.stringify(selector)}`, async (t) => {
    const fixture = nsisRecoveryFixture(t, { selector, env: { GITHUB_TOKEN: "fixture-token" } });
    assert.equal(await fixtureNsisCompiler(fixture.settings), fixture.compiler);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0][0].version, nsisVersion);
    assert.equal(fixture.calls[0][0].checksum, hash(fixtureArchive));
  });
}

test("a changed default bundle catalogue keeps the original builder selection", async (t) => {
  const fixture = nsisRecoveryFixture(t, { env: { GITHUB_TOKEN: "fixture-token" } });
  fixture.settings.nsisChecksums["1.2.2"] = { [nsisArchive]: "a".repeat(64) };
  fixture.settings.getMakeNsisPath = async (...args) => {
    fixture.calls.push(args);
    return fixture.compiler;
  };
  assert.equal(await fixtureNsisCompiler(fixture.settings), fixture.compiler);
  assert.deepEqual(fixture.calls, [[undefined, fixture.settings.resourcesDirectory]]);
  assert.deepEqual(fixture.requests, []);
});

for (const key of [
  "NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR",
  "npm_config_electron_builder_binaries_mirror",
  "npm_package_config_electron_builder_binaries_mirror",
  "ELECTRON_BUILDER_BINARIES_MIRROR",
]) {
  test(`authenticated provisioning preserves the configured ${key}`, async (t) => {
    const fixture = nsisRecoveryFixture(t, {
      env: { GITHUB_TOKEN: "fixture-token", [key]: "https://mirror.invalid/" },
    });
    await assert.rejects(fixtureNsisCompiler(fixture.settings), (error) => error === fixture.error);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.requests, []);
  });
}

for (const key of ["HTTPS_PROXY", "https_proxy"]) {
  test(`authenticated provisioning preserves the configured ${key} route`, async (t) => {
    const fixture = nsisRecoveryFixture(t, {
      env: { GITHUB_TOKEN: "fixture-token", [key]: "http://proxy.invalid:8080" },
    });
    await assert.rejects(fixtureNsisCompiler(fixture.settings), (error) => error === fixture.error);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.requests, []);
  });
}

for (const key of ["HTTPS_PROXY", "https_proxy"]) {
  test(`NSIS recovery preserves an explicitly configured ${key}`, async (t) => {
    const fixture = nsisRecoveryFixture(t, { env: { [key]: "http://proxy.invalid:8080" } });
    await assert.rejects(fixtureNsisCompiler(fixture.settings), (error) => error === fixture.error);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.requests, []);
    assert.deepEqual(fs.readdirSync(fixture.directory), []);
  });
}

for (const message of [
  `Response code 403 (Forbidden) for ${nsisURL}`,
  `Response code 404 (Not Found) for ${nsisURL}`,
  `Response code 504 (Gateway Time-out) for ${nsisURL}?mirror=1`,
  `Response code 504 (Gateway Time-out) for ${nsisURL.replace("github.com/", "mirror.invalid/")}`,
  `Response code 504 (Gateway Time-out) for ${nsisURL.replace("1.2.1/", "1.2.2/")}`,
  "checksum mismatch",
]) {
  test(`NSIS recovery preserves the original error: ${message}`, async (t) => {
    const fixture = nsisRecoveryFixture(t);
    fixture.error.message = message;
    await assert.rejects(fixtureNsisCompiler(fixture.settings), (error) => error === fixture.error);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.requests, []);
  });
}

for (const selector of ["0.0.0", "1.2.2", { url: "https://custom.invalid/archive" }]) {
  test(`a different NSIS selector remains the builder's responsibility: ${JSON.stringify(selector)}`, async (t) => {
    const fixture = nsisRecoveryFixture(t, { selector });
    await assert.rejects(fixtureNsisCompiler(fixture.settings), (error) => error === fixture.error);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.requests, []);
  });
}

for (const change of [
  (metadata) => (metadata.tag_name = "nsis@1.2.2"),
  (metadata) => metadata.assets.push(metadata.assets[0]),
  (metadata) => (metadata.assets[0].id = -1),
  (metadata) => (metadata.assets[0].size = 0),
  (metadata) => (metadata.assets[0].browser_download_url = "https://mirror.invalid/archive"),
]) {
  test("unmatched NSIS release metadata cannot select another toolset", async (t) => {
    const fixture = nsisRecoveryFixture(t);
    change(fixture.metadata);
    await assert.rejects(fixtureNsisCompiler(fixture.settings), /official NSIS release/i);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fs.readdirSync(fixture.directory), []);
  });
}

test("corrupt NSIS bytes fail before the builder receives a custom toolset", async (t) => {
  const fixture = nsisRecoveryFixture(t);
  fixture.settings.nsisChecksums[nsisVersion][nsisArchive] = "0".repeat(64);
  await assert.rejects(fixtureNsisCompiler(fixture.settings), /pinned builder checksum/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fs.readdirSync(fixture.directory), []);
});

test("NSIS recovery does not overwrite an existing owned archive", async (t) => {
  const fixture = nsisRecoveryFixture(t);
  fs.writeFileSync(path.join(fixture.directory, nsisArchive), "existing fixture");
  await assert.rejects(fixtureNsisCompiler(fixture.settings), { code: "EEXIST" });
  assert.equal(
    fs.readFileSync(path.join(fixture.directory, nsisArchive), "utf8"),
    "existing fixture",
  );
  assert.equal(fixture.calls.length, 1);
});

test("NSIS recovery stops on API errors without another attempt", async (t) => {
  const fixture = nsisRecoveryFixture(t);
  fixture.settings.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(fixtureNsisCompiler(fixture.settings), /metadata HTTP 403/);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fs.readdirSync(fixture.directory), []);
});

test("cancellation prevents the NSIS alternative asset request", async (t) => {
  const fixture = nsisRecoveryFixture(t);
  const controller = new AbortController();
  controller.abort();
  fixture.settings.signal = controller.signal;
  await assert.rejects(fixtureNsisCompiler(fixture.settings), { name: "AbortError" });
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.requests, []);
});

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
    let pendingToolset;
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
      await Promise.allSettled([pendingToolset, pendingNative].filter(Boolean));
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
    // This toolset helper has no package subpath export in the pinned builder.
    // Resolve its exported function relative to the supported package entry.
    const builderDirectory = path.dirname(require.resolve("app-builder-lib"));
    const builderManifest = JSON.parse(
      fs.readFileSync(path.join(builderDirectory, "..", "package.json"), "utf8"),
    );
    assert.equal(
      builderManifest.version,
      require("../package.json").devDependencies["electron-builder"],
      "Use the toolset implementation belonging to the pinned builder.",
    );
    const toolsetModule = path.join(builderDirectory, "toolsets", "nsis.js");
    const { getMakeNsisPath, nsisChecksums } = require(toolsetModule);
    // The same default toolset as the actual builder configuration. Its official
    // archive checksum and cache/download handling belong to electron-builder.
    pendingToolset = fixtureNsisCompiler({
      selector: whatToBuild().toolsets?.nsis,
      resourcesDirectory: path.join(root, "resources"),
      directory,
      signal: t.signal,
      getMakeNsisPath,
      nsisChecksums,
      report: (message) => t.diagnostic(message),
    });
    const compiler = await pendingToolset;
    if (path.extname(compiler.path).toLowerCase() === ".cmd") {
      // The official wrapper sets NSISDIR and invokes windows/makensis.exe.
      // Run that native child directly so cancellation cannot orphan a shell.
      const nsisDirectory = path.join(path.dirname(compiler.path), "windows");
      compiler.path = path.join(nsisDirectory, "makensis.exe");
      compiler.env = { ...compiler.env, NSISDIR: nsisDirectory };
    }
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
