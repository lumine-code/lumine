# Large document performance validation — 2026-10-26

The [accompanying results](large-document-2026-10-26.json) summarize one acceptance run on the provided **512.7 MiB document: 537,602,502 UTF-16 units and 12,530,436 lines**. Input SHA-256: `75b5fa9b37d8089ec4040497fe2a4512ce810b7e3f56290727e3a3745d124c43`. The input's file statistics and decoded-text hash remained unchanged. Every Enter series was undone and checked against the exact initial snapshot.

The normal Windows renderer ran in a fresh isolated profile, with None grammar, true unwrapped projection, 53 active packages, Electron 45.0.0 and Chromium 156.0.8078.48. CI timing overrides and the spec renderer were absent. The measured sources were clean and unchanged during the run: Lumine `5f5f444657837708300542dcd29bb4f39a115799`, search-panel `53339d2c1e1353a6f6caa5a45a8008a99b57e5c1`, and line-ending `8a2f7305f0a14e194d043618d2641e6dcfa79618`. Full source fingerprints are preserved in the JSON; later commits and dependency repins are not implicitly measured by this run.

## Navigation and input

Editor loading took **3,504.4 ms**. The first Ctrl+End took **2.6 ms of command dispatch**, **20.2 ms to the next RAF callback**, and **31.2 ms to the harness's settled-view checkpoint**. Dispatch time alone is not the complete visual response time.

Thirty Enter commands were issued at each location, spaced 33.33 ms apart through the normal command dispatcher.

| Location | Command median | Command p95 | Command maximum | Input-to-next-RAF median |
| -------- | -------------: | ----------: | --------------: | -----------------------: |
| Start    |         0.7 ms |      1.5 ms |          5.6 ms |                  10.3 ms |
| Middle   |         0.6 ms |      0.8 ms |          0.9 ms |                   9.8 ms |
| End      |         0.5 ms |      0.6 ms |          0.8 ms |                   9.7 ms |

RAF interval p95 was **8.4 ms** in each Enter series, with maxima of 8.4–8.5 ms and no observed long tasks. These callbacks indicate approximately 120 Hz scheduling, not physical display presentation. Counts above exactly 8.33 ms must not be treated as dropped frames: timestamp rounding naturally produces alternating 8.3 and 8.4 ms intervals.

## Search and correctness

These are **core search-session timings in the renderer**, not search-panel widget latency. “First progress” is the first count update containing a match.

| Query class | Complete count | First positive progress | Complete count time |
| ----------- | -------------: | ----------------------: | ------------------: |
| Sparse      |             64 |                  0.9 ms |            303.2 ms |
| Dense       |     83,887,552 |                  0.2 ms |          1,863.6 ms |

Cancelling the dense query after its first progress update completed in **1.3 ms** with `AbortError`; the partial count remained explicitly incomplete. Search did not change the document.

The logical document height was **263,140,387 px**. CSS containers stayed at or below **1,000,000 px**, and the native vertical scrollbar stayed at **16,000,000 px**. Checks passed for visible glyphs and gutter rows, visible IME anchoring, and cursor → pixels → cursor round trips. Huge single-line horizontal windows and shaped Unicode transitions are covered by separate renderer tests; this acceptance input primarily exercises millions of short lines.

## Scope of the measurement

The actual viewport was **617 × 1294 px**, with the default Fira Code font stack at **14 px**, DPR 1. The requested native window resize was unavailable, so this is not a controlled 1280 × 900 run. Opening was cold for the editor and process; operating-system disk caches were not flushed. Hashing and exact undo verification were outside command samples. Renderer RSS snapshots were approximately 1.89–1.92 GB; they are neither a measured peak nor a post-close reclamation test.

The original diagnosis used 245 active packages and retained the 500-column safety wrap even when the soft-wrap preference was off. This run uses 53 packages and the new truly unwrapped policy. It demonstrates the repaired behavior on the identical input, but does not establish a controlled speedup ratio. Explicit wrapping has different layout costs. Pixels in unmounted portions of very long lines remain estimates until rendered; assertions here concern mounted glyphs. Regex limits and cross-platform correctness are documented and tested separately.

For reproduction, see [the benchmark instructions](../large-document-benchmark.md) and [the document architecture](../../docs/large-document-editing.md). The JSON omits input paths, document text and search-expression text; profile directories are local runtime state and should not be published.
