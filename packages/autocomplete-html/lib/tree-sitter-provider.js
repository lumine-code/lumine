const {
  getTagNameCompletions,
  getAttributeNameCompletions,
  getAttributeValueCompletions,
} = require("./helpers");

// Completions for a buffer parsed by the Tree-sitter HTML grammar.
//
// The division of labour here is deliberate. Structure comes from the tree:
// whether the position sits in `<script>`/`<style>` raw text, and whether it
// sits inside a quoted attribute value (and if so, which attribute of which
// tag). Everything else comes from the text between the opening `<` and the
// cursor.
//
// That is not laziness about the tree — it is what completion needs. Half the
// inputs are, by definition, half-typed, and the grammar's error recovery
// reshapes them in ways that carry no useful signal: `<` alone parses to
// `(document (ERROR))`, `<div ` to a `self_closing_tag` with a `MISSING "/>"`,
// and `< h` to a tag actually *named* `h`, so the tree cannot even tell you
// there is a space after the `<`. The previous version of this file navigated
// those shapes, went stale when the grammar changed, and then silently returned
// nothing at all for every input.

const TAG_NAME = /^[a-zA-Z][-a-zA-Z0-9]*$/;
const LEADING_TAG_NAME = /^([a-zA-Z][-a-zA-Z0-9]*)\s/;
// An attribute name can only begin after whitespace, so this is both the test
// for "an attribute is being typed here" and the way its prefix is read. It is
// what rejects a caret parked just past a finished value, as in
// `<button type=""|`, where the run back to the last space is not a name.
const ATTRIBUTE_POSITION = /\s([-a-zA-Z0-9]*)$/;
// `foo=`, `foo= `, `foo="` — the caret is on its way to a value, and offering
// an attribute name there would be wrong. A caret actually *inside* the quotes
// is recognised from the tree, before this is consulted.
const AWAITING_VALUE = /=\s*["']?$/;

module.exports = function ({ editor, bufferPosition }) {
  const languageMode = editor.getBuffer().getLanguageMode();
  const node = languageMode.getSyntaxNodeAtPosition(
    bufferPosition,
    (node, grammar) => grammar.scopeName === "text.html.basic",
  );
  if (!node) return [];

  // `<script>`/`<style>` bodies belong to an injected grammar; the HTML tree
  // holds them only as raw text, and HTML completions have no business there.
  if (hasAncestor(node, "raw_text")) return [];

  const value = attributeValueContext(node, bufferPosition);
  if (value) {
    return getAttributeValueCompletions(value.tag, value.attribute, value.prefix);
  }

  const tag = openTagTextBefore(editor, bufferPosition);
  if (tag === null) return [];

  // `<`, or `<` plus the start of a name: the name is what is being completed.
  if (tag === "" || TAG_NAME.test(tag)) {
    return getTagNameCompletions(tag);
  }

  // Otherwise the name is settled and an attribute is being typed — unless
  // there is no name at all, as in `< ` or `< h`, which is not a tag.
  const named = LEADING_TAG_NAME.exec(tag);
  if (!named) return [];
  if (AWAITING_VALUE.test(tag)) return [];

  const attribute = ATTRIBUTE_POSITION.exec(tag);
  if (!attribute) return [];

  return getAttributeNameCompletions(named[1], attribute[1]);
};

function hasAncestor(node, type) {
  for (let current = node; current; current = current.parent) {
    if (current.type === type) return true;
  }
  return false;
}

// The text between the innermost unclosed `<` and the cursor, or null when the
// cursor is not inside a tag at all. Scanning back to the nearest `<` or `>` is
// enough: finding a `>` first means the last tag has already closed.
function openTagTextBefore(editor, bufferPosition) {
  let opening = null;
  editor.backwardsScanInBufferRange(/[<>]/g, [[0, 0], bufferPosition], ({ match, range, stop }) => {
    stop();
    if (match[0] === "<") opening = range.end;
  });
  if (!opening) return null;
  return editor.getTextInRange([opening, bufferPosition]);
}

// A caret strictly inside the quotes of an attribute value — never on the
// opening quote itself, which is `<select autofocus=|""`, where nothing has
// been typed and nothing should be offered yet.
function attributeValueContext(node, bufferPosition) {
  const quoted = closestOfType(node, "quoted_attribute_value");
  if (!quoted) return null;
  if (!bufferPosition.isGreaterThan(quoted.startPosition)) return null;
  if (!bufferPosition.isLessThan(quoted.endPosition)) return null;

  const attribute = closestOfType(quoted, "attribute");
  const tagNode = attribute && attribute.parent;
  if (!tagNode) return null;

  const attributeName = childOfType(attribute, "attribute_name");
  const tagName = childOfType(tagNode, "tag_name");
  if (!attributeName || !tagName) return null;

  // The value typed so far: from just past the opening quote to the caret. An
  // empty `""` has no `attribute_value` child at all.
  const contents = childOfType(quoted, "attribute_value");
  let prefix = "";
  if (contents && bufferPosition.isGreaterThan(contents.startPosition)) {
    prefix = contents.text.slice(0, bufferPosition.column - contents.startPosition.column);
  }

  return { tag: tagName.text, attribute: attributeName.text, prefix };
}

function closestOfType(node, type) {
  for (let current = node; current; current = current.parent) {
    if (current.type === type) return current;
  }
  return null;
}

function childOfType(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === type) return child;
  }
  return null;
}
