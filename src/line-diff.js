const Diff = require("diff");

// Compute context-free line-diff hunks between the HEAD blob and buffer text as
// `{oldStart, oldLines, newStart, newLines}`. jsdiff's Myers algorithm gives the
// expected hunk boundaries; pure deletions need one adjustment because jsdiff
// reports the new-side start one line later than Git's unified-diff convention.
// git-diff-view anchors its removed marker to the preceding line using that
// convention, so deletion starts are corrected here.
//
// * `oldText` The HEAD blob contents, or null when the path is absent at HEAD.
// * `newText` The current buffer contents.
// * `ignoreEolWhitespace` When true (win32, matching git-repository.js), ignore
//   end-of-line whitespace so an LF-in-HEAD vs CRLF-in-buffer file is not
//   reported as fully modified.
function computeLineDiffHunks(oldText, newText, { ignoreEolWhitespace = false } = {}) {
  if (oldText == null) return [];

  let a = oldText;
  let b = newText;
  if (ignoreEolWhitespace) {
    // Strip trailing whitespace (spaces, tabs, CR) at each line end. Line count
    // is preserved, so hunk line numbers still map to buffer rows.
    a = a.replace(/[ \t\r]+$/gm, "");
    b = b.replace(/[ \t\r]+$/gm, "");
  }

  const { hunks } = Diff.structuredPatch("a", "b", a, b, "", "", { context: 0 });
  return hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart,
    newLines: hunk.newLines,
  }));
}

module.exports = { computeLineDiffHunks };
