((module) @injection.owner @injection.content
  (#set! injection.language "python")
  (#set! injection.include-children)
  (#set! injection.content-edit-policy "words"))

((call function: (identifier) @injection.language
  arguments: (argument_list) @injection.content) @injection.owner)
