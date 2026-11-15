# Input responsiveness and language fleet validation

The follow-up to [multicursor input planning](multicursor-input-performance-2026-11-15.md) exercises continuous Enter–text–Backspace input, conservative ownership verification and the complete working language fleet. It found two input-ordering bugs and a scheduling defect at the compact transport boundary. The fixes do not change parser, query or memory budgets, and require no grammar or parser rebuild.

## Corrections

Inline multicursor insertion now returns its indentation completion promise when preparation is asynchronous. Previously, the UI queue accepted the following text or Backspace against the raw newline, invalidating its unfinished indentation. Deterministic Python, quoted IPython and root-range cases failed before the correction and pass in both backends afterward.

An asynchronous cancellation or failure now cancels input already waiting behind that operation. Previously, cancelling Enter by independently moving the cursor could replay queued text at the new cursor. Fresh input after the cancelled sequence drains still uses the current cursor, and preparation failures remain observable.

Interactive purpose now belongs to the private syntax session, independently of compact or streamed transport. Its priority lease spans fork, initialization and acknowledged result packets, and ends on release, cancellation or failure. Previously, crossing 128 changes dropped both parser priority and the presentation barrier. Optional syntax presentation queries repeatedly overtook the input plan. Paste retains its ordinary scheduling policy. The compact limits remain 128 changes, 128 rows and 65536 inserted UTF-16 units.

The implementation is [`7d2351c4151fcb23433033209d4761fac463254c`](https://github.com/lumine-code/lumine/commit/7d2351c4151fcb23433033209d4761fac463254c), following the inline and cancellation fixes in `9aad6b8062503ba27fdac97258e2b1dcee7c5ac9` and `e5d3486cfe5cf996dd0fe8f794659bb04e00a9fe`. The timing comparison below isolates the priority correction: both compared revisions already contain the two ordering fixes.

## Measured latency

Both revisions used the same committed benchmark and public synthetic fixtures, identical current Python/IPython packages, installed dependencies and Windows machine. Each case ran in a fresh Electron process and profile, with one warmup and two measured samples. Values are milliseconds, reported as warm medians; two samples do not establish tail percentiles. The baseline source is an exact archive of `e5d3486cfe5cf996dd0fe8f794659bb04e00a9fe`, and the final source is an exact archive of `7d2351c4151fcb23433033209d4761fac463254c`.

| 500 KiB, 129 cursors               | Publication before | Publication after | Speedup | Final command completion | Final parent settlement |
| ---------------------------------- | -----------------: | ----------------: | ------: | -----------------------: | ----------------------: |
| IPython, quoted bodies             |             2409.9 |             325.7 |    7.4× |                    340.1 |                   569.6 |
| IPython, commented bodies          |             2496.0 |             343.4 |    7.3× |                    358.3 |                   600.6 |
| Python, opaque root-range provider |             1756.4 |             297.5 |    5.9× |                    312.8 |                   524.9 |

With two cursors in 500 KiB, final warm publication medians were 12.8 ms for Python, 13.3 ms for ordinary IPython, 56.4 ms for quoted IPython and 48.9 ms for commented IPython. Quoted IPython with 32 cursors took 86.9 ms. Conservative ownership verification still has a measurable parsing cost.

A separate diagnostic attached the same visible editor before collecting runtime counters. Quoted IPython at 128 and 129 cursors used similar native parse CPU, about 299 and 289 ms before the fix. At 129 cursors, optional `paint-query` operations increased from four to 62 and consumed about 1261 ms of synchronous worker time. After the fix the 129-cursor case used four such queries and about 65 ms. These are syntax presentation query counts, not displayed frames. Node Inspector was unavailable in the Electron worker; the diagnostic explicitly used runtime counters and does not claim a sampled CPU profile. Diagnostic timings are excluded from the acceptance measurements.

## Continuous input and visible frames

Each burst schedules Enter, literal `xy` and Backspace through the actual UI input dispatcher; Backspace leaves `x`. Arrivals never await preceding commands or syntax settlement. Ten cycles schedule 30 operations with target 16 ms intervals; actual enqueue timestamps and event-loop delays remain in the report. The final model, every publication snapshot, cursor positions and every undo/redo state are checked against a separate string oracle outside the timings.

| 500 KiB burst               | Cycles | Final command completion | Maximum queue wait |
| --------------------------- | -----: | -----------------------: | -----------------: |
| Python, two cursors         |     10 |                   1174.5 |              722.9 |
| IPython, two cursors        |     10 |                    699.3 |              273.9 |
| Quoted IPython, two cursors |     10 |                   1839.5 |             1383.0 |
| IPython, 128 cursors        |     10 |                   4507.4 |             4036.2 |

The scheduling cliff is fixed; continuous input can still accumulate a substantial queue. Each subsequent Enter may need the updated parent syntax after intervening token changes. These stress results do not support a claim that all interactive latency is solved.

Frame cases run in a normal visible application after its full window-loaded event, with `CI` unset. They use Electron frame subscription and a revision marker changed only after the final model, cursor positions and actual visible editor line agree. Calibration records observed capture cadence and bounded renderer/main clock comparisons. The timed path does not force an editor update. This measures invocation to an observed composited frame, including capture/copy/delivery overhead; it cannot establish physical monitor scanout or the first display presentation.

| Visible application, 500 KiB                    | First publication | Command completion | Observed composited frame |
| ----------------------------------------------- | ----------------: | -----------------: | ------------------------: |
| Python, two cursors, one Enter                  |              15.7 |               16.6 |                      39.6 |
| Quoted IPython, two cursors, one Enter          |              72.3 |               73.3 |                      97.2 |
| Quoted IPython, two cursors, three burst cycles |              60.4 |              479.4 |                     568.2 |
| IPython, 128 cursors, three burst cycles        |             142.0 |             1315.5 |                    1332.7 |

The 16 final processes completed 48 trials, including 32 measured trials, 444 validated publications and 12 visible frame observations. All exact text, cursor, publication and history checks passed. The quoted-IPython ten-cycle process emitted eight `recycle-requested` events, compared with seven before the priority correction; no operation failed or cancelled. The resource policy latches that flag after observing substantial pool growth, and subsequent session releases can repeat the request. Eight events do not mean eight restarts or eight memory-pressure failures. The service waits for idle before recycling. The benchmark detaches its observer before editor teardown, so these measurements do not prove subsequent idle recycling or a long-session memory plateau. These requests remain in the raw reports; neither a memory leak nor leak-free long-session behavior is established here.

## Language fleet

The local ecosystem tool now provides `lem grammar --check-input`. It classifies every active Tree-sitter descriptor and runs inline and actual worker input against working package sources. Missing classifications, missing semantic fixtures, missing required query owners, indentation owners in a `none` fixture, skipped descriptors, wrong source paths or changed source fingerprints fail the audit. Named host injections must actually be present; a hidden grammar exercised as a root is not counted as host coverage.

The final run passed 325 specs: 162 fixtures in both backends plus the inventory guard, covering 120 descriptors in the 78-package language fleet. Seventy-five descriptors declare their own indentation query; six others are classified as injected and 39 have no active indentation-query owner in these fixtures. These classifications describe the audit cases, not every possible embedding a grammar supports. Thirty-two fixtures have authored indentation expectations, and 18 demonstrate named host injections. Every fixture checks each cursor alone, combined and reversed cursor order, settled operations, the equivalent queued burst and exact undo/redo. No parser/query execution failure or resource event occurred.

Generic cases reuse authored symbol sources and prove backend and queue parity rather than full language semantics. Forty-nine fixtures repeat a source with a single nonblank line to obtain two anchors. Fourteen fixture forests initially report `hasError=true`, including deliberately repeated JSON/XML and hidden fragments; parsing and query execution still complete, and these cases provide recovery/parity coverage. Their flags remain in the receipt. The test fixture corrections preserve Blade's own markup tree and locate PHPDoc under the actual PHP HTML wrapper.

The separate parser check accepted all 109 distributed WASMs inside the supported ABI 13–15 window and with the shared CLI pin. Query validation passed 165 specs, covering all 120 working descriptors, 43 bundled descriptors and two inventory guards. The input audit and its fixtures are maintained locally in `lem`, which is not pushed.

All 78 language packages also passed their own suites on Windows with inline syntax selected by default in fresh isolated profiles against the current editor and working package sources: 2380 package specs plus 78 source-provenance guards, 2458 total, with zero failures or pending specs. The separate 325-spec input audit covers both backends. The package run used two independent processes at a time, no retries, and unchanged hashes for the editor, grammars and 83 available package sources. Resource-only `language-source` is included even though it contributes no Tree-sitter descriptor.

## Other validation

At the implementation revision, all 610 Tree-sitter runtime tests, 263 document-core tests, 150 focused input/editor specs and 22 worker integration specs passed. Full lint, formatting, API documentation and bundled dependency checks passed; `npm audit --omit=dev` reported zero vulnerabilities. The full-fleet capture check reported zero errors and four non-failing naming warnings on unchanged generic text scopes, including bundled/working duplicates.

The full editor, bundled-package, runtime and worker input checks passed on Windows, macOS and Ubuntu in [CI for the exact implementation revision](https://github.com/lumine-code/lumine/actions/runs/43665014147). The complete 78-package working-source run and its timings were local Windows checks; this CI matrix validates the editor and its bundled/spec-package set, not every unbundled grammar's working tree on all three systems.

## Reproduction and provenance

After stopping other local tests and benchmarks, set `LUMINE_PERF_QUIET_WINDOW=1` and run `npm run benchmark:multicursor-input` with `--case`, `--mode newline|burst`, `--cycles`, `--interval`, `--samples`, `--warmups`, `--capture 0|1`, `--output`, and optional `--source` / `--revision` / `--package-root`. The launcher rejects dirty measured checkouts and existing output directories. Every report includes source, grammar and harness fingerprints, operation queue timestamps, publication hashes, history checks and resource events. Accepted runs do not patch parser, query, scheduler or resource-policy methods or configuration. Frame measurements add the documented renderer hook, marker and verification overhead.

The [machine-readable comparison](../benchmark/results/input-responsiveness-2026-11-15.json) retains sample arrays, queue statistics, resource requests and the verified receipts. Both measurement sets share benchmark SHA-256 `e89e3357989139d9519ec9be72a4a3cac04857180ee5425beba61088aca269b7`, fixture generator `a35e60736b50d80559df7ebf8dc9352bb323fb9afdf3e0b8f6083be510889f25` and grammar aggregate `adf5b33a6223cd4c572a7ab9630d3e94fbd4bda874d064feb06cb3ffa8590f8a`. The 32 original fixture source/output/cursor fingerprints remain unchanged and are protected by six Node oracle tests. Files larger than 500 KiB, cold input before initial parsing, longer sessions and cross-platform timing remain outside these measurements; cross-platform correctness is covered separately by CI.
