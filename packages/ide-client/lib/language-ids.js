// Grammar scope names mapped to LSP language identifiers. Resolution order for
// a document: adapter.languageIdForScope() override, this table, the adapter's
// blanket languageId, then the lowercased grammar name.

const LANGUAGE_IDS = {
  "source.c": "c",
  "source.clojure": "clojure",
  "source.coffee": "coffeescript",
  "source.cpp": "cpp",
  "source.cs": "csharp",
  "source.css": "css",
  "source.css.less": "less",
  "source.css.scss": "scss",
  "source.diff": "diff",
  "source.gfm": "markdown",
  "source.go": "go",
  "source.java": "java",
  "source.js": "javascript",
  "source.js.jsx": "javascriptreact",
  "source.json": "json",
  "source.lua": "lua",
  "source.makefile": "makefile",
  "source.perl": "perl",
  "source.python": "python",
  "source.ruby": "ruby",
  "source.rust": "rust",
  "source.sass": "sass",
  "source.shell": "shellscript",
  "source.sql": "sql",
  "source.toml": "toml",
  "source.ts": "typescript",
  "source.tsx": "typescriptreact",
  "source.typst": "typst",
  "source.yaml": "yaml",
  "text.bibtex": "bibtex",
  "text.html.basic": "html",
  "text.html.php": "php",
  "text.plain": "plaintext",
  "text.tex.latex": "latex",
  "text.tex.latex.beamer": "latex",
  "text.tex.latex.memoir": "latex",
  "text.xml": "xml",
};

exports.LANGUAGE_IDS = LANGUAGE_IDS;

exports.languageIdForEditor = (adapter, editor) => {
  const grammar = editor.getGrammar();
  const scopeName = grammar?.scopeName;
  return (
    adapter.languageIdForScope?.(scopeName) ??
    LANGUAGE_IDS[scopeName] ??
    adapter.languageId ??
    grammar?.name?.toLowerCase() ??
    "plaintext"
  );
};
