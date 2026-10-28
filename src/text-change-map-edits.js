const Point = require("./point");
const Range = require("./range");

// Expand a compressed, source-backed map lazily. The returned edits address
// the intermediate document after every preceding edit, not the enclosing
// span: annotations in unchanged gaps must retain ordinary splice semantics.
function* editsForMap(map) {
  if (map.maps) {
    for (const child of map.maps) yield* editsForMap(child);
    return;
  }
  if (map.transfers) {
    yield* editsForMap(map.base);
    return;
  }
  if (map.edits) {
    for (const edit of map.edits)
      yield {
        oldStart: edit.start,
        oldEnd: edit.oldEnd,
        newStart: edit.start,
        newEnd: edit.newEnd,
        oldRange: new Range(edit.start, edit.oldEnd),
        newRange: new Range(edit.start, edit.newEnd),
        oldTextSource: edit.oldTextSource,
        newTextSource: edit.newTextSource,
      };
    return;
  }
  for (const run of map.runs) {
    for (let index = 0; index < run.count; index++) {
      const before = run.start + index * run.step;
      const after = before + run.delta + index * (run.newLength - run.oldLength);
      const oldStart = Point.fromObject(map.before.positionAt(before));
      const oldEnd = Point.fromObject(map.before.positionAt(before + run.oldLength));
      const newStart = Point.fromObject(map.after.positionAt(after));
      const newEnd = Point.fromObject(map.after.positionAt(after + run.newLength));
      yield {
        oldStart,
        oldEnd,
        newStart,
        newEnd,
        oldRange: new Range(newStart, newStart.traverse(oldEnd.traversalFrom(oldStart))),
        newRange: new Range(newStart, newEnd),
        oldTextSource: map.before.subtext(before, before + run.oldLength),
        newTextSource: map.after.subtext(after, after + run.newLength),
      };
    }
  }
}

editsForMap.canReplay = (map) =>
  Boolean(
    map &&
    (map.runs ||
      (map.maps && map.maps.every(editsForMap.canReplay)) ||
      (map.transfers && editsForMap.canReplay(map.base)) ||
      (map.edits && map.edits.every((edit) => edit.oldTextSource && edit.newTextSource))),
  );
module.exports = editsForMap;
