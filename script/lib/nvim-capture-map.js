/*
 * Maps Neovim's Tree-sitter capture names onto the TextMate scope names
 * Lumine's scope resolver expects.
 *
 * Upstream grammar repositories and nvim-treesitter write `highlights.scm`
 * against a small, fixed vocabulary of highlight groups (`@keyword.function`,
 * `@variable.parameter`). Lumine has no such indirection: a capture name *is*
 * the scope applied to the text, so every capture has to be rewritten.
 *
 * Entries are `[nvimPrefix, scope, confidence, note]` and are matched
 * longest-prefix-first, so an unlisted tail inherits its parent — `@keyword.foo`
 * falls back to the `keyword` entry rather than being dropped.
 *
 * Confidence tiers:
 *   safe    a rename, applied without comment.
 *   review  a defensible guess that a human must confirm for this language.
 *   split   NOT a rename. One nvim capture corresponds to two or more Lumine
 *           patterns (an opening and a closing delimiter, say), so the rule has
 *           to be rewritten by hand.
 *   drop    no Lumine equivalent; the capture is removed.
 *
 * The `safe` targets are not invented. They are the scopes the bundled grammars
 * already use most, measured across every committed `highlights.scm`, so a
 * ported grammar themes consistently with the rest of the fleet.
 */

// prettier-ignore
module.exports = [
  // --- variables -----------------------------------------------------------
  ["variable.parameter.builtin", "variable.parameter.language",       "safe"],
  ["variable.parameter",         "variable.parameter",                "safe"],
  ["variable.member",            "variable.other.member",             "safe"],
  ["variable.builtin",           "variable.language",                 "safe"],
  ["variable",                   "variable.other",                    "safe"],
  ["property",                   "variable.other.member",             "safe",
    "nvim renamed @property to @variable.member; both land on the same scope"],

  // --- constants and literals ----------------------------------------------
  ["constant.builtin",           "constant.language",                 "safe"],
  ["constant.macro",             "entity.name.function.preprocessor", "review",
    "a macro constant may want constant.other instead, depending on the language"],
  ["constant",                   "constant.other",                    "safe"],
  ["boolean",                    "constant.language.boolean",         "safe"],
  ["number.float",               "constant.numeric.float",            "safe"],
  ["number",                     "constant.numeric",                  "safe"],
  ["character.special",          "constant.character.escape",         "safe"],
  ["character",                  "string.quoted.single",              "safe"],

  // --- strings -------------------------------------------------------------
  ["string.documentation",       "string.quoted.docstring",           "review",
    "some languages scope docstrings as comment.block.documentation instead"],
  ["string.regexp",              "string.regexp",                     "safe"],
  ["string.escape",              "constant.character.escape",         "safe"],
  ["string.special.symbol",      "constant.other.symbol",             "safe"],
  ["string.special.url",         "markup.underline.link",             "safe"],
  ["string.special.path",        "string.unquoted.path",              "review"],
  ["string.special",             "string.other",                      "review"],
  ["string",                     "string.quoted.double",              "review",
    "confirm the quoting style; single-quoted strings want string.quoted.single"],

  // --- types ---------------------------------------------------------------
  ["type.builtin",               "support.type.builtin",              "safe"],
  ["type.definition",            "entity.name.type",                  "safe"],
  ["type",                       "support.type",                      "review",
    "bundled grammars split this into support.storage.type, support.class and entity.name.type.class"],
  ["attribute.builtin",          "entity.other.attribute-name.builtin", "safe"],
  ["attribute",                  "entity.other.attribute-name",       "safe"],
  ["module.builtin",             "support.other.module",              "review"],
  ["module",                     "entity.name.namespace",             "review"],
  ["label",                      "entity.name.label",                 "safe"],

  // --- functions -----------------------------------------------------------
  ["function.builtin",           "support.function.builtin",          "safe"],
  ["function.method.call",       "support.other.function.method",     "safe"],
  ["function.method",            "entity.name.function.method",       "safe"],
  ["function.macro",             "entity.name.function.macro",        "safe"],
  ["function.call",              "support.other.function",            "safe"],
  ["function",                   "entity.name.function",              "safe"],
  ["constructor",                "entity.name.function.constructor",  "review",
    "some languages scope constructors as entity.name.type.class"],

  // --- keywords and operators ----------------------------------------------
  ["keyword.conditional.ternary", "keyword.operator.ternary",         "safe"],
  ["keyword.conditional",        "keyword.control.conditional",       "safe"],
  ["keyword.coroutine",          "keyword.control",                   "safe"],
  ["keyword.directive.define",   "keyword.control.directive.define",  "safe"],
  ["keyword.directive",          "keyword.control.directive",         "safe"],
  ["keyword.exception",          "keyword.control.exception",         "safe"],
  ["keyword.function",           "storage.type.function",             "safe"],
  ["keyword.import",             "keyword.control.import",            "safe"],
  ["keyword.modifier",           "storage.modifier",                  "safe"],
  ["keyword.operator",           "keyword.operator.word",             "safe"],
  ["keyword.repeat",             "keyword.control.loop",              "safe"],
  ["keyword.return",             "keyword.control.return",            "safe"],
  ["keyword.type",               "storage.type",                      "safe"],
  ["keyword.debug",              "keyword.control",                   "safe"],
  ["keyword",                    "keyword.control",                   "safe"],
  ["operator",                   "keyword.operator",                  "safe"],

  // --- comments ------------------------------------------------------------
  ["comment.documentation",      "comment.block.documentation",       "safe"],
  ["comment.todo",               null,                                "drop",
    "Lumine highlights TODO/FIXME/NOTE through the todo.injection service, not the grammar"],
  ["comment.note",               null,                                "drop",
    "see comment.todo — handled by the todo.injection service"],
  ["comment.warning",            null,                                "drop",
    "see comment.todo — handled by the todo.injection service"],
  ["comment.error",              null,                                "drop",
    "see comment.todo — handled by the todo.injection service"],
  ["comment",                    "comment.line",                      "review",
    "split into comment.line.<style> and comment.block by node type, and add punctuation.definition.comment"],

  // --- punctuation: never a rename -----------------------------------------
  ["punctuation.bracket",        null,                                "split",
    "one pattern per side: punctuation.definition.<what>.begin|end.bracket.round|square|curly"],
  ["punctuation.delimiter",      null,                                "split",
    "depends on the node: punctuation.separator.comma, .colon, .key-value, punctuation.terminator"],
  ["punctuation.special",        null,                                "split",
    "usually punctuation.definition.<what>, named for what it delimits"],
  ["tag.delimiter",              null,                                "split",
    "one pattern per side: punctuation.definition.tag.begin|end"],

  // --- markup --------------------------------------------------------------
  ["markup.strong",              "markup.bold",                       "safe"],
  ["markup.italic",              "markup.italic",                     "safe"],
  ["markup.strikethrough",       "markup.strikethrough",              "safe"],
  ["markup.underline",           "markup.underline",                  "safe"],
  ["markup.heading",             "markup.heading",                    "safe"],
  ["markup.quote",               "markup.quote",                      "safe"],
  ["markup.math",                "markup.math",                       "safe"],
  ["markup.link.label",          "string.other.link",                 "safe"],
  ["markup.link.url",            "markup.underline.link",             "safe"],
  ["markup.link",                "markup.underline.link",             "safe"],
  ["markup.raw.block",           "markup.raw.block",                  "safe"],
  ["markup.raw",                 "markup.raw",                        "safe"],
  ["markup.list",                "markup.list",                       "safe"],

  // --- diff ----------------------------------------------------------------
  ["diff.plus",                  "markup.inserted",                   "safe"],
  ["diff.minus",                 "markup.deleted",                    "safe"],
  ["diff.delta",                 "markup.changed",                    "safe"],

  // --- tags ----------------------------------------------------------------
  ["tag.builtin",                "entity.name.tag",                   "safe"],
  ["tag.attribute",              "entity.other.attribute-name",       "safe"],
  ["tag",                        "entity.name.tag",                   "safe"],

  // --- no equivalent -------------------------------------------------------
  ["error",                      "invalid.illegal",                   "review"],
  ["none",                       null,                                "drop"],
  ["spell",                      null,                                "drop"],
  ["nospell",                    null,                                "drop"],
  ["conceal",                    null,                                "drop"],

  // --- Neovim's pre-2023 names ---------------------------------------------
  // nvim renamed most of its highlight groups; plenty of upstream queries were
  // written before that and still use the old ones. They are listed last so a
  // current name always wins, and specific before general within the block.
  ["parameter.reference",        "variable.parameter",                "safe"],
  ["parameter",                  "variable.parameter",                "safe"],
  ["var.reference",              "variable.other",                    "safe"],
  ["field",                      "variable.other.member",             "safe"],
  ["method.call",                "support.other.function.method",     "safe"],
  ["method",                     "entity.name.function.method",       "safe"],
  ["namespace",                  "entity.name.namespace",             "safe"],
  ["float",                      "constant.numeric.float",            "safe"],
  ["repeat",                     "keyword.control.loop",              "safe"],
  ["conditional",                "keyword.control.conditional",       "safe"],
  ["exception",                  "keyword.control.exception",         "safe"],
  ["include",                    "keyword.control.import",            "safe"],
  ["define",                     "keyword.control.directive.define",  "safe"],
  ["preproc",                    "keyword.control.directive",         "safe"],
  ["storageclass",               "storage.modifier",                  "safe"],
  ["symbol",                     "constant.other.symbol",             "safe"],
  ["text.strong",                "markup.bold",                       "safe"],
  ["text.emphasis",              "markup.italic",                     "safe"],
  ["text.strike",                "markup.strikethrough",              "safe"],
  ["text.underline",             "markup.underline",                  "safe"],
  ["text.title",                 "markup.heading",                    "safe"],
  ["text.literal",               "markup.raw",                        "safe"],
  ["text.uri",                   "markup.underline.link",             "safe"],
  ["text.reference",             "markup.underline.link",             "safe"],
  ["text.quote",                 "markup.quote",                      "safe"],
  ["text.math",                  "markup.math",                       "safe"],
  ["text",                       "markup.other",                      "review",
    "a bare @text meant 'prose' in the old scheme; check what it actually marks"],
];
