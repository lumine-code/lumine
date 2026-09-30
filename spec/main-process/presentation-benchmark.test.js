const { revisionInFrame, percentile, summarize } = require("../../benchmark/presentation-observer");

describe("presentation benchmark frame boundaries", () => {
  function captured(revision, width = 4, height = 4) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 197;
      pixels[offset + 1] = revision & 255;
      pixels[offset + 2] = revision >> 8;
      pixels[offset + 3] = 255;
    }
    return { getSize: () => ({ width, height }), toBitmap: () => pixels };
  }
  it("decodes the rendered revision from the dirty crop", () => {
    expect(revisionInFrame(captured(513), { x: 6, y: 6 }, { x: 8, y: 8 }, 1)).toBe(513);
  });
  it("does not accept a frame that repainted elsewhere", () => {
    expect(revisionInFrame(captured(513), { x: 20, y: 20 }, { x: 8, y: 8 }, 1)).toBeNull();
  });
  it("accounts for device scaling when locating marker pixels", () => {
    const image = captured(513, 8, 8);
    const pixels = image.toBitmap();
    const markerPixels = Buffer.from(pixels.subarray((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4));
    pixels.fill(0);
    markerPixels.copy(pixels, (4 * 8 + 4) * 4);
    expect(revisionInFrame(image, { x: 12, y: 12 }, { x: 8, y: 8 }, 2)).toBe(513);
  });
  it("does not mistake unrelated pixels for the marker", () => {
    const image = captured(513);
    image.toBitmap().fill(0);
    expect(revisionInFrame(image, { x: 6, y: 6 }, { x: 8, y: 8 }, 1)).toBeNull();
  });
  it("reports no percentile for failed samples without valid frames", () => {
    expect(summarize([])).toEqual({
      count: 0,
      medianMs: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
    });
  });
  it("uses nearest-rank p95 and does not mutate raw samples", () => {
    const values = [3, 1, 2];
    expect(percentile(values, 0.95)).toBe(3);
    expect(values).toEqual([3, 1, 2]);
  });
});
