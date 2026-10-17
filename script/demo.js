// Real application screenshots. No dependency on the local ecosystem manager.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { assertNeutralDirectory } = require("./demo-privacy");
const net = require("node:net");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function inside(root, relative) {
  const result = path.resolve(root, relative);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    result === root ||
    !result.startsWith(root + path.sep)
  ) {
    throw new Error(`Path must stay inside its directory: ${relative}`);
  }
  let current = root;
  for (const part of path.relative(root, result).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error(`Symlink is not a demo asset: ${current}`);
  }
  return result;
}

function validate(recipe) {
  if (recipe.version !== 1) throw new Error("demo.js must declare version: 1");
  if (!Array.isArray(recipe.scenes) || !recipe.scenes.length)
    throw new Error("A demo needs scenes");
  for (const hook of ["before", "prepare", "cleanup", "privacyText"]) {
    if (recipe[hook] !== undefined && typeof recipe[hook] !== "function")
      throw new Error(`${hook} must be a function`);
  }
  if (
    recipe.secrets !== undefined &&
    (!Array.isArray(recipe.secrets) ||
      recipe.secrets.some((key) => typeof key !== "string" || !key.trim()))
  )
    throw new Error("secrets must name encrypted store keys");
  for (const key of ["width", "height"]) {
    const n = recipe.viewport?.[key];
    if (!Number.isInteger(n) || n < 320 || n > 3840) throw new Error(`Invalid viewport ${key}`);
  }
  const ids = new Set(),
    files = new Set();
  for (const scene of recipe.scenes) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scene.id) || ids.has(scene.id))
      throw new Error("Scene ids must be unique slugs");
    if (!/^demo(?:-[a-z0-9]+)*\.png$/.test(scene.file) || files.has(scene.file))
      throw new Error("Scene files must be unique demo*.png basenames");
    if (
      typeof scene.caption !== "string" ||
      !scene.caption.trim() ||
      /[\r\n[\]]/.test(scene.caption)
    )
      throw new Error("A scene needs a plain one-line caption");
    if (typeof scene.run !== "function" || typeof scene.ready !== "function")
      throw new Error("Each scene needs run() and ready() hooks");
    for (const hook of ["drag", "afterPointerMove"]) {
      if (scene[hook] !== undefined && typeof scene[hook] !== "function")
        throw new Error(`${hook} must be a function`);
    }
    if (
      scene.timeout !== undefined &&
      (!Number.isInteger(scene.timeout) || scene.timeout < 1 || scene.timeout > 90000)
    )
      throw new Error("Scene timeout must be between 1 and 90000 ms");
    if (scene.allowNotifications !== undefined && typeof scene.allowNotifications !== "boolean")
      throw new Error("allowNotifications must be a boolean");
    ids.add(scene.id);
    files.add(scene.file);
  }
  if (
    recipe.dependencies !== undefined &&
    (!Array.isArray(recipe.dependencies) ||
      recipe.dependencies.some((n) => typeof n !== "string" || !n))
  )
    throw new Error("Invalid dependencies");
  return recipe;
}

function fixtureFiles(directory, prefix = "") {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      const file = inside(directory, entry.name);
      if (entry.isDirectory()) return fixtureFiles(file, relative);
      if (!entry.isFile()) throw new Error(`Unsupported fixture: ${relative}`);
      return [{ file: relative.replaceAll("\\", "/"), sha256: hash(fs.readFileSync(file)) }];
    });
}

async function revision(directory) {
  const git = async (args) =>
    (
      await exec("git", ["-C", directory, ...args], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  const changes = await git(["diff", "HEAD", "--binary"]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  const contents = untracked
    .sort()
    .map((file) => [file, hash(fs.readFileSync(path.join(directory, file)))]);
  return {
    revision: commit,
    dirty: Boolean(changes || untracked.length),
    workingTreeHash: hash(changes + JSON.stringify(contents)),
  };
}

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  if (
    buffer.length < 33 ||
    buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error(`Invalid PNG: ${file}`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), sha256: hash(buffer) };
}

function check(directory) {
  directory = path.resolve(directory);
  const run = readJSON(path.join(directory, "run.json"));
  if (run.version !== 1 || run.status !== "complete" || !run.images?.length)
    throw new Error("The capture is incomplete");
  if (
    !run.expectedFiles ||
    JSON.stringify(run.expectedFiles) !== JSON.stringify(run.images.map((i) => i.file))
  )
    throw new Error("Missing or reordered scenes");
  const seen = new Set();
  for (const item of run.images) {
    if (!/^demo(?:-[a-z0-9]+)*\.png$/.test(item.file)) throw new Error("Invalid image filename");
    const actual = pngSize(inside(path.join(directory, "images"), item.file));
    if (
      actual.sha256 !== item.sha256 ||
      actual.width !== item.width ||
      actual.height !== item.height
    )
      throw new Error(`Changed image: ${item.file}`);
    if (seen.has(actual.sha256)) throw new Error(`Duplicate screenshot: ${item.file}`);
    seen.add(actual.sha256);
  }
  return run;
}

function readmeWithImages(text, images) {
  const start = /^## Features\s*$/m.exec(text);
  if (!start) throw new Error("README needs a Features section before accepting images");
  const endOffset = text.slice(start.index + start[0].length).search(/^## /m);
  const end = endOffset < 0 ? text.length : start.index + start[0].length + endOffset;
  const section = text
    .slice(start.index, end)
    .replace(/^!\[[^\]\r\n]*\]\(\.github\/demo(?:-[a-z0-9]+)*\.png\)[ \t]*\r?\n?/gm, "")
    .trimEnd();
  const links = images.map((i) => `![${i.label}](.github/${i.file})`).join("\n\n");
  return text.slice(0, start.index) + section + "\n\n" + links + "\n\n" + text.slice(end);
}

async function accept(directory, target) {
  const run = check(directory);
  target = path.resolve(target);
  const manifest = readJSON(path.join(target, "package.json"));
  if (manifest.name !== run.package) throw new Error("Capture belongs to another package");
  if (hash(fs.readFileSync(path.join(target, "demo.js"))) !== run.recipeHash)
    throw new Error("Recipe changed; capture again");
  if (
    run.fixtures &&
    JSON.stringify(fixtureFiles(inside(target, run.fixturesDirectory || "demo"))) !==
      JSON.stringify(run.fixtures)
  )
    throw new Error("Fixtures changed; capture again");
  const readme = path.join(target, "README.md");
  const next = readmeWithImages(fs.readFileSync(readme, "utf8"), run.images);
  const media = inside(target, ".github");
  fs.mkdirSync(media, { recursive: true });
  for (const item of run.images) inside(media, item.file);
  inside(media, "demo.json");
  const metadata = {
    title: manifest.name,
    description: run.images[0].label,
    recordedOn: run.recordedOn,
    sourceRevision: run.sources.package.revision,
    themeSourceRevision: run.sources["one-theme"].revision,
    mode: "normal",
    fontSettings: "default",
    scenario: "demo.js",
    recipeHash: run.recipeHash,
    environment: run.environment,
    viewport: run.viewport,
    cornerRadius: 10,
    privacy: run.privacy,
    sources: run.sources,
    fixtures: run.fixtures,
    images: run.images,
  };
  const prettier = require("prettier");
  const metadataText = await prettier.format(JSON.stringify(metadata), {
    ...(await prettier.resolveConfig(path.join(media, "demo.json"))),
    parser: "json",
  });
  // All input is checked before any tracked file is changed. Never delete other assets.
  for (const item of run.images)
    fs.copyFileSync(path.join(directory, "images", item.file), path.join(media, item.file));
  fs.writeFileSync(path.join(media, "demo.json"), metadataText);
  fs.writeFileSync(readme, next);
  console.log(
    `Accepted ${run.images.length} images in ${target}. Review the diff before committing.`,
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function seedSecrets(keys, secretsFile, profile) {
  const sourceFile = path.resolve(secretsFile);
  const source = readJSON(sourceFile);
  const selected = {};
  for (const key of keys) {
    if (typeof source[key] !== "string") throw new Error(`Missing requested credential: ${key}`);
    selected[key] = source[key];
  }
  fs.writeFileSync(path.join(profile, "secret-store.json"), JSON.stringify(selected), {
    mode: 0o600,
  });
  // Chromium on Windows encrypts store entries with a per-profile key. Copy
  // only its OS-protected crypto metadata, never the rest of the old profile.
  const stateFile = path.join(path.dirname(sourceFile), "electronUserData", "Local State");
  if (fs.existsSync(stateFile)) {
    const state = readJSON(stateFile);
    if (state.os_crypt) {
      const directory = path.join(profile, "electronUserData");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "Local State"),
        JSON.stringify({ os_crypt: state.os_crypt }),
        { mode: 0o600 },
      );
    }
  }
}

async function capture(repository, options = {}) {
  const repo = fs.realpathSync(path.resolve(repository));
  const recipePath = path.join(repo, "demo.js");
  const recipe = validate(require(recipePath));
  const manifest = readJSON(path.join(repo, "package.json"));
  if (!manifest.engines?.lumine) throw new Error("Only Lumine packages have editor demos");
  const workspace = path.resolve(options.workspace || path.dirname(repo));
  const wanted = [...new Set([manifest.name, "one-theme", ...(recipe.dependencies || [])])];
  const packages = new Map([[manifest.name, repo]]);
  for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = path.join(workspace, entry.name),
      file = path.join(folder, "package.json");
    if (!fs.existsSync(file)) continue;
    const candidate = readJSON(file);
    if (
      wanted.includes(candidate.name) &&
      candidate.engines?.lumine &&
      !packages.has(candidate.name)
    )
      packages.set(candidate.name, folder);
  }
  for (const name of wanted) {
    if (!packages.has(name))
      throw new Error(
        `Missing checkout for ${name}; clone it in --workspace and install its dependencies`,
      );
  }
  const fixtures = inside(repo, recipe.fixtures || "demo");
  const inputs = fixtureFiles(fixtures);
  const directory = assertNeutralDirectory(
    options.out ||
      path.join(
        process.platform === "win32" ? path.parse(ROOT).root : "/tmp",
        "Lumine-Demos",
        `${manifest.name}-${crypto.randomBytes(3).toString("hex")}`,
      ),
    [workspace, ROOT, repo, os.homedir()],
  );
  if (directory === fixtures || directory.startsWith(fixtures + path.sep))
    throw new Error("Output cannot be inside the fixtures");
  // Exclusive creation keeps an old capture/profile intact and allows concurrent runs.
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  const profile = path.join(directory, "profile"),
    project = path.join(directory, "project");
  fs.mkdirSync(profile);
  fs.mkdirSync(path.join(directory, "images"));
  fs.mkdirSync(path.join(directory, "raw"));
  fs.writeFileSync(path.join(profile, "styles.css"), "");
  if (recipe.secrets?.length) {
    if (!options["secrets-file"])
      throw new Error(
        "This demo requires an authenticated profile; pass --secrets-file with its encrypted secret-store.json",
      );
    seedSecrets(recipe.secrets, options["secrets-file"], profile);
  }
  fs.writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      "*": {
        ...(options.settings ? readJSON(path.resolve(options.settings)) : {}),
        ...(recipe.config || {}),
        core: { disabledPackages: wanted.filter((name) => name !== "one-theme") },
        about: { showOnStartup: false },
        "lumine-updater": { checkForUpdatesOnLaunch: false },
        welcome: { showOnStartup: false },
        theme: { mode: "light" },
        "spell-check": { locales: ["en-US"] },
      },
    }),
  );
  if (options["server-cache"]) {
    const cache = fs.realpathSync(path.resolve(options["server-cache"]));
    fs.symlinkSync(
      cache,
      path.join(profile, "language-servers"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  fs.cpSync(fixtures, project, { recursive: true, dereference: false });
  // Give copied fixtures a clean baseline rather than inheriting the editor's
  // enclosing repository and showing every line as newly added.
  const gitOptions = { cwd: project, windowsHide: true };
  await exec("git", ["-c", "init.templateDir=", "init", "--initial-branch=master"], gitOptions);
  // Both the fixture commit and the running Git UI must use the demo identity.
  // A command-only override leaves the UI reading the maintainer's global identity.
  await exec("git", ["config", "--local", "user.name", "Lumine Demo"], gitOptions);
  await exec("git", ["config", "--local", "user.email", "demo@example.invalid"], gitOptions);
  await exec("git", ["-c", "core.autocrlf=false", "add", "."], gitOptions);
  await exec(
    "git",
    ["-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "Prepare demo fixtures"],
    gitOptions,
  );
  const sources = { editor: await revision(ROOT), package: await revision(repo) };
  for (const [name, location] of packages) sources[name] = await revision(location);
  const run = {
    version: 1,
    status: "capturing",
    package: manifest.name,
    recordedOn: new Date().toISOString().slice(0, 10),
    recipeHash: hash(fs.readFileSync(recipePath)),
    fixtures: inputs,
    fixturesDirectory: recipe.fixtures || "demo",
    sources,
    viewport: recipe.viewport,
    expectedFiles: recipe.scenes.map((s) => s.file),
    privacy: { version: 1, location: "neutral", textChecked: true },
    images: [],
  };
  writeJSON(path.join(directory, "run.json"), run);
  const port = await freePort();
  const drive = async (args) => {
    const result = await exec(
      process.execPath,
      [path.join(__dirname, "drive.js"), ...args, "--port", String(port)],
      {
        cwd: ROOT,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          LUMINE_DEV_MODE: "0",
          LUMINE_RESOURCE_PATH: ROOT,
          LUMINE_DISABLE_URI_HANDLER_REGISTRATION: "1",
        },
      },
    );
    return result.stdout.trim();
  };
  let sequence = 0,
    launched = false;
  const evaluate = async (code) => {
    const file = path.join(directory, `evaluate-${++sequence}.js`);
    fs.writeFileSync(file, `(async () => {\n${code}\n})()`);
    return JSON.parse(await drive(["eval", "-f", file]));
  };
  try {
    console.log(`Capturing ${manifest.name}: ${directory}`);
    await drive([
      "launch",
      project,
      "--home",
      profile,
      "--no-dev",
      "--fresh",
      ...[...packages.values()].flatMap((p) => ["--link", p]),
    ]);
    launched = true;
    run.environment = await evaluate(
      `return await require(${JSON.stringify(path.join(__dirname, "demo-renderer.js"))}).setup(${JSON.stringify({ profile, project, recipePath, packages: wanted, packagePaths: Object.fromEntries(packages), nodePath: process.execPath, viewport: recipe.viewport, privateRoots: [workspace, ROOT, os.homedir(), path.dirname(process.execPath), ...packages.values()] })});`,
    );
    for (const scene of recipe.scenes) {
      console.log(`  ${scene.id}`);
      const gesture = await evaluate(
        `return await globalThis.lumineDemo.scene(${JSON.stringify(scene.id)});`,
      );
      if (gesture) {
        if (!Array.isArray(gesture) || gesture.length !== 4 || !gesture.every(Number.isFinite))
          throw new Error("drag() must return four finite coordinates");
        await drive(["drag", ...gesture.map(String)]);
      }
      await drive(["move", "500", "20"]);
      await evaluate("await globalThis.lumineDemo.check(); return true;");
      const raw = path.join(directory, "raw", scene.file),
        output = path.join(directory, "images", scene.file);
      await drive(["shot", "body", "--out", raw]);
      await evaluate(
        `await globalThis.lumineDemo.round(${JSON.stringify(raw)}, ${JSON.stringify(output)}); return true;`,
      );
      run.images.push({ file: scene.file, label: scene.caption, ...pngSize(output) });
    }
    const after = { editor: await revision(ROOT), package: await revision(repo) };
    for (const [name, location] of packages) after[name] = await revision(location);
    if (JSON.stringify(after) !== JSON.stringify(sources))
      throw new Error("Sources changed during capture; run again after the edits finish");
    run.status = "complete";
    writeJSON(path.join(directory, "run.json"), run);
    check(directory);
    console.log(`Review images/, then: node script/demo.js accept "${directory}" "${repo}"`);
  } catch (error) {
    run.status = "failed";
    run.error = error.message;
    writeJSON(path.join(directory, "run.json"), run);
    if (launched)
      await drive(["shot", "body", "--out", path.join(directory, "failure.png")]).catch(() => {});
    throw error;
  } finally {
    if (launched) {
      await evaluate("await globalThis.lumineDemo?.cleanup(); return true;").catch((error) =>
        console.error(`Cleanup: ${error.message}`),
      );
      await drive(["quit"]).catch((error) =>
        console.error(`Close the demo window manually: ${error.message}`),
      );
    }
  }
  return directory;
}

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help") {
    console.log(
      "Usage:\n  node script/demo.js capture <repo> [--workspace <dir>] [--out <new-dir>]\n    [--settings <json>] [--server-cache <dir>] [--secrets-file <encrypted-json>]\n  node script/demo.js check <run-dir>\n  node script/demo.js accept <run-dir> <repo>\n\nRead docs/reproducible-demos.md. Recipes execute trusted local JavaScript.",
    );
    return;
  }
  if (command === "check" && rest.length === 1) {
    console.log(`Verified ${check(rest[0]).images.length} images`);
    return;
  }
  if (command === "accept" && rest.length === 2) return accept(path.resolve(rest[0]), rest[1]);
  if (command === "capture" && rest[0]) {
    const options = {};
    for (let i = 1; i < rest.length; i += 2) {
      if (
        !["--workspace", "--out", "--settings", "--server-cache", "--secrets-file"].includes(
          rest[i],
        ) ||
        !rest[i + 1]
      )
        throw new Error(`Unknown or incomplete option: ${rest[i]}`);
      options[rest[i].slice(2)] = rest[i + 1];
    }
    return capture(rest[0], options);
  }
  throw new Error("Invalid arguments; use --help");
}

module.exports = {
  seedSecrets,
  inside,
  validate,
  fixtureFiles,
  pngSize,
  check,
  readmeWithImages,
  accept,
  capture,
};
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
