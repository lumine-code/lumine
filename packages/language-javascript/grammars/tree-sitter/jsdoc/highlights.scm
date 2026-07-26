; Highlight this comment even if it's not “valid” JSDoc.
((ERROR) @comment.block.documentation.jsdoc.js
  (#is? test.root true))

((ERROR) @punctuation.definition.begin.comment.jsdoc.js
  (#is? test.root true)
  (#set! adjust.startAndEndAroundFirstMatchOf "^/\\*\\*"))

((ERROR) @punctuation.definition.end.comment.jsdoc.js
  (#is? test.root true)
  (#set! adjust.startAndEndAroundFirstMatchOf "(?:\\*)?\\*/$"))


(document) @comment.block.documentation.jsdoc.js

((document) @punctuation.definition.begin.comment.jsdoc.js
  (#set! adjust.startAndEndAroundFirstMatchOf "^/\\*\\*"))

((document) @punctuation.definition.end.comment.jsdoc.js
  (#set! adjust.startAndEndAroundFirstMatchOf "(?:\\*)?\\*/$"))

((inline_tag) @meta.inline-tag.jsdoc.js)

(tag_name) @keyword.other.tag.jsdoc.js

((tag (type)) @storage.type.instance.jsdoc.js
  ; Join the type with its surrounding braces.
  (#set! adjust.startAt firstChild.nextSibling.startPosition)
  (#set! adjust.endAt firstChild.nextSibling.nextSibling.nextSibling.endPosition))

(identifier) @variable.other.jsdoc.js

; Fenced code blocks inside a description, scoped the way the GFM grammar
; scopes its own fences.
(code_block) @meta.embedded.block.fenced-code.jsdoc.js

(code_block
  "```" @punctuation.definition.raw.jsdoc.js
  ; The closing fence carries the line's leading ` * ` with it.
  (#set! adjust.startBeforeFirstMatchOf "```"))

(code_block_language) @storage.modifier.language._TEXT_.jsdoc.js

(code_block_line) @markup.raw.block.fenced.jsdoc.js

"{" @punctuation.definition.begin.bracket.curly.jsdoc.js
"}" @punctuation.definition.end.bracket.curly.jsdoc.js
