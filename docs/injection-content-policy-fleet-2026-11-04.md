# Injection content policy migration

The November 4, 2026 audit covers all 78 active language repositories, their 120 grammar descriptors and 300 static injection patterns. The [complete inventory and measurements](../benchmark/results/injection-content-policies-2026-11-04.json) record every repository, including those requiring no source change. Archived repositories are excluded.

The [stable content edit API](tree-sitter-grammars.md#stable-content-edits) extends injection declarations. It does not replace parsing, semantic language selection or synthetic content ranges. A parent-owned policy proves when cached ownership survives a local edit; the controlling language's ordinary indentation rules still decide whether that edit can publish immediately. Structural changes and unproven contexts retain atomic prepared editing.

## Fleet changes

Twenty-one language repositories changed. Fifteen now provide policies for their applicable embedded source regions, covering 72 static declarations and 10 callback declaration sites. One IPython declaration was already present from the initial fix; this migration adds the other 71. Some callback sites register several node types. Constant callback targets are now literal language names so core can distinguish annotations from possible indentation providers.

| Repositories                                                                                | Migrated source regions                                                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| language-html                                                                               | Script/style bodies and EJS/ERB code and text.                                                      |
| language-gfm                                                                                | Fenced code, front matter, HTML blocks and the existing math callback.                              |
| language-javascript, language-typescript                                                    | Tagged template payloads and HTML template assignments.                                             |
| language-vue                                                                                | Static expressions and callback-selected script/style bodies.                                       |
| language-blade                                                                              | Static shell/JavaScript regions and callback-selected PHP/JavaScript content.                       |
| language-coffee-script                                                                      | Embedded JavaScript/HTML and literate code/HTML blocks.                                             |
| language-go, language-mustache, language-ruby-on-rails                                      | Template text and code regions.                                                                     |
| language-julia, language-nix, language-elixir                                               | Applicable documentation, command, shell-valued string and sigil bodies.                            |
| language-clojure                                                                            | Embedded JavaScript/C++ and the existing EDN callbacks.                                             |
| language-ipython                                                                            | All declared executable and foreign-language body rules, extending the original Python-body policy. |
| language-crystal, language-css, language-cython, language-less, language-php, language-sass | Fixed callback targets exposed as declarations; conditional content selection remains intact.       |

Each new policy has parser-based tests that edit representative source, compare the actual immediate injection ownership against tracked ranges, restore the original source and reject structural characters. Package allowlists include the policy modules and tests. Existing suites continue to cover language selection, grammar replacement, malformed input and package lifecycle behavior.

The other 57 repositories retain their existing source. Most have no embedded indentation language, only TODO/link annotations, or same-language rules already covered by the root filter.

Remaining exact contexts include Ruby and Crystal heredocs and PHP's synthetic/heredoc regions, where the bounded line context cannot prove that a header-dependent terminator or ownership rule remains unchanged. Crystal and PHP receive only the fixed-target declaration changes listed above; their semantic content callbacks remain intact. Policies likewise do not bypass an opaque child indentation query merely because a parent can prove stable boundaries.

## Core contract

Core now follows literal callback language targets in its conservative grammar graph. Fixed annotations with no indentation query anywhere in their possible descendant graph do not block cached ownership. Callback providers that can affect indentation must declare a named policy, and all such policies must approve the candidate edit.

An injected grammar with an explicit indentation query owns the first text on its row, including when that query is deliberately empty. Its rejection filter can therefore work independently of opaque parent rules. When no child owns indentation, the parent's filter must reject the candidate too. Policies remain bounded to single-line interior edits; source holes, range boundaries, unsupported overlap, target-owned content filters and stale revisions fall back to preparation. Grammar changes and worker recovery invalidate the cache. These decisions preserve one publication of text, indentation and selections, without a later whitespace correction.

## Validation and latency

The changed language packages passed 801 specs across 21 isolated package runs. The 21 new policy fixtures also passed independently in both native and worker execution across all 15 policy packages. They obtain ownership data through `editor.analyzeSyntax`, keeping syntax handles inside the parser owner. Markdown and CoffeeScript additionally passed their complete worker suites (38 and 28 specs). Every policy package now runs worker validation in CI. API documentation, lint and formatting checks passed, and all 21 dry-run package manifests include the required licenses, policy modules, analysis helpers and tests.

Core passed 429 Tree-sitter runtime tests, 90 atomic-input, static-injection, prepared-paste and indentation-cancellation specs, and 10 highlight-configuration specs. Windows CI exposed an existing clock-ordering bug: checking the time before establishing a deadline could admit work with zero remaining budget. The scheduler now establishes the deadline first and checks the current time afterwards. A deterministic advancing-clock regression covers both zero allowance and expiry between clock reads; the original deferred-highlight assertion remains intact.

A normal development window with 247 active packages received 30 real CDP keydown/keyup pairs per case, approximately 50 ms apart, inside the `sampleword` token used by the package fixtures. Electron was 45.2.2 and Node was 24.22.2 on Windows. Times below run from the DOM keydown to the editor's insertion notification, including asynchronous input queuing if any. They are a single sequential diagnostic run on a workstation in ordinary use, not quiet-machine latency guarantees.

| Context            | Median |    p95 | Maximum |
| ------------------ | -----: | -----: | ------: |
| CSS root           | 1.5 ms | 2.5 ms | 55.0 ms |
| CSS in HTML        | 1.3 ms | 2.4 ms |  6.6 ms |
| CSS in JavaScript  | 1.5 ms | 2.6 ms |  5.2 ms |
| CSS in Vue         | 1.5 ms | 2.5 ms |  5.5 ms |
| Python root        | 1.4 ms | 2.2 ms |  2.4 ms |
| Python in Markdown | 1.5 ms | 2.5 ms |  4.4 ms |
| Python in IPython  | 1.5 ms | 2.4 ms |  4.4 ms |

The initial CSS control includes a cold outlier, retained in the table. Steady medians and p95 values show comparable root and injected typing for these eligible edits. A later check after the scheduler fix was more variable: medians were 1.7–2.6 ms, p95 values were 9.0–37.0 ms and the initial CSS control reached 286.4 ms. Both series are retained in the result artifact; this variation is why these measurements do not claim absolute latency guarantees or equivalence for every language, structural edit, nested injection or first cold parse. The first series' summary, later raw samples, diagnostic scripts, pack manifests and per-package logs remain in the workspace's `.dev/ipy-typing-20261104` directory. No private source document is included in the fleet artifact.
