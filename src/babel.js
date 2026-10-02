"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const resolve = require("resolve");
const defaultOptions = require("./babel.config.js");
const configFile = path.join(__dirname, "./babel.config.js");

let babel = null;
let babelVersionDirectory = null;

const PREFIXES = ["/** @babel */", '"use babel"', "'use babel'", "/* @flow */", "// @flow"];

const PREFIX_LENGTH = Math.max.apply(
  Math,
  PREFIXES.map(function (prefix) {
    return prefix.length;
  }),
);

exports.shouldCompile = function (sourceCode) {
  const start = sourceCode.substr(0, PREFIX_LENGTH);
  return PREFIXES.some(function (prefix) {
    return start.indexOf(prefix) === 0;
  });
};

exports.getCachePath = function (sourceCode, filePath) {
  if (babelVersionDirectory == null) {
    babelVersionDirectory = path.join("js", "babel", createCompilerDigest());
  }

  return path.join(
    babelVersionDirectory,
    crypto
      .createHash("sha1")
      .update(getCompilerFilename(filePath), "utf8")
      .update("\0", "utf8")
      .update(sourceCode, "utf8")
      .digest("hex") + ".js",
  );
};

exports.compile = function (sourceCode, filePath) {
  filePath = getCompilerFilename(filePath);

  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;

  process.stdout.write = () => true;
  process.stderr.write = () => true;

  try {
    if (!babel) {
      babel = require("@babel/core");
    }

    return transformWithLegacyJSXText(sourceCode, filePath);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
};

function transformWithLegacyJSXText(sourceCode, filePath) {
  let compatibleSourceCode = sourceCode;

  while (true) {
    try {
      return babel.transformSync(compatibleSourceCode, {
        filename: filePath,
        configFile,
      }).code;
    } catch (error) {
      const escapedSourceCode = escapeLegacyJSXTextCharacter(compatibleSourceCode, error);

      if (escapedSourceCode == null) throw error;
      compatibleSourceCode = escapedSourceCode;
    }
  }
}

function escapeLegacyJSXTextCharacter(sourceCode, error) {
  if (
    error.code !== "BABEL_PARSE_ERROR" ||
    error.reasonCode !== "UnexpectedToken" ||
    error.syntaxPlugin !== "jsx" ||
    !Number.isInteger(error.pos)
  ) {
    return null;
  }

  const character = sourceCode[error.pos];
  const suggestion = character === ">" ? "&gt;" : character === "}" ? "&rbrace;" : null;
  if (suggestion == null) return null;

  const expectedMessage = `Unexpected token \`${character}\`. Did you mean \`${suggestion}\``;
  if (!error.message.includes(expectedMessage)) return null;

  const replacement = character === "}" ? "&#125;" : suggestion;
  return sourceCode.slice(0, error.pos) + replacement + sourceCode.slice(error.pos + 1);
}

function getCompilerFilename(filePath) {
  const absolutePath = path.resolve(filePath);
  return process.platform === "win32"
    ? "file:///" + absolutePath.replace(/\\/g, "/")
    : absolutePath;
}

function createCompilerDigest() {
  // Presets and their transformers can advance without a new Babel core.
  // Fingerprint their installed dependency graph once, resolving nested copies
  // from each owner. The build omits lockfiles, so use the shipped manifests.
  const visited = new Set();
  const manifests = [];
  function visit(name, basedir) {
    const manifestPath = resolve.sync(`${name}/package.json`, {
      basedir,
      preserveSymlinks: false,
    });
    if (visited.has(manifestPath)) return;
    visited.add(manifestPath);
    const contents = fs.readFileSync(manifestPath, "utf8");
    manifests.push(contents);
    const metadata = JSON.parse(contents);
    for (const dependency of Object.keys(metadata.dependencies || {}).sort()) {
      visit(dependency, path.dirname(manifestPath));
    }
  }
  visit("@babel/core", __dirname);
  visit("@lumine-code/babel-preset", __dirname);

  const digest = crypto.createHash("sha1").update("babel-cache-v2\0", "utf8");
  for (const manifest of manifests.sort()) {
    digest.update(manifest, "utf8").update("\0", "utf8");
  }
  // The Git-pinned preset can change its implementation while staying at 1.0.0.
  digest.update(fs.readFileSync(require.resolve("@lumine-code/babel-preset")));
  digest.update(fs.readFileSync(__filename));
  digest.update(fs.readFileSync(configFile));
  return digest.update(JSON.stringify(defaultOptions), "utf8").digest("hex");
}
