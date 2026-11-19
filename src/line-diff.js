const { diffLines } = require("diff");

// Compute context-free line-diff hunks between a baseline blob and buffer text as
// `{oldStart, oldLines, newStart, newLines}`. jsdiff's Myers algorithm gives the
// expected hunk boundaries; pure deletions need one adjustment because jsdiff
// reports the new-side start one line later than Git's unified-diff convention.
// The gutter view anchors its removed marker to the preceding line using that
// convention, so deletion starts are corrected here.
//
// * `oldText` The baseline contents, or null when the path is absent there.
// * `newText` The current buffer contents.
// * `ignoreEolWhitespace` When true (win32, matching git-repository.js), ignore
//   end-of-line whitespace so an LF-in-HEAD vs CRLF-in-buffer file is not
//   reported as fully modified.
function computeLineDiffHunks(oldText, newText, { ignoreEolWhitespace = false, timeout } = {}) {
  let a = oldText ?? "";
  let b = newText;
  if (ignoreEolWhitespace) {
    // Strip trailing whitespace (spaces, tabs, CR) at each line end. Line count
    // is preserved, so hunk line numbers still map to buffer rows.
    // Start at the beginning of a whitespace run so a long interior run is
    // checked once instead of retrying the same suffix at each character.
    a = a.replace(/(^|[^ \t\r\n])[ \t\r]+$/gm, "$1");
    b = b.replace(/(^|[^ \t\r\n])[ \t\r]+$/gm, "$1");
  }

  const changes = diffLines(a, b, { timeout });
  if (!changes) return null;

  // Combine adjacent additions and removals into zero-context hunks. Use the
  // counts directly instead of materializing patch text that the gutter drops.
  const hunks = [];
  let oldLine = 1;
  let newLine = 1;
  let hunk = null;
  function finishHunk() {
    if (!hunk) return;
    if (hunk.newLines === 0) hunk.newStart--;
    hunks.push(hunk);
    hunk = null;
  }

  for (const { added, removed, count } of changes) {
    if (added || removed) {
      hunk ??= { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0 };
      if (added) hunk.newLines += count;
      else hunk.oldLines += count;
    } else {
      finishHunk();
    }
    if (!added) oldLine += count;
    if (!removed) newLine += count;
  }
  finishHunk();
  return hunks;
}

module.exports = { computeLineDiffHunks };
