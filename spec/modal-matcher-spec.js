"use strict";

const { matchers } = require("../src/modal-matcher");

describe("modal matchers", () => {
  const entriesFor = (texts) =>
    texts.map((text, index) => ({ id: String(index), text, item: text }));

  const query = (text) => ({ raw: text, text });

  describe("empty query", () => {
    // fuzzy-native scores every candidate exactly 1.0 for "" AND shuffles
    // candidates on insert, so anything that caps or sorts an empty-query match
    // returns a random subset in random order.
    it("returns every item in source order", () => {
      const texts = Array.from({ length: 500 }, (_, i) => `item-${i}`);
      const matcher = matchers.fuzzy();
      matcher.setItems(entriesFor(texts));

      const results = matcher.match(query(""));
      expect(results.length).toBe(500);
      expect(results.map((r) => r.entry.text)).toEqual(texts);
    });

    it("is stable across repeated matches", () => {
      const texts = Array.from({ length: 200 }, (_, i) => `item-${i}`);
      const matcher = matchers.fuzzy();
      matcher.setItems(entriesFor(texts));

      const first = matcher.match(query("")).map((r) => r.entry.text);
      const second = matcher.match(query("")).map((r) => r.entry.text);
      expect(first).toEqual(second);
    });

    it("ignores maxResults so nothing is silently truncated", () => {
      const texts = Array.from({ length: 300 }, (_, i) => `item-${i}`);
      const matcher = matchers.fuzzy({ maxResults: 10 });
      matcher.setItems(entriesFor(texts));

      expect(matcher.match(query("")).length).toBe(300);
    });
  });

  describe("defaults", () => {
    it("does not cap results unless asked", () => {
      const texts = Array.from({ length: 300 }, (_, i) => `alpha-${i}`);
      const matcher = matchers.fuzzy();
      matcher.setItems(entriesFor(texts));

      expect(matcher.match(query("alpha")).length).toBe(300);
    });

    it("caps when maxResults is given", () => {
      const texts = Array.from({ length: 300 }, (_, i) => `alpha-${i}`);
      const matcher = matchers.fuzzy({ maxResults: 25 });
      matcher.setItems(entriesFor(texts));

      expect(matcher.match(query("alpha")).length).toBe(25);
    });

    it("ranks better matches first", () => {
      const matcher = matchers.fuzzy();
      matcher.setItems(entriesFor(["banana", "abc", "a-b-c"]));

      const results = matcher.match(query("abc"));
      expect(results[0].entry.text).toBe("abc");
    });
  });

  describe("multiple fields", () => {
    const entries = [
      { id: "1", text: "main", item: 1, fields: { label: "main", detail: "Local branch" } },
      { id: "2", text: "main", item: 2, fields: { label: "main", detail: "Remote branch" } },
    ];
    const fields = [
      { name: "label", get: (e) => e.fields.label },
      { name: "detail", get: (e) => e.fields.detail },
    ];

    // Joined is the default because real queries straddle fields: "remote main"
    // matches nothing inside either field on its own.
    it("matches a query spanning two fields by default", () => {
      const matcher = matchers.fuzzy({ fields });
      matcher.setItems(entries);

      const results = matcher.match(query("remote main"));
      expect(results.length).toBe(1);
      expect(results[0].entry.id).toBe("2");
    });

    it("matches terms in either order", () => {
      const matcher = matchers.fuzzy({ fields });
      matcher.setItems(entries);

      expect(matcher.match(query("main remote")).length).toBe(1);
      expect(matcher.match(query("remote main")).length).toBe(1);
    });

    it("requires every term to match", () => {
      const matcher = matchers.fuzzy({ fields });
      matcher.setItems(entries);

      expect(matcher.match(query("remote zzzz")).length).toBe(0);
    });

    it("splits highlight offsets back onto the right field", () => {
      const matcher = matchers.fuzzy({ fields });
      matcher.setItems(entries);

      const results = matcher.match(query("main"));
      const highlights = matcher.highlightsFor(results[0], query("main"));
      expect(highlights.label).toEqual([0, 1, 2, 3]);
    });

    it("scopes matching to a single field in max mode", () => {
      const matcher = matchers.fuzzy({ fields, combine: "max" });
      matcher.setItems(entries);

      // No single field contains both terms, so max mode rejects it.
      expect(matcher.match(query("remote main")).length).toBe(0);
      expect(matcher.match(query("remote")).length).toBe(1);
    });
  });

  describe("diacritics", () => {
    it("folds accents by default and reports offsets against the original", () => {
      const matcher = matchers.fuzzy();
      matcher.setItems(entriesFor(["café"]));

      const results = matcher.match(query("cafe"));
      expect(results.length).toBe(1);
      const highlights = matcher.highlightsFor(results[0], query("cafe"));
      expect(highlights.label).toEqual([0, 1, 2, 3]);
    });

    it("rebuilds the native matcher when the flag changes", () => {
      const sensitive = matchers.fuzzy({ ignoreDiacritics: false });
      sensitive.setItems(entriesFor(["café"]));
      expect(sensitive.match(query("cafe")).length).toBe(0);
    });
  });

  describe("candidate swaps", () => {
    // fuzzy-native's incremental memo is reset by setCandidates itself, but a
    // swap must still never surface an item that is no longer in the set.
    it("does not leak results across a source swap", () => {
      const matcher = matchers.fuzzy();
      matcher.setItems(entriesFor(["alpha", "alphabet"]));
      expect(matcher.match(query("alph")).length).toBe(2);

      matcher.setItems(entriesFor(["beta"]));
      expect(matcher.match(query("alph")).length).toBe(0);
      expect(matcher.match(query("bet")).length).toBe(1);
    });

    it("finds candidates added after a narrowing query", () => {
      const matcher = matchers.fuzzy();
      matcher.setItems(entriesFor(["one"]));
      matcher.match(query("zzz"));

      matcher.setItems(entriesFor(["one", "zzz-two"]));
      expect(matcher.match(query("zzz")).length).toBe(1);
    });
  });

  describe("scoreModifier and order", () => {
    it("drops items scored to zero", () => {
      const matcher = matchers.fuzzy({
        scoreModifier: (item, score) => (item === "beta" ? 0 : score),
      });
      matcher.setItems(entriesFor(["beta", "best"]));

      const results = matcher.match(query("be"));
      expect(results.map((r) => r.entry.text)).toEqual(["best"]);
    });

    it("passes the query to the comparator so empty-query ordering can differ", () => {
      const seen = [];
      const matcher = matchers.fuzzy({
        order: (a, b, q) => {
          seen.push(q.text);
          return a.entry.text.localeCompare(b.entry.text);
        },
      });
      matcher.setItems(entriesFor(["c", "a", "b"]));

      const results = matcher.match(query(""));
      expect(results.map((r) => r.entry.text)).toEqual(["a", "b", "c"]);
      expect(seen.every((text) => text === "")).toBe(true);
    });
  });

  describe("none", () => {
    it("preserves source order and matches everything", () => {
      const matcher = matchers.none();
      matcher.setItems(entriesFor(["c", "a", "b"]));

      const results = matcher.match(query("zzz"));
      expect(results.map((r) => r.entry.text)).toEqual(["c", "a", "b"]);
    });
  });

  describe("command", () => {
    it("treats hyphens as spaces", () => {
      const matcher = matchers.command();
      matcher.setItems(entriesFor(["editor:fold-all"]));

      expect(matcher.match(query("fold all")).length).toBe(1);
    });
  });
});
