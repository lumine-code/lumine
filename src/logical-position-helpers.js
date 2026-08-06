const ZERO_POSITION = Object.freeze({ row: 0, pixels: 0 });

function add(a, b) {
  return {
    row: a.row + b.row,
    pixels: a.pixels + b.pixels,
  };
}

function subtract(a, b) {
  return {
    row: a.row - b.row,
    pixels: a.pixels - b.pixels,
  };
}

function format(position) {
  return `(row: ${position.row}, pixels: ${position.pixels})`;
}

module.exports = { ZERO_POSITION, add, subtract, format };
