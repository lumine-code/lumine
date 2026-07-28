/** @babel */

import _ from "@lumine-code/underscore-plus";

export default class SnippetsAvailable {
  constructor(snippets) {
    this.snippets = snippets;
  }

  toggle(editor) {
    const available = Object.values(this.snippets.getSnippets(editor));
    for (const snippet of available) {
      snippet.searchText = _.compact([snippet.prefix, snippet.name]).join(" ");
    }

    return atom.modals.toggle({
      id: "snippets.available",
      className: "available-snippets",
      placeholder: "Insert a snippet",
      source: available,
      renderer: {
        entry: (snippet) => ({ id: snippet.prefix, text: snippet.searchText }),
        row: (snippet) => ({ label: snippet.prefix, detail: snippet.name }),
      },
      confirm: ({ item, target }) => {
        for (const cursor of target.editor.getCursors()) {
          this.snippets.insert(item.bodyText, target.editor, cursor);
        }
      },
    });
  }

  destroy() {}
}
