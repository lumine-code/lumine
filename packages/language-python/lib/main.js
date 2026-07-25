exports.activate = function () {
  if (!atom.grammars.addInjectionPoint) return;

  // TODO: There's no regex literal in Python. The TM-style grammar has a
  // very obscure option that, when enabled, assumes all raw strings are
  // regexes and highlights them accordingly. This might be worth doing in the
  // new grammar _if_ someone asks for it.

  //
  // atom.grammars.addInjectionPoint('source.python', {
  //   type: 'string',
  //   language (node) {
  //     return (/^r(?=['"])/.test(node.text)) ? 'py-regex' : null
  //   },
  //   content (node) {
  //     return node.descendantsOfType('string_content')?.[0];
  //   },
  //   languageScope: null
  // });
};

// IPython is a separate grammar with its own scope, so every injection has to
// name it alongside plain Python. Both run the same parser, so the node types
// are identical.
const SCOPES = ["source.python", "source.python.ipy"];

exports.consumeHyperlinkInjection = (hyperlink) => {
  for (const scope of SCOPES) {
    hyperlink.addInjectionPoint(scope, {
      types: ["comment", "string_content"],
    });
  }
};

exports.consumeTodoInjection = (todo) => {
  for (const scope of SCOPES) {
    todo.addInjectionPoint(scope, { types: ["comment"] });
  }
};
