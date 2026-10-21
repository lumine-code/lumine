// Paint packets have a separate allowance from semantic result streams. The
// bounds amortize message round trips while keeping renderer decoding short.
exports.PAINT_TILE_ROWS = 128;
exports.PAINT_PACKET_EVENTS = 4096;
