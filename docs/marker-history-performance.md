# Marker history performance

Historical measurements from 2026-10-17, before the JavaScript text-model migration. The implementation description and validation counts below refer to that revision. The current marker index is JavaScript; see [JavaScript document core](javascript-document-core.md).

Marker history snapshots share unchanged range and property blocks instead of copying every marker at both ends of each transaction.

## Implementation

`MarkerHistoryMap` keeps the live state in an ordinary JavaScript Map and partitions snapshot references into blocks of 128 marker ids. Taking a snapshot shares the block directory. The first subsequent write copies that directory, and each changed block is copied once before the next snapshot. Range entries are replaced rather than mutated, and property records remain shared when only a marker's coordinates change. Snapshots retain no parent-version chain.

At the measured revision, the native MarkerIndex remained authoritative. Its mutations, invalidation semantics, public marker identity, callbacks and serialized history format are unchanged. Snapshot materialization is deferred until undo, redo, restoration or serialization needs it. Enabling `LUMINE_VERIFY_MARKER_SNAPSHOTS=1` compares snapshots with an eager native index dump; this correctness instrumentation must remain disabled during timing runs.

This is not a constant-time edit algorithm. Coordinate-changing edits still walk the live marker ranges, and a newline before many markers updates all affected ranges. The first write after a snapshot copies the block directory, whose size depends on the marker-id distribution. The extra live Map and block directory retain references to the same values; they trade a small amount of live bookkeeping for substantially less repeated snapshot allocation.

## Measurement method

The October 17, 2026 comparison uses frozen editor source based on `200598247a0ae40f5e0bf1998b44f7fe77bc0aa7` and the implementation recorded in `1d2cabb682f6618c5bee8a6652c8cb11fe73c2a1`. It runs on Windows x64, Node 24.18.0 and an Intel Core i9-10900K. Both variants use the same frozen Superstring Release binary. Eight fresh Node processes run in baseline, candidate, candidate, baseline, candidate, baseline, baseline, candidate order. Each case has five warmups and fifteen measured samples per process, giving sixty measured samples per variant. Source, benchmark and native binary SHA-256 values are retained with the results.

Every timing sample prepares a fresh buffer, markers and a retained checkpoint before explicit garbage collection. Fixture setup, garbage collection, assertions, undo verification and destruction are outside timing. Buffer cases include history-disabled controls, untouched and touched markers, same-row column shifts and newline row shifts. Editor model cases use actual TextEditor selections and folds with a populated display index; they include synchronous model notifications but exclude parser work, DOM updates and painting. These are Windows workstation measurements, not cross-platform or input-to-paint guarantees.

Retained-memory cases separately measure the change in JavaScript heap usage after forty ungrouped edits and garbage collection. Both ordinary inserts and newlines are measured, then all forty edits are undone and the restored text and marker snapshot are checked. Heap deltas exclude native allocations not reported in the JavaScript heap and are not process RSS measurements.

## Results

| Operation                                 | Baseline median (ms) | Candidate median (ms) | Baseline p95 (ms) | Candidate p95 (ms) |
| ----------------------------------------- | -------------------: | --------------------: | ----------------: | -----------------: |
| Snapshot, 10000 markers                   |                1.695 |                 0.005 |             2.309 |              0.010 |
| Equal-extent edit before 10000 markers    |                3.242 |                 0.219 |             3.998 |              0.425 |
| Insert before 10000 markers on later rows |                3.530 |                 0.535 |             4.370 |              0.753 |
| Newline before 10000 markers              |                3.507 |                 1.746 |             4.055 |              2.203 |
| Insert shifting 10000 same-row markers    |                3.560 |                 1.766 |             4.189 |              2.301 |
| Editor model, 1000 folds                  |                0.846 |                 0.600 |             1.064 |              0.917 |
| Editor model, 100 cursors                 |               10.625 |                10.958 |            12.538 |             12.201 |
| Editor model, 1000 cursors                |              129.390 |               127.592 |           140.323 |            136.528 |

All marker rows above maintain history. History-disabled and empty-layer controls are retained in the report. None of the 39 cases increased its median or p95 by both more than 5% and more than 0.5 ms. This threshold does not mean every operation improved: the 100-cursor median increased by 0.333 ms, and the empty snapshot increased from about 0.002 to 0.004 ms. The model results do not support claiming a multicursor speedup.

With 10000 markers, forty ordinary inserts before markers on later rows retained approximately 161.56 MiB of additional JavaScript heap in the baseline. Candidate deltas ranged from -13672 to 40752 bytes across the four processes, within the noise of this heap-difference probe; they do not mean history needs no memory. For forty newlines, which move all marker ranges, the corresponding deltas were approximately 161.64 MiB and 56.89 MiB. These are separate retained-memory workloads, not the allocation totals of the timing cases.

The [raw comparison](../benchmark/results/marker-history-2026-10-17.json) retains all timing samples, process medians, heap deltas and source/binary hashes. Frozen checkouts, individual process reports and exploratory variants remain locally under `.dev/benchmarks/marker-history/2026-10-17` at the workspace root.

## Correctness

The initial implementation passed 1026 local buffer, display-layer, selection and editor specs with eager snapshot verification enabled. After the live-iterator correction, 161 focused marker, custom tracking, display-marker, fold and shared-layout specs passed with the same verification enabled. Added cases retain snapshots across property updates, explicit range changes, destruction, clearing and restoration, and across deterministic text edits, undo/redo and nested transaction aborts. Every benchmark edit checks resulting text, undo and native snapshot agreement; editor model cases also check restored selections and fold counts. Local validation used Electron 44.9.0 and did not set `CI`.

## Reproduction

Run the same benchmark file against separately frozen sources in fresh processes. Use `--filter` to select case ids, `--counts` to change the raw marker counts, and `--models` to include the editor model cases. The memory probe is optional.

```sh
node --expose-gc benchmark/marker-history-benchmark.js --source /path/to/baseline --models --samples 15 --warmups 5 --memory-edits 40 --output before.json
node --expose-gc benchmark/marker-history-benchmark.js --source /path/to/candidate --models --samples 15 --warmups 5 --memory-edits 40 --output after.json
```

The first exploratory implementation iterated the snapshot blocks through a generator on every edit. It reduced snapshot allocations but regressed the 1000-cursor model case. An instrumented diagnostic traced the additional work to the shadow-range iteration. The final implementation retains the live Map's native iterator; the exploratory measurements are preserved separately and are not pooled into the final comparison.
