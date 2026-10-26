// Screen lines own token arrays and presentation objects. Retain a fixed
// working set rather than one slot (or one object) for every document row.
class ScreenLineCache {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.entries = new Map();
    this.rowCount = 0;
  }

  get length() {
    return this.rowCount;
  }
  set length(value) {
    this.rowCount = value;
    for (const row of this.entries.keys()) if (row >= value) this.entries.delete(row);
  }

  get(row) {
    const value = this.entries.get(row);
    if (value !== undefined) {
      this.entries.delete(row);
      this.entries.set(row, value);
    }
    return value;
  }

  set(row, value) {
    this.rowCount = Math.max(this.rowCount, row + 1);
    this.entries.delete(row);
    if (value === undefined) return;
    this.entries.set(row, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value);
  }

  spliceRows(start, removed, inserted = 0) {
    removed = Math.min(removed, Math.max(0, this.rowCount - start));
    const insertedCount = typeof inserted === "number" ? inserted : inserted.length;
    const delta = insertedCount - removed;
    const entries = new Map();
    for (const [row, value] of this.entries) {
      if (row < start) entries.set(row, value);
      else if (row >= start + removed) entries.set(row + delta, value);
    }
    this.entries = entries;
    this.rowCount = Math.max(this.rowCount, start) + delta;
  }

  at(index) {
    return this.get(index < 0 ? this.length + index : index);
  }
  slice(start = 0, end = this.length) {
    if (start < 0) start = Math.max(0, this.length + start);
    if (end < 0) end = Math.max(0, this.length + end);
    const result = [];
    for (let row = start; row < Math.min(end, this.length); row++) result.push(this.get(row));
    return result;
  }
}

module.exports = ScreenLineCache;
