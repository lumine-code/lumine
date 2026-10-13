# Creating a grammar

A grammar teaches Lumine to understand a language: it assigns **scopes** to pieces of text, which drive syntax highlighting, indentation, folding, symbols, and more. Grammars ship inside packages, in a `grammars/` directory.

## Tree-sitter grammar engine

Lumine grammars use Tree-sitter. They parse the document into a syntax tree, giving accurate, structure-aware highlighting and features like `editor:select-larger-syntax-node`. Every grammar descriptor declares `type: "tree-sitter"`; descriptors for other engines are rejected. See [Tree-sitter grammars](tree-sitter-grammars.md) for how parsers, queries, injections, and build tooling work.

## Anatomy

A grammar is a `.json` file under `grammars/`. Every grammar declares a **`scopeName`** (for example `source.js`) — the root scope that themes, snippets, and scoped settings target — plus a parser and its queries.

The bundled `language-*` packages are the best references. Each descriptor points to an immutable parser source, a committed Wasm binary, and the query files that provide highlighting and editor behavior.

In the maintainer's source workspace, `lem grammar new` scaffolds the repository — config, specs, CI, and lint setup — and prints the build and registration steps. `lem grammar port` rewrites queries from upstream or nvim-treesitter, whose capture names are highlight groups rather than Lumine's scope taxonomy; review its output before running `npm run check:grammar-captures`. This local workspace tool is separate from the portable grammar assets distributed by a package.

## Choosing which grammar applies

The grammar for an editor is picked from the file name and contents. Users can override it per file by running `grammar-selector:show` from the bundled `grammar-selector` package, and set per-language options under [Customization](https://lumine-code.github.io/docs.html#customization/personalizing-lumine).

## Symbols and more

A grammar also powers other features: the `symbol-tree-sitter` package derives symbols from a Tree-sitter tree, and scoped settings and snippets key off the grammar's `scopeName`.
