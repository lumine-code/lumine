# IPython typing latency

Typing in an indented Python statement inside an IPython document could queue each character behind speculative indentation. Python's conservative typing filter rejects ordinary identifier and string edits, but IPython's possible injection graph includes languages with dynamic or unknown indentation rules. Its document-wide filter therefore cannot make the same rejection, even when the current row contains ordinary Python.

The indentation worker now forks the current immutable text without waiting for the parent document's complete syntax publication. It reuses a current root tree when available and otherwise parses the candidate source independently. After parsing that prospective root, it checks the actual static injections around the requested edited rows. If the root and every possible descendant of those local injection grammars prove that the new row cannot trigger indentation, it avoids parsing the embedded document. Unknown rules, callback injections, actual dedent triggers, multiline indentation, more than 128 requested rows and rows longer than 4096 characters keep the complete path. A failed local proof repeats full discovery, including distant members of combined injections.

The live editor still publishes text, indentation and selections together. This change does not insert the character first and adjust whitespace later. Enter, closing delimiters, undo, redo and cancellation retain the prepared-edit contract.

## Measurement

Measured on Windows on November 4, 2026 with Electron 45.2.2, Node 24.22.2 and 247 active packages, using an isolated development profile with the maintainer's configuration and workspace package links. The private input contained 2326 lines and 83571 bytes. Each case sent 40 real CDP keydown/keyup pairs with approximately 100 ms between characters at line 1777, once inside a string and once after the trailing comma. Input was restored in memory and never saved. The baseline editor revision was `07d8eddb0e`; the candidate is the implementation accompanying this report.

| Keydown to text insertion | Baseline median | Candidate median | Baseline p95 | Candidate p95 | Baseline maximum | Candidate maximum |
| ------------------------- | --------------: | ---------------: | -----------: | ------------: | ---------------: | ----------------: |
| Inside the string         |       1538.1 ms |          19.6 ms |    2919.6 ms |       65.3 ms |        2989.9 ms |           70.9 ms |
| After the comma           |       1357.2 ms |          17.9 ms |    2497.4 ms |       36.0 ms |        2563.5 ms |           40.9 ms |

An independent candidate run measured medians of 17.2 and 18.2 ms. Switching the same file to Python measured medians of 1.7 and 1.5 ms: IPython still pays for the prospective root and the worker round trip, so this is not parity with Python's synchronous rejection filter. The final candidate's next-animation-frame medians were 28.1 and 37.8 ms; these observations include scheduling but do not measure compositor presentation on the physical display. The workstation remained in ordinary use, so these are diagnostic comparisons rather than quiet-machine latency guarantees.

Short alternating insert/backspace probes initially concealed the cumulative input queue. CDP command completion was also much faster than insertion: the handler could finish while its prepared edit still waited. The comparison above measures the editor's insertion notification from the original DOM keydown, including that queue.

Local CPU profiles, raw input/frame samples and diagnostic scripts remain under `.dev/ipy-typing-20261104` in the workspace. The private source and its filesystem path are not included in this repository.

## Validation

The Tree-sitter runtime suite passed 419 tests. The atomic-input, prepared-paste and indentation-cancellation suites passed 68 specs. New coverage compares optimized IPython indentation with full preparation for string edits, comma suffixes, closing delimiters, dedent keywords, Enter and embedded HTML; checks that no-op edits avoid parsing the combined Python injection; verifies that forks do not wait for parent syntax or reuse stale root trees; and observes a single atomic publication plus exact undo/redo for IPython text and dedentation. ESLint and formatting checks passed for the changed files.
