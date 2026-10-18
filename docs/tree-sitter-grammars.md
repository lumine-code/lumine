# Tree-sitter grammars

Each bundled Tree-sitter grammar combines three things: a **pre-built parser** compiled from an upstream `tree-sitter-*` repository into a `.wasm` file, **query files** with the `.scm` extension that turn syntax nodes into scopes, and a **grammar config** in `.json` that ties them together. This page describes grammar descriptors, runtime queries, injections and validation. Parser-build workflows are maintained with the build tooling.

Install [`language-tree-sitter-query`](https://github.com/lumine-code/language-tree-sitter-query) from **Settings → Install** or with `lumine --install lumine-code/language-tree-sitter-query` to edit `.scm` query files with syntax highlighting, folding, indentation, and symbols. These files use Tree-sitter's query syntax, which resembles Scheme but describes parser nodes, captures, and predicates.

## The grammar config

A Tree-sitter grammar config and all of its runtime assets live directly in a package's flat `grammars/` directory. Filenames describe the language or variant without repeating the `tree-sitter-` implementation prefix: `python.json`, `python.wasm`, `python-highlights.scm`.

```json
{
  "name": "JSON",
  "scopeName": "source.json",
  "type": "tree-sitter",
  "treeSitter": {
    "parserSource": "github:tree-sitter/tree-sitter-json#v0.24.8",
    "wasmBuildTool": "tree-sitter-cli#v0.27.0",
    "grammar": "json.wasm",
    "highlightsQuery": ["json-no-comments-highlights.scm", "json-highlights.scm"],
    "indentsQuery": "json-indents.scm",
    "foldsQuery": "json-folds.scm"
  }
}
```

- **`parserSource`** pins the exact upstream source as `github:org/repo#ref`, where `ref` is a tag or a full commit SHA — never a moving branch, so a build is always reproducible. For repositories that contain several grammars, add the subdirectory: `github:tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown-inline#<ref>`.
- **`wasmBuildTool`** records which `tree-sitter-cli` version built the committed wasm. It is provenance, not configuration.
- **`grammar`** points at the committed wasm, relative to the config file.
- The **query keys** (`highlightsQuery`, `injectionsQuery`, `indentsQuery`, `foldsQuery`, `tagsQuery`, `localsQuery`, and optional `parseBoundariesQuery`) point at `.scm` files. A key may hold an array; the files are concatenated in order, which lets grammars share a common base query. Query files may contain the `._LANG_` token, which is replaced with the config's `treeSitter.languageSegment` — this is how one query file serves both TypeScript and TSX.

Several configs can share one wasm (JSON, JSONC, and Jupyter). Configs that pin the same `parserSource` and wasm filename always move together.

## Building and updating parsers

Commit the parser Wasm, its immutable `parserSource` and its `wasmBuildTool` provenance together. A source update can change node types, fields and tree shapes; inspect it against the package's queries and fixtures, run query and scope validation, and test highlighting, indentation and folding on real source. Keep the package's own applicable license in `LICENSE`, and the parser's source license, inherited copyright notices, required NOTICE content, source URL and revision in `THIRD_PARTY_NOTICES`. Include both files in its shipped payload.

In the maintainer's flat source workspace, the local `lem grammar` tool owns parser checkouts, the pinned Tree-sitter CLI and reproducible builds. Its `docs/grammar-building.md` documents building, source updates, external-package checks and dependency repinning. `lem` is local workspace tooling; it is not a public package dependency. Grammar packages remain portable Wasm and query assets.

Link a grammar working copy into `~/.lumine/packages-dev` and run a development window to test query changes without advancing installed or bundled pins. See [Developing against a live editor](developing-a-package.md#developing-against-a-live-editor).

## Query validation and errors

Every query of every bundled grammar is compiled in CI by `spec/grammar-query-validation-spec.js`, so a broken query cannot ship silently — even for a language package with no spec suite of its own. It enumerates the dependencies whose manifests declare `engines.lumine` rather than reading `packages/`, so it covers grammars delivered through `node_modules/` too, and `LUMINE_GRAMMAR_PACKAGE_ROOTS` adds checkouts that are not pinned yet.

A grammar package in its own repository carries the same gate as a spec of its own, `spec/grammar-queries-spec.js`, which compiles every query its configs declare against its committed wasm. It needs no CI change: the package's existing integration job already runs its specs inside a real Lumine build. Without it such a package has **no** query gate at all, and a broken highlights query does not fail its other specs — the language layer degrades to a placeholder, so everything stays green while highlighting is silently dead.

The scaffolder described in [Creating a grammar](creating-a-grammar.md) emits that spec with the rest of a new package repository.

### Captures that compile but are not scopes

Compiling is not the whole story. A capture left with the name an upstream Neovim query gave it — `@tag.delimiter`, `@spell`, `@embedded` — compiles, and it matches. Every gate above passes. The scope simply is not a TextMate scope, so it themes as nothing and no scope selector can see it, and the only symptom is a token that stays grey.

`npm run check:grammar-captures` is the gate for that, and it runs in the lint job. A capture whose first segment is not one of the TextMate roots (`comment`, `constant`, `entity`, `invalid`, `keyword`, `markup`, `meta`, `punctuation`, `source`, `storage`, `string`, `support`, `text`, `variable`) fails the build; `_IGNORE_` and `_IGNORE_.…` are exempt, which is how a helper capture used only as a predicate operand says it is not a scope.

It also warns about a capture carrying no language segment. The segment is read off the queries — the one a majority of the captures already end in, per file and then per package — rather than derived from the scope name, which is wrong for `text.html.basic`, `source.json.jsonc`, `source.makefile` and `source.python.ipy`. A segment anywhere in the capture counts, not just last: `meta.diff.header` is the name the TextMate diff bundle fixed a decade ago and the tree-sitter grammar has to match its own TextMate twin, so a second `.diff` would be the wrong fix. That check warns rather than failing the build, because the next such family will not be knowable in advance and gating on it would mean keeping an allowlist.

Only `highlightsQuery` is checked. The other query types have vocabularies of their own (`@fold`, `@indent`, `@name`, `@local.scope`), so measuring them against scope names would say nothing. Use `--package-root` to include a checkout that is not pinned yet.

A query that fails to compile does **not** break the grammar: the editor still activates it, parses, and reports the error precisely — the query type, the offending `.scm` file and line, and the unknown node type or field name when there is one. In dev mode the error also appears as a notification, and query files are watched: saving a broken query beeps and reports, saving a fixed one hot-reloads it.

Two commands help while working on queries:

- `editor:validate-grammar-queries` — recompiles every query of the grammars used by the current buffer (including injected ones) and reports each failure.
- `editor:log-cursor-scope` — shows the scopes at the cursor, for checking what a query actually applied.

Mistakes inside predicates are contained the same way: an unknown `test.`/`adjust.`/`capture.` key, an invalid regular expression, or a predicate missing its argument drops only the affected capture and warns once per grammar in dev mode, instead of breaking highlighting for the whole file.

## Static injections

Declare `treeSitter.injectionsQuery` when a syntax pattern can identify an injection's owner, content and language without a JavaScript callback. Keep the query beside the grammar's other assets, for example `grammars/example-injections.scm`, and reference it as `"injectionsQuery": "example-injections.scm"`. The query is compiled against the same parser as highlighting, validated by the query gates, and watched and reloaded in dev mode.

Each pattern must capture exactly one `@injection.owner` and at least one `@injection.content`. The owner defines the range used for local rediscovery and layer reuse; the content defines what the child parser receives. Every content capture, language capture and helper capture used by predicates must lie within that owner. Choose a local owner that contains the fragments belonging to one injection, rather than the file's root node.

For example, a parser whose documentation comments use `///` can inject them into a grammar whose alias is `documentation`:

```scheme
((comment) @injection.owner @injection.content
  (#match? @injection.owner "^///")
  (#set! injection.language "documentation")
  (#set! injection.include-children "true")
  (#set! injection.combined "true")
  (#set! injection.newlines-between "true"))
```

The child grammar must accept the captured source, including its delimiters. To select the language from source, capture one node as `@injection.language` instead of setting `injection.language`; that node's text is resolved through the target grammar's `injectionNames` aliases. Use JavaScript when selection needs normalization, configuration, semantic checks or source ranges that the syntax tree does not represent.

| Property                                | Meaning                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `injection.language`                    | A fixed injection alias, used instead of `@injection.language`.                                         |
| `injection.include-children`            | Include each content node's child nodes in the parsed source. By default, direct children are excluded. |
| `injection.include-adjacent-whitespace` | Include whitespace between captured content ranges.                                                     |
| `injection.newlines-between`            | Include newline joins between captured content ranges.                                                  |
| `injection.combined`                    | Share one child document across owners from the same pattern and language.                              |
| `injection.combined-max-members`        | Bound a combined layer to this positive safe integer number of owners.                                  |
| `injection.language-scope`              | Override the child grammar's base scope; `"none"` suppresses it.                                        |
| `injection.cover-shallower-scopes`      | Cover scopes supplied by shallower language layers.                                                     |

Boolean properties accept `"true"`, `"false"`, or a directive without a value, which means true. Unknown properties and captures beginning with `injection.`, custom predicates and directives, and `#is?` or `#is-not?` assertions fail validation. The implemented text predicates are `#eq?`, `#not-eq?`, `#any-eq?`, `#any-not-eq?`, `#match?`, `#not-match?`, `#any-match?`, `#any-not-match?`, `#any-of?` and `#not-any-of?`. A pattern cannot combine a fixed language property with a language capture.

Matches from the same pattern, owner and language accumulate content fragments into one injection. The runtime deduplicates repeated captures across scan windows and preserves each pattern's identity for layer reuse. Separate patterns remain separate injections, even when they capture the same owner and select the same language. `combined` then groups these owners using the same range and parser lifecycle as JavaScript injection points; a member limit counts owners, rather than content fragments.

Static queries and `lumine.grammars.addInjectionPoint()` registrations are additive. Port a rule by removing its JavaScript registration when its query is ready, so both mechanisms do not create the same child document. Keep dynamic registrations for configuration changes, semantic eligibility checks and synthetic content ranges, and dispose them with the package or service edge that owns them. Removing or reloading a static query rebuilds its injections without removing unrelated dynamic registrations.

An injection target can declare a top-level `injectionContentRegex` in its grammar descriptor when a cheap text check can rule out owners that have nothing for it to parse:

```json
{
  "scopeName": "text.hyperlink",
  "injectionNames": ["hyperlink"],
  "injectionContentRegex": "\\bhttps?:"
}
```

The value is a nonempty regular-expression string or a nonempty array of such strings, treated as alternatives. An omitted or null value accepts every structurally eligible match; empty, invalid or malformed filters fail grammar loading. The runtime compiles the filter once and tests each static match's owner text before creating a child layer. Owner text includes the content captures, their children and any gaps between them, so the filter conservatively accepts matches whose actual content might not contain a token. This also avoids losing a token that crosses capture boundaries. Declare only a filter that cannot reject source the target parser should handle; JavaScript injection points keep their existing callback-controlled eligibility.

`language-hyperlink` and `language-todo` own their respective filters. A parent grammar selects their aliases without copying URL expressions or the TODO marker list, consuming a service, or defining a JavaScript entry point:

```scheme
((comment) @injection.owner @injection.content
  (#set! injection.language "hyperlink")
  (#set! injection.include-children)
  (#set! injection.language-scope "none"))

((comment) @injection.owner @injection.content
  (#set! injection.language "todo")
  (#set! injection.include-children)
  (#set! injection.language-scope "none"))
```

Use the parent parser's actual comment types and keep document-comment exclusions or URL-specific structural guards in its query. Including children preserves comment bodies represented by child nodes; for strings, capture literal content nodes and leave expressions out. For annotation patterns, give each independent literal fragment its own owner and content capture: joining fragments in one layer can let a lexer token span an excluded expression. When an injection target is unavailable, the editor retains the unresolved alias; grammar registration retries it, and grammar removal rebuilds the affected injections. The JavaScript services remain supported for rules requiring runtime logic.

The [C# grammar](https://github.com/lumine-code/language-csharp) uses these annotation patterns for `comment` nodes and selects `string_literal_content` for hyperlinks in ordinary string literals. TODO markers stay limited to comments. Raw, verbatim, and interpolated strings have different syntax nodes; inspect the parent parser before extending a literal-content pattern to those forms.

The performance benefit comes from structural selection in the query and fewer node accesses across the JavaScript/WASM boundary. Text predicates still run in JavaScript in `web-tree-sitter`, and every selected child document still needs range markers, reconciliation and parsing. Measure initial opening and incremental edits separately; changing the query format alone does not reduce the number of child layers.

Run `npm run test:only -- benchmark/tree-sitter-static-injections-spec.js` from the editor repository for a diagnostic comparison of equivalent JavaScript and static rules. It measures initial parsing with warm languages and queries, edits inside content and prefix shifts, and verifies owner ranges, content, syntax trees, scopes and layer counts outside the timers. It reports samples and medians without performance thresholds; set `LUMINE_STATIC_INJECTION_BENCHMARK_CONFIG` to a JSON object with `sizes`, `samples` and `warmups` to change the workload.

## Keeping grammar work local

### Optional incremental parse boundaries

A grammar that divides opaque text into bounded fragments can declare `parseBoundariesQuery` to preserve their alignment after edits that shift the fragment boundaries, including insertion of a physical newline. The scanner must recognize adjacent included-range starts as permitted fragment ends. This is an opt-in parser capability: a scanner that treats every included-range start as a separate language region must not enable it.

```json
{
  "treeSitter": {
    "grammar": "ipython.wasm",
    "parseBoundariesQuery": "ipython-parse-boundaries.scm"
  }
}
```

```scheme
(cell_body "opaque_fragment" @parse.boundary)
```

After replaying document edits on a private tree copy, the editor reads the selected fragments' updated end indices and positions. It passes sparse adjacent included ranges to the root parser so the edited prefix can end at an existing fragment boundary and the remaining tree can be reused. The ranges cover exactly the same source as before; language ownership and injection ranges retain their semantic boundaries. The editor rejects boundaries inside UTF-16 pairs or CRLF and removes duplicate or nearby cuts. Injected parsers receive no alignment hints by default. A grammar can explicitly set `treeSitter.parseBoundariesInjections` to `true` to load its boundary query and use hints in injected layers too. Their existing semantic ranges are subdivided without filling excluded gaps, and consolidation stays inside one semantic range.

For grammars with fragment groups containing many line nodes, `treeSitter.parseBoundariesMaxStartDepth` can limit the initial query traversal. A safe integer from 0 through 32 is accepted and passed as Tree-sitter's `maxStartDepth`; an absent or invalid value leaves the query unrestricted. The shallow query must capture each group as `@parse.boundary`. The editor expands captured groups that have changes and children recursively, querying each group with `maxStartDepth` set to the configured value plus one, with a minimum of one. It merges and deduplicates captures while descending only into changed captured groups, so boundaries inside an edited long line remain available while unchanged groups avoid a full descendant traversal. Each intermediate group must therefore appear within that relative depth and be captured by the query. An anonymous visible group node provides this traversal boundary while retaining its nested named line nodes; clients that previously read lines directly from a paragraph must account for that group.

With a valid depth limit, the editor keeps initial container captures of each node type until they cover at least 1024 characters, then keeps changed containers and enough following containers of the same type to reach at least 1024 characters beyond the changed container. Initial anchors permit realignment when an edit occurs in uncaptured leading whitespace. It keeps all captured leaves, including fragments of long lines. This supplies nearby alignment boundaries without reading buffer positions for every unchanged group. Without a valid depth limit, capture collection remains unrestricted.

The query is loaded before parsing and participates in query validation and reloads. It should select bounded fragments whose boundaries the scanner can use, rather than every token in the document. Verify fresh and incremental syntax, complete source coverage, injections, and edits near fragment and Unicode boundaries. Parser bindings used outside the editor need to pass equivalent alignment options when reparsing an old tree; the IPython binding exposes a helper for this purpose.

Repeated edits can create short fragments between surviving boundaries. The editor consolidates dense runs with bounded metadata-only invalidations before reparsing; it changes no source text, coordinates, or language ownership. This keeps fragment collection and reuse costs stable over a long editing session.

### Runtime snapshots and updates

The editor loads portable grammar `.wasm` files through `web-tree-sitter`. Grammar packages remain platform-independent. The native Node-API and Wasmtime experiment is archived; it is not an editor dependency.

To build the editor from source, install dependencies with `npm ci --ignore-scripts`, download Electron with `node script/install-electron.js`, then run `npm run build` to rebuild the editor's remaining native modules for Electron.

Initial loading may be asynchronous. Every update shares a 5 ms synchronous parsing allowance across documents and injection layers in the renderer task. Work that exceeds the allowance resumes in bounded WASM slices after yielding to the event loop. This is cooperative scheduling on the renderer thread, not a worker. Query construction, an individual query and buffer mutation remain synchronous operations, so the allowance is not a hard bound on total command latency.

Highlighting is published only when the root and every active injection layer describe the same current document revision. During a deferred update, previously painted scope boundaries are shifted with text edits and reused for presentation. Semantic APIs never return those cached scopes as a current syntax tree. Cancellation, grammar reload and new document revisions prevent an obsolete parse from being published.

Screen-line construction consumes prepared scope IDs and positions without executing queries or reading syntax nodes. The presentation queue prepares 64-row fragments around recent render requests with a 16-row margin, retaining the active views in full. Cache allowances of 16 fragments and 128000 boundary events evict older fragments without truncating a dense or heavily folded current view. Preparation shares the parser's synchronous allowance and yields between fragments when it runs out. A batch commits only after checking the document revision, grammar and highlight-query identities, query generation, injection topology and configuration invalidation generation. Requests coalesce while a batch is pending; superseded batches cannot publish. A newly visible uncached fragment is requested for the next task while the renderer retains any previous presentation. Semantic scope queries remain separate and resolve against current trees.

New revisions cancel queued and already started parser work at its next yield. Visible scope preparation takes priority over eager fold-cache warming. Fold queries return no current ranges while syntax is pending; folding commands wait for grammar settlement and discard their action if another edit, grammar change, fold or unfold command supersedes it.

Each display view registers its requested buffer fragments, excluding the interiors of folds. Scrolling replaces that view's urgent work while preserving other views of the same buffer. Cached fragments outside those requests remain available as old presentation but are not recomputed on every edit. Display views are weakly referenced and destroyed views are removed from subsequent plans.

Published trees retain their original UTF-16 text and revision. Consumers await `atGrammarSettlement()` to acquire current syntax; they must not edit or delete a published tree. Temporary private copies are released explicitly, while retained trees and queries follow their JavaScript lifetimes through the runtime's finalizers.

The pinned 0.27.1 runtime has unsafe automatic cursor cleanup and interleaved cursor copying. A small ownership layer in the editor uses the public `delete()` and `resetTo()` methods to preserve cursor lifetime and state; it does not modify the dependency or its Wasm binary. A subprocess regression forces garbage collection while cursors from different trees are used and copied.

That runtime also clears included-range differences when resuming an incremental parse, which can lose newly injected content. If a suspended job covers different source from its edited old tree, the adapter resets that job once and continues with a fresh parse. The comparison merges adjacent ranges and clips them at EOF: changing parse-boundary hints without changing their covered source retains incremental reuse. Incremental jobs that finish within their first slice also retain the incremental path. Deterministic regressions interrupt both kinds of job and verify the new injected token and reuse of unaffected syntax.

Large batches use a fresh parse and conservative syntax invalidation instead of applying thousands of edits to an old tree. The current policy switches at 128 edits, or when changed input spans at least half the previous text and 8192 code units. This affects parsing only: buffer transactions, selections and undo history retain the original edits.

Multicursor newline insertion plans indentation after all cursors have inserted text. It queries only the affected rows against the same committed trees, applies the resulting indents together and groups them with the insertion for undo. Deferred indentation is discarded when a later text revision makes its plan obsolete. Raw highlight and indentation captures are cached in bounded windows for the exact tree, query and range; scope predicates are evaluated again for every consumer.

Use `await editor.whenGrammarSettled()` before a command that depends on completed automatic indentation, such as expanding a snippet after inserting a newline. The editor waits for requested indentation and then settles syntax again if indentation changed the text. The language mode's `atTransactionEnd()` waits for syntax only; it cannot describe pending editor-owned text adjustments.

### Parser and query costs

Measure opening a file, editing a small range, and collecting symbols separately. A fast parser does not guarantee a fast grammar: query compilation, repeated sibling matches, and injection callbacks can dominate different phases. Use valid generated input as well as partially edited syntax, and compare captures and scopes before and after an optimization.

The first parse waits for the highlighting query and any declared injection query. Folding and indentation queries already in the grammar cache are reused immediately; cold queries are prepared during idle time after the first highlighting update. An explicit folding or indentation request prepares the query when needed, and completed folding queries invalidate the initial fold cache so gutter markers appear without an edit. Symbol and local-variable queries are compiled on their first asynchronous capture request. Changed optional queries stay uncompiled until requested; queries already in use retain validation and reload behavior. The validation command and CI still compile every declared query.

Upstream Tree-sitter query construction remains synchronous, so a large cold highlights query can still briefly occupy the renderer.

Prefer a field or a leaf pattern to an unbounded sibling sequence. A query containing `(comment)*` before a declaration can reconsider long suffixes even when the caller requests only a small row window. Capture definitions and names directly when documentation is not consumed; when a sequence is required, test its behavior inside a growing parent rather than only on a short fixture.

An injection callback should inspect the node that owns its content. Registering a root node and calling `descendantsOfType` inside the callback performs synchronous work on the entire tree after every edit. The runtime's outer scan budget cannot divide a traversal inside a callback.

Use `combined` when several discovered nodes contribute to one logical child document:

```js
const registration = lumine.grammars.addInjectionPoint("source.example", {
  type: "documentation_line",
  language: () => "documentation",
  content: (node) => node,
  combined: true,
  newlinesBetween: true,
});
```

The child layer shares its parser and queries while retaining individual owner and content ranges. An edit outside those ranges does not rediscover every member. `combined` can also be a function receiving the owner node: return `false` to parse that owner's content independently when joining it would change its meaning or its error recovery. Dispose the registration with the package or service edge that created it. Test malformed syntax as well as insertion, deletion, prefix shifts, and removal of the last member.

When independent owners are safe to combine but a large shared parse tree makes local edits expensive, set `combinedMaxMembers` to a positive safe integer. For example, validated regex literals can share layers with at most 128 owners each. Existing owners keep their group during ordinary edits; insertion and deletion split or merge neighboring groups when needed. Each owner counts once even if its `content` function returns several nodes, and those fragments stay together. Omit the limit when the regions require one continuous document, such as the SassDoc example above. Test scopes across group boundaries, changes in eligibility and flags, prefix shifts, and grammar replacement before enabling a limit.

For grammar-selection regular expressions, make repeated alternatives disjoint. A comment matcher must stop at the first closing delimiter; an optional whitespace matcher must not overlap another repeated whitespace branch. Include failed matches in regression cases: the costly backtracking often appears when the final language name or opening delimiter is absent.

## Recognizing unopened files

Use `await lumine.grammars.selectGrammarAsync(filePath, { signal })` when background work needs the language of a file that is not open. It reads the file asynchronously once, applies the same filename and content rules as `selectGrammar`, and accepts an `AbortSignal` so a package can cancel work during teardown. For an open editor, use `editor.getGrammar()` to preserve a manual language selection.

The synchronous `selectGrammar(filePath, fileContents)` remains available when the caller already has the text. Passing the contents avoids disk access; omitting them reads the file synchronously once. Both selectors honor custom file types, shebangs, multiline first-line expressions and content expressions. A package awaiting a result must still verify that its document, configuration and package generation are current before applying it.

## Constraining an embedded editor's root language

A host can keep a prefix in an editor's buffer while parsing only its body with the selected language. `lumine.grammars.setRootLanguageRanges(buffer, provider)` installs a policy for that buffer's root language without changing its source text or its assigned grammar. Notebook code cells use this for a visible `%%` header followed by a body parsed with its original language package.

The provider runs synchronously before each parse and receives the buffer. Return an array of `Range` objects in buffer coordinates, `null` to parse the whole buffer, or `[]` to parse no source. For a host-defined prefix occupying the first line:

```js
const { Range } = require("lumine");

const registration = lumine.grammars.setRootLanguageRanges(editor.getBuffer(), (buffer) => {
  if (!buffer.lineForRow(0).startsWith("%%")) return null;
  return [new Range(buffer.clipPosition([1, 0]), buffer.getEndPosition())];
});
```

The policy follows the buffer across grammar changes. It is not serialized, so the host recreates it when restoring its editor. Dispose the returned registration when the host releases the buffer; disposing an older registration does not remove a newer policy. Source outside the included ranges stays editable and is still available to save, copy, search, and execution. The host owns any highlighting or decorations for that excluded prefix.

Keep the provider small: use bounded prefix recognition and edit-aware markers or caches instead of rescanning a large body on every parse. The ranges constrain syntax parsing, not the code sent to a kernel or language server; those consumers still need their own source contract.

## ABI compatibility

A parser wasm carries the ABI version of the `tree-sitter-cli` that generated its `parser.c`. Rebuilding an existing `parser.c` preserves that ABI; `lem grammar --regenerate` replaces it with output from the fleet CLI. Lumine's runtime accepts a window of ABI versions (currently 13–15), so a wasm outside that window must not be committed. If an upstream commits sources generated with an incompatible CLI, run `lem grammar <config> --regenerate` so the parser is regenerated at an ABI the runtime accepts.
