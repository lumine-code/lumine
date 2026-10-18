// Finds Tree-sitter highlight captures whose raw nodes end on the carriage
// return of a CRLF line. TextBuffer's logical line ends before that character,
// so every renderer-facing capture over such a node must trim its end.
//
// The default sweep covers bundled packages. Pass a package checkout or a
// directory of package checkouts to audit that development set instead:
//
//   node script/check-grammar-line-endings.js --package-root ..

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const CSON = require("@lumine-code/season");

const ROOT = path.join(__dirname, "..");
function parseArgs(argv) {
  const packageRoots = [];
  let workerConfig = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package-root") {
      const value = argv[++i];
      if (!value) throw new Error("--package-root needs a value");
      packageRoots.push(path.resolve(value));
    } else if (argv[i] === "--worker-config") {
      workerConfig = argv[++i];
      if (!workerConfig) throw new Error("--worker-config needs a value");
    } else {
      throw new Error(`unknown option: ${argv[i]}`);
    }
  }

  return { packageRoots, workerConfig };
}

function bundledPackageDirs() {
  const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");
  return scanBundledPackageNames(ROOT)
    .map((name) => resolveBundledPackageDir(ROOT, name))
    .filter(Boolean);
}

function packageDirsInRoot(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.existsSync(path.join(root, "grammars"))) return [root];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function collectConfigs(packageRoots) {
  const packageDirs = packageRoots.length
    ? packageRoots.flatMap(packageDirsInRoot)
    : bundledPackageDirs();
  const configs = new Map();

  for (const packageDir of packageDirs) {
    const grammarsDir = path.join(packageDir, "grammars");
    if (!fs.existsSync(grammarsDir)) continue;

    for (const fileName of fs.readdirSync(grammarsDir)) {
      if (!/\.(?:json|cson)$/.test(fileName)) continue;
      const configPath = path.join(grammarsDir, fileName);
      let config;
      try {
        config = CSON.readFileSync(configPath);
      } catch {
        continue;
      }
      if (
        config?.type !== "tree-sitter" ||
        !config.treeSitter?.grammar ||
        !config.treeSitter?.highlightsQuery
      ) {
        continue;
      }
      configs.set(path.resolve(configPath).toLowerCase(), path.resolve(configPath));
    }
  }

  return [...configs.values()].sort((a, b) => a.localeCompare(b));
}

function sourceCases(config, querySource) {
  let configuredLine = config.comments?.line;
  if (!configuredLine && !config.comments?.end) configuredLine = config.comments?.start;
  if (!configuredLine) {
    configuredLine = {
      "source.clojure": ";",
      "source.edn": ";",
      "source.php": "//",
      "source.php.only": "//",
      "source.python": "#",
      "source.python.ipy": "#",
    }[config.scopeName];
  }

  const lines = [];
  if (configuredLine) {
    configuredLine = String(configuredLine).trimEnd();
    if (configuredLine === "/") configuredLine = "//";
    if (configuredLine === "#") {
      lines.push("# audit", "## audit", "#!/usr/bin/env audit");
    } else if (configuredLine === "//") {
      lines.push("// audit", "/// audit", "//! audit");
    } else if (configuredLine === "--") {
      lines.push("-- audit", "-- | audit");
    } else {
      lines.push(`${configuredLine} audit`);
    }
    if (config.scopeName === "source.hcl") {
      lines.push(`${configuredLine} unicode-é`);
    }
  }
  if (/\b(?:hash_bang_line|shebang(?:_line)?)\b/.test(querySource)) {
    lines.push("#!/usr/bin/env audit");
  }

  const uniqueLines = [...new Set(lines)];
  const cases = uniqueLines.map((line) => `${line}\r\nx\r\n`);
  if (/php/.test(config.scopeName ?? "")) {
    cases.push(...uniqueLines.map((line) => `<?php\r\n${line}\r\n$x = 1;\r\n?>\r\n`));
  }
  if (config.scopeName === "source.sassdoc") {
    cases.push(
      "audit\r\nx\r\n",
      "@param {String} $name - audit\r\nx\r\n",
      "@link https://example.com caption\r\n",
      "@name custom\r\n",
      "@example scss - demo\r\n  .x {}\r",
    );
  }
  return cases;
}

function logicalLineLengths(source) {
  // The JS binding receives a JavaScript string, so its point columns use the
  // same UTF-16 code units as TextBuffer rather than UTF-8 byte offsets.
  return source.split("\n").map((line) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line.length;
  });
}

function endsOnUnreachableCarriageReturn(node, source) {
  const lengths = logicalLineLengths(source);
  const { row, column } = node.endPosition;
  return row < lengths.length && column === lengths[row] + 1 && node.text.endsWith("\r");
}

function pointAfterText(startPosition, text) {
  const lines = text.split("\n");
  if (lines.length === 1) {
    return { row: startPosition.row, column: startPosition.column + text.length };
  }
  return {
    row: startPosition.row + lines.length - 1,
    column: lines.at(-1).length,
  };
}

function comparePoints(a, b) {
  return a.row - b.row || a.column - b.column;
}

function adjustmentProducesReachableEnd(capture, source) {
  const properties = capture.setProperties ?? {};
  const nodeText = capture.node.text;
  const logicalEnd = {
    row: capture.node.endPosition.row,
    column: logicalLineLengths(source)[capture.node.endPosition.row],
  };

  for (const [key, pattern] of Object.entries(properties)) {
    let includeMatch;
    if (key === "adjust.endBeforeFirstMatchOf") includeMatch = false;
    else if (
      key === "adjust.endAfterFirstMatchOf" ||
      key === "adjust.startAndEndAroundFirstMatchOf"
    ) {
      includeMatch = true;
    } else {
      continue;
    }

    let match;
    try {
      match = new RegExp(pattern).exec(nodeText);
    } catch {
      continue;
    }
    if (!match) continue;
    const prefixLength = match.index + (includeMatch ? match[0].length : 0);
    const adjustedEnd = pointAfterText(capture.node.startPosition, nodeText.slice(0, prefixLength));
    if (comparePoints(adjustedEnd, logicalEnd) <= 0) return true;
  }

  return false;
}

function isRelevantCapture(capture, scopeName) {
  if (capture.name === "_IGNORE_" || capture.name.startsWith("_IGNORE_.")) return false;
  if (scopeName === "source.sassdoc") return true;
  return (
    /comment|shebang|directive/i.test(capture.name) ||
    /comment|shebang|hash_bang/i.test(capture.node.type)
  );
}

function nodeOccupiesNamedField(node, fieldNames) {
  if (!node.parent || typeof fieldNames !== "string") return false;
  return fieldNames
    .split(/\s+/)
    .some((fieldName) => node.parent.childForFieldName(fieldName)?.id === node.id);
}

function passesFieldTests(capture) {
  for (const properties of [capture.setProperties, capture.assertedProperties]) {
    if (
      properties &&
      "test.field" in properties &&
      !nodeOccupiesNamedField(capture.node, properties["test.field"])
    ) {
      return false;
    }
  }
  const refutedField = capture.refutedProperties?.["test.field"];
  return refutedField == null || !nodeOccupiesNamedField(capture.node, refutedField);
}

async function auditConfig(configPath) {
  const TreeSitter = require("web-tree-sitter");
  await TreeSitter.Parser.init();

  const config = CSON.readFileSync(configPath);
  const grammarsDir = path.dirname(configPath);
  const wasmPath = path.join(grammarsDir, config.treeSitter.grammar);
  const language = await TreeSitter.Language.load(fs.readFileSync(wasmPath));
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);

  let queryFiles = config.treeSitter.highlightsQuery;
  if (!Array.isArray(queryFiles)) queryFiles = [queryFiles];
  let querySource = queryFiles
    .map((fileName) => fs.readFileSync(path.join(grammarsDir, fileName), "utf8"))
    .join("\n");
  if (config.treeSitter.languageSegment) {
    querySource = querySource.replace(/\._LANG_/g, `.${config.treeSitter.languageSegment}`);
  }
  const query = new TreeSitter.Query(language, querySource);

  const findings = new Map();
  let rawCaptureCount = 0;
  let protectedCaptureCount = 0;
  for (const source of sourceCases(config, querySource)) {
    const tree = parser.parse(source);
    for (const capture of query.captures(tree.rootNode)) {
      // Query.captures returns candidates for editor-specific predicates. A
      // wildcard leaf guarded by test.field can therefore include a comment
      // candidate even though ScopeResolver will reject it. Apply the same
      // structural test before auditing the renderer-facing range.
      if (!passesFieldTests(capture)) continue;
      if (!isRelevantCapture(capture, config.scopeName)) continue;
      if (!endsOnUnreachableCarriageReturn(capture.node, source)) continue;
      rawCaptureCount++;
      if (adjustmentProducesReachableEnd(capture, source)) {
        protectedCaptureCount++;
        continue;
      }
      const key = `${capture.name}\0${capture.node.type}\0${capture.node.text}`;
      findings.set(key, {
        capture: capture.name,
        nodeType: capture.node.type,
        text: capture.node.text.replace(/\r/g, "<CR>"),
        endPosition: capture.node.endPosition,
        properties: capture.setProperties ?? {},
      });
    }
    tree.delete();
  }

  query.delete();
  parser.delete();
  return {
    configPath,
    rawCaptureCount,
    protectedCaptureCount,
    findings: [...findings.values()],
  };
}

async function runWorker(configPath) {
  try {
    console.log(JSON.stringify(await auditConfig(path.resolve(configPath))));
  } catch (error) {
    console.log(
      JSON.stringify({
        configPath: path.resolve(configPath),
        error: error.stack ?? String(error),
      }),
    );
    process.exitCode = 1;
  }
}

function runController(packageRoots) {
  const configs = collectConfigs(packageRoots);
  const errors = [];
  const findings = [];
  let rawCaptureCount = 0;
  let protectedCaptureCount = 0;

  for (const configPath of configs) {
    const result = spawnSync(process.execPath, [__filename, "--worker-config", configPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      report = null;
    }
    if (result.status !== 0 || !report || report.error) {
      errors.push({
        configPath,
        error:
          report?.error ??
          (result.stderr?.trim() || result.error?.message || `worker exited ${result.status}`),
      });
      continue;
    }
    rawCaptureCount += report.rawCaptureCount;
    protectedCaptureCount += report.protectedCaptureCount;
    for (const finding of report.findings) findings.push({ configPath, ...finding });
  }

  for (const { configPath, error } of errors) {
    console.error(`ERROR ${path.relative(process.cwd(), configPath)}\n${error}`);
  }
  for (const finding of findings) {
    console.error(
      `UNCLIPPED ${path.relative(process.cwd(), finding.configPath)} ` +
        `@${finding.capture} (${finding.nodeType}) -> ` +
        `${finding.endPosition.row}:${finding.endPosition.column} ${JSON.stringify(finding.text)}`,
    );
  }

  console.log(
    `Checked ${configs.length} Tree-sitter grammar configs: ` +
      `${rawCaptureCount} CRLF-edge captures, ${protectedCaptureCount} protected, ` +
      `${findings.length} unprotected, ${errors.length} errors.`,
  );
  if (findings.length || errors.length) process.exitCode = 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (options.workerConfig) await runWorker(options.workerConfig);
  else runController(options.packageRoots);
}

main();
