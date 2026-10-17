// Marker ids are allocated monotonically by TextBuffer. Partitioning them keeps
// a single moved cursor from copying every fold's history state. Published
// snapshots own their blocks; the live map copies a block on its first write.
const BLOCK_SIZE = 128;

class MarkerHistorySnapshot {
  constructor(blocks) {
    this.blocks = blocks;
  }

  get(id) {
    return this.blocks.get(Math.floor(id / BLOCK_SIZE))?.get(id);
  }

  *[Symbol.iterator]() {
    for (const block of this.blocks.values()) yield* block;
  }
}

module.exports = class MarkerHistoryMap extends Map {
  constructor() {
    super();
    // Keep the live Map's native iterator: text edits visit these entries in
    // tight loops, and a generator over the snapshot blocks adds measurable
    // overhead to multicursor editing. Both maps share the immutable values.
    this.blocks = new Map();
    this.shared = false;
    this.writableBlocks = new Set();
  }

  set(id, value) {
    if (this.get(id) === value) return this;
    super.set(id, value);
    this.writableBlock(Math.floor(id / BLOCK_SIZE)).set(id, value);
    return this;
  }

  delete(id) {
    const key = Math.floor(id / BLOCK_SIZE);
    if (!super.delete(id)) return false;
    const block = this.writableBlock(key);
    block.delete(id);
    if (block.size === 0) {
      this.blocks.delete(key);
      this.writableBlocks.delete(key);
    }
    return true;
  }

  clear() {
    super.clear();
    this.blocks = new Map();
    this.shared = false;
    this.writableBlocks.clear();
  }

  writableBlock(key) {
    if (this.shared) {
      this.blocks = new Map(this.blocks);
      this.shared = false;
    }
    if (!this.writableBlocks.has(key)) {
      this.blocks.set(key, new Map(this.blocks.get(key)));
      this.writableBlocks.add(key);
    }
    return this.blocks.get(key);
  }

  snapshot() {
    this.shared = true;
    this.writableBlocks.clear();
    return new MarkerHistorySnapshot(this.blocks);
  }
};
