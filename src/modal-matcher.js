"use strict";

const fuzzyMatcher = require("./fuzzy-matcher");

// Matcher normalization and the fuzzy implementation for the modal kernel.
//
// Two facts about `@lumine-code/fuzzy-native` drive the design here, both
// verified against its C++ source:
//
//   1. An EMPTY query scores every candidate exactly 1.0 (`MatcherBase.cpp`
//      `if (query == "") score = 1`), and candidates are deliberately SHUFFLED
//      on insert. Capping an empty-query match therefore returns a random
//      subset in random order. The empty query bypasses the matcher entirely.
//   2. `setCandidates` runs `clear()` and re-adds every candidate with
//      `last_match = true`, so the incremental memo cannot leak across a
//      candidate swap. No throwaway priming match is needed. What is NOT
//      re-passed on that path is the construction-time option bag, so a change
//      to `ignoreDiacritics` must build a fresh native matcher.

const DEFAULT_ALGORITHM = "command-t";

function fieldsFrom(opts) {
  if (opts.fields && opts.fields.length) return opts.fields;
  return [{ name: "label", get: (entry) => entry.text }];
}

// Joins field texts with a single space and records where each field starts, so
// per-field highlight offsets can be recovered from one match over the joined
// haystack. Joining is the default because real queries straddle fields
// ("remote main" = label + detail, "fold editor" = name + description).
function joinFields(entry, fields) {
  if (fields.length === 1) {
    const text = fields[0].get(entry) ?? "";
    return { text: String(text), map: [{ name: fields[0].name, start: 0, length: text.length }] };
  }
  const map = [];
  const parts = [];
  let cursor = 0;
  for (const field of fields) {
    if (field.filter === false) continue;
    const text = String(field.get(entry) ?? "");
    map.push({ name: field.name, start: cursor, length: text.length });
    parts.push(text);
    cursor += text.length + 1;
  }
  return { text: parts.join(" "), map };
}

function splitOffsets(offsets, map) {
  const highlights = {};
  if (!offsets || offsets.length === 0) return highlights;
  for (const segment of map) {
    const end = segment.start + segment.length;
    const local = [];
    for (const offset of offsets) {
      if (offset >= segment.start && offset < end) local.push(offset - segment.start);
    }
    if (local.length) highlights[segment.name] = local;
  }
  return highlights;
}

class FuzzyMatcher {
  constructor(opts = {}) {
    this.opts = opts;
    this.fields = fieldsFrom(opts);
    this.combine = opts.combine === "max" ? "max" : "joined";
    this.ignoreDiacritics = opts.ignoreDiacritics !== false;
    this.algorithm = opts.algorithm || DEFAULT_ALGORITHM;
    this.maxResults = opts.maxResults ?? Infinity;
    this.native = null;
    this.nativeByField = null;
    this.entries = [];
    this.maps = [];
  }

  setItems(entries) {
    this.entries = entries;
    if (this.combine === "joined") {
      const candidates = new Array(entries.length);
      this.maps = new Array(entries.length);
      for (let i = 0; i < entries.length; i++) {
        const joined = joinFields(entries[i], this.fields);
        candidates[i] = joined.text;
        this.maps[i] = joined.map;
      }
      this.native = this.refreshNative(this.native, candidates);
    } else {
      this.nativeByField = this.fields
        .filter((field) => field.filter !== false)
        .map((field, index) => {
          const candidates = entries.map((entry) => String(field.get(entry) ?? ""));
          const previous = this.nativeByField ? this.nativeByField[index] : null;
          return {
            field,
            matcher: this.refreshNative(previous ? previous.matcher : null, candidates),
          };
        });
    }
  }

  // Reuses a native matcher when possible. `ignoreDiacritics` is fixed at
  // construction, so it is captured on the instance and a change rebuilds.
  refreshNative(existing, candidates) {
    if (existing && existing._ignoreDiacritics === this.ignoreDiacritics) {
      fuzzyMatcher.setCandidates(existing, candidates);
      return existing;
    }
    const matcher = fuzzyMatcher.setCandidates(candidates, {
      ignoreDiacritics: this.ignoreDiacritics,
    });
    matcher._ignoreDiacritics = this.ignoreDiacritics;
    return matcher;
  }

  matchOptions() {
    const options = { algorithm: this.algorithm, recordMatchIndexes: false };
    if (this.opts.maxGap !== undefined) options.maxGap = this.opts.maxGap;
    return options;
  }

  match(query) {
    const text = query.text ?? "";
    const results = text.length === 0 ? this.matchAll() : this.matchQuery(text);

    if (this.opts.scoreModifier) {
      for (const result of results) {
        result.score = this.opts.scoreModifier(result.entry.item, result.score, { query });
      }
    }

    let filtered = this.opts.scoreModifier ? results.filter((r) => r.score > 0) : results;

    if (this.opts.order) {
      filtered = filtered.slice().sort((a, b) => this.opts.order(a, b, query));
    } else if (text.length > 0 || this.opts.scoreModifier) {
      filtered = filtered.slice().sort((a, b) => b.score - a.score);
    }

    // An empty query returns everything in source order: capping it would slice
    // a shuffled tie (see the header note).
    if (text.length > 0 && this.maxResults !== Infinity) {
      filtered = filtered.slice(0, this.maxResults);
    }
    return filtered;
  }

  matchAll() {
    return this.entries.map((entry, index) => ({ entry, index, score: 1, highlights: null }));
  }

  // Whitespace separates independent terms, all of which must match (fzf and
  // VS Code both work this way). Fuzzy matching is an ORDERED subsequence, so
  // without this "remote main" could never find "main — Remote branch": only
  // the order the fields happen to be joined in would work.
  tokenize(text) {
    return text.split(/\s+/).filter(Boolean);
  }

  matchQuery(text) {
    if (this.combine === "joined") {
      if (!this.native) return [];
      return this.matchTokens(this.native, this.tokenize(text));
    }

    const tokens = this.tokenize(text);
    const best = new Map();
    for (const { field, matcher } of this.nativeByField ?? []) {
      const weight = field.weight ?? 1;
      for (const hit of this.matchTokens(matcher, tokens)) {
        if (hit.score <= 0) continue;
        const score = hit.score * weight;
        const previous = best.get(hit.id);
        if (!previous || score > previous.score) {
          best.set(hit.id, {
            entry: this.entries[hit.id],
            index: hit.id,
            score,
            field: field.name,
          });
        }
      }
    }
    return Array.from(best.values()).filter((r) => r.entry);
  }

  // Runs one native pass per term and keeps only candidates every term hit.
  // The single-term case — overwhelmingly the common one — is a plain
  // passthrough with no intersection work.
  matchTokens(matcher, tokens) {
    if (tokens.length === 0) {
      return this.entries.map((entry, index) => ({ entry, index, score: 1, id: index }));
    }

    const options = this.matchOptions();
    let surviving = null;
    const scores = new Map();

    for (const token of tokens) {
      const hits = matcher.match(token, options);
      const round = new Map();
      for (const hit of hits) {
        if (hit.score <= 0) continue;
        if (surviving && !surviving.has(hit.id)) continue;
        round.set(hit.id, hit.score);
      }
      if (round.size === 0) return [];
      for (const [id, score] of round) {
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
      surviving = new Set(round.keys());
    }

    const results = [];
    for (const id of surviving) {
      const entry = this.entries[id];
      if (!entry) continue;
      results.push({ entry, index: id, id, score: scores.get(id) / tokens.length });
    }
    return results;
  }

  // Offsets are computed lazily, per rendered row — the ranking pass runs with
  // `recordMatchIndexes: false`, exactly as the old select-list did, so typing
  // in a 50k-file picker does not pay for 50k index recordings.
  offsetsFor(candidate, text) {
    const merged = new Set();
    for (const token of this.tokenize(text)) {
      const hit = fuzzyMatcher.match(candidate, token, {
        algorithm: this.algorithm,
        ignoreDiacritics: this.ignoreDiacritics,
        recordMatchIndexes: true,
      });
      for (const offset of hit?.matchIndexes ?? []) merged.add(offset);
    }
    return Array.from(merged).sort((a, b) => a - b);
  }

  highlightsFor(result, query) {
    const text = query.text ?? "";
    if (!text) return {};
    if (this.combine === "joined") {
      const map = this.maps[result.index];
      if (!map) return {};
      const candidate = joinFields(result.entry, this.fields).text;
      return splitOffsets(this.offsetsFor(candidate, text), map);
    }
    const field = this.fields.find((f) => f.name === result.field) ?? this.fields[0];
    const candidate = String(field.get(result.entry) ?? "");
    const offsets = this.offsetsFor(candidate, text);
    return offsets.length ? { [field.name]: offsets } : {};
  }

  dispose() {
    this.native = null;
    this.nativeByField = null;
    this.entries = [];
    this.maps = [];
  }
}

class IdentityMatcher {
  setItems(entries) {
    this.entries = entries;
  }
  match() {
    return (this.entries ?? []).map((entry, index) => ({
      entry,
      index,
      score: 1,
      highlights: null,
    }));
  }
  highlightsFor() {
    return {};
  }
  dispose() {
    this.entries = [];
  }
}

class CustomMatcher {
  constructor(fn) {
    this.fn = fn;
  }
  setItems(entries) {
    this.entries = entries;
  }
  match(query, ctx) {
    const items = (this.entries ?? []).map((entry) => entry.item);
    const out = this.fn(items, query, ctx) ?? [];
    const byItem = new Map();
    (this.entries ?? []).forEach((entry, index) => byItem.set(entry.item, { entry, index }));
    const results = [];
    for (const value of out) {
      const item = value && value.item !== undefined ? value.item : value;
      const found = byItem.get(item);
      if (!found) continue;
      results.push({
        entry: found.entry,
        index: found.index,
        score: value && value.score !== undefined ? value.score : 1,
        highlights: value && value.highlights ? value.highlights : null,
      });
    }
    return results;
  }
  highlightsFor() {
    return {};
  }
  dispose() {
    this.entries = [];
  }
}

const matchers = {
  fuzzy(opts = {}) {
    return new FuzzyMatcher(opts);
  },
  none() {
    return new IdentityMatcher();
  },
  custom(fn) {
    return new CustomMatcher(fn);
  },
  // Preset for command lists: `-` reads as a space so "fold all" finds
  // "editor:fold-all", and the whole displayed string is the haystack.
  command(opts = {}) {
    return new FuzzyMatcher({
      ...opts,
      fields: opts.fields ?? [{ name: "label", get: (entry) => entry.text.replace(/-/g, " ") }],
    });
  },
};

function normalizeMatcher(value) {
  if (value == null || value === "fuzzy") return matchers.fuzzy();
  if (value === "none") return matchers.none();
  if (typeof value === "function") return matchers.custom(value);
  if (typeof value.match === "function") return value;
  return matchers.fuzzy(value);
}

module.exports = { matchers, normalizeMatcher, FuzzyMatcher };
