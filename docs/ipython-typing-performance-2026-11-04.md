# IPython typing latency

Typing in an indented Python statement inside an IPython document could queue each character behind speculative indentation. Python's conservative typing filter rejects ordinary identifier and string edits, but IPython's possible injection graph includes languages with dynamic or unknown indentation rules. Its document-wide filter therefore cannot make the same rejection, even when the current row contains ordinary Python.

Core now provides the [stable content edit contract](tree-sitter-grammars.md#stable-content-edits). The worker publishes revisioned injection ownership and the child's typing-indentation rules. A parent-owned policy proves which edits preserve that ownership, allowing core to use the same synchronous rejection filter as a root language. Safe edits rebase the cached context before subsequent input; structural edits, stale revisions, grammar changes and unsupported contexts discard it. Core contains no IPython-specific routing. The IPython package implements a bounded lexical policy for ordinary word edits, preserving string-prefix flags and rejecting magics, structural characters and uncertain prefixes.

When exact preparation remains necessary, the indentation worker forks the current immutable text without waiting for the parent document's complete syntax publication. After parsing the prospective root, it checks the actual static injections around the requested edited rows before parsing embedded documents. A failed local proof retains full discovery, including distant members of combined injections. This fallback also benefits grammars without a content edit policy.

The live editor still publishes text, indentation and selections together. This change does not insert the character first and adjust whitespace later. Enter, closing delimiters, undo, redo and cancellation retain the prepared-edit contract.

## Measurement

Measured on Windows on November 4, 2026 with Electron 45.2.2, Node 24.22.2 and 247 active packages, using an isolated development profile with the maintainer's configuration and workspace package links. The private input contained 2326 lines and 83571 bytes. Each case sent 40 real CDP keydown/keyup pairs with approximately 100 ms between characters at line 1777, once inside a string and once after the trailing comma. Input was restored in memory and never saved. The baseline editor revision was `07d8eddb0e`; the candidate is the implementation accompanying this report.

| Keydown to text insertion | Baseline median | Candidate median | Baseline p95 | Candidate p95 | Baseline maximum | Candidate maximum |
| ------------------------- | --------------: | ---------------: | -----------: | ------------: | ---------------: | ----------------: |
| Inside the string         |       1538.1 ms |           1.6 ms |    2919.6 ms |        2.9 ms |        2989.9 ms |           16.9 ms |
| After the comma           |       1357.2 ms |           1.3 ms |    2497.4 ms |        2.3 ms |        2563.5 ms |            2.6 ms |

An independent API candidate run measured medians of 1.8 and 1.3 ms. Switching the same file to Python measured medians of 1.7 and 1.5 ms: ordinary typing in these injected contexts now has comparable latency to root Python. Structural edits still retain exact preparation, so this is not a claim about every editing operation or every injection grammar. The final candidate's next-animation-frame medians were 8.4 and 21.1 ms; these observations include scheduling but do not measure compositor presentation on the physical display. The workstation remained in ordinary use, so these are diagnostic comparisons rather than quiet-machine latency guarantees.

Short alternating insert/backspace probes initially concealed the cumulative input queue. CDP command completion was also much faster than insertion: the handler could finish while its prepared edit still waited. The comparison above measures the editor's insertion notification from the original DOM keydown, including that queue.

Local CPU profiles, raw input/frame samples and diagnostic scripts remain under `.dev/ipy-typing-20261104` in the workspace. The private source and its filesystem path are not included in this repository.

## Validation

The Tree-sitter runtime suite passed 427 tests. The atomic-input and static-injection suites passed 48 specs; the earlier atomic-input, prepared-paste and indentation-cancellation validation passed 68 specs. The complete IPython suite passed 144 specs, including repeated parser comparisons for hundreds of admitted word edits. New coverage checks exact fallback indentation, uninterrupted synchronous typing before worker settlement, ownership rebasing, boundary and hole rejection, missing providers, asynchronous policy rejection, parent-fork independence and single-publication undo/redo. ESLint and formatting checks passed for the changed files.
