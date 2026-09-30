const TextBuffer = require("../src/text-buffer");
const { isWrapBoundary } = require("../src/text-utils");

describe("DisplayLayer buffer-position batches", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length > 0) buffers.pop().destroy();
  });

  function buildLayer(text, options = {}) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return buffer.addDisplayLayer(options);
  }

  function assertMatchesScalar(layer, positions, options) {
    const expected = positions.map((position) => layer.translateBufferPosition(position, options));
    const actual = layer.translateBufferPositions(positions, options);
    expect(actual).toEqual(expected);
    return actual;
  }

  function watchLookups(layer) {
    const patch = layer.spatialIndex;
    const packed = jasmine
      .createSpy("packed lookup")
      .and.callFake((points) => patch.changesForOldPositions(points));
    const scalar = jasmine
      .createSpy("scalar lookup")
      .and.callFake((point) => patch.changeForOldPosition(point));
    layer.spatialIndex = new Proxy(patch, {
      get(target, key) {
        if (key === "changesForOldPositions") return packed;
        if (key === "changeForOldPosition") return scalar;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { packed, scalar };
  }

  it("matches scalar clipping across wraps, folds, tabs, paired characters and soft tabs", () => {
    const layer = buildLayer(
      "    alpha\tbeta😀 e\u0301 delta\r\nhidden middle\n  tail\twords/next\n",
      {
        softWrapColumn: 11,
        softWrapHangingIndent: 2,
        tabLength: 4,
        isWrapBoundary,
      },
    );
    layer.foldBufferRange([
      [0, 20],
      [2, 4],
    ]);
    const positions = [];
    for (let row = -1; row <= layer.buffer.getLineCount(); row++) {
      for (let column = -1; column < 40; column++) positions.push([row, column]);
      positions.push([row, Infinity]);
    }
    positions.push([Infinity, Infinity], [0, 9], [0, 9]);
    for (const clipDirection of ["backward", "closest", "forward"]) {
      assertMatchesScalar(layer, positions, { clipDirection });
      assertMatchesScalar(layer, positions.slice().reverse(), { clipDirection });
    }
  });

  it("uses one packed predecessor query and does not alias the temporary hunk", () => {
    const layer = buildLayer("x".repeat(1000), { softWrapColumn: 20 });
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const positions = Array.from({ length: 100 }, (_, index) => [0, index * 7]);
    const expected = positions.map((position) => layer.translateBufferPosition(position));
    const { packed, scalar } = watchLookups(layer);
    const actual = layer.translateBufferPositions(positions);
    expect(actual).toEqual(expected);
    expect(packed).toHaveBeenCalledTimes(1);
    expect(scalar).not.toHaveBeenCalled();
    actual[0].column = 99;
    expect(actual[1]).toEqual(expected[1]);
    expect(layer.translateBufferPosition(positions[0])).toEqual(expected[0]);
  });

  it("keeps small and identity batches on the scalar path", () => {
    const layer = buildLayer("alpha\nbeta");
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const { packed } = watchLookups(layer);
    const positions = Array.from({ length: 100 }, () => [1, 2]);
    const expected = positions.map((point) => layer.translateBufferPosition(point));
    const clips = spyOn(layer.buffer, "clipPosition").and.callThrough();
    expect(layer.translateBufferPositions(positions)).toEqual(expected);
    expect(clips).toHaveBeenCalledTimes(positions.length);
    expect(packed).not.toHaveBeenCalled();
    layer.reset({ softWrapColumn: 2 });
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const smallLookups = watchLookups(layer);
    assertMatchesScalar(layer, [
      [0, 0],
      [0, 3],
    ]);
    expect(smallLookups.packed).not.toHaveBeenCalled();
    expect(layer.translateBufferPositions([])).toEqual([]);
  });

  it("falls back when a preceding Superstring build lacks packed lookup", () => {
    const layer = buildLayer("alpha beta ".repeat(20), { softWrapColumn: 9 });
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const patch = layer.spatialIndex;
    layer.spatialIndex = new Proxy(patch, {
      get(target, key) {
        if (key === "changesForOldPositions") return undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assertMatchesScalar(
      layer,
      Array.from({ length: 100 }, (_, index) => [0, index]),
    );
  });

  it("populates only the required prefix and retains custom callback behavior", () => {
    const layer = buildLayer("alpha beta\n".repeat(200), {
      softWrapColumn: 8,
      ratioForCharacter: (character) => (character === "a" ? 2 : 1),
    });
    assertMatchesScalar(
      layer,
      Array.from({ length: 100 }, (_, index) => [index % 3, index % 11]),
    );
    expect(layer.indexedBufferRowCount).toBeLessThan(layer.buffer.getLineCount());
  });

  it("falls back if character clipping reenters a buffer edit", () => {
    const layer = buildLayer("alpha_beta_gamma".repeat(20), { softWrapColumn: 12 });
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    const positions = Array.from({ length: 100 }, (_, index) => [0, index]);
    const readCharacter = layer.buffer.getCharacterAtPosition.bind(layer.buffer);
    let changed = false;
    spyOn(layer.buffer, "getCharacterAtPosition").and.callFake((point) => {
      if (!changed) {
        changed = true;
        layer.buffer.insert([0, 0], "prefix ");
      }
      return readCharacter(point);
    });
    const actual = layer.translateBufferPositions(positions);
    expect(changed).toBe(true);
    expect(actual).toEqual(positions.map((point) => layer.translateBufferPosition(point)));
  });
});
