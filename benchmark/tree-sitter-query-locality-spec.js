const path = require("path");

// Manual diagnostic only. Query latency depends on the host, but the setup
// assertions make sure every sample is the same six-row or twelve-column
// window inside one syntactically valid parent whose child count grows with
// `size`.
const SIZES = [100, 1000, 3000, 6000];
const TILE_ROWS = 6;
const TILE_COLUMNS = 12;
const WARMUP_ITERATIONS = 5;
const SAMPLE_ITERATIONS = 30;

function rows(count, buildRow) {
  return Array.from({ length: count }, (_, index) => buildRow(index, index === count - 1));
}

const CASES = [
  {
    name: "Python dictionary",
    packageName: "language-python",
    scopeName: "source.python",
    parentType: "dictionary",
    build(size) {
      return ["values = {", ...rows(size, (i) => `  "key_${i}": value_${i},`), "}"];
    },
  },
  {
    name: "IPython dictionary",
    packageName: "language-ipython",
    scopeName: "source.python.ipy",
    parentType: "dictionary",
    build(size) {
      return ["values = {", ...rows(size, (i) => `  "key_${i}": value_${i},`), "}"];
    },
  },
  {
    name: "JavaScript object",
    packageName: "language-javascript",
    scopeName: "source.js",
    parentType: "object",
    build(size) {
      return ["const values = {", ...rows(size, (i) => `  key_${i}: value_${i},`), "};"];
    },
  },
  {
    name: "JavaScript parameters",
    packageName: "language-javascript",
    scopeName: "source.js",
    parentType: "formal_parameters",
    build(size) {
      return [
        "function generated(",
        ...rows(size, (i, last) => `  value_${i}${last ? "" : ","}`),
        ") {}",
      ];
    },
  },
  {
    name: "TypeScript object",
    packageName: "language-typescript",
    scopeName: "source.ts",
    parentType: "object",
    build(size) {
      return ["const values = {", ...rows(size, (i) => `  key_${i}: value_${i},`), "};"];
    },
  },
  {
    name: "CSS arguments",
    packageName: "language-css",
    scopeName: "source.css",
    parentType: "arguments",
    childStartRow: 2,
    build(size) {
      return [
        ".selector {",
        "  color: rgb(",
        ...rows(size, (i, last) => `    ${i}${last ? "" : ","}`),
        "  );",
        "}",
      ];
    },
  },
  {
    name: "HCL block",
    packageName: "language-hcl",
    scopeName: "source.hcl",
    parentType: "block",
    build(size) {
      return [
        'resource "benchmark" "value" {',
        ...rows(size, (i) => `  key_${i} = value_${i}`),
        "}",
      ];
    },
  },
  {
    name: "CMake command",
    packageName: "language-cmake",
    scopeName: "source.cmake",
    parentType: "argument_list",
    build(size) {
      return ["custom(", ...rows(size, (i) => `  value_${i}`), ")"];
    },
  },
  {
    name: "C parameters",
    packageName: "language-c",
    scopeName: "source.c",
    parentType: "parameter_list",
    build(size) {
      return [
        "void function(",
        ...rows(size, (i, last) => `  int value_${i}${last ? "" : ","}`),
        ") {}",
      ];
    },
  },
  {
    name: "Cython list",
    packageName: "language-cython",
    scopeName: "source.cython",
    parentType: "list",
    build(size) {
      return ["values = [", ...rows(size, (i) => `  value_${i},`), "]"];
    },
  },
  {
    name: "Go composite literal",
    packageName: "language-go",
    scopeName: "source.go",
    parentType: "literal_value",
    outerParentType: "composite_literal",
    childStartRow: 2,
    build(size) {
      return ["package benchmark", "var values = []int{", ...rows(size, (i) => `  ${i},`), "}"];
    },
  },
  {
    name: "Java arguments",
    packageName: "language-java",
    scopeName: "source.java",
    parentType: "argument_list",
    childStartRow: 3,
    build(size) {
      return [
        "class Benchmark {",
        "  void benchmark() {",
        "    function(",
        ...rows(size, (i, last) => `      value_${i}${last ? "" : ","}`),
        "    );",
        "  }",
        "}",
      ];
    },
  },
  {
    name: "PHP array",
    packageName: "language-php",
    scopeName: "source.php.only",
    parentType: "array_creation_expression",
    build(size) {
      return ["$value = array(", ...rows(size, (i) => `  $value_${i},`), ");"];
    },
  },
  {
    name: "Lua table",
    packageName: "language-lua",
    scopeName: "source.lua",
    parentType: "table_constructor",
    build(size) {
      return ["local value = {", ...rows(size, (i) => `  key_${i} = value_${i},`), "}"];
    },
  },
  {
    name: "Clojure vector",
    packageName: "language-clojure",
    scopeName: "source.clojure",
    parentType: "vec_lit",
    build(size) {
      return ["[", ...rows(size, (i) => `  value-${i}`), "]"];
    },
  },
  {
    name: "Clojure list",
    packageName: "language-clojure",
    scopeName: "source.clojure",
    parentType: "list_lit",
    build(size) {
      return ["(", ...rows(size, (i) => `  value-${i}`), ")"];
    },
  },
  {
    name: "Bash array",
    packageName: "language-shellscript",
    scopeName: "source.shell",
    parentType: "array",
    build(size) {
      return ["values=(", ...rows(size, (i) => `  value_${i}`), ")"];
    },
  },
  {
    name: "Snakemake dictionary",
    packageName: "language-snakemake",
    scopeName: "source.snakemake",
    parentType: "dictionary",
    build(size) {
      return ["values = {", ...rows(size, (i) => `  "key_${i}": value_${i},`), "}"];
    },
  },
  {
    name: "TOML array",
    packageName: "language-toml",
    scopeName: "source.toml",
    parentType: "array",
    build(size) {
      return ["value = [", ...rows(size, (i) => `  ${i},`), "]"];
    },
  },
  {
    name: "C# type arguments",
    packageName: "language-csharp",
    scopeName: "source.cs",
    parentType: "type_argument_list",
    childStartRow: 2,
    build(size) {
      return [
        "class Benchmark {",
        "  Generic<",
        ...rows(size, (i, last) => `    Type${i}${last ? "" : ","}`),
        "  > field;",
        "}",
      ];
    },
  },
  {
    name: "Zig initializer",
    packageName: "language-zig",
    scopeName: "source.zig",
    parentType: "initializer_list",
    build(size) {
      return ["const value = .{", ...rows(size, (i) => `  .field_${i} = value_${i},`), "};"];
    },
  },
  {
    name: "JavaScript object pattern",
    packageName: "language-javascript",
    scopeName: "source.js",
    parentType: "object_pattern",
    build(size) {
      return ["function generated({", ...rows(size, (i) => `  key_${i},`), "}) {}"];
    },
  },
  {
    name: "JavaScript array pattern",
    packageName: "language-javascript",
    scopeName: "source.js",
    parentType: "array_pattern",
    build(size) {
      return ["function generated([", ...rows(size, (i) => `  value_${i},`), "]) {}"];
    },
  },
  {
    name: "JavaScript template escapes",
    packageName: "language-javascript",
    scopeName: "source.js",
    parentType: "template_string",
    build(size) {
      return ["const value = `", ...rows(size, () => "  \\n"), "`;"];
    },
  },
  {
    name: "JavaScript JSX opening tag",
    packageName: "language-javascript",
    scopeName: "source.js",
    parentType: "jsx_opening_element",
    build(size) {
      return [
        "const value = <Component",
        ...rows(size, (i) => `  key${i}={value${i}}`),
        ">child</Component>;",
      ];
    },
  },
  {
    name: "TypeScript object pattern",
    packageName: "language-typescript",
    scopeName: "source.ts",
    parentType: "object_pattern",
    build(size) {
      return ["function generated({", ...rows(size, (i) => `  key_${i},`), "}) {}"];
    },
  },
  {
    name: "TypeScript array pattern",
    packageName: "language-typescript",
    scopeName: "source.ts",
    parentType: "array_pattern",
    build(size) {
      return ["function generated([", ...rows(size, (i) => `  value_${i},`), "]) {}"];
    },
  },
  {
    name: "TSX opening tag",
    packageName: "language-typescript",
    scopeName: "source.tsx",
    parentType: "jsx_opening_element",
    build(size) {
      return [
        "const value = <Component",
        ...rows(size, (i) => `  key${i}={value${i}}`),
        ">child</Component>;",
      ];
    },
  },
  {
    name: "HTML start tag",
    packageName: "language-html",
    scopeName: "text.html.basic",
    parentType: "start_tag",
    build(size) {
      return ["<div", ...rows(size, (i) => `  data-key${i}="value${i}"`), ">content</div>"];
    },
  },
  {
    name: "XML start tag",
    packageName: "language-xml",
    scopeName: "text.xml",
    parentType: "STag",
    build(size) {
      return ["<root", ...rows(size, (i) => `  key${i}="value${i}"`), "></root>"];
    },
  },
  {
    name: "Groovy named arguments",
    packageName: "language-groovy",
    scopeName: "source.groovy",
    parentType: "argument_list",
    build(size) {
      return ["foo(", ...rows(size, (i) => `  key_${i}: value_${i},`), ")"];
    },
  },
  {
    name: "YAML flow mapping",
    packageName: "language-yaml",
    scopeName: "source.yaml",
    parentType: "flow_mapping",
    build(size) {
      return ["value: {", ...rows(size, (i) => `  key_${i}: value_${i},`), "}"];
    },
  },
  {
    name: "Rust use list",
    packageName: "language-rust",
    scopeName: "source.rust",
    parentType: "use_list",
    build(size) {
      return ["use crate::{", ...rows(size, (i) => `  item_${i},`), "};"];
    },
  },
  {
    name: "C++ template arguments",
    packageName: "language-c",
    scopeName: "source.cpp",
    parentType: "template_argument_list",
    build(size) {
      return [
        "using Value = Generic<",
        ...rows(size, (i, last) => `  Type${i}${last ? "" : ","}`),
        ">;",
      ];
    },
  },
  {
    name: "Ruby hash",
    packageName: "language-ruby",
    scopeName: "source.ruby",
    parentType: "hash",
    build(size) {
      return ["value = {", ...rows(size, (i) => `  key_${i}: value_${i},`), "}"];
    },
  },
  {
    name: "BibTeX entry",
    packageName: "language-bibtex",
    scopeName: "text.bibtex",
    parentType: "entry",
    build(size) {
      return ["@article{key,", ...rows(size, (i) => `  field${i} = "value",`), "}"];
    },
  },
  {
    name: "CSS block",
    packageName: "language-css",
    scopeName: "source.css",
    parentType: "block",
    outerParentType: "rule_set",
    build(size) {
      return [".selector {", ...rows(size, (i) => `  --key${i}: value${i};`), "}"];
    },
  },
  {
    name: "Bash pipeline",
    packageName: "language-shellscript",
    scopeName: "source.shell",
    parentType: "pipeline",
    childStartRow: 0,
    build(size) {
      return rows(size, (i, last) => `command_${i}${last ? "" : " |"}`);
    },
  },
  {
    name: "Elixir arguments",
    packageName: "language-elixir",
    scopeName: "source.elixir",
    parentType: "arguments",
    build(size) {
      return ["foo(", ...rows(size, (i, last) => `  value_${i}${last ? "" : ","}`), ")"];
    },
  },
  {
    name: "Kotlin Regex arguments",
    packageName: "language-kotlin",
    scopeName: "source.kotlin",
    parentType: "value_arguments",
    build(size) {
      return [
        "val regex = Regex(",
        ...rows(size, (i, last) =>
          i === 0 ? `  "pattern"${last ? "" : ","}` : `  value_${i}${last ? "" : ","}`,
        ),
        ")",
      ];
    },
  },
  {
    name: "C# interpolated string",
    packageName: "language-csharp",
    scopeName: "source.cs",
    parentType: "interpolated_string_expression",
    build(size) {
      return ['class Value { string Text = $@"', ...rows(size, (i) => `  {value${i}}`), '"; }'];
    },
  },
  {
    name: "Crystal named arguments",
    packageName: "language-crystal",
    scopeName: "source.crystal",
    parentType: "argument_list",
    build(size) {
      return ["foo(", ...rows(size, (i, last) => `  key_${i}: value_${i}${last ? "" : ","}`), ")"];
    },
  },
  {
    name: "Fortran parameters",
    packageName: "language-fortran",
    scopeName: "source.fortran",
    parentType: "parameters",
    build(size) {
      return [
        "subroutine generated(",
        ...rows(size, (i, last) => `  value_${i}${last ? "" : ","} &`),
        ")",
        "end subroutine generated",
      ];
    },
  },
  {
    name: "Dart type arguments",
    packageName: "language-dart",
    scopeName: "source.dart",
    parentType: "type_arguments",
    build(size) {
      return [
        "final value = Generic<",
        ...rows(size, (i, last) => `  Type${i}${last ? "" : ","}`),
        ">();",
      ];
    },
  },
  {
    name: "Swift type arguments",
    packageName: "language-swift",
    scopeName: "source.swift",
    parentType: "type_arguments",
    build(size) {
      return [
        "let value: Generic<",
        ...rows(size, (i, last) => `  Type${i}${last ? "" : ","}`),
        ">",
      ];
    },
  },
  {
    name: "Swift multiline interpolation",
    packageName: "language-swift",
    scopeName: "source.swift",
    parentType: "multi_line_string_literal",
    build(size) {
      return ['let value = """', ...rows(size, (i) => `  \\(value_${i})`), '"""'];
    },
  },
  {
    name: "SCSS arguments",
    packageName: "language-sass",
    scopeName: "source.css.scss",
    parentType: "arguments",
    childStartRow: 2,
    build(size) {
      return [
        ".selector {",
        "  color: fn(",
        ...rows(size, (i, last) => `    value${i}${last ? "" : ","}`),
        "  );",
        "}",
      ];
    },
  },
  {
    name: "Less arguments",
    packageName: "language-less",
    scopeName: "source.css.less",
    parentType: "arguments",
    childStartRow: 2,
    build(size) {
      return [
        ".selector {",
        "  color: fn(",
        ...rows(size, (i, last) => `    @value${i}${last ? "" : ","}`),
        "  );",
        "}",
      ];
    },
  },
  {
    name: "Vue template element",
    packageName: "language-vue",
    scopeName: "text.html.vue",
    parentType: "template_element",
    build(size) {
      return ["<template>", ...rows(size, (i) => `  <div>${i}</div>`), "</template>"];
    },
  },
  {
    name: "BibTeX command",
    packageName: "language-bibtex",
    scopeName: "text.bibtex",
    parentType: "command",
    childStartRow: 2,
    build(size) {
      return [
        "@article{benchmark,",
        "  title = {\\decorate{",
        ...rows(size, (i) => `    word_${i}`),
        "}}",
        "}",
      ];
    },
  },
  {
    name: "Objective-C protocol references",
    packageName: "language-objective-c",
    scopeName: "source.objc",
    parentType: "protocol_reference_list",
    build(size) {
      return [
        "@protocol Formatter <NSObject,",
        ...rows(size, (i, last) => `  Protocol${i}${last ? "" : ","}`),
        ">",
        "@end",
      ];
    },
  },
  {
    name: "MATLAB function arguments",
    packageName: "language-matlab",
    scopeName: "source.matlab",
    parentType: "function_arguments",
    build(size) {
      return [
        "function output = generated( ...",
        ...rows(size, (i, last) => `  value_${i}${last ? "" : ","} ...`),
        ")",
        "output = 1;",
        "end",
      ];
    },
  },
  {
    name: "Lua variable attributes",
    packageName: "language-lua",
    scopeName: "source.lua",
    parentType: "variable_list",
    build(size) {
      return [
        ...rows(size, (i, last) => {
          const prefix = i === 0 ? "local " : "  ";
          return `${prefix}value_${i} <const>${last ? "" : ","}`;
        }),
        "= nil",
      ];
    },
  },
  {
    name: "TypeScript template escapes",
    packageName: "language-typescript",
    scopeName: "source.ts",
    parentType: "template_string",
    build(size) {
      return ["const value = `", ...rows(size, () => "  \\n"), "`;"];
    },
  },
  {
    name: "Crystal command escapes",
    packageName: "language-crystal",
    scopeName: "source.crystal",
    parentType: "command",
    build(size) {
      return ["value = `", ...rows(size, () => "  \\n"), "`"];
    },
  },
  {
    name: "PHP encapsed string escapes",
    packageName: "language-php",
    scopeName: "source.php.only",
    parentType: "encapsed_string",
    build(size) {
      return ['$value = "', ...rows(size, () => "  \\n"), '";'];
    },
  },
  {
    name: "TypeScript template literal type",
    packageName: "language-typescript",
    scopeName: "source.ts",
    parentType: "template_literal_type",
    build(size) {
      return ["type Value = `", ...rows(size, (i) => `  \${Type${i}}`), "`;"];
    },
  },
  {
    name: "R string escapes",
    packageName: "language-r",
    scopeName: "source.r",
    parentType: "string",
    build(size) {
      return ['value <- "', ...rows(size, () => "  \\n"), '"'];
    },
  },
  {
    name: "Typst content",
    packageName: "language-typst",
    scopeName: "source.typst",
    parentType: "content",
    build(size) {
      return ["#let value = [", ...rows(size, (i) => `  content ${i}`), "]"];
    },
  },
  {
    name: "AutoHotkey parameters",
    packageName: "language-ahkpp",
    scopeName: "source.ahk",
    parentType: "param_sequence",
    build(size) {
      return [
        "generated(",
        ...rows(size, (i, last) => `  parameter_${i}${last ? "" : ","}`),
        ") {",
        "}",
      ];
    },
  },
  {
    name: "Dart object pattern",
    packageName: "language-dart",
    scopeName: "source.dart",
    parentType: "object_pattern",
    childStartRow: 2,
    build(size) {
      return [
        "void main() {",
        "  for (var Record(",
        ...rows(size, (i) => `    field_${i}: value_${i},`),
        "  ) in values) {}",
        "}",
      ];
    },
  },
  {
    name: "Dart record pattern",
    packageName: "language-dart",
    scopeName: "source.dart",
    parentType: "record_pattern",
    childStartRow: 2,
    build(size) {
      return [
        "void main() {",
        "  var (",
        ...rows(size, (i) => `    field_${i}: value_${i},`),
        "  ) = record;",
        "}",
      ];
    },
  },
  {
    name: "Bash string substitutions",
    packageName: "language-shellscript",
    scopeName: "source.shell",
    parentType: "string",
    build(size) {
      return ['value="', ...rows(size, (i) => `  $(command_${i})`), '"'];
    },
  },
  {
    name: "Docker heredoc",
    packageName: "language-dockerfile",
    scopeName: "source.dockerfile",
    parentType: "heredoc_block",
    build(size) {
      return ["RUN <<EOF", ...rows(size, (i) => `line_${i}`), "EOF", ""];
    },
  },
  {
    name: "C preprocessor parameters",
    packageName: "language-c",
    scopeName: "source.c",
    parentType: "preproc_params",
    build(size) {
      return ["#define MANY(", ...rows(size, (i) => `  value_${i},`), "  ...) value_0", ""];
    },
  },
  {
    name: "C multiline string escapes",
    packageName: "language-c",
    scopeName: "source.c",
    parentType: "string_literal",
    build(size) {
      return ['const char *value = "\\', ...rows(size, () => "\\"), '";'];
    },
  },
  {
    name: "C++ multiline string escapes",
    packageName: "language-c",
    scopeName: "source.cpp",
    parentType: "string_literal",
    build(size) {
      return ['const char *value = "\\', ...rows(size, () => "\\"), '";'];
    },
  },
  {
    name: "Python triple-string escapes",
    packageName: "language-python",
    scopeName: "source.python",
    parentType: "string_content",
    build(size) {
      return ['value = """', ...rows(size, (i) => `  \\nvalue_${i}`), '"""'];
    },
  },
  {
    name: "IPython triple-string escapes",
    packageName: "language-ipython",
    scopeName: "source.python.ipy",
    parentType: "string_content",
    build(size) {
      return ['value = """', ...rows(size, (i) => `  \\nvalue_${i}`), '"""'];
    },
  },
  {
    name: "Snakemake triple-string escapes",
    packageName: "language-snakemake",
    scopeName: "source.snakemake",
    parentType: "string_content",
    build(size) {
      return ['value = """', ...rows(size, (i) => `  \\nvalue_${i}`), '"""'];
    },
  },
  {
    name: "PHP trait use list",
    packageName: "language-php",
    scopeName: "source.php.only",
    parentType: "use_list",
    childStartRow: 3,
    build(size) {
      return [
        "<?php",
        "class Example {",
        "  use Trait {",
        ...rows(size, (i) => `    Trait::method_${i} as alias_${i};`),
        "  }",
        "}",
      ];
    },
  },
  {
    name: "Perl hash list",
    packageName: "language-perl",
    scopeName: "source.perl",
    parentType: "list_expression",
    build(size) {
      return ["my %hash = (", ...rows(size, (i) => `  key_${i} => value_${i},`), ");"];
    },
  },
  {
    name: "JSON soft-wrapped string escapes",
    packageName: "language-json",
    scopeName: "source.json",
    parentType: "string",
    build(size) {
      return [`"${"\\n".repeat(size)}"`];
    },
    columnRange(size) {
      const startColumn = 1 + 2 * Math.floor((size - 6) / 2);
      return { row: 0, startColumn, endColumn: startColumn + TILE_COLUMNS };
    },
  },
  {
    name: "TypeScript soft-wrapped string escapes",
    packageName: "language-typescript",
    scopeName: "source.ts",
    parentType: "string",
    build(size) {
      return [`const value = "${"\\n".repeat(size)}";`];
    },
    columnRange(size) {
      const startColumn = 'const value = "'.length + 2 * Math.floor((size - 6) / 2);
      return { row: 0, startColumn, endColumn: startColumn + TILE_COLUMNS };
    },
  },
];

function percentile(samples, fraction) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function comparePoints(a, b) {
  return a.row - b.row || a.column - b.column;
}

function summarize(samples) {
  return {
    count: samples.length,
    medianMs: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
  };
}

function ancestorOfType(node, type) {
  for (let current = node; current; current = current.parent) {
    if (current.type === type) return current;
  }
  return null;
}

async function measureCase(benchmarkCase, grammarsByScopeName) {
  const grammar = grammarsByScopeName.get(benchmarkCase.scopeName);
  expect(grammar).not.toBeNull();
  expect(grammar.packageName).toBe(benchmarkCase.packageName);

  const language = await grammar.getLanguage();
  const query = await grammar.getQuery("highlightsQuery");
  expect(language).not.toBeNull();
  expect(query).not.toBeNull();

  const parser = grammar.createParser(language);
  const results = [];
  try {
    for (const size of SIZES) {
      const lines = benchmarkCase.build(size);
      const columnRange = benchmarkCase.columnRange?.(size) ?? null;
      const childStartRow = benchmarkCase.childStartRow ?? 1;
      const startRow = columnRange?.row ?? childStartRow + Math.floor((size - TILE_ROWS) / 2);
      const endRow = columnRange?.row ?? startRow + TILE_ROWS;
      const source = lines.join("\n");

      const parseStartedAt = performance.now();
      const tree = parser.parse(source);
      const parseMs = performance.now() - parseStartedAt;
      try {
        expect(tree.rootNode.hasError).toBe(false);
        let startPosition;
        let endPosition;
        let probePosition;
        let rangeSummary;
        if (columnRange) {
          expect(columnRange.endColumn - columnRange.startColumn).toBe(TILE_COLUMNS);
          expect(columnRange.startColumn).toBeGreaterThan(0);
          expect(columnRange.endColumn).toBeLessThan(lines[columnRange.row].length);
          startPosition = { row: columnRange.row, column: columnRange.startColumn };
          endPosition = { row: columnRange.row, column: columnRange.endColumn };
          probePosition = startPosition;
          rangeSummary = {
            row: columnRange.row,
            startColumn: columnRange.startColumn,
            endColumn: columnRange.endColumn,
            columns: TILE_COLUMNS,
          };
        } else {
          expect(endRow - startRow).toBe(TILE_ROWS);
          expect(startRow).toBeGreaterThan(childStartRow - 1);
          expect(endRow).toBeLessThan(lines.length);
          const firstTextColumn = lines[startRow].search(/\S/);
          expect(firstTextColumn).toBeGreaterThanOrEqual(0);
          startPosition = { row: startRow, column: 0 };
          endPosition = { row: endRow, column: 0 };
          probePosition = { row: startRow, column: firstTextColumn };
          rangeSummary = { startRow, endRow, rows: TILE_ROWS };
        }

        const nodeInTile = tree.rootNode.descendantForPosition(probePosition);
        const parent = ancestorOfType(nodeInTile, benchmarkCase.parentType);
        expect(parent).not.toBeNull();
        expect(comparePoints(parent.startPosition, startPosition)).toBeLessThan(0);
        expect(comparePoints(parent.endPosition, endPosition)).toBeGreaterThanOrEqual(0);
        if (benchmarkCase.outerParentType) {
          expect(ancestorOfType(parent.parent, benchmarkCase.outerParentType)).not.toBeNull();
        }

        const range = { startPosition, endPosition };
        for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration++) {
          query.captures(tree.rootNode, range);
        }

        const durations = [];
        const captureCounts = new Set();
        for (let iteration = 0; iteration < SAMPLE_ITERATIONS; iteration++) {
          const startedAt = process.hrtime.bigint();
          const captures = query.captures(tree.rootNode, range);
          durations.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
          captureCounts.add(captures.length);
        }

        expect(captureCounts.size).toBe(1);
        expect(query.didExceedMatchLimit()).toBe(false);
        results.push({
          size,
          sourceRows: lines.length,
          sourceBytes: Buffer.byteLength(source),
          descendants: tree.rootNode.descendantCount,
          parentRows: parent.endPosition.row - parent.startPosition.row + 1,
          range: rangeSummary,
          captures: [...captureCounts][0],
          parseMs: round(parseMs),
          query: summarize(durations),
        });
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }

  return {
    name: benchmarkCase.name,
    packageName: benchmarkCase.packageName,
    scopeName: benchmarkCase.scopeName,
    parentType: benchmarkCase.parentType,
    results,
  };
}

describe("Tree-sitter query locality benchmark", () => {
  it("reports warm six-row query work inside growing single parents", async () => {
    jasmine.useRealClock();
    const packages = await Promise.all(
      [...new Set(CASES.map(({ packageName }) => packageName))].map((packageName) =>
        lumine.packages.activatePackage(path.resolve(__dirname, "..", "..", packageName)),
      ),
    );
    const grammarsByScopeName = new Map();
    for (const pack of packages) {
      for (const grammar of pack.grammars) grammarsByScopeName.set(grammar.scopeName, grammar);
    }

    const results = [];
    for (const benchmarkCase of CASES) {
      results.push(await measureCase(benchmarkCase, grammarsByScopeName));
    }

    console.log(
      `TREE_SITTER_QUERY_LOCALITY_BENCHMARK=${JSON.stringify({
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        config: {
          sizes: SIZES,
          tileRows: TILE_ROWS,
          tileColumns: TILE_COLUMNS,
          warmupIterations: WARMUP_ITERATIONS,
          sampleIterations: SAMPLE_ITERATIONS,
        },
        results,
      })}`,
    );
  }, 120000);
});
