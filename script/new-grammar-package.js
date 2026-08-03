/*
 * Scaffolds a Tree-sitter grammar package as a standalone repository.
 *
 * Usage:
 *   node script/new-grammar-package.js --name language-lua --scope source.lua \
 *        --file-types lua --parser-source "github:org/repo#v1.0.0" \
 *        --kind bundled|community [--out <dir>] [--title Lua] \
 *        [--comment-start "-- "] [--description "…"] [--keywords a,b,c]
 *
 * `--out` is the directory to write, and defaults to the package name under the
 * current working directory. Where these checkouts live is a local choice, so
 * nothing here assumes one.
 *
 * Both kinds produce a full repository: its own CI, lockfile scaffolding,
 * lint/format configuration, LICENSE, README, specs, and a `.gitattributes`
 * that keeps the committed wasm from being mangled by EOL conversion.
 *
 * The kinds differ only in where the package is registered afterwards, and the
 * script prints those steps rather than performing them:
 *
 *   bundled    pinned in the editor's `packageDependencies` and counted by
 *              `spec/grammar-query-validation-spec.js`
 *   community  listed in the catalog's `index.json` and installed on demand
 *
 * Editing the editor's `package.json` from a generator would be a footgun, and
 * creating the GitHub repository is deliberately left to a human too.
 *
 * The query directory is always `grammars/<parser>/`. The grammars already in
 * the editor are inconsistent about this (`ts/`, `tree-sitter/`, `…/queries/`);
 * those are not worth churning, but everything new should look the same.
 */

const fs = require("node:fs");
const path = require("node:path");

const TEMPLATES_DIR = path.join(__dirname, "templates", "grammar-package");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    name: null,
    scope: null,
    fileTypes: null,
    parserSource: null,
    kind: null,
    out: null,
    title: null,
    segment: null,
    commentStart: "# ",
    description: null,
    keywords: null,
    force: false,
  };
  const flags = {
    "--name": "name",
    "--scope": "scope",
    "--file-types": "fileTypes",
    "--parser-source": "parserSource",
    "--kind": "kind",
    "--out": "out",
    "--title": "title",
    "--segment": "segment",
    "--comment-start": "commentStart",
    "--description": "description",
    "--keywords": "keywords",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    const key = flags[arg];
    if (!key) fail(`Unknown option: ${arg}`);
    options[key] = argv[++i] ?? fail(`${arg} needs a value`);
  }
  return options;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// The scope's last segment is what every emitted capture ends with, and it is
// not always derivable from the package name (`text.html.basic` -> `html`).
function defaultSegment(scope) {
  return scope.split(".").pop();
}

// The result is substituted into a regex *literal*, so the delimiter has to be
// escaped too: a `//` comment marker would otherwise emit `///`, which is an
// empty regex followed by a stray slash.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// JSON-escapes a value that will be substituted between quotes already present
// in a template.
function jsonInner(value) {
  return JSON.stringify(value).slice(1, -1);
}

// `github:org/repo[/subdir]#ref` -> a markdown link to the parser's repository.
// The package ships someone else's parser; a reader should be one click from
// the source it was built out of.
function parserRepoLink(parserSource) {
  const match = /^github:([^/]+)\/([^/#]+)/.exec(parserSource ?? "");
  if (!match) return "its upstream parser";
  const [, org, repo] = match;
  return `[${repo}](https://github.com/${org}/${repo})`;
}

function buildTokens(options) {
  const segment = options.segment ?? defaultSegment(options.scope);
  const fileTypes = options.fileTypes
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  const title = options.title ?? capitalize(segment);
  const parser = `tree-sitter-${segment}`;
  const description = options.description ?? `${title} language support.`;
  const keywords = options.keywords
    ? options.keywords
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean)
    : [...fileTypes.filter((type) => !options.name.includes(type)), "tree-sitter"];

  return {
    name: options.name,
    scope: options.scope,
    scopeSelector: `.${options.scope}`,
    segment,
    Title: title,
    parser,
    description,
    keywordList: keywords,
    keywords: JSON.stringify(keywords, null, 2).replace(/\n/g, "\n  "),
    fileTypes: JSON.stringify(fileTypes).replace(/,/g, ", "),
    ext: fileTypes[0],
    parserSource: options.parserSource ?? "github:ORG/REPO#REF",
    parserRepoLink: parserRepoLink(options.parserSource),
    injectionRegex: `^(${segment})$`,
    commentStart: options.commentStart,
    commentRegex: escapeRegex(options.commentStart.trim()),
    // These land inside JSON string literals, and the patterns contain both
    // backslashes and a double quote, so they have to be escaped for JSON —
    // minus the surrounding quotes, which the template already supplies.
    increaseIndentPattern: jsonInner("\\{[^}\"']*$"),
    decreaseIndentPattern: jsonInner("^\\s*\\}"),
    enginesAtom: options.kind === "bundled" ? "*" : ">=1.100.0 <2.0.0",
    // Every package carries the same Installation note, whichever tier it
    // ships in: a reader should not have to know the tier to find out how to
    // get it, and a package can move between tiers without its README
    // changing shape.
    installationSection: `\n## Installation\n\nTo install \`${options.name}\` search for *${options.name}* in the Install pane of the Lumine settings or run \`lumine --install lumine-code/${options.name}\`.\n`,
  };
}

function render(text, tokens) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in tokens)) fail(`Template referenced unknown token {{${key}}}`);
    return tokens[key];
  });
}

// Template file names carry placeholders of their own, since the grammar config
// and the settings file are both named after the language.
function targetNameFor(relativePath, tokens) {
  return relativePath
    .replace("tree-sitter-GRAMMAR.json", `tree-sitter-${tokens.segment}.json`)
    .replace(path.join("settings", "SETTINGS.json"), path.join("settings", `${tokens.name}.json`));
}

function collectTemplates(dir, base = "") {
  const entries = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = path.join(base, dirent.name);
    if (dirent.isDirectory()) {
      entries.push(...collectTemplates(path.join(dir, dirent.name), relativePath));
    } else {
      entries.push(relativePath);
    }
  }
  return entries;
}

function sampleFixture(tokens) {
  return [
    `${tokens.commentStart}A fixture, not a tutorial: every line here exists to assert a scope.`,
    `${tokens.commentStart}`,
    `${tokens.commentStart}\`<- scope\` asserts at this comment's own column on the previous`,
    `${tokens.commentStart}non-comment line; \`^ scope\` asserts at the caret's column. Scopes`,
    `${tokens.commentStart}match by prefix. A caret left of the comment marker never runs, so`,
    `${tokens.commentStart}break one assertion and confirm the spec fails before trusting it.`,
    "",
    `${tokens.commentStart}TODO: replace this with real ${tokens.Title} source and real assertions.`,
    "",
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const required of ["name", "scope", "fileTypes", "kind"]) {
    if (!options[required])
      fail(`--${required.replace(/[A-Z]/g, "-$&").toLowerCase()} is required`);
  }
  if (!["bundled", "community"].includes(options.kind)) {
    fail("--kind must be 'bundled' or 'community'");
  }
  if (!options.name.startsWith("language-")) {
    fail("A grammar package is named language-<something>");
  }

  const tokens = buildTokens(options);
  // A grammar package is its own repository, and where a developer keeps their
  // checkouts is their business — there is no layout to default to. `--out` is
  // the directory the package is written into, named for the package.
  const outDir = path.resolve(options.out ?? options.name);

  if (fs.existsSync(outDir) && !options.force) {
    fail(`${outDir} already exists (pass --force to write into it anyway)`);
  }

  for (const relativePath of collectTemplates(TEMPLATES_DIR)) {
    const target = path.join(outDir, targetNameFor(relativePath, tokens));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      render(fs.readFileSync(path.join(TEMPLATES_DIR, relativePath), "utf8"), tokens),
    );
    console.log(`  ${path.relative(process.cwd(), target)}`);
  }

  const fixture = path.join(outDir, "spec", "fixtures", `sample.${tokens.ext}`);
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, sampleFixture(tokens));
  console.log(`  ${path.relative(process.cwd(), fixture)}`);

  const queriesDir = path.join(outDir, "grammars", tokens.parser);
  fs.mkdirSync(queriesDir, { recursive: true });
  console.log(
    `  ${path.relative(process.cwd(), queriesDir)}${path.sep}  (queries and wasm land here)`,
  );

  const registration =
    options.kind === "bundled"
      ? [
          `Pin it in lumine/package.json packageDependencies:\n` +
            `     "${tokens.name}": "github:lumine-code/${tokens.name}#<sha>"`,
          "Bump EXPECTED_GRAMMAR_COUNT in spec/grammar-query-validation-spec.js.",
        ]
      : [`Append "lumine-code/${tokens.name}" to packages/index.json, then npm run validate.`];

  const steps = [
    `Build the wasm:\n` +
      `     node script/build-grammar-wasm.js ${path.join(outDir, "grammars", `tree-sitter-${tokens.segment}.json`)} \\\n` +
      `          --source "${tokens.parserSource}"`,
    `Port the queries into grammars/${tokens.parser}/.\n` +
      `   Upstream capture names are not TextMate scopes, so every one has to be\n` +
      `   rewritten; check the result with 'npm run check:grammar-captures'.`,
    "Write the fixture assertions, and mutation-test them.",
    ...registration,
    `git init, commit, create lumine-code/${tokens.name}, push, and set the\n` +
      `   GitHub About to exactly: ${tokens.description}`,
  ];

  if (tokens.keywordList.length < 3) {
    console.warn(
      `\nWARNING: only ${tokens.keywordList.length} keyword(s) could be derived — ` +
        "a keyword that is a substring of the package's own name is a wasted slot, " +
        "since the Install tab already scores the name match higher. Pass --keywords " +
        "with 3 to 8 terms naming what this language is actually about.",
    );
  }

  console.log(
    [
      "",
      `Scaffolded ${tokens.name} (${options.kind}) at ${outDir}`,
      "",
      "Next:",
      ...steps.map((step, index) => `  ${index + 1}. ${step}`),
      "",
      "While authoring, symlink this package into ~/.lumine/dev/packages so the",
      "editor loads the working copy — that path is searched ahead of the bundled",
      "checkout, so you never have to repin a SHA to see a query change.",
    ].join("\n"),
  );
}

module.exports = { buildTokens, render, targetNameFor, defaultSegment };

if (require.main === module) main();
