// ECMAScript replacement-string expansion, shared by project replacements and
// TextBuffer.replace. The source is the full text being replaced, so prefix and
// suffix references retain their original context.
module.exports = function getSubstitution(
  matchedText,
  sourceText,
  matchIndex,
  captures,
  namedCaptures,
  replacementText,
) {
  return replacementText.replace(/\$([$&'`]|\d{1,2}|<[^>]*>)/g, (token, reference) => {
    switch (reference) {
      case "$":
        return "$";
      case "&":
        return matchedText;
      case "`":
        return sourceText.slice(0, matchIndex);
      case "'":
        return sourceText.slice(matchIndex + matchedText.length);
    }

    if (reference.startsWith("<")) {
      if (namedCaptures == null) return token;
      return namedCaptures[reference.slice(1, -1)] ?? "";
    }

    let captureIndex = Number(reference);
    let suffix = "";
    if (captureIndex > captures.length && reference.length === 2) {
      captureIndex = Number(reference[0]);
      suffix = reference[1];
    }

    if (captureIndex === 0 || captureIndex > captures.length) return token;
    return (captures[captureIndex - 1] ?? "") + suffix;
  });
};
