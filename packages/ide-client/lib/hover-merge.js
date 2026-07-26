// Merges the hover answers of several language servers into one document.
//
// Servers covering the same file overlap heavily — a type checker and a linter
// both like to open with the symbol's signature — but they rarely phrase it
// identically: one wraps it in a fenced block, the other does not. Comparing
// whole answers therefore catches almost nothing. Instead each answer is split
// into sections and compared section by section, so the shared signature is
// shown once and every server still contributes whatever it alone knows.

const FENCE = /^\s*(```|~~~)/;
const HORIZONTAL_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

// Sections are fenced code blocks (kept whole, however many blank lines they
// contain) and runs of prose between blank lines or horizontal rules.
const splitSections = (value) => {
  const sections = [];
  let current = [];
  let fence = null;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) sections.push(text);
    current = [];
  };
  for (const line of value.split(/\r?\n/)) {
    if (fence) {
      current.push(line);
      if (line.trim().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const opening = FENCE.exec(line);
    if (opening) {
      flush();
      fence = opening[1];
      current.push(line);
      continue;
    }
    if (!line.trim() || HORIZONTAL_RULE.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return sections;
};

// Comparison ignores the presentation a server chose: fences, the language tag
// on them, and whitespace differences. `foo(x: int)` in a Python block and the
// same text as bare prose are one and the same section.
const keyFor = (section) =>
  section
    .replace(/^\s*(```|~~~)[^\n]*\n?/, "")
    .replace(/\n?\s*(```|~~~)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

// Returns the merged markdown, with each server's surviving sections kept
// together and separated from the next server's by a rule. A server whose
// every section was already said contributes nothing and disappears.
exports.mergeHoverValues = (values) => {
  const seen = new Set();
  const blocks = [];
  for (const value of values) {
    if (!value) continue;
    const kept = [];
    for (const section of splitSections(value)) {
      const key = keyFor(section);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      kept.push(section);
    }
    if (kept.length) blocks.push(kept.join("\n\n"));
  }
  return blocks.join("\n\n---\n\n");
};

exports.splitSections = splitSections;
exports.keyFor = keyFor;
