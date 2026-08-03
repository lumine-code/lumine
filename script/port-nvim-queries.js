/*
 * Ports Neovim / upstream Tree-sitter queries to Lumine's conventions.
 *
 * Usage:
 *   node script/port-nvim-queries.js <src-dir-or-file> --out <dir>
 *        (--segment <lang> | --lang-token) [--report <path>] [--dry-run]
 *   node script/port-nvim-queries.js --verify <dir> [--segment <lang>]
 *   node script/port-nvim-queries.js --emit-map
 *
 * Only `highlights.scm` needs real translation. Lumine has no highlight-group
 * indirection — a capture name IS the scope applied to the text — so every
 * `@keyword.function` has to become a `@storage.type.function.<lang>`. The
 * other query types share most of their vocabulary with upstream already:
 *
 *   tags.scm     identical (@name, @definition.*, @reference.*) — copied as is
 *   locals.scm   near-identical; @local.definition.function loses its tail
 *   folds.scm    upstream's bare @fold is what Lumine wants
 *   indents.scm  a DIFFERENT MODEL, not a different vocabulary. Upstream's
 *                @indent.begin/.end/.branch/.align/.zero does not correspond
 *                to Lumine's @indent/@dedent/@dedent.next/@match plus
 *                `#set! indent.*`. Machine-translating it produces indentation
 *                that looks plausible and is wrong in ways fixtures do not
 *                catch, so this tool refuses to and copies the original to
 *                `indents.scm.nvim-reference` for reading. Write the real one
 *                by hand, starting from the closest bundled grammar.
 *
 * What comes out is a starting point, never a finished query. Every emitted
 * file carries a `; PORT:` header listing what still needs a human, and
 * `--verify` fails while any of those remain.
 *
 * This is one-shot scaffolding. It is NOT idempotent — re-running it over
 * hand-edited output destroys the edits. Never wire it into a build or CI.
 */

const fs = require("node:fs");
const path = require("node:path");

const CAPTURE_MAP = require("./lib/nvim-capture-map");

const PORT_MARKER = "; PORT:";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// --- scanning ----------------------------------------------------------------

// `.scm` files carry `;` line comments and `"…"` strings, both of which can
// hold text that looks like a capture or a predicate. Mark which offsets are
// actually code so the rewrites never fire inside them.
function codeMask(source) {
  const mask = new Uint8Array(source.length);
  let inString = false;
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inComment) {
      if (char === "\n") inComment = false;
    } else if (inString) {
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === '"') inString = false;
    } else if (char === ";") {
      inComment = true;
    } else if (char === '"') {
      inString = true;
    } else {
      mask[i] = 1;
    }
  }
  return mask;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

// Finds `(#predicate? …)` forms, returning each with its full span.
function findPredicates(source, mask) {
  const predicates = [];
  for (let i = 0; i < source.length - 1; i++) {
    if (!mask[i] || source[i] !== "(" || source[i + 1] !== "#") continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < source.length; j++) {
      if (!mask[j]) continue;
      if (source[j] === "(") depth++;
      else if (source[j] === ")") {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    const text = source.slice(i, end);
    predicates.push({ start: i, end, text, name: /^\(#([a-zA-Z0-9_.!?-]+)/.exec(text)?.[1] ?? "" });
    i = end - 1;
  }
  return predicates;
}

// --- capture mapping ---------------------------------------------------------

function lookup(name) {
  for (const [prefix, scope, confidence, note] of CAPTURE_MAP) {
    if (name === prefix || name.startsWith(`${prefix}.`)) {
      const tail = name.slice(prefix.length);
      return { prefix, scope: scope === null ? null : `${scope}${tail}`, confidence, note };
    }
  }
  return null;
}

function mapCapture(name, options) {
  // Upstream marks helper captures — ones that exist only so a predicate can
  // refer to them — with a leading underscore. Lumine spells that `_IGNORE_`.
  // The separating dot is not cosmetic: the resolver recognises `_IGNORE_` and
  // `_IGNORE_.…` only, so `_IGNORE__url` would be applied as a real scope.
  if (name.startsWith("_")) {
    return { name: `_IGNORE_.${name.replace(/^_+/, "")}`, confidence: "safe" };
  }
  const suffix = options.langToken ? "._LANG_" : `.${options.segment}`;
  const entry = lookup(name);
  if (!entry) {
    return { name, confidence: "unmapped", note: "no mapping for this capture" };
  }
  if (entry.confidence === "drop") {
    return { name: `_IGNORE_.${name}`, confidence: "drop", note: entry.note };
  }
  if (entry.confidence === "split") {
    return { name, confidence: "split", note: entry.note };
  }
  return { name: `${entry.scope}${suffix}`, confidence: entry.confidence, note: entry.note };
}

// --- predicate translation ---------------------------------------------------

// Supported by the query engine itself, so they need no translation.
const NATIVE_PREDICATES = new Set([
  "eq?",
  "not-eq?",
  "any-eq?",
  "any-not-eq?",
  "match?",
  "not-match?",
  "any-match?",
  "any-not-match?",
  "any-of?",
  "not-any-of?",
]);

function translatePredicate(predicate) {
  const { name, text } = predicate;

  if (NATIVE_PREDICATES.has(name)) return { kind: "keep" };
  // Lumine's own vocabulary: `#is?`/`#is-not?` with test.*, `#set!` with
  // adjust.* / capture.* / indent.* / fold.*. Already in the right shape.
  if (name === "is?" || name === "is-not?") return { kind: "keep" };
  if (name === "set!" && /#set!\s+(adjust|capture|indent|fold|highlight)\./.test(text)) {
    return { kind: "keep" };
  }

  // Expressible, with a different spelling.
  if (name === "has-ancestor?" || name === "not-has-ancestor?") {
    return {
      kind: "rewrite",
      text: rewriteAncestorPredicate(text, name.startsWith("not-"), "descendantOfType"),
    };
  }
  if (name === "has-parent?" || name === "not-has-parent?") {
    return {
      kind: "rewrite",
      text: rewriteAncestorPredicate(text, name.startsWith("not-"), "childOfType"),
    };
  }
  if (name === "offset!") {
    const rewritten = rewriteOffsetPredicate(text);
    if (rewritten) return { kind: "rewrite", text: rewritten };
    return { kind: "remove", reason: "#offset! with a row delta has no adjust.* equivalent" };
  }

  // Injections are wired in `lib/main.js`, not in the query.
  if (name === "set!" && /injection\./.test(text)) {
    const language = /injection\.language\s+"?([\w.-]+)"?/.exec(text)?.[1];
    return {
      kind: "remove",
      reason: language
        ? `injection into "${language}" — add an atom.grammars.addInjectionPoint call in lib/main.js`
        : "injection settings belong in lib/main.js, not the query",
    };
  }

  if (name === "lua-match?" || name === "not-lua-match?" || name === "vim-match?") {
    return {
      kind: "remove",
      reason: `${name} is not a regex dialect Lumine can evaluate — rewrite by hand as #match?`,
    };
  }

  return { kind: "remove", reason: `no Lumine equivalent for #${name}` };
}

function rewriteAncestorPredicate(text, negated, test) {
  // (#has-ancestor? @cap type_a type_b) -> (#is? test.descendantOfType "type_a type_b")
  const parts = text.slice(1, -1).trim().split(/\s+/);
  const capture = parts.find((part) => part.startsWith("@")) ?? "";
  const types = parts.slice(1).filter((part) => !part.startsWith("@"));
  const predicate = negated ? "#is-not?" : "#is?";
  const argument = types.join(" ").replace(/"/g, "");
  return `(${predicate} ${capture} test.${test} "${argument}")`.replace("  ", " ");
}

function rewriteOffsetPredicate(text) {
  // (#offset! @cap 0 startCol 0 endCol) — only a pure column shift maps over.
  const match = /#offset!\s+(@[\w._-]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(text);
  if (!match) return null;
  const [, capture, startRow, startCol, endRow, endCol] = match;
  if (startRow !== "0" || endRow !== "0") return null;
  const parts = [];
  if (startCol !== "0") parts.push(`(#set! ${capture} adjust.offsetStart ${startCol})`);
  if (endCol !== "0") parts.push(`(#set! ${capture} adjust.offsetEnd ${endCol})`);
  return parts.join(" ");
}

// --- per-file porting --------------------------------------------------------

const QUERY_KINDS = {
  "highlights.scm": "highlights",
  "locals.scm": "locals",
  "folds.scm": "folds",
  "tags.scm": "tags",
  "indents.scm": "indents",
  "injections.scm": "injections",
};

function portHighlights(source, options, findings, fileName) {
  const mask = codeMask(source);
  const edits = [];

  for (const predicate of findPredicates(source, mask)) {
    const result = translatePredicate(predicate);
    if (result.kind === "keep") continue;
    if (result.kind === "rewrite") {
      edits.push({ start: predicate.start, end: predicate.end, text: result.text });
      continue;
    }
    edits.push({ start: predicate.start, end: predicate.end, text: "" });
    findings.push({
      file: fileName,
      line: lineOf(source, predicate.start),
      kind: "predicate",
      detail: result.reason,
      source: predicate.text.replace(/\s+/g, " "),
    });
  }

  const capturePattern = /@[a-zA-Z_][a-zA-Z0-9_.-]*/g;
  for (const match of source.matchAll(capturePattern)) {
    if (!mask[match.index]) continue;
    const original = match[0].slice(1);
    const mapped = mapCapture(original, options);
    if (mapped.name !== original) {
      edits.push({
        start: match.index,
        end: match.index + match[0].length,
        text: `@${mapped.name}`,
      });
    }
    if (mapped.confidence === "safe") continue;
    findings.push({
      file: fileName,
      line: lineOf(source, match.index),
      kind: mapped.confidence,
      detail: mapped.note ?? "",
      source: match[0],
    });
  }

  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  // Removing a predicate can strand the whitespace it sat in.
  return output.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}

function portLocals(source) {
  // @local.definition.function -> @local.definition; the same for references.
  return source.replace(/@local\.(definition|reference|scope)[\w.]*/g, "@local.$1");
}

function header(fileName, findings, options) {
  const mine = findings.filter((finding) => finding.file === fileName);
  const lines = [
    `; Ported from upstream by script/port-nvim-queries.js.`,
    `; Scopes end in "${options.langToken ? "._LANG_" : `.${options.segment}`}".`,
  ];
  if (mine.length === 0) {
    lines.push("; Nothing outstanding — but read it through before shipping.");
    return `${lines.join("\n")}\n\n`;
  }
  lines.push(";");
  lines.push(`; ${mine.length} item(s) still need a human. Nothing ships with a ${PORT_MARKER}`);
  lines.push("; marker left in it — `--verify` fails while any remain.");
  lines.push("; Line numbers are the upstream file's, before this header was added.");
  for (const finding of mine) {
    lines.push(
      `${PORT_MARKER} upstream line ${finding.line} [${finding.kind}] ${finding.source}` +
        (finding.detail ? ` — ${finding.detail}` : ""),
    );
  }
  return `${lines.join("\n")}\n\n`;
}

function portDirectory(sourceFiles, options) {
  const findings = [];
  const outputs = [];

  for (const sourcePath of sourceFiles) {
    const fileName = path.basename(sourcePath);
    const kind = QUERY_KINDS[fileName];
    const source = fs.readFileSync(sourcePath, "utf8");

    if (kind === "indents") {
      outputs.push({ fileName: `${fileName}.nvim-reference`, text: source, verbatim: true });
      findings.push({
        file: fileName,
        line: 1,
        kind: "manual",
        detail:
          "indents use a different model in Lumine; write it by hand from the closest bundled grammar",
        source: "indents.scm",
      });
      continue;
    }
    if (kind === "injections") {
      outputs.push({ fileName: `${fileName}.nvim-reference`, text: source, verbatim: true });
      findings.push({
        file: fileName,
        line: 1,
        kind: "manual",
        detail: "injections are declared with atom.grammars.addInjectionPoint in lib/main.js",
        source: "injections.scm",
      });
      continue;
    }
    if (kind === "tags") {
      outputs.push({ fileName, text: source, verbatim: true });
      continue;
    }
    if (kind === "locals") {
      outputs.push({ fileName, text: portLocals(source) });
      continue;
    }
    if (kind === "folds" || kind === undefined) {
      outputs.push({ fileName, text: source });
      continue;
    }
    outputs.push({
      fileName,
      text: portHighlights(source, options, findings, fileName),
      ported: true,
    });
  }

  for (const output of outputs) {
    if (output.verbatim || !output.ported) continue;
    output.text = header(output.fileName, findings, options) + output.text;
  }
  return { outputs, findings };
}

// --- report ------------------------------------------------------------------

const KIND_ORDER = ["unmapped", "split", "review", "predicate", "manual", "drop"];

function renderReport(findings) {
  if (findings.length === 0) return "Nothing outstanding.";
  const lines = [];
  for (const kind of KIND_ORDER) {
    const group = findings.filter((finding) => finding.kind === kind);
    if (group.length === 0) continue;
    lines.push(`\n${kind.toUpperCase()} (${group.length})`);
    for (const finding of group) {
      lines.push(
        `  ${finding.file}:${finding.line}  ${finding.source}${finding.detail ? `  — ${finding.detail}` : ""}`,
      );
    }
  }
  const blocking = findings.filter(
    (finding) => finding.kind === "unmapped" || finding.kind === "split",
  ).length;
  lines.push(
    `\n${findings.length} item(s); ${blocking} of them block (unmapped or split captures).`,
  );
  return lines.join("\n");
}

// --- verify ------------------------------------------------------------------

function verify(dir, options) {
  const suffix = options.langToken ? "._LANG_" : options.segment ? `.${options.segment}` : null;
  const problems = [];
  const files = fs
    .readdirSync(dir, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".scm"));

  for (const name of files) {
    const filePath = path.join(dir, name);
    const source = fs.readFileSync(filePath, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (line.includes(PORT_MARKER)) {
        problems.push(`${name}:${index + 1}  unfinished: ${line.trim()}`);
      }
    }
    if (!name.endsWith("highlights.scm") || !suffix) continue;
    const mask = codeMask(source);
    for (const match of source.matchAll(/@[a-zA-Z_][a-zA-Z0-9_.-]*/g)) {
      if (!mask[match.index]) continue;
      const name_ = match[0].slice(1);
      if (name_.startsWith("_IGNORE_") || name_.endsWith(suffix)) continue;
      problems.push(
        `${name}:${lineOf(source, match.index)}  ${match[0]} does not end in "${suffix}"`,
      );
    }
  }
  return problems;
}

// --- map documentation -------------------------------------------------------

function emitMap() {
  const rows = ["| Upstream capture | Lumine scope | Confidence | Notes |", "|---|---|---|---|"];
  for (const [prefix, scope, confidence, note] of CAPTURE_MAP) {
    rows.push(
      `| \`@${prefix}\` | ${scope ? `\`${scope}\`` : "—"} | ${confidence} | ${note ?? ""} |`,
    );
  }
  return rows.join("\n");
}

// --- cli ---------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    source: null,
    out: null,
    segment: null,
    langToken: false,
    report: null,
    dryRun: false,
    verify: null,
    emitMap: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        options.out = argv[++i] ?? fail("--out needs a value");
        break;
      case "--segment":
        options.segment = argv[++i] ?? fail("--segment needs a value");
        break;
      case "--lang-token":
        options.langToken = true;
        break;
      case "--report":
        options.report = argv[++i] ?? fail("--report needs a value");
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--verify":
        options.verify = argv[++i] ?? fail("--verify needs a value");
        break;
      case "--emit-map":
        options.emitMap = true;
        break;
      default:
        if (arg.startsWith("--")) fail(`Unknown option: ${arg}`);
        if (options.source) fail("Only one source may be given");
        options.source = path.resolve(arg);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.emitMap) {
    console.log(emitMap());
    return;
  }

  if (options.verify) {
    const problems = verify(path.resolve(options.verify), options);
    if (problems.length === 0) {
      console.log("ok — no unfinished markers, every scope carries the language segment.");
      return;
    }
    for (const problem of problems) console.error(problem);
    fail(`${problems.length} problem(s); the port is not finished.`);
  }

  if (!options.source) fail("A source directory or .scm file is required");
  if (!options.segment && !options.langToken) fail("Pass --segment <lang> or --lang-token");
  if (!options.out && !options.dryRun) fail("--out is required unless --dry-run is given");

  const stat = fs.statSync(options.source);
  const sourceFiles = stat.isDirectory()
    ? fs
        .readdirSync(options.source)
        .filter((name) => name.endsWith(".scm"))
        .map((name) => path.join(options.source, name))
    : [options.source];
  if (sourceFiles.length === 0) fail(`No .scm files under ${options.source}`);

  const { outputs, findings } = portDirectory(sourceFiles, options);

  if (!options.dryRun) {
    fs.mkdirSync(options.out, { recursive: true });
    for (const output of outputs) {
      const target = path.join(options.out, output.fileName);
      fs.writeFileSync(target, output.text);
      console.log(`  wrote ${path.relative(process.cwd(), target)}`);
    }
  }

  console.log(renderReport(findings));
  if (options.report) {
    fs.writeFileSync(options.report, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(`\nreport -> ${options.report}`);
  }
  console.log(
    "\nThis is a starting point. Resolve every split and unmapped capture, add " +
      "punctuation.definition.string.begin/end and punctuation.definition.comment, " +
      "split @comment by node type, and write indents.scm by hand.",
  );
}

module.exports = { codeMask, findPredicates, mapCapture, translatePredicate, portLocals, verify };

if (require.main === module) main();
