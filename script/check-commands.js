// Verifies a command's two pieces of prose — its label and its description.
// See "Command display names" and "Command descriptions" in the workspace
// CLAUDE.md for the rules.
//
//   node script/check-commands.js                     the bundled fleet
//   node script/check-commands.js --root ..           every repository here
//   node script/check-commands.js --root .. --uncovered
//
// A command's label is derived: `extractDescriptor` (src/command-registry.js)
// falls back to `_.humanizeEventName`, which spells the words with a casing of
// their own from the `ACRONYMS` map in underscore-plus. A `displayName` is the
// escape hatch for a label that vocabulary still cannot reach, so it may
// differ from the derived label only in letter case and internal spacing.
// Anything else is a rename wearing a label, and belongs in the command name.
//
// Four findings, each of which the derivation makes possible:
//
//   1. a displayName that rephrases — rename the command instead
//   2. a displayName the humanizer already produces — delete it
//   3. a displayName that adds a space — the name is squashed, add the dash
//   4. a displayName that only re-cases an ordinary word — palette labels keep
//      the humanizer's word case; lowercase prepositions are a menu-label rule
//
// What survives is a package spelling its own domain's jargon: SOFiSTiK's WPS
// and SOFiPLUS are spelled where those commands live, because the shared
// vocabulary is what every consumer carries and no one else needs those words.
//
// A description is checked the same way and reported six ways: one that only
// restates the label, one that does not end with a period, one that does not
// start with a capital, one written in the third person, one past 76
// characters, and one carrying markdown the palette renders as text. A command
// registered twice with two different descriptions is reported as well, since
// which of them shows depends on where focus is.
//
// Coverage is *reported and never fails*. A description belongs only where the
// derived label leaves something open, so a bare command is a judgement rather
// than a defect, and a check that demanded one everywhere would buy a fleet of
// lines restating their own titles.
//
// The inventory is static: command names come from menus/, keymaps/ and the
// `"<pkg>:<name>":` keys registered in lib/ and src/. A name built at runtime
// from a variable is invisible here, and so is metadata a helper forwards
// rather than writing literally.
//
// Command names are lowercase dash-separated words, so the literal pattern can
// end at the closing quote without mistaking punctuation for part of a name.
//
// Scope defaults to the bundled fleet. That reads the *pinned* copies out of
// node_modules, so a
// description written in a working tree is invisible until a repin lands, and
// the community-tier repositories are never installed for it to see at all.
// `--root <dir>` scans a flat workspace instead, every repository from its own
// working tree, which is what the rule actually covers.

const fs = require("fs");
const path = require("path");
const { parse } = require("@babel/parser");

const ROOT = path.join(__dirname, "..");
const CSON = require("@lumine-code/season");
const _ = require("@lumine-code/underscore-plus");

// A command name literal used as an object key or a string argument. The
// namespace is anchored to the package's own name, so `core:save` written by a
// package is not mistaken for one of its own.
//
// The half after the colon is matched case-insensitively because a few commands
// spell an acronym in the name itself — `bacadra-tools:open-CALC`. Lowercasing
// the class here hid those from the description scan entirely: they were counted
// from a manifest trigger list. Command metadata now lives beside the runtime
// registration, so every command is visited through this source pattern.
const commandPattern = (packageName) =>
  new RegExp(`["'\`]${_.escapeRegExp(packageName)}:([A-Za-z0-9-]+)["'\`]`, "g");

// `displayName: "…"` sitting inside the object literal that follows a command
// key. Matched within the span up to the next command key so a label cannot be
// credited to the wrong command.
const DISPLAY_NAME = /displayName\s*:\s*["'`]([^"'`]*)["'`]/;

// For a non-cold command, `description: "…"` as the *first* key of the
// descriptor a command name opens.
// The window is one literal rather than the span to the next command, because
// `description` is also the options key for a notification and for a
// configSchema entry, and both appear in the same files in quantity. Anchoring
// on the convention — description first, didDispatch last — is what makes the
// key findable without parsing, and enforces the ordering as a side effect.
// The separator is `:` in a command map and `,` in the three-argument form
// `add(target, name, listener)`, which core and several packages use; both open
// the same descriptor, so both are credited.
const descriptionPattern = (command) =>
  new RegExp(
    `["'\`]${_.escapeRegExp(command)}["'\`]\\s*[:,]\\s*\\{` +
      `(?:\\s*//[^\\n]*)*` +
      `\\s*description\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`,
  );

// The same convention in JSX, where a component registers the command for its
// subtree: `<Command command="pkg:cmd" description="…" callback={…} />`. The
// description still comes first, directly after the name it belongs to.
const jsxDescriptionPattern = (command) =>
  new RegExp(
    `command=(["'\`])${_.escapeRegExp(command)}\\1` +
      `\\s*description=(["'\`])((?:\\\\.|(?!\\2).)*)\\2`,
  );

const comparable = (label) => label.replace(/\s+/g, "").toLowerCase();

// A description is one imperative sentence. Third person is the tell that it was
// written as documentation about the command rather than as the command itself.
const THIRD_PERSON =
  /^(Shows|Opens|Toggles|Displays|Runs|Adds|Removes|Closes|Copies|Moves|Sets|Creates|Deletes|Inserts|Selects|Switches|Turns|Makes|Returns|Prints|Reloads|Restarts|Saves|Sends|Starts|Stops|Updates|Clears|Focuses|Jumps|Marks|Reveals|Scrolls|Splits|Wraps|Cuts|Pastes|Folds|Indents|Hides|Lists|Loads|Picks|Applies|Enables|Disables)\b/;

const MARKDOWN = /`|\*\*|\[[^\]]*\]\([^)]*\)/;

const MAX_LENGTH = 76;

// The editor's own commands are not namespaced by its package name, so the
// derivation that works for every package needs the list spelled out here.
const EDITOR_NAMESPACES = ["core", "editor", "pane", "window", "application", "modal", "git"];

const namespacesFor = (packageName) =>
  packageName === "lumine" ? EDITOR_NAMESPACES : [packageName];

const STATIC_UNKNOWN = Symbol("static-unknown");
const FUNCTION_NODES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

function walkAst(node, visit, owner = null) {
  if (!node || typeof node !== "object") return;
  const currentOwner = FUNCTION_NODES.has(node.type) ? node : owner;
  visit(node, currentOwner);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walkAst(child, visit, currentOwner));
    else if (value && typeof value.type === "string") walkAst(value, visit, currentOwner);
  }
}

function staticPropertyName(node, environment) {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticValue(node.property, environment);
}

function staticValue(node, environment) {
  if (!node) return STATIC_UNKNOWN;
  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral"
  ) {
    return node.value;
  }
  if (node.type === "NullLiteral") return null;
  if (node.type === "Identifier") return environment.get(node.name) ?? STATIC_UNKNOWN;
  if (node.type === "TemplateLiteral") {
    let value = node.quasis[0]?.value?.cooked ?? "";
    for (let index = 0; index < node.expressions.length; index++) {
      const expression = staticValue(node.expressions[index], environment);
      if (expression === STATIC_UNKNOWN) return STATIC_UNKNOWN;
      value += String(expression) + (node.quasis[index + 1]?.value?.cooked ?? "");
    }
    return value;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticValue(node.left, environment);
    const right = staticValue(node.right, environment);
    return left === STATIC_UNKNOWN || right === STATIC_UNKNOWN ? STATIC_UNKNOWN : left + right;
  }
  if (node.type === "ArrayExpression") {
    const values = node.elements.map((element) => staticValue(element, environment));
    return values.includes(STATIC_UNKNOWN) ? STATIC_UNKNOWN : values;
  }
  if (node.type === "ObjectExpression") {
    const value = {};
    for (const property of node.properties) {
      if (property.type !== "ObjectProperty") continue;
      const key = property.computed
        ? staticValue(property.key, environment)
        : (property.key.name ?? property.key.value);
      if (typeof key !== "string") continue;
      value[key] = staticValue(property.value, environment);
    }
    return value;
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const object = staticValue(node.object, environment);
    const property = staticPropertyName(node, environment);
    if (object === STATIC_UNKNOWN || object == null || typeof property !== "string") {
      return STATIC_UNKNOWN;
    }
    return Object.hasOwn(object, property) ? object[property] : STATIC_UNKNOWN;
  }
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return staticValue(node.expression, environment);
  }
  return STATIC_UNKNOWN;
}

function bindStaticPattern(pattern, value, environment) {
  if (pattern?.type === "Identifier") {
    environment.set(pattern.name, value);
    return;
  }
  if (pattern?.type !== "ObjectPattern" || value === STATIC_UNKNOWN || value == null) return;
  for (const property of pattern.properties) {
    if (property.type !== "ObjectProperty") continue;
    const key = property.key.name ?? property.key.value;
    bindStaticPattern(
      property.value,
      typeof key === "string" && Object.hasOwn(value, key) ? value[key] : STATIC_UNKNOWN,
      environment,
    );
  }
}

function localModulePath(fromFile, request) {
  if (typeof request !== "string" || !request.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  for (const candidate of [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.cjs`,
    `${base}.mjs`,
    path.join(base, "index.js"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function staticModule(file, cache = new Map()) {
  const resolved = path.resolve(file);
  if (cache.has(resolved)) return cache.get(resolved);
  const model = { ast: null, environment: new Map(), exports: {} };
  cache.set(resolved, model);
  try {
    model.ast = parse(fs.readFileSync(resolved, "utf8"), {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return model;
  }

  for (const statement of model.ast.program.body) {
    if (statement.type === "ImportDeclaration") {
      const importedPath = localModulePath(resolved, statement.source.value);
      const imported = importedPath ? staticModule(importedPath, cache).exports : {};
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          model.environment.set(
            specifier.local.name,
            imported[specifier.imported.name ?? specifier.imported.value] ?? STATIC_UNKNOWN,
          );
        } else if (specifier.type === "ImportDefaultSpecifier") {
          model.environment.set(specifier.local.name, imported.default ?? STATIC_UNKNOWN);
        } else if (specifier.type === "ImportNamespaceSpecifier") {
          model.environment.set(specifier.local.name, imported);
        }
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        let value = STATIC_UNKNOWN;
        if (
          item.init?.type === "CallExpression" &&
          item.init.callee?.type === "Identifier" &&
          item.init.callee.name === "require"
        ) {
          const request = staticValue(item.init.arguments[0], model.environment);
          const importedPath = localModulePath(resolved, request);
          if (importedPath) value = staticModule(importedPath, cache).exports;
        } else {
          value = staticValue(item.init, model.environment);
        }
        bindStaticPattern(item.id, value, model.environment);
      }
    }
    if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
      for (const item of statement.declaration.declarations || []) {
        if (item.id.type === "Identifier") {
          model.exports[item.id.name] = model.environment.get(item.id.name) ?? STATIC_UNKNOWN;
        }
      }
    }
    if (statement.type !== "ExpressionStatement") continue;
    const expression = statement.expression;
    if (expression.type !== "AssignmentExpression") continue;
    const left = expression.left;
    if (
      left.type === "MemberExpression" &&
      left.object?.type === "Identifier" &&
      left.object.name === "module" &&
      staticPropertyName(left, model.environment) === "exports"
    ) {
      const exported = staticValue(expression.right, model.environment);
      if (exported !== STATIC_UNKNOWN) model.exports = exported;
    } else if (
      left.type === "MemberExpression" &&
      left.object?.type === "Identifier" &&
      left.object.name === "exports"
    ) {
      const key = staticPropertyName(left, model.environment);
      const exported = staticValue(expression.right, model.environment);
      if (typeof key === "string" && exported !== STATIC_UNKNOWN) model.exports[key] = exported;
    }
  }
  return model;
}

function memberPath(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type !== "MemberExpression" && node?.type !== "OptionalMemberExpression") return "";
  const property = node.computed ? node.property?.value : node.property?.name;
  return `${memberPath(node.object)}.${property ?? ""}`;
}

// Resolve table-driven registrations whose command names and descriptors are
// assembled from a literal array imported by the package entrypoint. This is
// the same authoring shape as writing each descriptor inline; the loop merely
// removes repetition, so the coverage audit must not make authors duplicate it.
function tableDrivenCommandMetadata(dir) {
  const metadata = new Map();
  const moduleCache = new Map();
  for (const file of sourceFiles(dir)) {
    const model = staticModule(file, moduleCache);
    if (!model.ast) continue;
    const commandMaps = [];
    const loops = [];
    walkAst(model.ast.program, (node, owner) => {
      if (
        node.type === "CallExpression" &&
        /(?:^|\.)commands\.add$/.test(memberPath(node.callee)) &&
        node.arguments[1]?.type === "Identifier"
      ) {
        commandMaps.push({ name: node.arguments[1].name, owner });
      }
      if (node.type === "ForOfStatement") loops.push({ node, owner });
    });

    for (const { name: mapName, owner } of commandMaps) {
      for (const { node: loop, owner: loopOwner } of loops) {
        if (loopOwner !== owner) continue;
        const values = staticValue(loop.right, model.environment);
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          const environment = new Map(model.environment);
          const pattern =
            loop.left.type === "VariableDeclaration" ? loop.left.declarations[0]?.id : loop.left;
          bindStaticPattern(pattern, value, environment);
          walkAst(
            loop.body,
            (candidate, nestedOwner) => {
              if (nestedOwner !== owner || candidate.type !== "AssignmentExpression") return;
              const target = candidate.left;
              if (
                target.type !== "MemberExpression" ||
                target.object?.type !== "Identifier" ||
                target.object.name !== mapName
              ) {
                return;
              }
              const command = staticPropertyName(target, environment);
              const descriptor = staticValue(candidate.right, environment);
              if (typeof command !== "string" || descriptor === STATIC_UNKNOWN) return;
              metadata.set(command, descriptor);
            },
            owner,
          );
        }
      }
    }
  }
  return metadata;
}

function bundledPackages() {
  const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");
  return scanBundledPackageNames(ROOT)
    .map((name) => ({ name, dir: resolveBundledPackageDir(ROOT, name) }))
    .filter(({ dir }) => dir);
}

function sourceFiles(dir) {
  const files = [];
  for (const subdirectory of ["lib", "src"]) {
    const root = path.join(dir, subdirectory);
    if (!fs.existsSync(root)) continue;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);
  }
  return files;
}

function declaredFiles(dir) {
  const files = [];
  for (const subdirectory of ["menus", "keymaps"]) {
    const root = path.join(dir, subdirectory);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (name.endsWith(".json") || name.endsWith(".jsonc")) files.push(path.join(root, name));
    }
  }
  return files;
}

// Every command the package names, mapped to the displayName it registers for
// it, if any. A command declared in a menu but registered in a file this scan
// cannot read still counts — the label is derived either way.
function inventory(name, dir) {
  const commands = new Map();
  const note = (command) => {
    if (!commands.has(command)) {
      commands.set(command, {
        displayName: null,
        description: null,
        runtimeDescription: null,
      });
    }
    return commands.get(command);
  };
  const namespaces = namespacesFor(name);
  const patterns = namespaces.map((namespace) => commandPattern(namespace));
  const recordRuntimeMetadata = (command, metadata) => {
    if (!namespaces.some((namespace) => command.startsWith(`${namespace}:`))) return;
    const entry = note(command);
    if (typeof metadata.displayName === "string") entry.displayName = metadata.displayName;
    if (typeof metadata.description !== "string") return;
    if (entry.runtimeDescription != null && entry.runtimeDescription !== metadata.description) {
      entry.conflict = metadata.description;
    }
    entry.runtimeDescription = metadata.description;
    entry.description = metadata.description;
  };

  for (const file of declaredFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) note(match[0].slice(1, -1));
    }
  }

  for (const [command, metadata] of tableDrivenCommandMetadata(dir)) {
    recordRuntimeMetadata(command, metadata);
  }

  for (const file of sourceFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    const matches = patterns
      .flatMap((pattern) => [...text.matchAll(pattern)])
      .sort((a, b) => a.index - b.index);
    matches.forEach((match, index) => {
      const command = match[0].slice(1, -1);
      const entry = note(command);
      const until = matches[index + 1]?.index ?? text.length;
      const label = text.slice(match.index, until).match(DISPLAY_NAME);
      if (label) entry.displayName = label[1];

      // Anchored on the command itself rather than on the slice, so a
      // descriptor split across the window boundary is still credited. The JSX
      // form anchors on the `command=` attribute instead, which sits one token
      // before the name rather than on it.
      const rest = text.slice(match.index);
      const described = rest.match(descriptionPattern(command));
      const jsx = text.slice(Math.max(0, match.index - 16)).match(jsxDescriptionPattern(command));
      const found = described && described.index === 0 ? described[2] : jsx ? jsx[3] : null;
      if (found != null) {
        recordRuntimeMetadata(command, { description: found });
      }
    });
  }

  return commands;
}

// A description earns its row by saying something the label does not. These are
// the ways one fails to, each of them cheap to see and expensive to leave in:
// the palette joins the description to the fuzzy candidate, so a wasted line
// also costs the command score for a query aimed at its own name.
function checkDescription(command, description, report) {
  const label = _.humanizeEventName(command).replace(/^[^:]+:\s*/, "");

  if (comparable(description.replace(/[.!?]+$/, "")) === comparable(label)) {
    report(`${command}: description "${description}" only restates the label "${label}"`);
    return;
  }
  if (!/[.]$/.test(description)) {
    report(`${command}: description "${description}" does not end with a period`);
  }
  if (/^[a-z]/.test(description)) {
    report(`${command}: description "${description}" does not start with a capital`);
  }
  if (THIRD_PERSON.test(description)) {
    report(`${command}: description "${description}" is third person — write the imperative`);
  }
  if (description.length > MAX_LENGTH) {
    report(`${command}: description is ${description.length} characters, over ${MAX_LENGTH}`);
  }
  if (MARKDOWN.test(description)) {
    report(`${command}: description "${description}" carries markdown, which is rendered as text`);
  }
}

function checkPackage(name, dir, report) {
  const commands = inventory(name, dir);

  for (const [command, entry] of commands) {
    const { displayName, description } = entry;

    if (description != null) checkDescription(command, description, report);
    if (entry.conflict != null) {
      report(
        `${command}: registered with two descriptions — "${description}" and ` +
          `"${entry.conflict}". Which one shows depends on where focus is`,
      );
    }

    if (displayName == null) continue;
    const derived = _.humanizeEventName(command);

    if (displayName === derived) {
      report(`${command}: displayName "${displayName}" is what the humanizer already derives`);
      continue;
    }

    if (comparable(displayName) !== comparable(derived)) {
      report(
        `${command}: displayName "${displayName}" renames "${derived}" rather than re-casing ` +
          `it — rename the command instead`,
      );
      continue;
    }

    const written = displayName.split(/\s+/);
    const words = derived.split(/\s+/);
    if (written.length !== words.length) {
      report(
        `${command}: displayName "${displayName}" splits a word "${derived}" does not — the ` +
          `command name is missing a dash`,
      );
      continue;
    }

    // Same words, different case. A word carrying a capital past its first
    // letter — HTML, WinGRAF, SOFiPLUS, DBInfo — is a deliberate spelling, and
    // spelling one is the whole job of a displayName. Anything else is a
    // word-case preference the palette does not honour.
    const ordinary = written.filter(
      (word, index) => word !== words[index] && !/[A-Z]/.test(word.slice(1)),
    );
    if (ordinary.length > 0) {
      report(
        `${command}: displayName "${displayName}" re-cases ${ordinary.join(", ")} — palette ` +
          `labels keep the humanizer's word case`,
      );
    }
  }

  const described = [...commands.values()].filter((entry) => entry.description != null).length;
  return {
    total: commands.size,
    described,
    undescribed: [...commands]
      .filter(([, entry]) => entry.description == null)
      .map(([command]) => command),
  };
}

// Every repository in a flat workspace that declares itself a package, plus the
// editor. `--root` exists because the default scan reads the *pinned* copies out
// of node_modules, so a description written in a working tree is invisible to it
// until a repin lands, and the community-tier repositories are never installed
// for it to see at all.
function packagesUnderRoot(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .map(({ name, dir }) => {
      const manifest = path.join(dir, "package.json");
      if (!fs.existsSync(manifest)) return null;
      let parsed;
      try {
        parsed = CSON.readFileSync(manifest);
      } catch {
        return null;
      }
      const isPackage = parsed?.engines?.lumine != null;
      const isEditor = fs.existsSync(path.join(dir, "src", "register-default-commands.js"));
      if (!isPackage && !isEditor) return null;
      return { name: parsed?.name ?? name, dir };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? null : path.resolve(process.argv[rootFlag + 1] ?? ".");
  const verbose = process.argv.includes("--uncovered");

  const errors = [];
  const packages = root ? packagesUnderRoot(root) : bundledPackages();
  let total = 0;
  let described = 0;
  const uncovered = [];

  for (const { name, dir } of packages) {
    const result = checkPackage(name, dir, (message) => errors.push(`${name}: ${message}`));
    total += result.total;
    described += result.described;
    if (result.undescribed.length > 0) {
      uncovered.push({ name, count: result.undescribed.length, commands: result.undescribed });
    }
  }

  for (const error of errors) console.error(`error: ${error}`);

  const scope = root
    ? `${packages.length} packages under ${root}`
    : `${packages.length} bundled packages`;
  console.log(`command metadata: ${scope}, ${total} commands scanned, ${errors.length} error(s)`);

  // Coverage reports and never fails: a description belongs only where the
  // derived label leaves something open, so a gap is a judgement, not a defect.
  const percent = total === 0 ? 100 : Math.round((described / total) * 100);
  console.log(
    `coverage: ${described}/${total} described (${percent}%) — ` +
      `${uncovered.length} package(s) with a gap`,
  );
  uncovered.sort((a, b) => b.count - a.count);
  for (const entry of uncovered.slice(0, verbose ? uncovered.length : 10)) {
    console.log(
      `  ${entry.name}: ${entry.count}${verbose ? ` — ${entry.commands.join(", ")}` : ""}`,
    );
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

if (require.main === module) main();

module.exports = { comparable, inventory, tableDrivenCommandMetadata };
